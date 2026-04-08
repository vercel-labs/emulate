import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getMongoAtlasStore } from "./store.js";
import { generateClusterId, generateGroupId, generateUserId } from "./helpers.js";
import { dataApiRoutes } from "./routes/data-api.js";
import { adminRoutes } from "./routes/admin.js";

export { getMongoAtlasStore, type MongoAtlasStore } from "./store.js";
export * from "./entities.js";

export interface MongoAtlasSeedConfig {
  port?: number;
  projects?: Array<{
    name: string;
    org_id?: string;
  }>;
  clusters?: Array<{
    name: string;
    project: string;
    provider?: string;
    instance_size?: string;
    region?: string;
    disk_size_gb?: number;
    mongodb_version?: string;
  }>;
  database_users?: Array<{
    username: string;
    project: string;
    roles?: Array<{ database_name: string; role_name: string }>;
  }>;
  databases?: Array<{
    cluster: string;
    name: string;
    collections?: string[];
  }>;
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const ms = getMongoAtlasStore(store);

  const groupId = generateGroupId();
  ms.projects.insert({
    group_id: groupId,
    name: "Project0",
    org_id: "default_org",
    cluster_count: 1,
  });

  const clusterId = generateClusterId();
  ms.clusters.insert({
    cluster_id: clusterId,
    name: "Cluster0",
    group_id: groupId,
    state: "IDLE",
    mongo_uri: "mongodb+srv://Cluster0.emulate.mongodb.net",
    connection_strings: {
      standard: "mongodb://Cluster0.emulate.mongodb.net:27017",
      standard_srv: "mongodb+srv://Cluster0.emulate.mongodb.net",
    },
    provider_settings: {
      provider_name: "AWS",
      instance_size_name: "M10",
      region_name: "US_EAST_1",
    },
    cluster_type: "REPLICASET",
    disk_size_gb: 10,
    mongodb_version: "8.0",
  });

  ms.users.insert({
    user_id: generateUserId(),
    username: "admin",
    group_id: groupId,
    roles: [{ database_name: "admin", role_name: "atlasAdmin" }],
  });

  ms.databases.insert({ cluster_id: clusterId, name: "test" });
  ms.collections.insert({ cluster_id: clusterId, database: "test", name: "items" });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: MongoAtlasSeedConfig): void {
  const ms = getMongoAtlasStore(store);

  const projectIdMap = new Map<string, string>();

  if (config.projects) {
    for (const p of config.projects) {
      const existing = ms.projects.all().find((ep) => ep.name === p.name);
      if (existing) {
        projectIdMap.set(p.name, existing.group_id);
        continue;
      }

      const groupId = generateGroupId();
      ms.projects.insert({
        group_id: groupId,
        name: p.name,
        org_id: p.org_id ?? "default_org",
        cluster_count: 0,
      });
      projectIdMap.set(p.name, groupId);
    }
  }

  // Map default project
  const defaultProject = ms.projects.all()[0];
  if (defaultProject) {
    projectIdMap.set(defaultProject.name, defaultProject.group_id);
  }

  const clusterIdMap = new Map<string, string>();

  if (config.clusters) {
    for (const cl of config.clusters) {
      const groupId = projectIdMap.get(cl.project);
      if (!groupId) continue;

      const existing = ms.clusters.all().find((ec) => ec.group_id === groupId && ec.name === cl.name);
      if (existing) {
        clusterIdMap.set(cl.name, existing.cluster_id);
        continue;
      }

      const clusterId = generateClusterId();
      ms.clusters.insert({
        cluster_id: clusterId,
        name: cl.name,
        group_id: groupId,
        state: "IDLE",
        mongo_uri: `mongodb+srv://${cl.name}.emulate.mongodb.net`,
        connection_strings: {
          standard: `mongodb://${cl.name}.emulate.mongodb.net:27017`,
          standard_srv: `mongodb+srv://${cl.name}.emulate.mongodb.net`,
        },
        provider_settings: {
          provider_name: cl.provider ?? "AWS",
          instance_size_name: cl.instance_size ?? "M10",
          region_name: cl.region ?? "US_EAST_1",
        },
        cluster_type: "REPLICASET",
        disk_size_gb: cl.disk_size_gb ?? 10,
        mongodb_version: cl.mongodb_version ?? "8.0",
      });
      clusterIdMap.set(cl.name, clusterId);

      const project = ms.projects.findOneBy("group_id", groupId);
      if (project) {
        ms.projects.update(project.id, { cluster_count: project.cluster_count + 1 });
      }
    }
  }

  // Map default cluster
  const defaultCluster = ms.clusters.all()[0];
  if (defaultCluster) {
    clusterIdMap.set(defaultCluster.name, defaultCluster.cluster_id);
  }

  if (config.database_users) {
    for (const u of config.database_users) {
      const groupId = projectIdMap.get(u.project);
      if (!groupId) continue;

      const existing = ms.users.all().find((eu) => eu.group_id === groupId && eu.username === u.username);
      if (existing) continue;

      ms.users.insert({
        user_id: generateUserId(),
        username: u.username,
        group_id: groupId,
        roles: u.roles ?? [{ database_name: "admin", role_name: "readWriteAnyDatabase" }],
      });
    }
  }

  if (config.databases) {
    for (const db of config.databases) {
      const clusterId = clusterIdMap.get(db.cluster);
      if (!clusterId) continue;

      const existingDb = ms.databases.all().find((edb) => edb.cluster_id === clusterId && edb.name === db.name);
      if (!existingDb) {
        ms.databases.insert({ cluster_id: clusterId, name: db.name });
      }

      if (db.collections) {
        for (const colName of db.collections) {
          const existingCol = ms.collections
            .all()
            .find((ec) => ec.cluster_id === clusterId && ec.database === db.name && ec.name === colName);
          if (!existingCol) {
            ms.collections.insert({ cluster_id: clusterId, database: db.name, name: colName });
          }
        }
      }
    }
  }
}

export const mongoatlasPlugin: ServicePlugin = {
  name: "mongoatlas",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    adminRoutes(ctx);
    dataApiRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default mongoatlasPlugin;
