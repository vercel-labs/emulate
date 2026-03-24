import { type Store, type Collection } from "@internal/core";
import type {
  MongoAtlasCluster,
  MongoAtlasDatabase,
  MongoAtlasCollection,
  MongoAtlasDocument,
  MongoAtlasProject,
  MongoAtlasUser,
  MongoAtlasApiKey,
} from "./entities.js";

export interface MongoAtlasStore {
  clusters: Collection<MongoAtlasCluster>;
  databases: Collection<MongoAtlasDatabase>;
  collections: Collection<MongoAtlasCollection>;
  documents: Collection<MongoAtlasDocument>;
  projects: Collection<MongoAtlasProject>;
  users: Collection<MongoAtlasUser>;
  apiKeys: Collection<MongoAtlasApiKey>;
}

export function getMongoAtlasStore(store: Store): MongoAtlasStore {
  return {
    clusters: store.collection<MongoAtlasCluster>("mongoatlas.clusters", ["cluster_id", "name"]),
    databases: store.collection<MongoAtlasDatabase>("mongoatlas.databases", ["cluster_id", "name"]),
    collections: store.collection<MongoAtlasCollection>("mongoatlas.collections", ["cluster_id", "name"]),
    documents: store.collection<MongoAtlasDocument>("mongoatlas.documents", ["cluster_id", "doc_id"]),
    projects: store.collection<MongoAtlasProject>("mongoatlas.projects", ["group_id"]),
    users: store.collection<MongoAtlasUser>("mongoatlas.users", ["user_id", "username"]),
    apiKeys: store.collection<MongoAtlasApiKey>("mongoatlas.api_keys", ["public_key"]),
  };
}
