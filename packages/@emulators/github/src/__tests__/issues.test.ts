import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";

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

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token" };
}

describe("GitHub issues routes", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const testApp = createTestApp();
    app = testApp.app;
    store = testApp.store;
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

  it("does not create labels when a duplicate transition is rejected", async () => {
    const createResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Issue with rejected transition" }),
    });
    expect(createResponse.status).toBe(201);
    const issue = (await createResponse.json()) as { number: number };
    const gh = getGitHubStore(store);
    const before = JSON.stringify(store.snapshot());

    const response = await app.request(`${base}/repos/octocat/hello-world/issues/${issue.number}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed", state_reason: "duplicate", labels: ["created-after-validation"] }),
    });

    expect(response.status).toBe(422);
    const afterIssue = await app.request(`${base}/repos/octocat/hello-world/issues/${issue.number}`, {
      headers: authHeaders(),
    });
    expect(await afterIssue.json()).toMatchObject({ state: "open", state_reason: null });
    expect(gh.labels.count()).toBe(0);
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });
});
