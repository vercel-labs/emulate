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
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user"] });

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

  return { app };
}

function jsonHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token", "Content-Type": "application/json" };
}

async function createPull(app: Hono): Promise<number> {
  const res = await app.request(`${base}/repos/octocat/hello-world/pulls`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ title: "Live head", head: "feature", base: "main" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { number: number }).number;
}

async function mergePull(app: Hono, pullNumber: number): Promise<void> {
  const res = await app.request(`${base}/repos/octocat/hello-world/pulls/${pullNumber}/merge`, {
    method: "PUT",
    headers: jsonHeaders(),
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
}

async function pushFile(app: Hono, path: string, text: string): Promise<string> {
  const res = await app.request(`${base}/repos/octocat/hello-world/contents/${path}`, {
    method: "PUT",
    headers: jsonHeaders(),
    body: JSON.stringify({
      message: `add ${path}`,
      content: Buffer.from(text, "utf8").toString("base64"),
      branch: "feature",
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { commit: { sha: string } }).commit.sha;
}

describe("pull request head follows pushed commits", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("updates the head SHA and file stats", async () => {
    const pullNumber = await createPull(app);

    const before = (await (
      await app.request(`${base}/repos/octocat/hello-world/pulls/${pullNumber}`, {
        headers: { Authorization: "Bearer test-token" },
      })
    ).json()) as { head: { sha: string }; changed_files: number };

    const sha = await pushFile(app, "src/app.ts", "export const answer = 42\n");

    const after = (await (
      await app.request(`${base}/repos/octocat/hello-world/pulls/${pullNumber}`, {
        headers: { Authorization: "Bearer test-token" },
      })
    ).json()) as {
      head: { sha: string };
      changed_files: number;
      additions: number;
      deletions: number;
      commits: number;
    };

    expect(after.head.sha).toBe(sha);
    expect(after.head.sha).not.toBe(before.head.sha);
    expect(after.changed_files).toBe(1);
    expect(after.additions).toBe(1);
    expect(after.deletions).toBe(0);
    expect(after.commits).toBe(1);
  });

  it("lists the files and commits of new pushes", async () => {
    const pullNumber = await createPull(app);
    const first = await pushFile(app, "src/app.ts", "export const answer = 42\n");
    const second = await pushFile(app, "src/other.ts", "export const other = true\n");

    const filesRes = await app.request(`${base}/repos/octocat/hello-world/pulls/${pullNumber}/files`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(filesRes.status).toBe(200);
    const files = (await filesRes.json()) as Array<{ filename: string; status: string; patch?: string }>;
    expect(files.map((file) => file.filename)).toEqual(["src/app.ts", "src/other.ts"]);
    expect(files.find((file) => file.filename === "src/app.ts")?.status).toBe("added");
    expect(files.find((file) => file.filename === "src/app.ts")?.patch).toContain("+export const answer = 42");

    const commitsRes = await app.request(`${base}/repos/octocat/hello-world/pulls/${pullNumber}/commits`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(commitsRes.status).toBe(200);
    const commits = (await commitsRes.json()) as Array<{ sha: string }>;
    expect(commits.map((commit) => commit.sha)).toEqual([first, second]);
  });

  it("keeps the files and commits after a normal merge", async () => {
    const pullNumber = await createPull(app);
    const sha = await pushFile(app, "src/app.ts", "export const answer = 42\n");
    await mergePull(app, pullNumber);

    const filesRes = await app.request(`${base}/repos/octocat/hello-world/pulls/${pullNumber}/files`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(filesRes.status).toBe(200);
    const files = (await filesRes.json()) as Array<{ filename: string }>;
    expect(files.map((file) => file.filename)).toEqual(["src/app.ts"]);

    const commitsRes = await app.request(`${base}/repos/octocat/hello-world/pulls/${pullNumber}/commits`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(commitsRes.status).toBe(200);
    const commits = (await commitsRes.json()) as Array<{ sha: string }>;
    expect(commits.map((commit) => commit.sha)).toEqual([sha]);
  });

  it("keeps the post-push stats on a merged pull request", async () => {
    const pullNumber = await createPull(app);
    await pushFile(app, "src/app.ts", "export const answer = 42\n");

    const merged = await app.request(`${base}/repos/octocat/hello-world/pulls/${pullNumber}`, {
      headers: { Authorization: "Bearer test-token" },
    });
    const before = (await merged.json()) as {
      changed_files: number;
      additions: number;
      deletions: number;
      commits: number;
    };
    expect(before).toMatchObject({ changed_files: 1, additions: 1, deletions: 0, commits: 1 });

    await mergePull(app, pullNumber);

    const after = (await (
      await app.request(`${base}/repos/octocat/hello-world/pulls/${pullNumber}`, {
        headers: { Authorization: "Bearer test-token" },
      })
    ).json()) as { merged: boolean; changed_files: number; additions: number; deletions: number; commits: number };

    expect(after.merged).toBe(true);
    expect(after.changed_files).toBe(1);
    expect(after.additions).toBe(1);
    expect(after.deletions).toBe(0);
    expect(after.commits).toBe(1);
  });
});
