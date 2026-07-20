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
  tokenMap.set("outsider-token", { login: "outsider", id: 2, scopes: ["repo"] });
  tokenMap.set("org-member-token", { login: "org-member", id: 3, scopes: ["repo"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "outsider" }, { login: "org-member" }],
    orgs: [{ login: "acme" }],
    repos: [
      { owner: "octocat", name: "hello-world" },
      { owner: "octocat", name: "empty-repo", auto_init: false },
      { owner: "acme", name: "project" },
    ],
  });

  return { app, store, webhooks, tokenMap };
}

function authHeaders(token = "test-token"): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(token = "test-token"): Record<string, string> {
  return { ...authHeaders(token), "Content-Type": "application/json" };
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
    const body = (await res.json()) as {
      type: string;
      encoding: string;
      content: string;
      sha: string;
      path: string;
      download_url: string;
    };
    expect(body.type).toBe("file");
    expect(body.path).toBe("README.md");
    expect(Buffer.from(body.content, "base64").toString("utf8")).toBe("# hello-world\n");
    expect(body.sha).toBeTruthy();

    const download = await app.request(body.download_url, { headers: authHeaders() });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("# hello-world\n");
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

  it("selects READMEs from .github, root, then docs", async () => {
    const docs = await putFile(app, "docs/README.md", "docs\n");
    const docsBody = (await docs.json()) as { content: { sha: string } };
    const dotGitHub = await putFile(app, ".github/README.md", "github\n");
    const dotGitHubBody = (await dotGitHub.json()) as { content: { sha: string } };

    const preferred = await app.request(`${base}/repos/octocat/hello-world/readme`, { headers: authHeaders() });
    expect(((await preferred.json()) as { path: string }).path).toBe(".github/README.md");

    const deleteDotGitHub = await app.request(`${base}/repos/octocat/hello-world/contents/.github/README.md`, {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Delete .github README", sha: dotGitHubBody.content.sha }),
    });
    expect(deleteDotGitHub.status).toBe(200);
    const rootPreferred = await app.request(`${base}/repos/octocat/hello-world/readme`, { headers: authHeaders() });
    expect(((await rootPreferred.json()) as { path: string }).path).toBe("README.md");

    const root = await app.request(`${base}/repos/octocat/hello-world/contents/README.md`, { headers: authHeaders() });
    const rootBody = (await root.json()) as { sha: string };
    const deleteRoot = await app.request(`${base}/repos/octocat/hello-world/contents/README.md`, {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Delete root README", sha: rootBody.sha }),
    });
    expect(deleteRoot.status).toBe(200);
    const docsPreferred = await app.request(`${base}/repos/octocat/hello-world/readme`, { headers: authHeaders() });
    const docsPreferredBody = (await docsPreferred.json()) as { path: string; sha: string };
    expect(docsPreferredBody.path).toBe("docs/README.md");
    expect(docsPreferredBody.sha).toBe(docsBody.content.sha);
  });

  it("lists the repo root and subdirectories", async () => {
    expect((await putFile(app, "src/index.ts", "export {};\n")).status).toBe(201);

    const root = await app.request(`${base}/repos/octocat/hello-world/contents`, { headers: authHeaders() });
    expect(root.status).toBe(200);
    const rootBody = (await root.json()) as Array<{ name: string; type: string; sha: string; git_url: string | null }>;
    expect(rootBody.find((e) => e.name === "README.md")?.type).toBe("file");
    const src = rootBody.find((e) => e.name === "src");
    expect(src?.type).toBe("dir");
    expect(src?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(src?.git_url).toBeTruthy();

    const tree = await app.request(src!.git_url!, { headers: authHeaders() });
    expect(tree.status).toBe(200);
    const treeBody = (await tree.json()) as { tree: Array<{ path: string; type: string }> };
    expect(treeBody.tree).toContainEqual(expect.objectContaining({ path: "index.ts", type: "blob" }));

    const dir = await app.request(`${base}/repos/octocat/hello-world/contents/src`, { headers: authHeaders() });
    expect(dir.status).toBe(200);
    const dirBody = (await dir.json()) as Array<{ path: string; type: string }>;
    expect(dirBody).toHaveLength(1);
    expect(dirBody[0].path).toBe("src/index.ts");
  });

  it("returns encoded content URLs that resolve for special path characters", async () => {
    const created = await putFile(app, "docs/My%20File%20%231.md", "hello\n");
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { content: { path: string; url: string; download_url: string } };
    expect(createdBody.content.path).toBe("docs/My File #1.md");
    expect(createdBody.content.url).toContain("My%20File%20%231.md");

    const read = await app.request(createdBody.content.url, { headers: authHeaders() });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { path: string }).path).toBe("docs/My File #1.md");

    const download = await app.request(createdBody.content.download_url, { headers: authHeaders() });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("hello\n");
  });

  it("addresses literal percent signs without decoding route parameters twice", async () => {
    const created = await putFile(app, "100%25.md", "percent\n");
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { content: { path: string; url: string } };
    expect(createdBody.content.path).toBe("100%.md");
    expect(createdBody.content.url).toContain("100%25.md");

    const read = await app.request(createdBody.content.url, { headers: authHeaders() });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { path: string }).path).toBe("100%.md");
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

  it("requires repository contents write permission for PUT and DELETE", async () => {
    const { app, store } = createTestApp();
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    const outsider = gh.users.findOneBy("login", "outsider")!;
    const body = JSON.stringify({
      message: "Create guarded.txt",
      content: Buffer.from("guarded\n", "utf8").toString("base64"),
    });

    const deniedCreate = await app.request(`${base}/repos/octocat/hello-world/contents/guarded.txt`, {
      method: "PUT",
      headers: jsonHeaders("outsider-token"),
      body,
    });
    expect(deniedCreate.status).toBe(403);

    const readme = await app.request(`${base}/repos/octocat/hello-world/contents/README.md`, {
      headers: authHeaders(),
    });
    const readmeBody = (await readme.json()) as { sha: string };
    const deniedDelete = await app.request(`${base}/repos/octocat/hello-world/contents/README.md`, {
      method: "DELETE",
      headers: jsonHeaders("outsider-token"),
      body: JSON.stringify({ message: "Delete README", sha: readmeBody.sha }),
    });
    expect(deniedDelete.status).toBe(403);

    const collaborator = gh.collaborators.insert({ repo_id: repo.id, user_id: outsider.id, permission: "pull" });
    const deniedReader = await app.request(`${base}/repos/octocat/hello-world/contents/guarded.txt`, {
      method: "PUT",
      headers: jsonHeaders("outsider-token"),
      body,
    });
    expect(deniedReader.status).toBe(403);

    gh.collaborators.update(collaborator.id, { permission: "push" });
    const allowedCreate = await app.request(`${base}/repos/octocat/hello-world/contents/guarded.txt`, {
      method: "PUT",
      headers: jsonHeaders("outsider-token"),
      body,
    });
    expect(allowedCreate.status).toBe(201);
    const allowedBody = (await allowedCreate.json()) as { content: { sha: string } };

    const allowedDelete = await app.request(`${base}/repos/octocat/hello-world/contents/guarded.txt`, {
      method: "DELETE",
      headers: jsonHeaders("outsider-token"),
      body: JSON.stringify({ message: "Delete guarded.txt", sha: allowedBody.content.sha }),
    });
    expect(allowedDelete.status).toBe(200);
  });

  it("honors organization default and team repository write permissions", async () => {
    const { app, store } = createTestApp();
    const gh = getGitHubStore(store);
    const org = gh.orgs.findOneBy("login", "acme")!;
    const repo = gh.repos.findOneBy("full_name", "acme/project")!;
    const member = gh.users.findOneBy("login", "org-member")!;
    const team = gh.teams.insert({
      node_id: "team-node",
      name: "Developers",
      slug: "developers",
      description: null,
      privacy: "closed",
      permission: "pull",
      org_id: org.id,
      parent_id: null,
      members_count: 1,
      repos_count: 0,
    });
    gh.teamMembers.insert({ team_id: team.id, user_id: member.id, role: "member" });
    const request = (path: string) =>
      app.request(`${base}/repos/acme/project/contents/${path}`, {
        method: "PUT",
        headers: jsonHeaders("org-member-token"),
        body: JSON.stringify({
          message: `Create ${path}`,
          content: Buffer.from(`${path}\n`, "utf8").toString("base64"),
        }),
      });

    expect((await request("denied.txt")).status).toBe(403);

    gh.orgs.update(org.id, { default_repository_permission: "write" });
    expect((await request("org-default.txt")).status).toBe(201);

    gh.orgs.update(org.id, { default_repository_permission: "read" });
    gh.teams.update(team.id, { permission: "push" });
    gh.teamRepos.insert({ team_id: team.id, repo_id: repo.id });
    expect((await request("team-access.txt")).status).toBe(201);
  });

  it("rejects malformed Base64 and incomplete commit identities without creating commits", async () => {
    const before = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const beforeCount = ((await before.json()) as unknown[]).length;

    const invalidContent = await app.request(`${base}/repos/octocat/hello-world/contents/invalid.txt`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Invalid content", content: "not Base64!" }),
    });
    expect(invalidContent.status).toBe(422);

    const invalidAuthor = await putFile(app, "invalid-author.txt", "hello\n", {
      author: { name: "Missing Email" },
    });
    expect(invalidAuthor.status).toBe(422);

    const after = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    expect((await after.json()) as unknown[]).toHaveLength(beforeCount);
  });

  it("uses an explicit committer as the default author", async () => {
    const identity = { name: "Fixture User", email: "fixture@example.com", date: "2024-01-02T03:04:05Z" };
    const created = await putFile(app, "identity.txt", "hello\n", { committer: identity });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      commit: { author: typeof identity; committer: typeof identity };
    };
    expect(body.commit.author).toEqual(identity);
    expect(body.commit.committer).toEqual(identity);
  });

  it("updates only the selected branch", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [initial] = (await commits.json()) as Array<{ sha: string }>;
    const branch = await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: "refs/heads/feature", sha: initial.sha }),
    });
    expect(branch.status).toBe(201);

    const created = await putFile(app, "feature.txt", "feature\n", { branch: "feature" });
    expect(created.status).toBe(201);

    const onFeature = await app.request(`${base}/repos/octocat/hello-world/contents/feature.txt?ref=feature`, {
      headers: authHeaders(),
    });
    expect(onFeature.status).toBe(200);
    const onMain = await app.request(`${base}/repos/octocat/hello-world/contents/feature.txt?ref=main`, {
      headers: authHeaders(),
    });
    expect(onMain.status).toBe(404);
  });

  it("requires an existing branch for content writes", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string }>;
    const tag = await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: "refs/tags/v1", sha: head.sha }),
    });
    expect(tag.status).toBe(201);

    expect((await putFile(app, "from-tag.txt", "tag\n", { branch: "v1" })).status).toBe(404);
    expect((await putFile(app, "from-sha.txt", "sha\n", { branch: head.sha })).status).toBe(404);

    const readme = await app.request(`${base}/repos/octocat/hello-world/contents/README.md`, {
      headers: authHeaders(),
    });
    const readmeBody = (await readme.json()) as { sha: string };
    const deleted = await app.request(`${base}/repos/octocat/hello-world/contents/README.md`, {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Delete through tag", sha: readmeBody.sha, branch: "v1" }),
    });
    expect(deleted.status).toBe(404);

    const inventedBranch = await app.request(`${base}/repos/octocat/hello-world/git/ref/heads/v1`, {
      headers: authHeaders(),
    });
    expect(inventedBranch.status).toBe(404);
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

  it("creates traversable subtrees from nested Git Data paths", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string }>;

    const tree = await app.request(`${base}/repos/octocat/hello-world/git/trees`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        tree: [{ path: "src/index.ts", mode: "100644", type: "blob", content: "export {};\n" }],
      }),
    });
    expect(tree.status).toBe(201);
    const treeBody = (await tree.json()) as {
      sha: string;
      tree: Array<{ path: string; type: string; sha: string }>;
    };
    const srcTree = treeBody.tree.find((entry) => entry.path === "src");
    expect(srcTree).toEqual(expect.objectContaining({ type: "tree", sha: expect.stringMatching(/^[0-9a-f]{40}$/) }));
    expect(treeBody.tree.some((entry) => entry.path === "src/index.ts")).toBe(false);

    const commit = await app.request(`${base}/repos/octocat/hello-world/git/commits`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Create nested tree", tree: treeBody.sha, parents: [head.sha] }),
    });
    expect(commit.status).toBe(201);
    const commitBody = (await commit.json()) as { sha: string };
    const updateRef = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/main`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sha: commitBody.sha }),
    });
    expect(updateRef.status).toBe(200);

    const root = await app.request(`${base}/repos/octocat/hello-world/contents`, { headers: authHeaders() });
    const rootBody = (await root.json()) as Array<{ name: string; type: string; sha: string; git_url: string | null }>;
    const src = rootBody.find((entry) => entry.name === "src");
    expect(src).toEqual(
      expect.objectContaining({ type: "dir", sha: srcTree!.sha, git_url: expect.stringContaining(srcTree!.sha) }),
    );
    const subtree = await app.request(src!.git_url!, { headers: authHeaders() });
    expect(subtree.status).toBe(200);
    expect((await subtree.json()) as { tree: unknown[] }).toEqual(
      expect.objectContaining({ tree: [expect.objectContaining({ path: "index.ts", type: "blob" })] }),
    );
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

  it("paginates a single commit file list and serves its raw URLs", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string }>;
    const gitCommit = await app.request(`${base}/repos/octocat/hello-world/git/commits/${head.sha}`, {
      headers: authHeaders(),
    });
    const gitCommitBody = (await gitCommit.json()) as { tree: { sha: string } };
    const tree = await app.request(`${base}/repos/octocat/hello-world/git/trees`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        base_tree: gitCommitBody.tree.sha,
        tree: ["a.txt", "b.txt", "c.txt"].map((path) => ({
          path,
          mode: "100644",
          type: "blob",
          content: `${path}\n`,
        })),
      }),
    });
    const treeBody = (await tree.json()) as { sha: string };
    const created = await app.request(`${base}/repos/octocat/hello-world/git/commits`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Add three files", tree: treeBody.sha, parents: [head.sha] }),
    });
    const createdBody = (await created.json()) as { sha: string };

    const first = await app.request(`${base}/repos/octocat/hello-world/commits/${createdBody.sha}?per_page=2&page=1`, {
      headers: authHeaders(),
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("link")).toContain('rel="next"');
    const firstBody = (await first.json()) as {
      stats: { additions: number };
      files: Array<{ filename: string; raw_url: string }>;
    };
    expect(firstBody.stats.additions).toBe(3);
    expect(firstBody.files.map((file) => file.filename)).toEqual(["a.txt", "b.txt"]);
    const raw = await app.request(firstBody.files[0].raw_url, { headers: authHeaders() });
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe("a.txt\n");

    const second = await app.request(`${base}/repos/octocat/hello-world/commits/${createdBody.sha}?per_page=2&page=2`, {
      headers: authHeaders(),
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("link")).toContain('rel="prev"');
    const secondBody = (await second.json()) as {
      stats: { additions: number };
      files: Array<{ filename: string }>;
    };
    expect(secondBody.stats.additions).toBe(3);
    expect(secondBody.files.map((file) => file.filename)).toEqual(["c.txt"]);
  });

  it("reports trailing-newline-only changes in commit diffs", async () => {
    const created = await putFile(app, "newline.txt", "x");
    const createdBody = (await created.json()) as { content: { sha: string } };
    const updated = await putFile(app, "newline.txt", "x\n", { sha: createdBody.content.sha });
    const updatedBody = (await updated.json()) as { commit: { sha: string } };

    const commit = await app.request(`${base}/repos/octocat/hello-world/commits/${updatedBody.commit.sha}`, {
      headers: authHeaders(),
    });
    const commitBody = (await commit.json()) as {
      stats: { additions: number; deletions: number };
      files: Array<{ additions: number; deletions: number; patch?: string }>;
    };
    expect(commitBody.stats).toEqual(expect.objectContaining({ additions: 1, deletions: 1 }));
    expect(commitBody.files[0]).toEqual(expect.objectContaining({ additions: 1, deletions: 1 }));
    expect(commitBody.files[0].patch).toContain("No newline at end of file");
  });

  it("reports mode-only changes in commit details and comparisons", async () => {
    const list = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await list.json()) as Array<{ sha: string }>;
    const gitCommit = await app.request(`${base}/repos/octocat/hello-world/git/commits/${head.sha}`, {
      headers: authHeaders(),
    });
    const gitCommitBody = (await gitCommit.json()) as { tree: { sha: string } };
    const readme = await app.request(`${base}/repos/octocat/hello-world/contents/README.md`, {
      headers: authHeaders(),
    });
    const readmeBody = (await readme.json()) as { sha: string };

    const tree = await app.request(`${base}/repos/octocat/hello-world/git/trees`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        base_tree: gitCommitBody.tree.sha,
        tree: [{ path: "README.md", mode: "100755", type: "blob", sha: readmeBody.sha }],
      }),
    });
    expect(tree.status).toBe(201);
    const treeBody = (await tree.json()) as { sha: string };
    const created = await app.request(`${base}/repos/octocat/hello-world/git/commits`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Make README executable", tree: treeBody.sha, parents: [head.sha] }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { sha: string };

    const commit = await app.request(`${base}/repos/octocat/hello-world/commits/${createdBody.sha}`, {
      headers: authHeaders(),
    });
    expect(commit.status).toBe(200);
    const commitBody = (await commit.json()) as {
      stats: { additions: number; deletions: number; total: number };
      files: Array<Record<string, unknown>>;
    };
    expect(commitBody.stats).toEqual({ additions: 0, deletions: 0, total: 0 });
    expect(commitBody.files).toHaveLength(1);
    expect(commitBody.files[0]).toEqual(
      expect.objectContaining({ filename: "README.md", status: "modified", additions: 0, deletions: 0, changes: 0 }),
    );
    expect(commitBody.files[0]).not.toHaveProperty("patch");

    const comparison = await app.request(`${base}/repos/octocat/hello-world/compare/${head.sha}...${createdBody.sha}`, {
      headers: authHeaders(),
    });
    expect(comparison.status).toBe(200);
    const comparisonBody = (await comparison.json()) as { files: Array<Record<string, unknown>> };
    expect(comparisonBody.files).toEqual([
      expect.objectContaining({ filename: "README.md", status: "modified", additions: 0, deletions: 0, changes: 0 }),
    ]);
  });

  it("keeps Git Data and REST commit response shapes distinct", async () => {
    const list = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await list.json()) as Array<{ sha: string }>;

    const gitData = await app.request(`${base}/repos/octocat/hello-world/git/commits/${head.sha}`, {
      headers: authHeaders(),
    });
    expect(gitData.status).toBe(200);
    const gitDataBody = (await gitData.json()) as Record<string, unknown> & {
      tree: { sha: string };
      author: { name: string; email: string; date: string };
    };
    expect(gitDataBody.tree.sha).toBeTruthy();
    expect(gitDataBody.author.email).toBeTruthy();
    expect(gitDataBody).not.toHaveProperty("commit");
    expect(gitDataBody).not.toHaveProperty("stats");
    expect(gitDataBody).not.toHaveProperty("files");

    const rest = await app.request(`${base}/repos/octocat/hello-world/commits/${head.sha}`, {
      headers: authHeaders(),
    });
    expect(rest.status).toBe(200);
    const restBody = (await rest.json()) as Record<string, unknown>;
    expect(restBody).toHaveProperty("commit");
    expect(restBody).toHaveProperty("stats");
    expect(restBody).toHaveProperty("files");
    expect(restBody).not.toHaveProperty("tree");
  });

  it("resolves documented branch, tag, and sha commit references", async () => {
    const created = await putFile(app, "notes.txt", "one\n");
    const createdBody = (await created.json()) as { commit: { sha: string } };

    const byBranch = await app.request(`${base}/repos/octocat/hello-world/commits/main`, { headers: authHeaders() });
    expect(byBranch.status).toBe(200);
    expect(((await byBranch.json()) as { sha: string }).sha).toBe(createdBody.commit.sha);

    const byHeadRef = await app.request(`${base}/repos/octocat/hello-world/commits/heads/main`, {
      headers: authHeaders(),
    });
    expect(byHeadRef.status).toBe(200);
    expect(((await byHeadRef.json()) as { sha: string }).sha).toBe(createdBody.commit.sha);

    const tag = await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: "refs/tags/v1", sha: createdBody.commit.sha }),
    });
    expect(tag.status).toBe(201);
    const byTagRef = await app.request(`${base}/repos/octocat/hello-world/commits/tags/v1`, {
      headers: authHeaders(),
    });
    expect(byTagRef.status).toBe(200);
    expect(((await byTagRef.json()) as { sha: string }).sha).toBe(createdBody.commit.sha);

    const byPrefix = await app.request(
      `${base}/repos/octocat/hello-world/commits/${createdBody.commit.sha.slice(0, 8)}`,
      { headers: authHeaders() },
    );
    expect(byPrefix.status).toBe(200);
    expect(((await byPrefix.json()) as { sha: string }).sha).toBe(createdBody.commit.sha);
  });

  it("resolves percent signs in branch and comparison route parameters", async () => {
    const list = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await list.json()) as Array<{ sha: string }>;
    const branch = await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: "refs/heads/release%", sha: head.sha }),
    });
    expect(branch.status).toBe(201);

    const commit = await app.request(`${base}/repos/octocat/hello-world/commits/release%25`, {
      headers: authHeaders(),
    });
    expect(commit.status).toBe(200);
    expect(((await commit.json()) as { sha: string }).sha).toBe(head.sha);

    const comparison = await app.request(`${base}/repos/octocat/hello-world/compare/main...release%25`, {
      headers: authHeaders(),
    });
    expect(comparison.status).toBe(200);
    expect(((await comparison.json()) as { status: string }).status).toBe("identical");

    const branchDetails = await app.request(`${base}/repos/octocat/hello-world/branches/release%25`, {
      headers: authHeaders(),
    });
    expect(branchDetails.status).toBe(200);
    expect(((await branchDetails.json()) as { name: string }).name).toBe("release%");
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

  it("paginates comparison commits and only returns files on the first page", async () => {
    const initialList = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [initial] = (await initialList.json()) as Array<{ sha: string }>;
    await putFile(app, "a.txt", "a\n");
    await putFile(app, "b.txt", "b\n");
    await putFile(app, "c.txt", "c\n");

    const first = await app.request(
      `${base}/repos/octocat/hello-world/compare/${initial.sha}...main?per_page=1&page=1`,
      { headers: authHeaders() },
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("link")).toContain('rel="next"');
    const firstBody = (await first.json()) as { total_commits: number; commits: unknown[]; files: unknown[] };
    expect(firstBody.total_commits).toBe(3);
    expect(firstBody.commits).toHaveLength(1);
    expect(firstBody.files).toHaveLength(3);

    const second = await app.request(
      `${base}/repos/octocat/hello-world/compare/${initial.sha}...main?per_page=1&page=2`,
      { headers: authHeaders() },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { total_commits: number; commits: unknown[]; files: unknown[] };
    expect(secondBody.total_commits).toBe(3);
    expect(secondBody.commits).toHaveLength(1);
    expect(secondBody.files).toHaveLength(0);
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
