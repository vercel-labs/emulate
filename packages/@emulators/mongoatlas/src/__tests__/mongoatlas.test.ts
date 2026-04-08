import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { mongoatlasPlugin, seedFromConfig, getMongoAtlasStore } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-api-key", { login: "admin", id: 1, scopes: [] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  mongoatlasPlugin.register(app as any, store, webhooks, base, tokenMap);
  mongoatlasPlugin.seed!(store, base);

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-api-key", "Content-Type": "application/json" };
}

describe("MongoAtlas plugin - Projects", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("lists projects", async () => {
    const res = await app.request(`${base}/api/atlas/v2/groups`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0].name).toBe("Project0");
  });

  it("creates a project", async () => {
    const res = await app.request(`${base}/api/atlas/v2/groups`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "NewProject" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.name).toBe("NewProject");
    expect(body.id).toBeDefined();
  });

  it("rejects duplicate project name", async () => {
    const res = await app.request(`${base}/api/atlas/v2/groups`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "Project0" }),
    });
    expect(res.status).toBe(409);
  });

  it("gets a project by ID", async () => {
    const listRes = await app.request(`${base}/api/atlas/v2/groups`, { headers: authHeaders() });
    const list = (await listRes.json()) as any;
    const groupId = list.results[0].id;

    const res = await app.request(`${base}/api/atlas/v2/groups/${groupId}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe("Project0");
  });

  it("deletes a project", async () => {
    // Create a project to delete
    const createRes = await app.request(`${base}/api/atlas/v2/groups`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "ToDelete" }),
    });
    const created = (await createRes.json()) as any;

    const res = await app.request(`${base}/api/atlas/v2/groups/${created.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(204);
  });
});

describe("MongoAtlas plugin - Clusters", () => {
  let app: Hono;
  let groupId: string;

  beforeEach(async () => {
    app = createTestApp().app;
    const listRes = await app.request(`${base}/api/atlas/v2/groups`, { headers: authHeaders() });
    const list = (await listRes.json()) as any;
    groupId = list.results[0].id;
  });

  it("lists clusters in a project", async () => {
    const res = await app.request(`${base}/api/atlas/v2/groups/${groupId}/clusters`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0].name).toBe("Cluster0");
  });

  it("gets a cluster by name", async () => {
    const res = await app.request(`${base}/api/atlas/v2/groups/${groupId}/clusters/Cluster0`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe("Cluster0");
    expect(body.stateName).toBe("IDLE");
    expect(body.connectionStrings).toBeDefined();
  });

  it("creates a cluster", async () => {
    const res = await app.request(`${base}/api/atlas/v2/groups/${groupId}/clusters`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "NewCluster", clusterType: "REPLICASET" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.name).toBe("NewCluster");
  });

  it("deletes a cluster", async () => {
    const res = await app.request(`${base}/api/atlas/v2/groups/${groupId}/clusters/Cluster0`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(204);
  });
});

describe("MongoAtlas plugin - Data API", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("inserts and finds a document", async () => {
    const insertRes = await app.request(`${base}/app/data-api/v1/action/insertOne`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "Cluster0",
        database: "test",
        collection: "items",
        document: { name: "Widget", price: 9.99 },
      }),
    });
    expect(insertRes.status).toBe(201);
    const inserted = (await insertRes.json()) as any;
    expect(inserted.insertedId).toBeDefined();

    const findRes = await app.request(`${base}/app/data-api/v1/action/findOne`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "Cluster0",
        database: "test",
        collection: "items",
        filter: { name: "Widget" },
      }),
    });
    expect(findRes.status).toBe(200);
    const found = (await findRes.json()) as any;
    expect(found.document.name).toBe("Widget");
    expect(found.document.price).toBe(9.99);
  });

  it("inserts many documents", async () => {
    const res = await app.request(`${base}/app/data-api/v1/action/insertMany`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "Cluster0",
        database: "test",
        collection: "items",
        documents: [{ name: "A" }, { name: "B" }, { name: "C" }],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.insertedIds.length).toBe(3);
  });

  it("finds multiple documents with filter", async () => {
    await app.request(`${base}/app/data-api/v1/action/insertMany`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "Cluster0",
        database: "test",
        collection: "items",
        documents: [
          { name: "A", price: 10 },
          { name: "B", price: 20 },
          { name: "C", price: 30 },
        ],
      }),
    });

    const res = await app.request(`${base}/app/data-api/v1/action/find`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "Cluster0",
        database: "test",
        collection: "items",
        filter: { price: { $gte: 20 } },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.documents.length).toBe(2);
  });

  it("updates a document", async () => {
    await app.request(`${base}/app/data-api/v1/action/insertOne`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "Cluster0",
        database: "test",
        collection: "items",
        document: { name: "ToUpdate", count: 1 },
      }),
    });

    const res = await app.request(`${base}/app/data-api/v1/action/updateOne`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "Cluster0",
        database: "test",
        collection: "items",
        filter: { name: "ToUpdate" },
        update: { $inc: { count: 5 } },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.matchedCount).toBe(1);
    expect(body.modifiedCount).toBe(1);

    const findRes = await app.request(`${base}/app/data-api/v1/action/findOne`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "Cluster0",
        database: "test",
        collection: "items",
        filter: { name: "ToUpdate" },
      }),
    });
    const found = (await findRes.json()) as any;
    expect(found.document.count).toBe(6);
  });

  it("upserts a document", async () => {
    const res = await app.request(`${base}/app/data-api/v1/action/updateOne`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "Cluster0",
        database: "test",
        collection: "items",
        filter: { name: "Upserted" },
        update: { $set: { name: "Upserted", value: 42 } },
        upsert: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.upsertedId).toBeDefined();
  });

  it("deletes a document", async () => {
    await app.request(`${base}/app/data-api/v1/action/insertOne`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "Cluster0",
        database: "test",
        collection: "items",
        document: { name: "ToDelete" },
      }),
    });

    const res = await app.request(`${base}/app/data-api/v1/action/deleteOne`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "Cluster0",
        database: "test",
        collection: "items",
        filter: { name: "ToDelete" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.deletedCount).toBe(1);
  });

  it("deletes many documents", async () => {
    await app.request(`${base}/app/data-api/v1/action/insertMany`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "Cluster0",
        database: "test",
        collection: "items",
        documents: [{ tag: "bulk" }, { tag: "bulk" }, { tag: "keep" }],
      }),
    });

    const res = await app.request(`${base}/app/data-api/v1/action/deleteMany`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "Cluster0",
        database: "test",
        collection: "items",
        filter: { tag: "bulk" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.deletedCount).toBe(2);
  });

  it("runs aggregate pipeline", async () => {
    await app.request(`${base}/app/data-api/v1/action/insertMany`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "Cluster0",
        database: "test",
        collection: "items",
        documents: [
          { category: "A", value: 10 },
          { category: "B", value: 20 },
          { category: "A", value: 30 },
        ],
      }),
    });

    const res = await app.request(`${base}/app/data-api/v1/action/aggregate`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "Cluster0",
        database: "test",
        collection: "items",
        pipeline: [{ $match: { category: "A" } }, { $count: "total" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.documents[0].total).toBe(2);
  });

  it("returns error for unknown cluster", async () => {
    const res = await app.request(`${base}/app/data-api/v1/action/find`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        dataSource: "NonExistent",
        database: "test",
        collection: "items",
      }),
    });
    expect(res.status).toBe(404);
  });
});

describe("MongoAtlas plugin - seedFromConfig", () => {
  it("seeds projects, clusters, users, and databases from config", () => {
    const store = new Store();
    const webhooks = new WebhookDispatcher();
    const app = new Hono();
    mongoatlasPlugin.register(app as any, store, webhooks, base);
    mongoatlasPlugin.seed!(store, base);

    seedFromConfig(store, base, {
      projects: [{ name: "CustomProject" }],
      clusters: [{ name: "CustomCluster", project: "CustomProject" }],
      database_users: [
        {
          username: "appuser",
          project: "CustomProject",
          roles: [{ database_name: "mydb", role_name: "readWrite" }],
        },
      ],
      databases: [
        {
          cluster: "CustomCluster",
          name: "mydb",
          collections: ["users", "orders"],
        },
      ],
    });

    const ms = getMongoAtlasStore(store);

    const projects = ms.projects.all();
    expect(projects.length).toBe(2); // Project0 + CustomProject

    const clusters = ms.clusters.all();
    expect(clusters.length).toBe(2); // Cluster0 + CustomCluster

    const users = ms.users.all();
    expect(users.length).toBe(2); // admin + appuser

    const databases = ms.databases.all();
    expect(databases.some((d) => d.name === "mydb")).toBe(true);

    const collections = ms.collections.all();
    expect(collections.some((c) => c.name === "users")).toBe(true);
    expect(collections.some((c) => c.name === "orders")).toBe(true);
  });
});
