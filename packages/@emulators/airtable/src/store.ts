import { Store, type Collection } from "@emulators/core";
import type {
  AirtableBase,
  AirtableComment,
  AirtableField,
  AirtableRecordEntity,
  AirtableTable,
  AirtableUser,
  AirtableView,
} from "./entities.js";

export interface AirtableStore {
  bases: Collection<AirtableBase>;
  tables: Collection<AirtableTable>;
  fields: Collection<AirtableField>;
  views: Collection<AirtableView>;
  records: Collection<AirtableRecordEntity>;
  comments: Collection<AirtableComment>;
  users: Collection<AirtableUser>;
}

export function getAirtableStore(store: Store): AirtableStore {
  return {
    bases: store.collection<AirtableBase>("airtable.bases", ["base_id"]),
    tables: store.collection<AirtableTable>("airtable.tables", ["base_id", "table_id", "name"]),
    fields: store.collection<AirtableField>("airtable.fields", ["table_id", "field_id", "name"]),
    views: store.collection<AirtableView>("airtable.views", ["table_id", "view_id"]),
    records: store.collection<AirtableRecordEntity>("airtable.records", ["base_id", "table_id", "record_id"]),
    comments: store.collection<AirtableComment>("airtable.comments", ["record_id", "comment_id"]),
    users: store.collection<AirtableUser>("airtable.users", ["user_id", "email"]),
  };
}
