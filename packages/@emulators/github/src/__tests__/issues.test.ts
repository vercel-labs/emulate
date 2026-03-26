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

describe("GitHub issues routes", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("creates an issue", async () => {
    const res = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test issue" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { title: string; number: number };
    expect(body.title).toBe("Test issue");
    expect(body.number).toBe(1);
  });

  it("lists issues", async () => {
    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Listed issue" }),
    });

    const res = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "GET",
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("gets an issue by number", async () => {
    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Issue one" }),
    });

    const res = await app.request(`${base}/repos/octocat/hello-world/issues/1`, {
      method: "GET",
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { number: number; title: string };
    expect(body.number).toBe(1);
    expect(body.title).toBe("Issue one");
  });

  it("updates an issue", async () => {
    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Original" }),
    });

    const res = await app.request(`${base}/repos/octocat/hello-world/issues/1`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated title" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("Updated title");
  });
});
