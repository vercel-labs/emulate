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
    repos: [
      { owner: "octocat", name: "hello-world" },
      { owner: "octocat", name: "empty-repo", auto_init: false },
    ],
  });

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token" };
}

function jsonHeaders(): Record<string, string> {
  return { ...authHeaders(), "Content-Type": "application/json" };
}

async function putFile(app: Hono, path: string, text: string, extra: Record<string, unknown> = {}) {
  return app.request(`${base}/repos/octocat/hello-world/contents/${path}`, {
    method: "PUT",
    headers: jsonHeaders(),
    body: JSON.stringify({
      message: `Update ${path}`,
      content: Buffer.from(text, "utf8").toString("base64"),
      ...extra,
    }),
  });
}

describe("GitHub contents routes", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("returns the auto-init README via /contents/{path}", async () => {
    const res = await app.request(`${base}/repos/octocat/hello-world/contents/README.md`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; encoding: string; content: string; sha: string; path: string };
    expect(body.type).toBe("file");
    expect(body.path).toBe("README.md");
    expect(Buffer.from(body.content, "base64").toString("utf8")).toBe("# hello-world\n");
    expect(body.sha).toBeTruthy();
  });

  it("serves the URL shape that code search results advertise (?ref=HEAD)", async () => {
    const res = await app.request(`${base}/repos/octocat/hello-world/contents/README.md?ref=HEAD`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
  });

  it("returns the README via /readme", async () => {
    const res = await app.request(`${base}/repos/octocat/hello-world/readme`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; content: string };
    expect(body.name).toBe("README.md");
  });

  it("lists the repo root and subdirectories", async () => {
    expect((await putFile(app, "src/index.ts", "export {};\n")).status).toBe(201);

    const root = await app.request(`${base}/repos/octocat/hello-world/contents`, { headers: authHeaders() });
    expect(root.status).toBe(200);
    const rootBody = (await root.json()) as Array<{ name: string; type: string }>;
    expect(rootBody.find((e) => e.name === "README.md")?.type).toBe("file");
    expect(rootBody.find((e) => e.name === "src")?.type).toBe("dir");

    const dir = await app.request(`${base}/repos/octocat/hello-world/contents/src`, { headers: authHeaders() });
    expect(dir.status).toBe(200);
    const dirBody = (await dir.json()) as Array<{ path: string; type: string }>;
    expect(dirBody).toHaveLength(1);
    expect(dirBody[0].path).toBe("src/index.ts");
  });

  it("404s on a missing path", async () => {
    const res = await app.request(`${base}/repos/octocat/hello-world/contents/nope.txt`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it("creates, updates, and deletes a file through PUT/DELETE /contents", async () => {
    const created = await putFile(app, "notes.txt", "one\n");
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      content: { sha: string };
      commit: { sha: string; parents: unknown[] };
    };
    expect(createdBody.content.sha).toBeTruthy();
    expect(createdBody.commit.parents).toHaveLength(1);

    // Update without sha -> 422; wrong sha -> 409.
    expect((await putFile(app, "notes.txt", "two\n")).status).toBe(422);
    expect((await putFile(app, "notes.txt", "two\n", { sha: "0".repeat(40) })).status).toBe(409);

    const updated = await putFile(app, "notes.txt", "two\n", { sha: createdBody.content.sha });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as { content: { sha: string } };

    const read = await app.request(`${base}/repos/octocat/hello-world/contents/notes.txt`, { headers: authHeaders() });
    const readBody = (await read.json()) as { content: string };
    expect(Buffer.from(readBody.content, "base64").toString("utf8")).toBe("two\n");

    const deleted = await app.request(`${base}/repos/octocat/hello-world/contents/notes.txt`, {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Delete notes.txt", sha: updatedBody.content.sha }),
    });
    expect(deleted.status).toBe(200);
    const deletedBody = (await deleted.json()) as { content: null; commit: { sha: string } };
    expect(deletedBody.content).toBeNull();

    const gone = await app.request(`${base}/repos/octocat/hello-world/contents/notes.txt`, { headers: authHeaders() });
    expect(gone.status).toBe(404);
  });

  it("reads a file at an older ref", async () => {
    const created = await putFile(app, "notes.txt", "one\n");
    const createdBody = (await created.json()) as { content: { sha: string }; commit: { sha: string } };
    await putFile(app, "notes.txt", "two\n", { sha: createdBody.content.sha });

    const res = await app.request(
      `${base}/repos/octocat/hello-world/contents/notes.txt?ref=${createdBody.commit.sha}`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(Buffer.from(body.content, "base64").toString("utf8")).toBe("one\n");
  });
});

describe("GitHub commits routes", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("lists commits newest first", async () => {
    await putFile(app, "a.txt", "a\n");
    await putFile(app, "b.txt", "b\n");

    const res = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ sha: string; commit: { message: string } }>;
    expect(body).toHaveLength(3);
    expect(body[0].commit.message).toBe("Update b.txt");
    expect(body[2].commit.message).toBe("Initial commit");
  });

  it("filters commits by path", async () => {
    await putFile(app, "a.txt", "a\n");
    await putFile(app, "b.txt", "b\n");

    const res = await app.request(`${base}/repos/octocat/hello-world/commits?path=b.txt`, {
      headers: authHeaders(),
    });
    const body = (await res.json()) as Array<{ commit: { message: string } }>;
    expect(body).toHaveLength(1);
    expect(body[0].commit.message).toBe("Update b.txt");
  });

  it("409s on an empty repository", async () => {
    const res = await app.request(`${base}/repos/octocat/empty-repo/commits`, { headers: authHeaders() });
    expect(res.status).toBe(409);
  });

  it("returns a single commit with files and stats", async () => {
    const created = await putFile(app, "notes.txt", "one\ntwo\n");
    const createdBody = (await created.json()) as { commit: { sha: string } };

    const res = await app.request(`${base}/repos/octocat/hello-world/commits/${createdBody.commit.sha}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sha: string;
      stats: { additions: number; deletions: number; total: number };
      files: Array<{ filename: string; status: string; additions: number; patch?: string }>;
    };
    expect(body.sha).toBe(createdBody.commit.sha);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].filename).toBe("notes.txt");
    expect(body.files[0].status).toBe("added");
    expect(body.files[0].additions).toBe(2);
    expect(body.files[0].patch).toContain("+one");
    expect(body.stats.additions).toBe(2);
  });

  it("resolves a commit by branch name and by sha prefix", async () => {
    const created = await putFile(app, "notes.txt", "one\n");
    const createdBody = (await created.json()) as { commit: { sha: string } };

    const byBranch = await app.request(`${base}/repos/octocat/hello-world/commits/main`, { headers: authHeaders() });
    expect(byBranch.status).toBe(200);
    expect(((await byBranch.json()) as { sha: string }).sha).toBe(createdBody.commit.sha);

    const byPrefix = await app.request(
      `${base}/repos/octocat/hello-world/commits/${createdBody.commit.sha.slice(0, 8)}`,
      { headers: authHeaders() },
    );
    expect(byPrefix.status).toBe(200);
    expect(((await byPrefix.json()) as { sha: string }).sha).toBe(createdBody.commit.sha);
  });

  it("compares base...head", async () => {
    const first = await putFile(app, "notes.txt", "one\n");
    const firstBody = (await first.json()) as { content: { sha: string }; commit: { sha: string } };
    await putFile(app, "notes.txt", "one\ntwo\n", { sha: firstBody.content.sha });

    const res = await app.request(`${base}/repos/octocat/hello-world/compare/${firstBody.commit.sha}...main`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      ahead_by: number;
      behind_by: number;
      total_commits: number;
      commits: Array<{ commit: { message: string } }>;
      files: Array<{ filename: string; status: string; patch?: string }>;
      merge_base_commit: { sha: string };
    };
    expect(body.status).toBe("ahead");
    expect(body.ahead_by).toBe(1);
    expect(body.behind_by).toBe(0);
    expect(body.total_commits).toBe(1);
    expect(body.commits[0].commit.message).toBe("Update notes.txt");
    expect(body.merge_base_commit.sha).toBe(firstBody.commit.sha);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].filename).toBe("notes.txt");
    expect(body.files[0].status).toBe("modified");
    expect(body.files[0].patch).toContain("+two");
  });

  it("reports identical for the same ref on both sides", async () => {
    const res = await app.request(`${base}/repos/octocat/hello-world/compare/main...main`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; ahead_by: number; files: unknown[] };
    expect(body.status).toBe("identical");
    expect(body.ahead_by).toBe(0);
    expect(body.files).toHaveLength(0);
  });

  it("does not shadow /commits/{sha}/comments", async () => {
    const list = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await list.json()) as Array<{ sha: string }>;
    const res = await app.request(`${base}/repos/octocat/hello-world/commits/${head.sha}/comments`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe("GitHub repository-by-id route", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("looks up a repo by numeric id", async () => {
    const byName = await app.request(`${base}/repos/octocat/hello-world`, { headers: authHeaders() });
    const repo = (await byName.json()) as { id: number };

    const byId = await app.request(`${base}/repositories/${repo.id}`, { headers: authHeaders() });
    expect(byId.status).toBe(200);
    const body = (await byId.json()) as { full_name: string };
    expect(body.full_name).toBe("octocat/hello-world");
  });

  it("404s on an unknown id", async () => {
    const res = await app.request(`${base}/repositories/999999`, { headers: authHeaders() });
    expect(res.status).toBe(404);
  });
});

describe("search result URLs resolve against the contents API", () => {
  it("GET on a code-search result url returns the file", async () => {
    const { app } = createTestApp();
    const search = await app.request(`${base}/search/code?q=hello-world`, { headers: authHeaders() });
    expect(search.status).toBe(200);
    const searchBody = (await search.json()) as { items: Array<{ url: string }> };
    expect(searchBody.items.length).toBeGreaterThan(0);

    const res = await app.request(searchBody.items[0].url, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("file");
  });
});
