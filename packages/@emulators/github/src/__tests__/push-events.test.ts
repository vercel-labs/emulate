import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "@emulators/core";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const ZERO_SHA = "0".repeat(40);

interface PushCommit {
  id: string;
  tree_id: string;
  distinct: boolean;
  message: string;
  timestamp: string;
  url: string;
  author: { name: string; email: string; username?: string };
  committer: { name: string; email: string; username?: string };
  added: string[];
  removed: string[];
  modified: string[];
}

interface PushPayload {
  ref: string;
  before: string;
  after: string;
  created: boolean;
  deleted: boolean;
  forced: boolean;
  base_ref: null;
  compare: string;
  commits: PushCommit[];
  head_commit: PushCommit | null;
  repository: { full_name: string };
  pusher: { name: string; email: string };
  sender: { login: string };
}

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
    users: [{ login: "octocat", email: "octocat@github.com" }],
    repos: [
      { owner: "octocat", name: "hello-world" },
      { owner: "octocat", name: "empty-repo", auto_init: false },
    ],
  });
  for (const repo of ["hello-world", "empty-repo"]) {
    webhooks.register({
      url: `https://hooks.example/${repo}`,
      events: ["push", "delete"],
      active: true,
      owner: "octocat",
      repo,
    });
  }

  return app;
}

function jsonHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token", "Content-Type": "application/json" };
}

const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

function deliveries(event: string): unknown[] {
  return mockFetch.mock.calls
    .filter(([, init]) => ((init as RequestInit).headers as Record<string, string>)["X-GitHub-Event"] === event)
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

function lastPush(): PushPayload {
  const pushes = deliveries("push") as PushPayload[];
  expect(pushes.length).toBeGreaterThan(0);
  return pushes[pushes.length - 1];
}

async function putFile(app: Hono, repo: string, path: string, text: string, extra: Record<string, unknown> = {}) {
  const response = await app.request(`${base}/repos/octocat/${repo}/contents/${path}`, {
    method: "PUT",
    headers: jsonHeaders(),
    body: JSON.stringify({
      message: `Update ${path}`,
      content: Buffer.from(text, "utf8").toString("base64"),
      ...extra,
    }),
  });
  expect([200, 201]).toContain(response.status);
  return (await response.json()) as { content: { sha: string }; commit: { sha: string; tree: { sha: string } } };
}

async function headSha(app: Hono): Promise<string> {
  const response = await app.request(`${base}/repos/octocat/hello-world/commits/main`, { headers: jsonHeaders() });
  return ((await response.json()) as { sha: string }).sha;
}

describe("GitHub push event payloads", () => {
  let app: Hono;

  beforeEach(() => {
    mockFetch.mockClear();
    vi.stubGlobal("fetch", mockFetch);
    app = createTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("describes contents writes with pusher, head_commit, and change flags", async () => {
    const before = await headSha(app);
    const created = await putFile(app, "hello-world", "notes.txt", "hello\n");

    const push = lastPush();
    expect(push).toEqual(
      expect.objectContaining({
        ref: "refs/heads/main",
        before,
        after: created.commit.sha,
        created: false,
        deleted: false,
        forced: false,
        base_ref: null,
        compare: `${base}/octocat/hello-world/compare/${before.slice(0, 12)}...${created.commit.sha.slice(0, 12)}`,
        repository: expect.objectContaining({ full_name: "octocat/hello-world" }),
        pusher: { name: "octocat", email: "octocat@github.com" },
        sender: expect.objectContaining({ login: "octocat" }),
      }),
    );
    expect(push.commits).toHaveLength(1);
    expect(push.commits[0]).toEqual({
      id: created.commit.sha,
      tree_id: created.commit.tree.sha,
      distinct: true,
      message: "Update notes.txt",
      timestamp: expect.any(String),
      url: `${base}/octocat/hello-world/commit/${created.commit.sha}`,
      author: { name: "octocat", email: "octocat@github.com", username: "octocat" },
      committer: { name: "octocat", email: "octocat@github.com", username: "octocat" },
      added: ["notes.txt"],
      removed: [],
      modified: [],
    });
    expect(push.head_commit).toEqual(push.commits[0]);

    const updated = await putFile(app, "hello-world", "notes.txt", "hello again\n", { sha: created.content.sha });
    const updatePush = lastPush();
    expect(updatePush.before).toBe(created.commit.sha);
    expect(updatePush.after).toBe(updated.commit.sha);
    expect(updatePush.head_commit).toEqual(
      expect.objectContaining({ id: updated.commit.sha, modified: ["notes.txt"] }),
    );

    const deleted = await app.request(`${base}/repos/octocat/hello-world/contents/notes.txt`, {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Remove notes", sha: updated.content.sha }),
    });
    expect(deleted.status).toBe(200);
    const deleteSha = ((await deleted.json()) as { commit: { sha: string } }).commit.sha;
    const deletePush = lastPush();
    expect(deletePush).toEqual(
      expect.objectContaining({ before: updated.commit.sha, after: deleteSha, created: false, deleted: false }),
    );
    expect(deletePush.head_commit).toEqual(
      expect.objectContaining({ id: deleteSha, added: [], removed: ["notes.txt"], modified: [] }),
    );
  });

  it("flags the first push to an empty repository as a created ref", async () => {
    const first = await putFile(app, "empty-repo", "README.md", "# Empty\n");
    const push = lastPush();
    expect(push).toEqual(
      expect.objectContaining({
        ref: "refs/heads/main",
        before: ZERO_SHA,
        after: first.commit.sha,
        created: true,
        deleted: false,
        forced: false,
        repository: expect.objectContaining({ full_name: "octocat/empty-repo" }),
      }),
    );
    expect(push.commits.map((commit) => commit.added)).toEqual([["README.md"]]);
    expect(push.head_commit?.id).toBe(first.commit.sha);
  });

  it("lists pushed commits for ref updates and flags forced, created, and deleted refs", async () => {
    const root = await headSha(app);
    const first = await putFile(app, "hello-world", "a.txt", "a\n");
    const second = await putFile(app, "hello-world", "b.txt", "b\n");
    const third = await putFile(app, "hello-world", "a.txt", "a2\n", { sha: first.content.sha });
    mockFetch.mockClear();

    const createdRef = await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: "refs/heads/topic", sha: root }),
    });
    expect(createdRef.status).toBe(201);
    expect(lastPush()).toEqual(
      expect.objectContaining({
        ref: "refs/heads/topic",
        before: ZERO_SHA,
        after: root,
        created: true,
        deleted: false,
        forced: false,
        commits: [],
        head_commit: expect.objectContaining({ id: root }),
        pusher: { name: "octocat", email: "octocat@github.com" },
      }),
    );

    const fastForward = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/topic`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sha: third.commit.sha }),
    });
    expect(fastForward.status).toBe(200);
    const forwardPush = lastPush();
    expect(forwardPush).toEqual(
      expect.objectContaining({ before: root, after: third.commit.sha, created: false, deleted: false, forced: false }),
    );
    expect(forwardPush.commits.map((commit) => [commit.id, commit.added, commit.modified])).toEqual([
      [first.commit.sha, ["a.txt"], []],
      [second.commit.sha, ["b.txt"], []],
      [third.commit.sha, [], ["a.txt"]],
    ]);
    expect(forwardPush.head_commit).toEqual(forwardPush.commits[2]);

    const forced = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/topic`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sha: first.commit.sha, force: true }),
    });
    expect(forced.status).toBe(200);
    const forcedPush = lastPush();
    expect(forcedPush).toEqual(
      expect.objectContaining({
        before: third.commit.sha,
        after: first.commit.sha,
        forced: true,
        commits: [],
        head_commit: expect.objectContaining({ id: first.commit.sha, added: ["a.txt"] }),
      }),
    );

    const forcedFastForward = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/topic`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sha: second.commit.sha, force: true }),
    });
    expect(forcedFastForward.status).toBe(200);
    expect(lastPush()).toEqual(expect.objectContaining({ after: second.commit.sha, forced: false }));

    const removed = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/topic`, {
      method: "DELETE",
      headers: jsonHeaders(),
    });
    expect(removed.status).toBe(204);
    expect(lastPush()).toEqual(
      expect.objectContaining({
        ref: "refs/heads/topic",
        before: second.commit.sha,
        after: ZERO_SHA,
        created: false,
        deleted: true,
        forced: false,
        commits: [],
        head_commit: null,
      }),
    );
    expect(deliveries("delete")).toEqual([
      expect.objectContaining({
        ref: "refs/heads/topic",
        ref_type: "branch",
        pusher_type: "user",
        repository: expect.objectContaining({ full_name: "octocat/hello-world" }),
        sender: expect.objectContaining({ login: "octocat" }),
      }),
    ]);
  });
});
