import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { vercelPlugin, seedFromConfig } from "../index.js";

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

function authHeaders(): HeadersInit {
  return { Authorization: "Bearer test-token" };
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
});
