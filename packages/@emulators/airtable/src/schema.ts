import type { Store } from "@emulators/core";
import { getAirtableStore } from "./store.js";
import type { AirtableBase, AirtableField, AirtableSelectChoice, AirtableTable } from "./entities.js";
import { generateFieldId } from "./ids.js";

// Field types Airtable computes; writes to them are silently ignored (not errors).
const COMPUTED_TYPES: Record<string, true> = {
  formula: true,
  rollup: true,
  count: true,
  lookup: true,
  multipleLookupValues: true,
  autoNumber: true,
  createdTime: true,
  lastModifiedTime: true,
  createdBy: true,
  lastModifiedBy: true,
  button: true,
  externalSyncSource: true,
};

const SELECT_TYPES: Record<string, true> = { singleSelect: true, multipleSelects: true };

export function resolveBase(store: Store, baseId: string): AirtableBase | undefined {
  return getAirtableStore(store).bases.findOneBy("base_id", baseId);
}

/** Resolve a table within a base by id first, then by name (both are valid in the URL). */
export function resolveTable(store: Store, baseId: string, tableIdOrName: string): AirtableTable | undefined {
  const s = getAirtableStore(store);
  const byId = s.tables.findOneBy("table_id", tableIdOrName);
  if (byId && byId.base_id === baseId) return byId;
  return s.tables.findBy("base_id", baseId).find((t) => t.name === tableIdOrName);
}

export function tableFields(store: Store, tableId: string): AirtableField[] {
  return getAirtableStore(store)
    .fields.findBy("table_id", tableId)
    .sort((a, b) => a.position - b.position);
}

export function findField(fields: AirtableField[], key: string): AirtableField | undefined {
  return fields.find((f) => f.field_id === key || f.name === key);
}

export interface NormalizeResult {
  cells?: Record<string, unknown>;
  error?: { type: string; message: string };
}

/**
 * Validate an incoming `fields` map (keyed by field name OR id) against the table
 * schema and return cells keyed by canonical field name. Unknown fields 422; writes
 * to computed fields are dropped; select choices are enforced unless `typecast` adds
 * the missing option.
 */
export function normalizeWriteCells(
  store: Store,
  table: AirtableTable,
  incoming: Record<string, unknown>,
  typecast: boolean,
): NormalizeResult {
  const fields = tableFields(store, table.table_id);
  const cells: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(incoming)) {
    const field = findField(fields, key);
    if (!field) {
      return { error: { type: "UNKNOWN_FIELD_NAME", message: `Unknown field name: "${key}"` } };
    }
    if (COMPUTED_TYPES[field.type]) {
      continue; // Airtable ignores writes to computed fields.
    }
    if (SELECT_TYPES[field.type] && value != null) {
      const check = applySelectChoice(store, field, value, typecast);
      if (check.error) return { error: check.error };
    }
    cells[field.name] = value;
  }

  return { cells };
}

function applySelectChoice(
  store: Store,
  field: AirtableField,
  value: unknown,
  typecast: boolean,
): { error?: { type: string; message: string } } {
  const options = field.options ?? {};
  const choices: AirtableSelectChoice[] = Array.isArray(options.choices) ? options.choices : [];
  const values = Array.isArray(value) ? value : [value];

  for (const v of values) {
    if (typeof v !== "string") continue;
    if (choices.some((c) => c.name === v)) continue;
    if (!typecast) {
      return {
        error: {
          type: "INVALID_MULTIPLE_CHOICE_OPTIONS",
          message: `Insufficient permissions to create new select option "${v}"`,
        },
      };
    }
    // typecast: add the new choice to the field's schema.
    choices.push({ id: generateFieldId().replace(/^fld/, "sel"), name: v });
  }

  if (typecast) {
    const s = getAirtableStore(store);
    s.fields.update(field.id, { options: { ...options, choices } });
  }
  return {};
}

export interface SerializeOptions {
  returnFieldsByFieldId?: boolean;
  fieldsSubset?: string[];
}

export interface SerializedRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

/** Shape a stored record for the API: `{ id, createdTime, fields }`, honoring
 * `fields[]` selection and `returnFieldsByFieldId`. Empty cells are omitted. */
export function serializeRecord(
  store: Store,
  table: AirtableTable,
  record: { record_id: string; created_time: string; cells: Record<string, unknown> },
  options: SerializeOptions = {},
): SerializedRecord {
  const fields = tableFields(store, table.table_id);
  const byName = new Map(fields.map((f) => [f.name, f]));

  let wanted: Set<string> | null = null;
  if (options.fieldsSubset && options.fieldsSubset.length > 0) {
    wanted = new Set();
    for (const key of options.fieldsSubset) {
      const field = findField(fields, key);
      if (field) wanted.add(field.name);
    }
  }

  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(record.cells)) {
    if (value === undefined || value === null || value === "") continue;
    if (wanted && !wanted.has(name)) continue;
    const field = byName.get(name);
    const key = options.returnFieldsByFieldId && field ? field.field_id : name;
    out[key] = value;
  }

  return { id: record.record_id, createdTime: record.created_time, fields: out };
}
