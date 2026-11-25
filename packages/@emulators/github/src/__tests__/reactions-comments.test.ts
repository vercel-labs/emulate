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
  const tokenMap: TokenMap = new Map([
    ["test-token", { login: "octocat", id: 1, scopes: ["repo", "user"] }],
    ["other-token", { login: "other", id: 2, scopes: ["repo", "user"] }],
  ]);

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "other" }],
    repos: [{ owner: "octocat", name: "hello-world" }],
  });

  return { app };
}

function jsonHeaders(token = "test-token"): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function readHeaders(token = "test-token"): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

type Rollup = {
  url: string;
  total_count: number;
  "+1": number;
  heart: number;
  rocket: number;
};

async function createIssue(app: Hono): Promise<number> {
  const res = await app.request(`${base}/repos/octocat/hello-world/issues`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ title: "Reactions" }),
  });
  return ((await res.json()) as { number: number }).number;
}

async function createPull(app: Hono): Promise<number> {
  const res = await app.request(`${base}/repos/octocat/hello-world/pulls`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ title: "Reactions PR", head: "feature", base: "main" }),
  });
  return ((await res.json()) as { number: number }).number;
}

async function postComment(app: Hono, number: number, token = "test-token"): Promise<number> {
  const res = await app.request(`${base}/repos/octocat/hello-world/issues/${number}/comments`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ body: "A comment" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

async function react(app: Hono, path: string, content: string, token = "test-token") {
  const res = await app.request(`${base}${path}/reactions`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ content }),
  });
  expect([200, 201]).toContain(res.status);
  return (await res.json()) as { id: number; content: string };
}

describe("issue and pull request comment counts and reactions", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("counts comments and rolls up reactions as they are added", async () => {
    const number = await createIssue(app);
    const path = `/repos/octocat/hello-world/issues/${number}`;

    const initial = (await (await app.request(`${base}${path}`, { headers: readHeaders() })).json()) as {
      comments: number;
      reactions: Rollup;
    };
    expect(initial.comments).toBe(0);
    expect(initial.reactions.total_count).toBe(0);

    await postComment(app, number);
    await postComment(app, number, "other-token");

    const reacted = await react(app, path, "+1");
    await react(app, path, "heart", "other-token");

    const updated = (await (await app.request(`${base}${path}`, { headers: readHeaders() })).json()) as {
      comments: number;
      reactions: Rollup;
    };
    expect(updated.comments).toBe(2);
    expect(updated.reactions.total_count).toBe(2);
    expect(updated.reactions["+1"]).toBe(1);
    expect(updated.reactions.heart).toBe(1);

    const listed = await app.request(`${base}${path}/reactions`, { headers: readHeaders() });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as Array<{ content: string }>).map((reaction) => reaction.content).sort()).toEqual([
      "+1",
      "heart",
    ]);

    const removed = await app.request(`${base}${path}/reactions/${reacted.id}`, {
      method: "DELETE",
      headers: readHeaders(),
    });
    expect(removed.status).toBe(204);

    const after = (await (await app.request(`${base}${path}`, { headers: readHeaders() })).json()) as {
      reactions: Rollup;
    };
    expect(after.reactions.total_count).toBe(1);
    expect(after.reactions["+1"]).toBe(0);
    expect(after.reactions.heart).toBe(1);
  });

  it("counts comments and reactions on pull requests", async () => {
    const number = await createPull(app);
    const issuePath = `/repos/octocat/hello-world/issues/${number}`;
    const pullPath = `/repos/octocat/hello-world/pulls/${number}`;

    await postComment(app, number);
    await react(app, issuePath, "rocket");

    const pull = (await (await app.request(`${base}${pullPath}`, { headers: readHeaders() })).json()) as {
      comments: number;
      reactions: Rollup;
    };
    expect(pull.comments).toBe(1);
    expect(pull.reactions.total_count).toBe(1);
    expect(pull.reactions.rocket).toBe(1);

    const issueView = (await (await app.request(`${base}${issuePath}`, { headers: readHeaders() })).json()) as {
      comments: number;
      reactions: Rollup;
    };
    expect(issueView.comments).toBe(1);
    expect(issueView.reactions.total_count).toBe(1);
  });

  it("counts reactions on comments", async () => {
    const number = await createIssue(app);
    const commentId = await postComment(app, number);

    await react(app, `/repos/octocat/hello-world/issues/comments/${commentId}`, "laugh");

    const comment = (await (
      await app.request(`${base}/repos/octocat/hello-world/issues/comments/${commentId}`, { headers: readHeaders() })
    ).json()) as { reactions: Rollup };
    expect(comment.reactions.total_count).toBe(1);
  });

  it("keeps review- and commit-comment reactions when the issue tracker is off", async () => {
    const disabled = await app.request(`${base}/repos/octocat/hello-world`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ has_issues: false }),
    });
    expect(disabled.status).toBe(200);

    const number = await createPull(app);
    const pull = (await (
      await app.request(`${base}/repos/octocat/hello-world/pulls/${number}`, { headers: readHeaders() })
    ).json()) as { head: { sha: string } };

    const reviewRes = await app.request(`${base}/repos/octocat/hello-world/pulls/${number}/comments`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ body: "review note", path: "src/app.ts" }),
    });
    expect(reviewRes.status).toBe(201);
    const reviewId = ((await reviewRes.json()) as { id: number }).id;
    const reviewReaction = await app.request(`${base}/repos/octocat/hello-world/pulls/comments/${reviewId}/reactions`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ content: "+1" }),
    });
    expect(reviewReaction.status).toBe(201);

    const commitRes = await app.request(`${base}/repos/octocat/hello-world/commits/${pull.head.sha}/comments`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ body: "commit note" }),
    });
    expect(commitRes.status).toBe(201);
    const commitId = ((await commitRes.json()) as { id: number }).id;
    const commitReaction = await app.request(`${base}/repos/octocat/hello-world/comments/${commitId}/reactions`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ content: "heart" }),
    });
    expect(commitReaction.status).toBe(201);

    // The issue tracker itself is still closed.
    const issueReaction = await app.request(`${base}/repos/octocat/hello-world/issues/${number}/reactions`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ content: "+1" }),
    });
    expect(issueReaction.status).toBe(404);
  });

  it("rejects unknown reaction content", async () => {
    const number = await createIssue(app);
    const res = await app.request(`${base}/repos/octocat/hello-world/issues/${number}/reactions`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ content: "party" }),
    });
    expect(res.status).toBe(422);
  });
});
