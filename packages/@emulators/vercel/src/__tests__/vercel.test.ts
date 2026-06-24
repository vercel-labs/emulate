import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { vercelPlugin, seedFromConfig } from "../index.js";
import { getVercelStore } from "../store.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "testuser", id: 1, scopes: ["user"] });

  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  vercelPlugin.register(app as any, store, webhooks, base, tokenMap);
  vercelPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ username: "testuser", email: "testuser@example.com" }],
  });

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token" };
}

function seedTestTeam(store: Store, slug = "test-team"): string {
  seedFromConfig(store, base, {
    teams: [{ slug, name: "Test Team" }],
  });
  const team = getVercelStore(store).teams.findOneBy("slug", slug);
  if (!team) throw new Error("Expected test team to be seeded");
  return team.uid;
}

describe("Vercel plugin integration", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("GET /v2/user returns the current user", async () => {
    const res = await app.request(`${base}/v2/user`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string; email: string } };
    expect(body.user).toBeDefined();
    expect(body.user.username).toBe("testuser");
    expect(body.user.email).toBe("testuser@example.com");
  });

  it("GET /v10/projects lists projects for the authenticated account", async () => {
    const res = await app.request(`${base}/v10/projects`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: unknown[]; pagination: unknown };
    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.pagination).toBeDefined();
  });

  it("POST /v11/projects creates a project", async () => {
    const name = `it-project-${Date.now()}`;
    const res = await app.request(`${base}/v11/projects`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { name: string; id: string };
    expect(body.name).toBe(name);
    expect(body.id).toBeDefined();
  });

  it("GET /v6/deployments returns deployments for the account", async () => {
    const res = await app.request(`${base}/v6/deployments`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deployments: unknown[]; pagination: unknown };
    expect(Array.isArray(body.deployments)).toBe(true);
    expect(body.pagination).toBeDefined();
  });

  it("GET /v1/integrations/configuration/:id returns 404 for unknown config", async () => {
    const { app: testApp, store } = createTestApp();
    const ownerId = seedTestTeam(store);

    const res = await testApp.request(`${base}/v1/integrations/configuration/icfg_unknown?teamId=${ownerId}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it("GET /v1/integrations/configuration/:id returns team-owned seeded configuration", async () => {
    const { app: testApp, store } = createTestApp();
    const ownerId = seedTestTeam(store);
    seedFromConfig(store, base, {
      integrations: [{ client_id: "test-app", client_secret: "secret", name: "test-integration", redirect_uris: [] }],
      integration_configurations: [
        {
          id: "icfg_test123",
          integrationId: "test-app",
          ownerId,
          projectSelection: "all",
          canConfigureOpenTelemetry: true,
        },
      ],
    });

    const res = await testApp.request(`${base}/v1/integrations/configuration/icfg_test123?teamId=${ownerId}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; projectSelection: string; canConfigureOpenTelemetry: boolean };
    expect(body.id).toBe("icfg_test123");
    expect(body.projectSelection).toBe("all");
    expect(body.canConfigureOpenTelemetry).toBe(true);
  });

  it("DELETE /v1/integrations/configuration/:id removes configuration", async () => {
    const { app: testApp, store } = createTestApp();
    const ownerId = seedTestTeam(store);
    seedFromConfig(store, base, {
      integration_configurations: [{ id: "icfg_delete_me", integrationId: "test-app", ownerId }],
    });

    const deleteRes = await testApp.request(`${base}/v1/integrations/configuration/icfg_delete_me?teamId=${ownerId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleteRes.status).toBe(204);

    const getRes = await testApp.request(`${base}/v1/integrations/configuration/icfg_delete_me?teamId=${ownerId}`, {
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(404);
  });

  it("GET /v1/integrations/configuration/:id returns 403 when slug scope cannot be resolved", async () => {
    const { app: testApp, store } = createTestApp();
    seedFromConfig(store, base, {
      integration_configurations: [{ id: "icfg_forbidden", integrationId: "test-app", ownerId: "team_abc" }],
    });

    const res = await testApp.request(`${base}/v1/integrations/configuration/icfg_forbidden?slug=missing-team`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });
});
