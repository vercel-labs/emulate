import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user", "admin:org"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }],
    repos: [{ owner: "octocat", name: "hello-world" }],
  });

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): HeadersInit {
  return { Authorization: "Bearer test-token" };
}

describe("GitHub repos routes", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("lists repos for the authenticated user", async () => {
    const res = await app.request(`${base}/user/repos`, {
      method: "GET",
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it("returns a repo by owner/name", async () => {
    const res = await app.request(`${base}/repos/octocat/hello-world`, {
      method: "GET",
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { full_name: string; name: string };
    expect(body.full_name).toBe("octocat/hello-world");
    expect(body.name).toBe("hello-world");
  });

  it("creates a repo", async () => {
    const res = await app.request(`${base}/user/repos`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new-repo" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; full_name: string };
    expect(body.name).toBe("new-repo");
    expect(body.full_name).toBe("octocat/new-repo");
  });

  it("returns 404 when the repo does not exist", async () => {
    const res = await app.request(`${base}/repos/nonexistent/repo`, {
      method: "GET",
      headers: authHeaders(),
    });

    expect(res.status).toBe(404);
  });

  it("lists repos for a user", async () => {
    const res = await app.request(`${base}/users/octocat/repos`, {
      method: "GET",
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });
});
