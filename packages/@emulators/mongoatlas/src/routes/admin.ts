import type { RouteContext } from "@emulators/core";
import { getMongoAtlasStore } from "../store.js";
import { generateClusterId, generateGroupId, generateUserId, mongoOk, mongoError } from "../helpers.js";

/**
 * MongoDB Atlas Admin API endpoints.
 * These emulate the Atlas Administration API v2 for managing projects, clusters, and users.
 * See: https://www.mongodb.com/docs/atlas/reference/api-resources-spec/v2/
 */
export function adminRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ms = () => getMongoAtlasStore(store);

  // --- Projects ---

  // List projects
  app.get("/api/atlas/v2/groups", (c) => {
    const projects = ms().projects.all();
    return mongoOk(c, {
      results: projects.map(formatProject),
      totalCount: projects.length,
    });
  });

  // Get project by ID
  app.get("/api/atlas/v2/groups/:groupId", (c) => {
    const groupId = c.req.param("groupId");
    const project = ms().projects.findOneBy("group_id", groupId);
    if (!project) {
      return mongoError(c, "GROUP_NOT_FOUND", `Group '${groupId}' not found.`, 404);
    }
    return mongoOk(c, formatProject(project));
  });

  // Create project
  app.post("/api/atlas/v2/groups", async (c) => {
    const body = await c.req.json<{ name?: string; orgId?: string }>();
    if (!body.name?.trim()) {
      return mongoError(c, "INVALID_PARAMETER", "name is required");
    }

    const existing = ms()
      .projects.all()
      .find((p) => p.name === body.name);
    if (existing) {
      return mongoError(c, "DUPLICATE_GROUP_NAME", `Group name '${body.name}' already exists.`, 409);
    }

    const groupId = generateGroupId();
    const project = ms().projects.insert({
      group_id: groupId,
      name: body.name,
      org_id: body.orgId ?? "default_org",
      cluster_count: 0,
    });

    return mongoOk(c, formatProject(project), 201);
  });

  // Delete project
  app.delete("/api/atlas/v2/groups/:groupId", (c) => {
    const groupId = c.req.param("groupId");
    const project = ms().projects.findOneBy("group_id", groupId);
    if (!project) {
      return mongoError(c, "GROUP_NOT_FOUND", `Group '${groupId}' not found.`, 404);
    }

    // Cascade delete clusters in this project
    const clusters = ms()
      .clusters.all()
      .filter((cl) => cl.group_id === groupId);
    for (const cluster of clusters) {
      deleteClusterData(ms, cluster.cluster_id);
      ms().clusters.delete(cluster.id);
    }

    ms().projects.delete(project.id);
    return c.body(null, 204);
  });

  // --- Clusters ---

  // List clusters
  app.get("/api/atlas/v2/groups/:groupId/clusters", (c) => {
    const groupId = c.req.param("groupId");
    const project = ms().projects.findOneBy("group_id", groupId);
    if (!project) {
      return mongoError(c, "GROUP_NOT_FOUND", `Group '${groupId}' not found.`, 404);
    }

    const clusters = ms()
      .clusters.all()
      .filter((cl) => cl.group_id === groupId);
    return mongoOk(c, {
      results: clusters.map(formatCluster),
      totalCount: clusters.length,
    });
  });

  // Get cluster
  app.get("/api/atlas/v2/groups/:groupId/clusters/:clusterName", (c) => {
    const groupId = c.req.param("groupId");
    const clusterName = c.req.param("clusterName");
    const cluster = ms()
      .clusters.all()
      .find((cl) => cl.group_id === groupId && cl.name === clusterName);

    if (!cluster) {
      return mongoError(c, "CLUSTER_NOT_FOUND", `Cluster '${clusterName}' not found.`, 404);
    }

    return mongoOk(c, formatCluster(cluster));
  });

  // Create cluster
  app.post("/api/atlas/v2/groups/:groupId/clusters", async (c) => {
    const groupId = c.req.param("groupId");
    const project = ms().projects.findOneBy("group_id", groupId);
    if (!project) {
      return mongoError(c, "GROUP_NOT_FOUND", `Group '${groupId}' not found.`, 404);
    }

    const body = await c.req.json<{
      name?: string;
      clusterType?: "REPLICASET" | "SHARDED";
      providerSettings?: {
        providerName?: string;
        instanceSizeName?: string;
        regionName?: string;
      };
      diskSizeGB?: number;
      mongoDBMajorVersion?: string;
    }>();

    if (!body.name?.trim()) {
      return mongoError(c, "INVALID_PARAMETER", "name is required");
    }

    const existing = ms()
      .clusters.all()
      .find((cl) => cl.group_id === groupId && cl.name === body.name);
    if (existing) {
      return mongoError(c, "DUPLICATE_CLUSTER_NAME", `Cluster '${body.name}' already exists.`, 409);
    }

    const clusterId = generateClusterId();
    const cluster = ms().clusters.insert({
      cluster_id: clusterId,
      name: body.name,
      group_id: groupId,
      state: "IDLE",
      mongo_uri: `mongodb+srv://${body.name}.emulate.mongodb.net`,
      connection_strings: {
        standard: `mongodb://${body.name}.emulate.mongodb.net:27017`,
        standard_srv: `mongodb+srv://${body.name}.emulate.mongodb.net`,
      },
      provider_settings: {
        provider_name: body.providerSettings?.providerName ?? "AWS",
        instance_size_name: body.providerSettings?.instanceSizeName ?? "M10",
        region_name: body.providerSettings?.regionName ?? "US_EAST_1",
      },
      cluster_type: body.clusterType ?? "REPLICASET",
      disk_size_gb: body.diskSizeGB ?? 10,
      mongodb_version: body.mongoDBMajorVersion ?? "8.0",
    });

    ms().projects.update(project.id, { cluster_count: project.cluster_count + 1 });

    return mongoOk(c, formatCluster(cluster), 201);
  });

  // Update cluster
  app.patch("/api/atlas/v2/groups/:groupId/clusters/:clusterName", async (c) => {
    const groupId = c.req.param("groupId");
    const clusterName = c.req.param("clusterName");
    const cluster = ms()
      .clusters.all()
      .find((cl) => cl.group_id === groupId && cl.name === clusterName);

    if (!cluster) {
      return mongoError(c, "CLUSTER_NOT_FOUND", `Cluster '${clusterName}' not found.`, 404);
    }

    const body = await c.req.json<{
      providerSettings?: {
        instanceSizeName?: string;
        regionName?: string;
      };
      diskSizeGB?: number;
    }>();

    const updates: Partial<typeof cluster> = {};
    if (body.providerSettings) {
      updates.provider_settings = {
        provider_name: cluster.provider_settings.provider_name,
        instance_size_name: body.providerSettings.instanceSizeName ?? cluster.provider_settings.instance_size_name,
        region_name: body.providerSettings.regionName ?? cluster.provider_settings.region_name,
      };
    }
    if (body.diskSizeGB !== undefined) {
      updates.disk_size_gb = body.diskSizeGB;
    }

    const updated = ms().clusters.update(cluster.id, updates);
    return mongoOk(c, formatCluster(updated!));
  });

  // Delete cluster
  app.delete("/api/atlas/v2/groups/:groupId/clusters/:clusterName", (c) => {
    const groupId = c.req.param("groupId");
    const clusterName = c.req.param("clusterName");
    const cluster = ms()
      .clusters.all()
      .find((cl) => cl.group_id === groupId && cl.name === clusterName);

    if (!cluster) {
      return mongoError(c, "CLUSTER_NOT_FOUND", `Cluster '${clusterName}' not found.`, 404);
    }

    deleteClusterData(ms, cluster.cluster_id);
    ms().clusters.delete(cluster.id);

    const project = ms().projects.findOneBy("group_id", groupId);
    if (project) {
      ms().projects.update(project.id, { cluster_count: Math.max(0, project.cluster_count - 1) });
    }

    return c.body(null, 204);
  });

  // --- Database Users ---

  // List database users
  app.get("/api/atlas/v2/groups/:groupId/databaseUsers", (c) => {
    const groupId = c.req.param("groupId");
    const users = ms()
      .users.all()
      .filter((u) => u.group_id === groupId);
    return mongoOk(c, {
      results: users.map(formatUser),
      totalCount: users.length,
    });
  });

  // Get database user
  app.get("/api/atlas/v2/groups/:groupId/databaseUsers/admin/:username", (c) => {
    const groupId = c.req.param("groupId");
    const username = c.req.param("username");
    const user = ms()
      .users.all()
      .find((u) => u.group_id === groupId && u.username === username);

    if (!user) {
      return mongoError(c, "USER_NOT_FOUND", `Database user '${username}' not found.`, 404);
    }

    return mongoOk(c, formatUser(user));
  });

  // Create database user
  app.post("/api/atlas/v2/groups/:groupId/databaseUsers", async (c) => {
    const groupId = c.req.param("groupId");
    const body = await c.req.json<{
      username?: string;
      password?: string;
      databaseName?: string;
      roles?: Array<{ databaseName: string; roleName: string }>;
    }>();

    if (!body.username?.trim()) {
      return mongoError(c, "INVALID_PARAMETER", "username is required");
    }

    const existing = ms()
      .users.all()
      .find((u) => u.group_id === groupId && u.username === body.username);
    if (existing) {
      return mongoError(c, "DUPLICATE_USER", `User '${body.username}' already exists.`, 409);
    }

    const userId = generateUserId();
    const user = ms().users.insert({
      user_id: userId,
      username: body.username,
      group_id: groupId,
      roles: (body.roles ?? []).map((r) => ({ database_name: r.databaseName, role_name: r.roleName })),
    });

    return mongoOk(c, formatUser(user), 201);
  });

  // Delete database user
  app.delete("/api/atlas/v2/groups/:groupId/databaseUsers/admin/:username", (c) => {
    const groupId = c.req.param("groupId");
    const username = c.req.param("username");
    const user = ms()
      .users.all()
      .find((u) => u.group_id === groupId && u.username === username);

    if (!user) {
      return mongoError(c, "USER_NOT_FOUND", `Database user '${username}' not found.`, 404);
    }

    ms().users.delete(user.id);
    return c.body(null, 204);
  });

  // --- Databases & Collections (Data Explorer) ---

  // List databases in a cluster
  app.get("/api/atlas/v2/groups/:groupId/clusters/:clusterName/databases", (c) => {
    const groupId = c.req.param("groupId");
    const clusterName = c.req.param("clusterName");
    const cluster = ms()
      .clusters.all()
      .find((cl) => cl.group_id === groupId && cl.name === clusterName);

    if (!cluster) {
      return mongoError(c, "CLUSTER_NOT_FOUND", `Cluster '${clusterName}' not found.`, 404);
    }

    const databases = ms()
      .databases.all()
      .filter((db) => db.cluster_id === cluster.cluster_id);
    return mongoOk(c, {
      results: databases.map((db) => ({ databaseName: db.name })),
      totalCount: databases.length,
    });
  });

  // List collections in a database
  app.get("/api/atlas/v2/groups/:groupId/clusters/:clusterName/databases/:databaseName/collections", (c) => {
    const groupId = c.req.param("groupId");
    const clusterName = c.req.param("clusterName");
    const databaseName = c.req.param("databaseName");
    const cluster = ms()
      .clusters.all()
      .find((cl) => cl.group_id === groupId && cl.name === clusterName);

    if (!cluster) {
      return mongoError(c, "CLUSTER_NOT_FOUND", `Cluster '${clusterName}' not found.`, 404);
    }

    const collections = ms()
      .collections.all()
      .filter((col) => col.cluster_id === cluster.cluster_id && col.database === databaseName);
    return mongoOk(c, {
      results: collections.map((col) => ({ collectionName: col.name, databaseName })),
      totalCount: collections.length,
    });
  });
}

function deleteClusterData(ms: () => ReturnType<typeof getMongoAtlasStore>, clusterId: string): void {
  const docs = ms()
    .documents.all()
    .filter((d) => d.cluster_id === clusterId);
  for (const doc of docs) ms().documents.delete(doc.id);

  const cols = ms()
    .collections.all()
    .filter((col) => col.cluster_id === clusterId);
  for (const col of cols) ms().collections.delete(col.id);

  const dbs = ms()
    .databases.all()
    .filter((db) => db.cluster_id === clusterId);
  for (const db of dbs) ms().databases.delete(db.id);
}

function formatProject(p: {
  group_id: string;
  name: string;
  org_id: string;
  cluster_count: number;
  created_at: string;
}) {
  return {
    id: p.group_id,
    name: p.name,
    orgId: p.org_id,
    clusterCount: p.cluster_count,
    created: p.created_at,
  };
}

function formatCluster(cl: {
  cluster_id: string;
  name: string;
  group_id: string;
  state: string;
  mongo_uri: string;
  connection_strings: { standard: string; standard_srv: string };
  provider_settings: { provider_name: string; instance_size_name: string; region_name: string };
  cluster_type: string;
  disk_size_gb: number;
  mongodb_version: string;
  created_at: string;
}) {
  return {
    id: cl.cluster_id,
    name: cl.name,
    groupId: cl.group_id,
    stateName: cl.state,
    mongoURI: cl.mongo_uri,
    connectionStrings: {
      standard: cl.connection_strings.standard,
      standardSrv: cl.connection_strings.standard_srv,
    },
    providerSettings: {
      providerName: cl.provider_settings.provider_name,
      instanceSizeName: cl.provider_settings.instance_size_name,
      regionName: cl.provider_settings.region_name,
    },
    clusterType: cl.cluster_type,
    diskSizeGB: cl.disk_size_gb,
    mongoDBVersion: cl.mongodb_version,
    created: cl.created_at,
  };
}

function formatUser(u: {
  user_id: string;
  username: string;
  group_id: string;
  roles: Array<{ database_name: string; role_name: string }>;
}) {
  return {
    username: u.username,
    groupId: u.group_id,
    databaseName: "admin",
    roles: u.roles.map((r) => ({ databaseName: r.database_name, roleName: r.role_name })),
  };
}
