import { describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const seed = {
  users: [{ login: "octocat" }],
  repos: [{ owner: "octocat", name: "graph" }],
  labels: [{ key: "bug", repo: "octocat/graph", name: "bug", color: "b60205" }],
  issues: [
    { key: "canonical", repo: "octocat/graph", number: 7, title: "Canonical" },
    {
      key: "duplicate",
      repo: "octocat/graph",
      number: 42,
      title: "Duplicate",
      state: "closed" as const,
      state_reason: "duplicate" as const,
      duplicate_of: "canonical",
      labels: ["bug"],
      comments: [{ key: "first-comment", body: "Seeded comment" }],
    },
  ],
};

function appFor(config = seed) {
  const store = new Store();
  const tokens: TokenMap = new Map([["token", { login: "octocat", id: 1, scopes: ["repo", "user"] }]]);
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokens));
  githubPlugin.register(app as any, store, new WebhookDispatcher(), base, tokens);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, config);
  return { app, store };
}

describe("stable issue graph seeds", () => {
  it("exposes seeded labels, lifecycle, comments, and stable numbers through REST", async () => {
    const { app } = appFor();
    const response = await app.request(`${base}/repos/octocat/graph/issues/42`, {
      headers: { Authorization: "Bearer token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      number: 42,
      state_reason: "duplicate",
      duplicate_issue_id: expect.any(Number),
      labels: [{ name: "bug" }],
      comments: 1,
    });
    const graph = await app.request(`${base}/graphql`, {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{ repository(owner: "octocat", name: "graph") { issue(number: 42) { state stateReason duplicateOf { number } comments { totalCount } } } }`,
      }),
    });
    expect(graph.status).toBe(200);
    expect(await graph.json()).toMatchObject({
      data: {
        repository: {
          issue: { state: "CLOSED", stateReason: "DUPLICATE", duplicateOf: { number: 7 }, comments: { totalCount: 1 } },
        },
      },
    });
  });

  it("rolls back the complete store when a late graph reference is invalid", () => {
    const { store } = appFor();
    const before = JSON.stringify(store.snapshot());
    expect(() =>
      seedFromConfig(store, base, {
        ...seed,
        comments: [{ key: "bad", repo: "octocat/graph", issue: "missing", body: "bad" }],
      }),
    ).toThrow();
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });
});
