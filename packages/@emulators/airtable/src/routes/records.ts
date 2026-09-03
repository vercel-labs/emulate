import type { Context, RouteContext, Store } from "@emulators/core";
import { getAirtableStore } from "../store.js";
import type { AirtableRecordEntity, AirtableTable } from "../entities.js";
import { airtableError, airtableNotFound, decodeOffset, encodeOffset, parseJsonBody } from "../helpers.js";
import { findField, normalizeWriteCells, resolveBase, resolveTable, serializeRecord, tableFields } from "../schema.js";
import { collectFieldRefs, FormulaError, matchesFormula, parseFormula } from "../formula.js";
import { generateRecordId } from "../ids.js";

const MODEL_NOT_FOUND =
  "Invalid permissions, or the requested model was not found. Check that both your user and your token have the required permissions, and that the model names and/or ids are correct.";
const BATCH_LIMIT = 10;

interface ListParams {
  fields?: string[];
  filterByFormula?: string;
  maxRecords?: number;
  pageSize?: number;
  offset?: string;
  view?: string;
  cellFormat?: string;
  returnFieldsByFieldId?: boolean;
  sort?: Array<{ field: string; direction?: string }>;
}

/** Resolve a base + table, returning the distinct Airtable errors: unknown base is a
 * bare-string 404, unknown table is a 403 model-not-found. */
function resolveTarget(
  c: Context,
  store: Store,
  baseId: string,
  tableIdOrName: string,
): { table: AirtableTable } | Response {
  if (!resolveBase(store, baseId)) return airtableNotFound(c);
  const table = resolveTable(store, baseId, tableIdOrName);
  if (!table) return airtableError(c, 403, "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND", MODEL_NOT_FOUND);
  return { table };
}

function boolOf(value: unknown): boolean {
  return value === true || value === "true";
}

function readFieldsInput(item: unknown): Record<string, unknown> | null {
  if (item && typeof item === "object" && "fields" in item) {
    const fields = item.fields;
    if (fields && typeof fields === "object" && !Array.isArray(fields)) {
      return fields as Record<string, unknown>;
    }
  }
  return null;
}

function readId(item: unknown): string | undefined {
  if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
    return item.id;
  }
  return undefined;
}

function compareCells(
  a: AirtableRecordEntity,
  b: AirtableRecordEntity,
  keys: Array<{ name: string; dir: number }>,
): number {
  for (const { name, dir } of keys) {
    const av = a.cells[name];
    const bv = b.cells[name];
    const aBlank = av === undefined || av === null || av === "";
    const bBlank = bv === undefined || bv === null || bv === "";
    if (aBlank && bBlank) continue;
    if (aBlank) return 1;
    if (bBlank) return -1;
    let cmp: number;
    if (typeof av === "number" && typeof bv === "number") {
      cmp = av - bv;
    } else {
      const as = String(av);
      const bs = String(bv);
      cmp = as < bs ? -1 : as > bs ? 1 : 0;
    }
    if (cmp !== 0) return cmp * dir;
  }
  return 0;
}

interface FilterResult {
  rows?: AirtableRecordEntity[];
  error?: Response;
}

/** Parse + validate + apply a formula to `rows`. Field refs are validated against
 * field NAMES (so `{fldXXX}` id tokens 422), matching Airtable. */
function applyFormula(
  c: Context,
  formula: string,
  fieldNames: Set<string>,
  rows: AirtableRecordEntity[],
): FilterResult {
  let ast;
  try {
    ast = parseFormula(formula);
  } catch (err) {
    return {
      error: airtableError(c, 422, "INVALID_FILTER_BY_FORMULA", err instanceof Error ? err.message : "Invalid formula"),
    };
  }

  const unknown = collectFieldRefs(ast).filter((ref) => !fieldNames.has(ref));
  if (unknown.length > 0) {
    return { error: airtableError(c, 422, "INVALID_FILTER_BY_FORMULA", `Unknown field names: ${unknown.join(", ")}`) };
  }

  const now = new Date();
  try {
    const rowsOut = rows.filter((rec) =>
      matchesFormula(ast, {
        field: (name) => rec.cells[name],
        recordId: rec.record_id,
        createdTime: rec.created_time,
        now,
      }),
    );
    return { rows: rowsOut };
  } catch (err) {
    if (err instanceof FormulaError) {
      return { error: airtableError(c, 422, "INVALID_FILTER_BY_FORMULA", err.message) };
    }
    throw err;
  }
}

function runList(c: Context, store: Store, table: AirtableTable, p: ListParams): Response {
  const fields = tableFields(store, table.table_id);
  const fieldNames = new Set(fields.map((f) => f.name));

  const pageSize = p.pageSize ?? 100;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return airtableError(c, 422, "INVALID_PAGE_SIZE_ARGUMENT", "Page size argument should be between 0 and 100");
  }
  if (p.cellFormat && p.cellFormat !== "json") {
    return airtableError(c, 422, "INVALID_CELL_FORMAT", 'The emulator only supports cellFormat "json"');
  }

  let rows = getAirtableStore(store).records.findBy("table_id", table.table_id);

  let viewSort: Array<{ field: string; direction?: string }> | undefined;
  let viewFields: string[] | undefined;
  if (p.view) {
    const view = getAirtableStore(store)
      .views.findBy("table_id", table.table_id)
      .find((v) => v.view_id === p.view || v.name === p.view);
    if (!view) return airtableError(c, 422, "VIEW_NAME_NOT_FOUND", `The view "${p.view}" was not found`);
    if (view.filter) {
      const filtered = applyFormula(c, view.filter, fieldNames, rows);
      if (filtered.error) return filtered.error;
      rows = filtered.rows ?? rows;
    }
    viewSort = view.sort ?? undefined;
    viewFields = view.fields ?? undefined;
  }

  if (p.filterByFormula) {
    const filtered = applyFormula(c, p.filterByFormula, fieldNames, rows);
    if (filtered.error) return filtered.error;
    rows = filtered.rows ?? rows;
  }

  const sortSpec = p.sort && p.sort.length > 0 ? p.sort : viewSort;
  if (sortSpec && sortSpec.length > 0) {
    const keys: Array<{ name: string; dir: number }> = [];
    for (const spec of sortSpec) {
      const field = findField(fields, spec.field);
      if (!field) return airtableError(c, 422, "UNKNOWN_FIELD_NAME", `Unknown field name: "${spec.field}"`);
      keys.push({ name: field.name, dir: spec.direction === "desc" ? -1 : 1 });
    }
    rows = [...rows].sort((a, b) => compareCells(a, b, keys));
  }

  const capped = p.maxRecords && p.maxRecords > 0 ? rows.slice(0, p.maxRecords) : rows;
  const start = decodeOffset(p.offset);
  const page = capped.slice(start, start + pageSize);
  const nextOffset = start + pageSize < capped.length ? encodeOffset(start + pageSize) : undefined;

  const subset = p.fields ?? viewFields;
  const records = page.map((rec) =>
    serializeRecord(store, table, rec, { returnFieldsByFieldId: p.returnFieldsByFieldId, fieldsSubset: subset }),
  );

  return c.json(nextOffset ? { records, offset: nextOffset } : { records });
}

function listParamsFromQuery(c: Context): ListParams {
  const sort: Array<{ field: string; direction?: string }> = [];
  for (let i = 0; ; i++) {
    const field = c.req.query(`sort[${i}][field]`);
    if (!field) break;
    sort.push({ field, direction: c.req.query(`sort[${i}][direction]`) });
  }
  const pageSize = c.req.query("pageSize");
  const maxRecords = c.req.query("maxRecords");
  return {
    fields: c.req.queries("fields[]") ?? c.req.queries("fields"),
    filterByFormula: c.req.query("filterByFormula"),
    pageSize: pageSize != null ? Number(pageSize) : undefined,
    maxRecords: maxRecords != null ? Number(maxRecords) : undefined,
    offset: c.req.query("offset"),
    view: c.req.query("view"),
    cellFormat: c.req.query("cellFormat"),
    returnFieldsByFieldId: c.req.query("returnFieldsByFieldId") === "true",
    sort: sort.length > 0 ? sort : undefined,
  };
}

function listParamsFromBody(body: Record<string, unknown>): ListParams {
  const sort: Array<{ field: string; direction?: string }> = [];
  if (Array.isArray(body.sort)) {
    for (const s of body.sort) {
      if (s && typeof s === "object" && "field" in s && typeof s.field === "string") {
        const direction = "direction" in s && typeof s.direction === "string" ? s.direction : undefined;
        sort.push({ field: s.field, direction });
      }
    }
  }
  return {
    fields: Array.isArray(body.fields) ? body.fields.filter((f): f is string => typeof f === "string") : undefined,
    filterByFormula: typeof body.filterByFormula === "string" ? body.filterByFormula : undefined,
    pageSize: typeof body.pageSize === "number" ? body.pageSize : undefined,
    maxRecords: typeof body.maxRecords === "number" ? body.maxRecords : undefined,
    offset: typeof body.offset === "string" ? body.offset : undefined,
    view: typeof body.view === "string" ? body.view : undefined,
    cellFormat: typeof body.cellFormat === "string" ? body.cellFormat : undefined,
    returnFieldsByFieldId: boolOf(body.returnFieldsByFieldId),
    sort,
  };
}

function createRecord(store: Store, table: AirtableTable, cells: Record<string, unknown>): AirtableRecordEntity {
  return getAirtableStore(store).records.insert({
    base_id: table.base_id,
    table_id: table.table_id,
    record_id: generateRecordId(),
    cells,
    created_time: new Date().toISOString(),
  });
}

function findRecord(store: Store, table: AirtableTable, recordId: string): AirtableRecordEntity | undefined {
  const rec = getAirtableStore(store).records.findOneBy("record_id", recordId);
  return rec && rec.table_id === table.table_id ? rec : undefined;
}

export function recordRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.get("/v0/:baseId/:tableId", (c) => {
    const target = resolveTarget(c, store, c.req.param("baseId"), c.req.param("tableId"));
    if (target instanceof Response) return target;
    return runList(c, store, target.table, listParamsFromQuery(c));
  });

  app.post("/v0/:baseId/:tableId/listRecords", async (c) => {
    const target = resolveTarget(c, store, c.req.param("baseId"), c.req.param("tableId"));
    if (target instanceof Response) return target;
    return runList(c, store, target.table, listParamsFromBody(await parseJsonBody(c)));
  });

  app.get("/v0/:baseId/:tableId/:recordId", (c) => {
    const target = resolveTarget(c, store, c.req.param("baseId"), c.req.param("tableId"));
    if (target instanceof Response) return target;
    const rec = findRecord(store, target.table, c.req.param("recordId"));
    if (!rec) return airtableNotFound(c);
    return c.json(
      serializeRecord(store, target.table, rec, {
        returnFieldsByFieldId: c.req.query("returnFieldsByFieldId") === "true",
      }),
    );
  });

  app.post("/v0/:baseId/:tableId", async (c) => {
    const target = resolveTarget(c, store, c.req.param("baseId"), c.req.param("tableId"));
    if (target instanceof Response) return target;
    return handleCreate(c, store, target.table, await parseJsonBody(c));
  });

  app.patch("/v0/:baseId/:tableId", async (c) => {
    const target = resolveTarget(c, store, c.req.param("baseId"), c.req.param("tableId"));
    if (target instanceof Response) return target;
    return handleBatchUpdate(c, store, target.table, await parseJsonBody(c), false);
  });

  app.put("/v0/:baseId/:tableId", async (c) => {
    const target = resolveTarget(c, store, c.req.param("baseId"), c.req.param("tableId"));
    if (target instanceof Response) return target;
    return handleBatchUpdate(c, store, target.table, await parseJsonBody(c), true);
  });

  app.patch("/v0/:baseId/:tableId/:recordId", async (c) => {
    const target = resolveTarget(c, store, c.req.param("baseId"), c.req.param("tableId"));
    if (target instanceof Response) return target;
    return handleSingleUpdate(c, store, target.table, c.req.param("recordId"), await parseJsonBody(c), false);
  });

  app.put("/v0/:baseId/:tableId/:recordId", async (c) => {
    const target = resolveTarget(c, store, c.req.param("baseId"), c.req.param("tableId"));
    if (target instanceof Response) return target;
    return handleSingleUpdate(c, store, target.table, c.req.param("recordId"), await parseJsonBody(c), true);
  });

  app.delete("/v0/:baseId/:tableId/:recordId", (c) => {
    const target = resolveTarget(c, store, c.req.param("baseId"), c.req.param("tableId"));
    if (target instanceof Response) return target;
    const rec = findRecord(store, target.table, c.req.param("recordId"));
    if (!rec) return airtableNotFound(c);
    getAirtableStore(store).records.delete(rec.id);
    return c.json({ deleted: true, id: rec.record_id });
  });

  app.delete("/v0/:baseId/:tableId", (c) => {
    const target = resolveTarget(c, store, c.req.param("baseId"), c.req.param("tableId"));
    if (target instanceof Response) return target;
    const ids = c.req.queries("records[]") ?? c.req.queries("records") ?? [];
    const deleted: Array<{ deleted: true; id: string }> = [];
    for (const id of ids) {
      const rec = findRecord(store, target.table, id);
      if (!rec) return airtableNotFound(c);
      getAirtableStore(store).records.delete(rec.id);
      deleted.push({ deleted: true, id: rec.record_id });
    }
    return c.json({ records: deleted });
  });
}

function serialize(store: Store, table: AirtableTable, rec: AirtableRecordEntity, returnFieldsByFieldId: boolean) {
  return serializeRecord(store, table, rec, { returnFieldsByFieldId });
}

function handleCreate(c: Context, store: Store, table: AirtableTable, body: Record<string, unknown>): Response {
  const returnFieldIds = boolOf(body.returnFieldsByFieldId);
  const typecast = boolOf(body.typecast);

  if (Array.isArray(body.records)) {
    if (body.records.length > BATCH_LIMIT) {
      return airtableError(
        c,
        422,
        "INVALID_REQUEST_BODY",
        `You may only create up to ${BATCH_LIMIT} records at a time`,
      );
    }
    const created: AirtableRecordEntity[] = [];
    for (const item of body.records) {
      const incoming = readFieldsInput(item);
      if (!incoming) {
        return airtableError(
          c,
          422,
          "INVALID_REQUEST_MISSING_FIELDS",
          'Could not find field "fields" in the request body',
        );
      }
      const normalized = normalizeWriteCells(store, table, incoming, typecast);
      if (normalized.error) return airtableError(c, 422, normalized.error.type, normalized.error.message);
      created.push(createRecord(store, table, normalized.cells ?? {}));
    }
    return c.json({ records: created.map((r) => serialize(store, table, r, returnFieldIds)) });
  }

  const incoming = readFieldsInput(body);
  if (!incoming) {
    return airtableError(c, 422, "INVALID_REQUEST_MISSING_FIELDS", 'Could not find field "fields" in the request body');
  }
  const normalized = normalizeWriteCells(store, table, incoming, typecast);
  if (normalized.error) return airtableError(c, 422, normalized.error.type, normalized.error.message);
  const rec = createRecord(store, table, normalized.cells ?? {});
  return c.json(serialize(store, table, rec, returnFieldIds));
}

function handleSingleUpdate(
  c: Context,
  store: Store,
  table: AirtableTable,
  recordId: string,
  body: Record<string, unknown>,
  replace: boolean,
): Response {
  const rec = findRecord(store, table, recordId);
  if (!rec) return airtableNotFound(c);

  const incoming = readFieldsInput(body);
  if (!incoming) {
    return airtableError(c, 422, "INVALID_REQUEST_MISSING_FIELDS", 'Could not find field "fields" in the request body');
  }
  const normalized = normalizeWriteCells(store, table, incoming, boolOf(body.typecast));
  if (normalized.error) return airtableError(c, 422, normalized.error.type, normalized.error.message);

  const cells = replace ? (normalized.cells ?? {}) : { ...rec.cells, ...(normalized.cells ?? {}) };
  const updated = getAirtableStore(store).records.update(rec.id, { cells });
  return c.json(serialize(store, table, updated ?? rec, boolOf(body.returnFieldsByFieldId)));
}

function handleBatchUpdate(
  c: Context,
  store: Store,
  table: AirtableTable,
  body: Record<string, unknown>,
  replace: boolean,
): Response {
  const returnFieldIds = boolOf(body.returnFieldsByFieldId);
  const typecast = boolOf(body.typecast);

  if (!Array.isArray(body.records)) {
    return airtableError(
      c,
      422,
      "INVALID_REQUEST_MISSING_FIELDS",
      'Could not find field "records" in the request body',
    );
  }
  if (body.records.length > BATCH_LIMIT) {
    return airtableError(c, 422, "INVALID_REQUEST_BODY", `You may only update up to ${BATCH_LIMIT} records at a time`);
  }

  const upsert = readUpsert(body.performUpsert);
  if (upsert) return handleUpsert(c, store, table, body.records, upsert, typecast, returnFieldIds);

  const updated: AirtableRecordEntity[] = [];
  for (const item of body.records) {
    const id = readId(item);
    const incoming = readFieldsInput(item);
    if (!id || !incoming) {
      return airtableError(c, 422, "INVALID_REQUEST_BODY", "Each record must have an id and a fields object");
    }
    const rec = findRecord(store, table, id);
    if (!rec) return airtableNotFound(c);
    const normalized = normalizeWriteCells(store, table, incoming, typecast);
    if (normalized.error) return airtableError(c, 422, normalized.error.type, normalized.error.message);
    const cells = replace ? (normalized.cells ?? {}) : { ...rec.cells, ...(normalized.cells ?? {}) };
    const out = getAirtableStore(store).records.update(rec.id, { cells });
    if (out) updated.push(out);
  }
  return c.json({ records: updated.map((r) => serialize(store, table, r, returnFieldIds)) });
}

function readUpsert(value: unknown): { fieldsToMergeOn: string[] } | null {
  if (value && typeof value === "object" && "fieldsToMergeOn" in value && Array.isArray(value.fieldsToMergeOn)) {
    return { fieldsToMergeOn: value.fieldsToMergeOn.filter((f): f is string => typeof f === "string") };
  }
  return null;
}

function handleUpsert(
  c: Context,
  store: Store,
  table: AirtableTable,
  records: unknown[],
  upsert: { fieldsToMergeOn: string[] },
  typecast: boolean,
  returnFieldIds: boolean,
): Response {
  const mergeOn = upsert.fieldsToMergeOn;
  if (mergeOn.length === 0 || mergeOn.length > 3) {
    return airtableError(c, 422, "INVALID_REQUEST_BODY", "fieldsToMergeOn must contain between 1 and 3 fields");
  }
  const fields = tableFields(store, table.table_id);
  const mergeNames: string[] = [];
  for (const key of mergeOn) {
    const field = findField(fields, key);
    if (!field) return airtableError(c, 422, "UNKNOWN_FIELD_NAME", `Unknown field name: "${key}"`);
    mergeNames.push(field.name);
  }

  const out: AirtableRecordEntity[] = [];
  const createdRecords: string[] = [];
  const updatedRecords: string[] = [];

  for (const item of records) {
    const incoming = readFieldsInput(item);
    if (!incoming) {
      return airtableError(
        c,
        422,
        "INVALID_REQUEST_MISSING_FIELDS",
        'Could not find field "fields" in the request body',
      );
    }
    const normalized = normalizeWriteCells(store, table, incoming, typecast);
    if (normalized.error) return airtableError(c, 422, normalized.error.type, normalized.error.message);
    const cells = normalized.cells ?? {};

    const existing = getAirtableStore(store)
      .records.findBy("table_id", table.table_id)
      .find((rec) => mergeNames.every((name) => String(rec.cells[name] ?? "") === String(cells[name] ?? "")));

    if (existing) {
      const merged = getAirtableStore(store).records.update(existing.id, { cells: { ...existing.cells, ...cells } });
      if (merged) {
        out.push(merged);
        updatedRecords.push(merged.record_id);
      }
    } else {
      const rec = createRecord(store, table, cells);
      out.push(rec);
      createdRecords.push(rec.record_id);
    }
  }

  return c.json({
    records: out.map((r) => serialize(store, table, r, returnFieldIds)),
    createdRecords,
    updatedRecords,
  });
}
