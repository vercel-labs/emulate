import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
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

  return app;
}

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token" };
}

describe("GitHub checks routes", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  it("lists a check run and suite by their created head SHA", async () => {
    const headSha = "a".repeat(40);
    const createRes = await app.request(`${base}/repos/octocat/hello-world/check-runs`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test", head_sha: headSha }),
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: number; head_sha: string };
    expect(created.head_sha).toBe(headSha);

    const runsRes = await app.request(`${base}/repos/octocat/hello-world/commits/${headSha}/check-runs`, {
      headers: authHeaders(),
    });

    expect(runsRes.status).toBe(200);
    const runs = (await runsRes.json()) as {
      total_count: number;
      check_runs: Array<{ id: number; head_sha: string }>;
    };
    expect(runs).toEqual({
      total_count: 1,
      check_runs: [expect.objectContaining({ id: created.id, head_sha: headSha })],
    });

    const suitesRes = await app.request(`${base}/repos/octocat/hello-world/commits/${headSha}/check-suites`, {
      headers: authHeaders(),
    });

    expect(suitesRes.status).toBe(200);
    const suites = (await suitesRes.json()) as {
      total_count: number;
      check_suites: Array<{ head_sha: string }>;
    };
    expect(suites).toEqual({
      total_count: 1,
      check_suites: [expect.objectContaining({ head_sha: headSha })],
    });
  });

  it("returns 404 for a head SHA unknown to the repository and checks subsystem", async () => {
    const headSha = "b".repeat(40);

    const runsRes = await app.request(`${base}/repos/octocat/hello-world/commits/${headSha}/check-runs`, {
      headers: authHeaders(),
    });
    expect(runsRes.status).toBe(404);

    const suitesRes = await app.request(`${base}/repos/octocat/hello-world/commits/${headSha}/check-suites`, {
      headers: authHeaders(),
    });
    expect(suitesRes.status).toBe(404);
  });
});
