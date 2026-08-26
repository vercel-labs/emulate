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
import { githubPlugin, seedFromConfig, type GitHubSeedConfig } from "../index.js";

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

function appFor(config: GitHubSeedConfig = seed) {
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

  it("accumulates comments and keeps dependency pairs distinct", async () => {
    const config: GitHubSeedConfig = {
      ...seed,
      issues: [
        {
          key: "a",
          repo: "octocat/graph",
          number: 1,
          title: "A",
          comments: [
            { key: "a1", body: "one" },
            { key: "a2", body: "two" },
          ],
        },
        { key: "b", repo: "octocat/graph", number: 2, title: "B" },
        { key: "c", repo: "octocat/graph", number: 3, title: "C" },
      ],
      dependencies: [
        { blocked: "a", blocking: "b" },
        { blocked: "a", blocking: "c" },
      ],
    };
    const { app } = appFor(config);
    const issue = await app.request(`${base}/repos/octocat/graph/issues/1`, {
      headers: { Authorization: "Bearer token" },
    });
    expect(((await issue.json()) as { comments: number }).comments).toBe(2);
    const comments = await app.request(`${base}/repos/octocat/graph/issues/1/comments`, {
      headers: { Authorization: "Bearer token" },
    });
    expect(((await comments.json()) as Array<{ body: string }>).map((comment) => comment.body)).toEqual(["one", "two"]);
    const graph = await app.request(`${base}/graphql`, {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{ repository(owner: "octocat", name: "graph") { issue(number: 1) { comments { totalCount nodes { body } } blockedBy { nodes { number } } } } }`,
      }),
    });
    expect(await graph.json()).toMatchObject({
      data: {
        repository: {
          issue: {
            comments: { totalCount: 2, nodes: [{ body: "one" }, { body: "two" }] },
            blockedBy: { nodes: [{ number: 2 }, { number: 3 }] },
          },
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

  const issuePair = {
    issues: [
      { key: "parent", repo: "octocat/graph", title: "Parent" },
      { key: "child", repo: "octocat/graph", title: "Child" },
      { key: "other", repo: "octocat/graph", title: "Other" },
    ],
  } as const;
  const invalidSeeds: Array<[string, object]> = [
    ["duplicate label key", { ...seed, labels: [...seed.labels, { ...seed.labels[0] }] }],
    ["duplicate issue key", { ...seed, issues: [...seed.issues, { ...seed.issues[0] }] }],
    [
      "duplicate explicit issue number",
      { ...seed, issues: [...seed.issues, { key: "other", repo: "octocat/graph", number: 7, title: "Other" }] },
    ],
    [
      "missing author",
      {
        ...seed,
        issues: [...seed.issues, { key: "authored", repo: "octocat/graph", title: "Authored", author: "missing" }],
      },
    ],
    [
      "missing issue reference",
      { ...seed, comments: [{ key: "comment", repo: "octocat/graph", issue: "missing", body: "comment" }] },
    ],
    [
      "missing comment repository",
      { ...seed, comments: [{ key: "comment", repo: "octocat/missing", issue: "canonical", body: "comment" }] },
    ],
    ["missing label reference", { ...seed, issues: [{ ...seed.issues[0], labels: ["missing"] }] }],
    [
      "missing canonical reference",
      {
        ...seed,
        issues: [{ ...seed.issues[0], state: "closed", state_reason: "duplicate" as const, duplicate_of: "missing" }],
      },
    ],
    ["negative position", { ...seed, ...issuePair, sub_issues: [{ parent: "parent", child: "child", position: -1 }] }],
    [
      "duplicate positions",
      {
        ...seed,
        ...issuePair,
        sub_issues: [
          { parent: "parent", child: "child", position: 0 },
          { parent: "parent", child: "other", position: 0 },
        ],
      },
    ],
    [
      "noncontiguous positions",
      {
        ...seed,
        ...issuePair,
        sub_issues: [
          { parent: "parent", child: "child", position: 1 },
          { parent: "parent", child: "other", position: 2 },
        ],
      },
    ],
    [
      "mixed positions",
      {
        ...seed,
        ...issuePair,
        sub_issues: [
          { parent: "parent", child: "child", position: 0 },
          { parent: "parent", child: "other" },
        ],
      },
    ],
    ["self hierarchy", { ...seed, ...issuePair, sub_issues: [{ parent: "parent", child: "parent" }] }],
    [
      "multiple parents",
      {
        ...seed,
        ...issuePair,
        sub_issues: [
          { parent: "parent", child: "child" },
          { parent: "other", child: "child" },
        ],
      },
    ],
    [
      "hierarchy cycle",
      {
        ...seed,
        ...issuePair,
        sub_issues: [
          { parent: "parent", child: "child" },
          { parent: "child", child: "parent" },
        ],
      },
    ],
    [
      "different-owner hierarchy",
      {
        ...seed,
        repos: [...seed.repos, { owner: "other", name: "graph" }],
        issues: [...issuePair.issues, { key: "foreign", repo: "other/graph", title: "Foreign" }],
        sub_issues: [{ parent: "parent", child: "foreign" }],
      },
    ],
    ["self dependency", { ...seed, ...issuePair, dependencies: [{ blocked: "parent", blocking: "parent" }] }],
    [
      "duplicate dependency",
      {
        ...seed,
        ...issuePair,
        dependencies: [
          { blocked: "parent", blocking: "child" },
          { blocked: "parent", blocking: "child" },
        ],
      },
    ],
    [
      "dependency cycle",
      {
        ...seed,
        ...issuePair,
        dependencies: [
          { blocked: "parent", blocking: "child" },
          { blocked: "child", blocking: "parent" },
        ],
      },
    ],
    [
      "open completed",
      { ...seed, issues: [{ ...seed.issues[0], state: "open" as const, state_reason: "completed" as const }] },
    ],
    [
      "closed reopened",
      { ...seed, issues: [{ ...seed.issues[0], state: "closed" as const, state_reason: "reopened" as const }] },
    ],
    [
      "duplicate without canonical",
      { ...seed, issues: [{ ...seed.issues[0], state: "closed" as const, state_reason: "duplicate" as const }] },
    ],
    [
      "canonical self",
      {
        ...seed,
        issues: [
          {
            ...seed.issues[0],
            state: "closed" as const,
            state_reason: "duplicate" as const,
            duplicate_of: "canonical",
          },
        ],
      },
    ],
    [
      "canonical already duplicate",
      {
        ...seed,
        issues: [
          {
            ...seed.issues[0],
            state: "closed" as const,
            state_reason: "duplicate" as const,
            duplicate_of: "duplicate",
          },
        ],
      },
    ],
    [
      "cross-repository canonical",
      {
        ...seed,
        repos: [...seed.repos, { owner: "octocat", name: "other" }],
        issues: [
          ...seed.issues,
          { key: "foreign", repo: "octocat/other", title: "Foreign" },
          {
            key: "cross",
            repo: "octocat/graph",
            title: "Cross",
            state: "closed" as const,
            state_reason: "duplicate" as const,
            duplicate_of: "foreign",
          },
        ],
      },
    ],
  ];

  it.each(invalidSeeds)("rejects %s without changing the store", (_name, invalid) => {
    const { store } = appFor();
    const before = JSON.stringify(store.snapshot());
    expect(() => seedFromConfig(store, base, invalid as Parameters<typeof seedFromConfig>[2])).toThrow();
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });
});
