import type { Store } from "@emulators/core";
import { getAirtableStore } from "./store.js";
import type { AirtableFieldOptions, AirtableViewSort } from "./entities.js";
import {
  generateBaseId,
  generateFieldId,
  generateRecordId,
  generateTableId,
  generateUserId,
  generateViewId,
} from "./ids.js";
import { findField, tableFields } from "./schema.js";

export interface AirtableSeedField {
  id?: string;
  name: string;
  type?: string;
  options?: AirtableFieldOptions;
}

export interface AirtableSeedView {
  id?: string;
  name: string;
  type?: string;
  filter?: string;
  sort?: AirtableViewSort[];
  fields?: string[];
}

export type AirtableSeedRecord = Record<string, unknown> | { id?: string; fields: Record<string, unknown> };

export interface AirtableSeedTable {
  id?: string;
  name: string;
  description?: string;
  primary_field?: string;
  fields?: AirtableSeedField[];
  views?: AirtableSeedView[];
  records?: AirtableSeedRecord[];
}

export interface AirtableSeedBase {
  id?: string;
  name: string;
  permission_level?: string;
  tables?: AirtableSeedTable[];
}

export interface AirtableSeedUser {
  id?: string;
  email?: string;
  name?: string;
  scopes?: string[];
}

export interface AirtableSeedConfig {
  user?: AirtableSeedUser;
  bases?: AirtableSeedBase[];
  baseUrl?: string;
}

const DEFAULT_SCOPES = ["data.records:read", "data.records:write", "schema.bases:read"];

function inferFieldType(value: unknown): string {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "checkbox";
  if (Array.isArray(value)) return "multipleSelects";
  return "singleLineText";
}

function recordFieldsOf(record: AirtableSeedRecord): { id?: string; fields: Record<string, unknown> } {
  if (record && typeof record === "object" && "fields" in record) {
    const fieldsValue: unknown = record.fields;
    if (fieldsValue && typeof fieldsValue === "object" && !Array.isArray(fieldsValue)) {
      const id = "id" in record && typeof record.id === "string" ? record.id : undefined;
      // Narrowed to a non-array object above; it is the record's cell map.
      const fields = fieldsValue as Record<string, unknown>;
      return { id, fields };
    }
  }
  // Bare-map form: the record object itself is the cell map.
  const bare: Record<string, unknown> = record;
  return { fields: bare };
}

export function ensureUser(store: Store, user?: AirtableSeedUser) {
  const s = getAirtableStore(store);
  const email = user?.email ?? "dev@example.com";
  const existing = s.users.findOneBy("email", email);
  if (existing) return existing;
  return s.users.insert({
    user_id: user?.id ?? generateUserId(),
    email,
    name: user?.name,
    scopes: user?.scopes ?? DEFAULT_SCOPES,
  });
}

function seedTable(store: Store, baseId: string, table: AirtableSeedTable): void {
  const s = getAirtableStore(store);
  const tableId = table.id ?? generateTableId();

  // Explicit fields, or inferred from the first record that carries each key.
  const declared = table.fields ?? [];
  const inferred: AirtableSeedField[] = [];
  if (declared.length === 0 && table.records && table.records.length > 0) {
    const seen: Record<string, true> = {};
    for (const record of table.records) {
      const { fields } = recordFieldsOf(record);
      for (const [key, value] of Object.entries(fields)) {
        if (seen[key]) continue;
        seen[key] = true;
        inferred.push({ name: key, type: inferFieldType(value) });
      }
    }
  }
  const fieldSpecs = declared.length > 0 ? declared : inferred;

  let position = 0;
  let primaryFieldId: string | undefined;
  for (const spec of fieldSpecs) {
    const fieldId = spec.id ?? generateFieldId();
    if (position === 0) primaryFieldId = fieldId;
    s.fields.insert({
      table_id: tableId,
      field_id: fieldId,
      name: spec.name,
      type: spec.type ?? "singleLineText",
      options: spec.options ?? null,
      position: position++,
    });
  }

  const fields = tableFields(store, tableId);
  if (table.primary_field) {
    const primary = findField(fields, table.primary_field);
    if (primary) primaryFieldId = primary.field_id;
  }

  s.tables.insert({
    base_id: baseId,
    table_id: tableId,
    name: table.name,
    primary_field_id: primaryFieldId ?? "",
    description: table.description ?? null,
  });

  for (const view of table.views ?? []) {
    s.views.insert({
      table_id: tableId,
      view_id: view.id ?? generateViewId(),
      name: view.name,
      type: view.type ?? "grid",
      filter: view.filter ?? null,
      sort: view.sort ?? null,
      fields: view.fields ?? null,
    });
  }

  for (const record of table.records ?? []) {
    const { id, fields: rawFields } = recordFieldsOf(record);
    const cells: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawFields)) {
      const field = findField(fields, key);
      cells[field ? field.name : key] = value;
    }
    s.records.insert({
      base_id: baseId,
      table_id: tableId,
      record_id: id ?? generateRecordId(),
      cells,
      created_time: new Date().toISOString(),
    });
  }
}

export function seedFromConfig(store: Store, _baseUrl: string, config: AirtableSeedConfig): void {
  ensureUser(store, config.user);
  const s = getAirtableStore(store);
  for (const base of config.bases ?? []) {
    const baseId = base.id ?? generateBaseId();
    s.bases.insert({
      base_id: baseId,
      name: base.name,
      permission_level: base.permission_level ?? "create",
    });
    for (const table of base.tables ?? []) {
      seedTable(store, baseId, table);
    }
  }
}

// Deterministic default so zero-config `--service airtable` is explorable and
// `reset()` is stable (fixed ids across replays).
export function seedDefaults(store: Store): void {
  if (getAirtableStore(store).bases.all().length > 0) return;
  ensureUser(store, { id: "usrLocalDevAccount", email: "dev@example.com", name: "Local Developer" });
  seedFromConfig(store, "", {
    bases: [
      {
        id: "appEmulateExample1",
        name: "Example Base",
        tables: [
          {
            id: "tblExampleTasks01",
            name: "Tasks",
            fields: [
              { id: "fldExampleTaskName", name: "Name", type: "singleLineText" },
              {
                id: "fldExampleTaskStat",
                name: "Status",
                type: "singleSelect",
                options: {
                  choices: [
                    { id: "selTodo000000001", name: "Todo" },
                    { id: "selDoing00000001", name: "Doing" },
                    { id: "selDone000000001", name: "Done" },
                  ],
                },
              },
              { id: "fldExampleTaskDone", name: "Done", type: "checkbox" },
            ],
            views: [{ id: "viwExampleTasksAll", name: "All Tasks", type: "grid" }],
            records: [
              {
                id: "recExampleTask0001",
                fields: { Name: "Ship the Airtable emulator", Status: "Doing", Done: false },
              },
              { id: "recExampleTask0002", fields: { Name: "Write conformance tests", Status: "Todo", Done: false } },
            ],
          },
        ],
      },
    ],
  });
}
