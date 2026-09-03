import type { Entity } from "@emulators/core";

/**
 * Airtable is the first schema-defined service: bases, tables, fields, and views
 * are user data, and the Data API validates records against them. Each entity keeps
 * the kernel's numeric `id` internal and carries the real Airtable string id
 * (`app…`/`tbl…`/`fld…`/`viw…`/`rec…`) as an indexed field, mirroring Linear's
 * `linear_id` pattern.
 */

export interface AirtableBase extends Entity {
  base_id: string;
  name: string;
  permission_level: string;
}

export interface AirtableSelectChoice {
  id: string;
  name: string;
  color?: string;
}

export interface AirtableFieldOptions {
  choices?: AirtableSelectChoice[];
  [key: string]: unknown;
}

export interface AirtableField extends Entity {
  table_id: string;
  field_id: string;
  name: string;
  type: string;
  options?: AirtableFieldOptions | null;
  position: number;
}

export interface AirtableViewSort {
  field: string;
  direction?: "asc" | "desc";
}

export interface AirtableView extends Entity {
  table_id: string;
  view_id: string;
  name: string;
  type: string;
  // Seeded, not discoverable: the public schema API never returns a view's
  // filter/sort/hidden-field config, so applying `view=` requires seeding it.
  filter?: string | null;
  sort?: AirtableViewSort[] | null;
  fields?: string[] | null;
}

export interface AirtableTable extends Entity {
  base_id: string;
  table_id: string;
  name: string;
  primary_field_id: string;
  description?: string | null;
}

export interface AirtableRecordEntity extends Entity {
  base_id: string;
  table_id: string;
  record_id: string;
  // Cell values keyed by canonical field name. Computed fields hold their
  // stored/seeded value (never recomputed); linked fields hold record-id arrays.
  cells: Record<string, unknown>;
  created_time: string;
}

export interface AirtableCommentAuthor {
  id: string;
  email: string;
  name?: string;
}

export interface AirtableMention {
  type: string;
  id: string;
  displayName?: string;
  email?: string;
}

export interface AirtableComment extends Entity {
  comment_id: string;
  record_id: string;
  text: string;
  author: AirtableCommentAuthor;
  created_time: string;
  last_updated_time?: string | null;
  mentioned?: Record<string, AirtableMention> | null;
}

export interface AirtableUser extends Entity {
  user_id: string;
  email: string;
  name?: string;
  scopes: string[];
}
