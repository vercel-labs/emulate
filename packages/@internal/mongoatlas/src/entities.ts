import type { Entity } from "@internal/core";

export interface MongoAtlasCluster extends Entity {
  cluster_id: string;
  name: string;
  group_id: string;
  state: "IDLE" | "CREATING" | "UPDATING" | "DELETING" | "DELETED" | "REPAIRING";
  mongo_uri: string;
  connection_strings: {
    standard: string;
    standard_srv: string;
  };
  provider_settings: {
    provider_name: string;
    instance_size_name: string;
    region_name: string;
  };
  cluster_type: "REPLICASET" | "SHARDED";
  disk_size_gb: number;
  mongodb_version: string;
}

export interface MongoAtlasDatabase extends Entity {
  cluster_id: string;
  name: string;
}

export interface MongoAtlasCollection extends Entity {
  cluster_id: string;
  database: string;
  name: string;
}

export interface MongoAtlasDocument extends Entity {
  cluster_id: string;
  database: string;
  collection: string;
  doc_id: string;
  data: Record<string, unknown>;
}

export interface MongoAtlasProject extends Entity {
  group_id: string;
  name: string;
  org_id: string;
  cluster_count: number;
}

export interface MongoAtlasUser extends Entity {
  user_id: string;
  username: string;
  group_id: string;
  roles: Array<{ database_name: string; role_name: string }>;
}
