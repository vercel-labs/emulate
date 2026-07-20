import { createHash } from "crypto";
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
  app.use("*", async (c, next) => {
    if (c.req.header("Authorization") === "Bearer test-app-jwt") {
      c.set("authApp", { appId: 9, slug: "contents-app", name: "Contents App" });
    }
    await next();
  });
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "outsider" }, { login: "org-member" }],
    orgs: [{ login: "acme" }],
    repos: [
      { owner: "octocat", name: "hello-world" },
      { owner: "octocat", name: "empty-repo", auto_init: false },
      { owner: "acme", name: "project" },
      { owner: "acme", name: "other" },
    ],
    apps: [
      {
        app_id: 9,
        slug: "contents-app",
        name: "Contents App",
        private_key: "test-key",
        permissions: {
          contents: "write",
          workflows: "write",
          actions: "write",
          issues: "read",
          pull_requests: "read",
        },
        installations: [
          {
            installation_id: 41,
            account: "acme",
            repository_selection: "all",
            permissions: { contents: "write", workflows: "write", actions: "write" },
          },
          {
            installation_id: 42,
            account: "octocat",
            repository_selection: "all",
            permissions: {
              contents: "read",
              issues: "read",
              pull_requests: "read",
              actions: "write",
            },
          },
        ],
      },
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

function gitObjectSha(type: "blob" | "tree" | "commit", content: Buffer): string {
  return createHash("sha1")
    .update(Buffer.from(`${type} ${content.byteLength}\0`, "utf8"))
    .update(content)
    .digest("hex");
}

function gitIdentityDate(date: string): string {
  const zone = date.match(/(Z|([+-])(\d{2}):?(\d{2}))$/i);
  const offset = !zone || zone[1].toUpperCase() === "Z" ? "+0000" : `${zone[2]}${zone[3]}${zone[4]}`;
  return `${Math.floor(Date.parse(date) / 1000)} ${offset}`;
}

function gitCommitSha(commit: {
  message: string;
  tree: { sha: string };
  parents: Array<{ sha: string }>;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
}): string {
  const headers = [`tree ${commit.tree.sha}`, ...commit.parents.map((parent) => `parent ${parent.sha}`)];
  headers.push(
    `author ${commit.author.name} <${commit.author.email}> ${gitIdentityDate(commit.author.date)}`,
    `committer ${commit.committer.name} <${commit.committer.email}> ${gitIdentityDate(commit.committer.date)}`,
  );
  const message = commit.message.endsWith("\n") ? commit.message : `${commit.message}\n`;
  return gitObjectSha("commit", Buffer.from(`${headers.join("\n")}\n\n${message}`, "utf8"));
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

async function issueInstallationToken(app: Hono, installationId: number, requestBody?: Record<string, unknown>) {
  const response = await app.request(`${base}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: jsonHeaders("test-app-jwt"),
    ...(requestBody ? { body: JSON.stringify(requestBody) } : {}),
  });
  const body = (await response.json()) as {
    token: string;
    repository_selection?: string;
    repositories?: Array<{ name: string }>;
  };
  return { response, token: body.token, body };
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
    expect(body.sha).toBe(gitObjectSha("blob", Buffer.from("# hello-world\n", "utf8")));

    const duplicateBlob = await app.request(`${base}/repos/octocat/hello-world/git/blobs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ content: "# hello-world\n", encoding: "utf-8" }),
    });
    expect(duplicateBlob.status).toBe(201);
    expect(((await duplicateBlob.json()) as { sha: string }).sha).toBe(body.sha);

    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ commit: { tree: { sha: string } } }>;
    const duplicateTree = await app.request(`${base}/repos/octocat/hello-world/git/trees`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        tree: [{ path: "README.md", mode: "100644", type: "blob", sha: body.sha }],
      }),
    });
    expect(duplicateTree.status).toBe(201);
    expect(((await duplicateTree.json()) as { sha: string }).sha).toBe(head.commit.tree.sha);

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

  it("reuses blob and untouched subtree identities", async () => {
    const createdA = await putFile(app, "a/x.txt", "one\n");
    const createdABody = (await createdA.json()) as { content: { sha: string } };
    expect(createdABody.content.sha).toBe("5626abf0f72e58d7a153368ba57db4c673c0e171");
    await putFile(app, "b/y.txt", "two\n");

    const rootBefore = await app.request(`${base}/repos/octocat/hello-world/contents`, { headers: authHeaders() });
    const rootBeforeBody = (await rootBefore.json()) as Array<{ name: string; sha: string }>;
    const bTreeSha = rootBeforeBody.find((entry) => entry.name === "b")!.sha;
    const commitsBefore = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [headBefore] = (await commitsBefore.json()) as Array<{ commit: { tree: { sha: string } } }>;

    const identical = await putFile(app, "a/x.txt", "one\n", { sha: createdABody.content.sha });
    expect(identical.status).toBe(200);
    const identicalBody = (await identical.json()) as {
      content: { sha: string };
      commit: { sha: string; tree: { sha: string } };
    };
    expect(identicalBody.content.sha).toBe(createdABody.content.sha);
    expect(identicalBody.commit.tree.sha).toBe(headBefore.commit.tree.sha);

    const identicalCommit = await app.request(`${base}/repos/octocat/hello-world/commits/${identicalBody.commit.sha}`, {
      headers: authHeaders(),
    });
    expect((await identicalCommit.json()) as { files: unknown[] }).toEqual(expect.objectContaining({ files: [] }));

    const changed = await putFile(app, "a/x.txt", "changed\n", { sha: createdABody.content.sha });
    expect(changed.status).toBe(200);
    const rootAfter = await app.request(`${base}/repos/octocat/hello-world/contents`, { headers: authHeaders() });
    const rootAfterBody = (await rootAfter.json()) as Array<{ name: string; sha: string }>;
    expect(rootAfterBody.find((entry) => entry.name === "b")!.sha).toBe(bTreeSha);
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
    const updatedBody = (await updated.json()) as { content: { sha: string }; commit: { sha: string } };

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

    const deletionCommit = await app.request(`${base}/repos/octocat/hello-world/commits/${deletedBody.commit.sha}`, {
      headers: authHeaders(),
    });
    expect(deletionCommit.status).toBe(200);
    const deletionCommitBody = (await deletionCommit.json()) as {
      files: Array<{ status: string; raw_url: string; contents_url: string }>;
    };
    const removed = deletionCommitBody.files[0];
    expect(removed.status).toBe("removed");
    expect(removed.raw_url).toContain(updatedBody.commit.sha);
    expect(removed.contents_url).toContain(`ref=${updatedBody.commit.sha}`);
    const removedRaw = await app.request(removed.raw_url, { headers: authHeaders() });
    expect(removedRaw.status).toBe(200);
    expect(await removedRaw.text()).toBe("two\n");
    const removedContents = await app.request(removed.contents_url, { headers: authHeaders() });
    expect(removedContents.status).toBe(200);

    const comparison = await app.request(
      `${base}/repos/octocat/hello-world/compare/${updatedBody.commit.sha}...${deletedBody.commit.sha}`,
      { headers: authHeaders() },
    );
    expect(comparison.status).toBe(200);
    const comparisonBody = (await comparison.json()) as {
      files: Array<{ status: string; raw_url: string; contents_url: string }>;
    };
    expect(comparisonBody.files[0]).toEqual(
      expect.objectContaining({
        status: "removed",
        raw_url: expect.stringContaining(updatedBody.commit.sha),
        contents_url: expect.stringContaining(`ref=${updatedBody.commit.sha}`),
      }),
    );

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

  it("uses installation repository access and Contents permissions for writes", async () => {
    const { app } = createTestApp();
    const orgInstallation = await issueInstallationToken(app, 41, { repositories: ["project"] });
    expect(orgInstallation.response.status).toBe(201);
    expect(orgInstallation.body.repository_selection).toBe("selected");
    expect(orgInstallation.body.repositories?.map((repo) => repo.name)).toEqual(["project"]);
    const userInstallation = await issueInstallationToken(app, 42);
    expect(userInstallation.response.status).toBe(201);
    const escalated = await issueInstallationToken(app, 42, { permissions: { contents: "write" } });
    expect(escalated.response.status).toBe(422);

    const orgWrite = await app.request(`${base}/repos/acme/project/contents/installed.txt`, {
      method: "PUT",
      headers: jsonHeaders(orgInstallation.token),
      body: JSON.stringify({
        message: "Write through installation",
        content: Buffer.from("installed\n").toString("base64"),
      }),
    });
    expect(orgWrite.status).toBe(201);

    const outsideSelection = await app.request(`${base}/repos/acme/other/contents/blocked.txt`, {
      method: "PUT",
      headers: jsonHeaders(orgInstallation.token),
      body: JSON.stringify({
        message: "Write outside installation",
        content: Buffer.from("blocked\n").toString("base64"),
      }),
    });
    expect(outsideSelection.status).toBe(403);

    const readOnlyWrite = await app.request(`${base}/repos/octocat/hello-world/contents/read-only.txt`, {
      method: "PUT",
      headers: jsonHeaders(userInstallation.token),
      body: JSON.stringify({
        message: "Write with read permission",
        content: Buffer.from("blocked\n").toString("base64"),
      }),
    });
    expect(readOnlyWrite.status).toBe(403);
  });

  it("requires Workflows write permission for Contents mutations under .github/workflows", async () => {
    const { app } = createTestApp();
    const contentsOnly = await issueInstallationToken(app, 41, {
      repositories: ["project"],
      permissions: { contents: "write" },
    });
    const workflowWriter = await issueInstallationToken(app, 41, {
      repositories: ["project"],
      permissions: { contents: "write", workflows: "write" },
    });
    expect(contentsOnly.response.status).toBe(201);
    expect(workflowWriter.response.status).toBe(201);

    const createFile = (path: string, token: string) =>
      app.request(`${base}/repos/acme/project/contents/${path}`, {
        method: "PUT",
        headers: jsonHeaders(token),
        body: JSON.stringify({
          message: `Create ${path}`,
          content: Buffer.from("name: CI\n", "utf8").toString("base64"),
        }),
      });

    expect((await createFile("ordinary.txt", contentsOnly.token)).status).toBe(201);
    expect((await createFile(".github/workflows/ci.yml", contentsOnly.token)).status).toBe(403);

    const created = await createFile(".github/workflows/ci.yml", workflowWriter.token);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { content: { sha: string } };
    const deleteWorkflow = (token: string) =>
      app.request(`${base}/repos/acme/project/contents/.github/workflows/ci.yml`, {
        method: "DELETE",
        headers: jsonHeaders(token),
        body: JSON.stringify({ message: "Delete workflow", sha: createdBody.content.sha }),
      });

    expect((await deleteWorkflow(contentsOnly.token)).status).toBe(403);
    expect((await deleteWorkflow(workflowWriter.token)).status).toBe(200);
  });

  it("requires Actions write permission to dispatch a workflow", async () => {
    const { app, store } = createTestApp();
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    const workflow = gh.workflows.insert({
      node_id: "workflow-node",
      repo_id: repo.id,
      name: "CI",
      path: ".github/workflows/ci.yml",
      state: "active",
      badge_url: `${base}/repos/octocat/hello-world/actions/workflows/ci.yml/badge.svg`,
    });
    const reader = await issueInstallationToken(app, 42, { permissions: { actions: "read" } });
    const writer = await issueInstallationToken(app, 42, { permissions: { actions: "write" } });
    expect(reader.response.status).toBe(201);
    expect(writer.response.status).toBe(201);

    const dispatch = (token: string) =>
      app.request(`${base}/repos/octocat/hello-world/actions/workflows/${workflow.id}/dispatches`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify({ ref: "main" }),
      });

    expect((await dispatch(reader.token)).status).toBe(403);
    expect(gh.workflowRuns.findBy("repo_id", repo.id)).toHaveLength(0);
    expect((await dispatch(writer.token)).status).toBe(204);
    const [run] = gh.workflowRuns.findBy("repo_id", repo.id);
    expect(run).toBeDefined();
    expect(gh.users.get(run.actor_id)?.login).toBe("contents-app[bot]");
  });

  it("keeps installation writes within selected public repositories", async () => {
    const { app, store } = createTestApp();
    const gh = getGitHubStore(store);
    const project = gh.repos.findOneBy("full_name", "acme/project")!;
    const other = gh.repos.findOneBy("full_name", "acme/other")!;
    const createWorkflow = (repoId: number, fullName: string) =>
      gh.workflows.insert({
        node_id: `workflow-${repoId}`,
        repo_id: repoId,
        name: "CI",
        path: ".github/workflows/ci.yml",
        state: "active",
        badge_url: `${base}/repos/${fullName}/actions/workflows/ci.yml/badge.svg`,
      });
    const selectedWorkflow = createWorkflow(project.id, project.full_name);
    const outsideWorkflow = createWorkflow(other.id, other.full_name);
    const installation = await issueInstallationToken(app, 41, {
      repositories: ["project"],
      permissions: { actions: "write" },
    });
    expect(installation.response.status).toBe(201);

    const dispatch = (repoName: string, workflowId: number) =>
      app.request(`${base}/repos/acme/${repoName}/actions/workflows/${workflowId}/dispatches`, {
        method: "POST",
        headers: jsonHeaders(installation.token),
        body: JSON.stringify({ ref: "main" }),
      });

    expect((await dispatch("project", selectedWorkflow.id)).status).toBe(204);
    expect((await dispatch("other", outsideWorkflow.id)).status).toBe(403);
    const [run] = gh.workflowRuns.findBy("repo_id", project.id);
    expect(gh.users.get(run.actor_id)?.login).toBe("contents-app[bot]");
    expect(gh.workflowRuns.findBy("repo_id", other.id)).toHaveLength(0);
  });

  it("requires Contents permission for installation reads from private repositories", async () => {
    const { app, store } = createTestApp();
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    gh.repos.update(repo.id, { private: true });

    const noContents = await issueInstallationToken(app, 42, { permissions: {} });
    expect(noContents.response.status).toBe(201);
    const readContents = await issueInstallationToken(app, 42);
    expect(readContents.response.status).toBe(201);

    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string }>;
    const gitCommit = await app.request(`${base}/repos/octocat/hello-world/git/commits/${head.sha}`, {
      headers: authHeaders(),
    });
    const gitCommitBody = (await gitCommit.json()) as { tree: { sha: string } };
    const readme = await app.request(`${base}/repos/octocat/hello-world/contents/README.md`, {
      headers: authHeaders(),
    });
    const readmeBody = (await readme.json()) as { sha: string };

    const protectedUrls = [
      `${base}/repos/octocat/hello-world/contents/README.md`,
      `${base}/repos/octocat/hello-world/readme`,
      `${base}/octocat/hello-world/raw/main/README.md`,
      `${base}/repos/octocat/hello-world/commits`,
      `${base}/repos/octocat/hello-world/commits/${head.sha}`,
      `${base}/repos/octocat/hello-world/compare/${head.sha}...${head.sha}`,
      `${base}/repos/octocat/hello-world/git/commits/${head.sha}`,
      `${base}/repos/octocat/hello-world/git/trees/${gitCommitBody.tree.sha}`,
      `${base}/repos/octocat/hello-world/git/blobs/${readmeBody.sha}`,
    ];

    for (const url of protectedUrls) {
      expect((await app.request(url, { headers: authHeaders(noContents.token) })).status, url).toBe(403);
      expect((await app.request(url, { headers: authHeaders(readContents.token) })).status, url).toBe(200);
    }

    const searches = [
      `${base}/search/code?q=${encodeURIComponent("hello-world repo:octocat/hello-world")}`,
      `${base}/search/commits?q=${encodeURIComponent("Initial commit repo:octocat/hello-world")}`,
    ];
    for (const url of searches) {
      const denied = await app.request(url, { headers: authHeaders(noContents.token) });
      expect(denied.status, url).toBe(200);
      expect((await denied.json()) as { total_count: number }).toEqual(expect.objectContaining({ total_count: 0 }));

      const allowed = await app.request(url, { headers: authHeaders(readContents.token) });
      expect(allowed.status, url).toBe(200);
      expect(((await allowed.json()) as { total_count: number }).total_count, url).toBeGreaterThan(0);
    }
  });

  it("enforces endpoint-specific installation permissions on private repository reads", async () => {
    const { app, store } = createTestApp();
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    gh.repos.update(repo.id, { private: true });

    const contents = await issueInstallationToken(app, 42, { permissions: { contents: "read" } });
    const issues = await issueInstallationToken(app, 42, { permissions: { issues: "read" } });
    const pulls = await issueInstallationToken(app, 42, { permissions: { pull_requests: "read" } });
    expect(contents.response.status).toBe(201);
    expect(issues.response.status).toBe(201);
    expect(pulls.response.status).toBe(201);

    const urls = {
      contents: `${base}/repos/octocat/hello-world/branches`,
      refs: `${base}/repos/octocat/hello-world/git/ref/heads/main`,
      issues: `${base}/repos/octocat/hello-world/issues`,
      pulls: `${base}/repos/octocat/hello-world/pulls`,
    };

    expect((await app.request(urls.contents, { headers: authHeaders(contents.token) })).status).toBe(200);
    expect((await app.request(urls.refs, { headers: authHeaders(contents.token) })).status).toBe(200);
    expect((await app.request(urls.issues, { headers: authHeaders(contents.token) })).status).toBe(403);
    expect((await app.request(urls.pulls, { headers: authHeaders(contents.token) })).status).toBe(403);

    expect((await app.request(urls.issues, { headers: authHeaders(issues.token) })).status).toBe(200);
    expect((await app.request(urls.contents, { headers: authHeaders(issues.token) })).status).toBe(403);
    expect((await app.request(urls.refs, { headers: authHeaders(issues.token) })).status).toBe(403);
    expect((await app.request(urls.pulls, { headers: authHeaders(issues.token) })).status).toBe(403);

    expect((await app.request(urls.pulls, { headers: authHeaders(pulls.token) })).status).toBe(200);
    expect((await app.request(urls.contents, { headers: authHeaders(pulls.token) })).status).toBe(403);
    expect((await app.request(urls.refs, { headers: authHeaders(pulls.token) })).status).toBe(403);
    expect((await app.request(urls.issues, { headers: authHeaders(pulls.token) })).status).toBe(403);
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

  it("associates and filters commit authors and committers independently", async () => {
    const external = { name: "External", email: "external@example.com" };
    const created = await putFile(app, "external.txt", "external\n", { author: external });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { commit: { sha: string } };

    const commit = await app.request(`${base}/repos/octocat/hello-world/commits/${createdBody.commit.sha}`, {
      headers: authHeaders(),
    });
    expect(commit.status).toBe(200);
    const commitBody = (await commit.json()) as {
      commit: { author: { email: string }; committer: { email: string } };
      author: { login: string } | null;
      committer: { login: string } | null;
    };
    expect(commitBody.commit.author.email).toBe(external.email);
    expect(commitBody.commit.committer.email).toBe("octocat@users.noreply.github.com");
    expect(commitBody.author).toBeNull();
    expect(commitBody.committer?.login).toBe("octocat");

    const byExternalEmail = await app.request(
      `${base}/repos/octocat/hello-world/commits?author=${encodeURIComponent(external.email)}`,
      { headers: authHeaders() },
    );
    expect(((await byExternalEmail.json()) as Array<{ sha: string }>).map((item) => item.sha)).toContain(
      createdBody.commit.sha,
    );

    const byActor = await app.request(`${base}/repos/octocat/hello-world/commits?author=octocat`, {
      headers: authHeaders(),
    });
    expect(((await byActor.json()) as Array<{ sha: string }>).map((item) => item.sha)).not.toContain(
      createdBody.commit.sha,
    );

    const byCommitter = await app.request(`${base}/repos/octocat/hello-world/commits?committer=octocat`, {
      headers: authHeaders(),
    });
    expect(((await byCommitter.json()) as Array<{ sha: string }>).map((item) => item.sha)).toContain(
      createdBody.commit.sha,
    );
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

  it("enforces protected-branch requirements for contents writes and ref updates", async () => {
    const { app, store } = createTestApp();
    const gh = getGitHubStore(store);
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
        tree: [{ path: "via-ref.txt", mode: "100644", type: "blob", content: "via ref\n" }],
      }),
    });
    const treeBody = (await tree.json()) as { sha: string };
    const pending = await app.request(`${base}/repos/octocat/hello-world/git/commits`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Pending protected update", tree: treeBody.sha, parents: [head.sha] }),
    });
    const pendingBody = (await pending.json()) as { sha: string };

    const protectionBody = {
      required_status_checks: null,
      enforce_admins: true,
      required_pull_request_reviews: { required_approving_review_count: 1 },
      restrictions: null,
      required_linear_history: false,
      allow_force_pushes: false,
      allow_deletions: false,
      required_signatures: false,
    };
    const protect = await app.request(`${base}/repos/octocat/hello-world/branches/main/protection`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify(protectionBody),
    });
    expect(protect.status).toBe(200);

    const blobCount = gh.blobs.findBy("repo_id", gh.repos.findOneBy("full_name", "octocat/hello-world")!.id).length;
    expect((await putFile(app, "blocked.txt", "blocked\n")).status).toBe(409);
    expect(gh.blobs.findBy("repo_id", gh.repos.findOneBy("full_name", "octocat/hello-world")!.id)).toHaveLength(
      blobCount,
    );

    const readme = await app.request(`${base}/repos/octocat/hello-world/contents/README.md`, {
      headers: authHeaders(),
    });
    const readmeBody = (await readme.json()) as { sha: string };
    const blockedDelete = await app.request(`${base}/repos/octocat/hello-world/contents/README.md`, {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Blocked delete", sha: readmeBody.sha }),
    });
    expect(blockedDelete.status).toBe(409);

    const blockedRef = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/main`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sha: pendingBody.sha }),
    });
    expect(blockedRef.status).toBe(409);
    const unchangedRef = await app.request(`${base}/repos/octocat/hello-world/git/ref/heads/main`, {
      headers: authHeaders(),
    });
    expect(((await unchangedRef.json()) as { object: { sha: string } }).object.sha).toBe(head.sha);

    const allowAdminBypass = await app.request(`${base}/repos/octocat/hello-world/branches/main/protection`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({ ...protectionBody, enforce_admins: false }),
    });
    expect(allowAdminBypass.status).toBe(200);
    expect((await putFile(app, "allowed.txt", "allowed\n")).status).toBe(201);
  });

  it("allows protected ref updates after every required check succeeds on the target commit", async () => {
    const list = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await list.json()) as Array<{ sha: string; commit: { tree: { sha: string } } }>;
    const tree = await app.request(`${base}/repos/octocat/hello-world/git/trees`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        base_tree: head.commit.tree.sha,
        tree: [{ path: "checked.txt", mode: "100644", type: "blob", content: "checked\n" }],
      }),
    });
    const treeBody = (await tree.json()) as { sha: string };
    const pending = await app.request(`${base}/repos/octocat/hello-world/git/commits`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Checked update", tree: treeBody.sha, parents: [head.sha] }),
    });
    const pendingBody = (await pending.json()) as { sha: string };

    const protect = await app.request(`${base}/repos/octocat/hello-world/branches/main/protection`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({
        required_status_checks: { strict: false, contexts: ["ci"] },
        enforce_admins: true,
        required_pull_request_reviews: null,
        restrictions: null,
        required_linear_history: false,
        allow_force_pushes: false,
        allow_deletions: false,
        required_signatures: false,
      }),
    });
    expect(protect.status).toBe(200);

    const update = () =>
      app.request(`${base}/repos/octocat/hello-world/git/refs/heads/main`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ sha: pendingBody.sha }),
      });
    expect((await update()).status).toBe(409);

    const check = await app.request(`${base}/repos/octocat/hello-world/check-runs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "ci", head_sha: pendingBody.sha, status: "completed", conclusion: "success" }),
    });
    expect(check.status).toBe(201);
    expect((await update()).status).toBe(200);
  });

  it("rejects merge commits anywhere in a protected linear-history update range", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [baseCommit] = (await commits.json()) as Array<{ sha: string; commit: { tree: { sha: string } } }>;
    const createCommit = async (message: string, parents: string[]) => {
      const response = await app.request(`${base}/repos/octocat/hello-world/git/commits`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ message, tree: baseCommit.commit.tree.sha, parents }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { sha: string };
    };
    const side = await createCommit("Side commit", [baseCommit.sha]);
    const merge = await createCommit("Merge commit", [baseCommit.sha, side.sha]);
    const tip = await createCommit("Tip commit", [merge.sha]);

    const protection = await app.request(`${base}/repos/octocat/hello-world/branches/main/protection`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({
        required_status_checks: null,
        enforce_admins: true,
        required_pull_request_reviews: null,
        restrictions: null,
        required_linear_history: true,
        allow_force_pushes: false,
        allow_deletions: false,
        required_signatures: false,
      }),
    });
    expect(protection.status).toBe(200);

    const update = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/main`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sha: tip.sha }),
    });
    expect(update.status).toBe(409);
    const current = await app.request(`${base}/repos/octocat/hello-world/git/ref/heads/main`, {
      headers: authHeaders(),
    });
    expect((await current.json()) as { object: { sha: string } }).toEqual(
      expect.objectContaining({ object: expect.objectContaining({ sha: baseCommit.sha }) }),
    );
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

    const recursive = await app.request(`${base}/repos/octocat/hello-world/git/trees/${treeBody.sha}?recursive=1`, {
      headers: authHeaders(),
    });
    expect(recursive.status).toBe(200);
    const recursiveBody = (await recursive.json()) as { tree: Array<{ path: string; type: string }> };
    expect(recursiveBody.tree).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src", type: "tree" }),
        expect.objectContaining({ path: "src/index.ts", type: "blob" }),
      ]),
    );
  });

  it("applies nested tree updates independently of input order", async () => {
    const subtree = await app.request(`${base}/repos/octocat/hello-world/git/trees`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        tree: [{ path: "base.txt", mode: "100644", type: "blob", content: "base\n" }],
      }),
    });
    expect(subtree.status).toBe(201);
    const subtreeBody = (await subtree.json()) as { sha: string };
    const directory = { path: "dir", mode: "040000", type: "tree", sha: subtreeBody.sha };
    const nested = { path: "dir/file.txt", mode: "100644", type: "blob", content: "nested\n" };

    const create = (tree: Array<Record<string, unknown>>) =>
      app.request(`${base}/repos/octocat/hello-world/git/trees`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ tree }),
      });
    const nestedFirst = await create([nested, directory]);
    const directoryFirst = await create([directory, nested]);
    expect(nestedFirst.status).toBe(201);
    expect(directoryFirst.status).toBe(201);
    const nestedFirstBody = (await nestedFirst.json()) as { sha: string };
    const directoryFirstBody = (await directoryFirst.json()) as { sha: string };
    expect(nestedFirstBody.sha).toBe(directoryFirstBody.sha);

    const recursive = await app.request(
      `${base}/repos/octocat/hello-world/git/trees/${nestedFirstBody.sha}?recursive=1`,
      { headers: authHeaders() },
    );
    expect(recursive.status).toBe(200);
    const recursiveBody = (await recursive.json()) as { tree: Array<{ path: string }> };
    expect(recursiveBody.tree.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["dir", "dir/base.txt", "dir/file.txt"]),
    );
  });

  it("supports documented Git tree modes and rejects invalid mode and type pairs", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ commit: { tree: { sha: string } } }>;
    const submoduleSha = "a".repeat(40);
    const valid = await app.request(`${base}/repos/octocat/hello-world/git/trees`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        tree: [
          { path: "regular", mode: "100644", type: "blob", content: "regular\n" },
          { path: "executable", mode: "100755", type: "blob", content: "executable\n" },
          { path: "link", mode: "120000", type: "blob", content: "regular" },
          { path: "directory", mode: "040000", type: "tree", sha: head.commit.tree.sha },
          { path: "module", mode: "160000", type: "commit", sha: submoduleSha },
        ],
      }),
    });
    expect(valid.status).toBe(201);
    expect((await valid.json()) as { tree: unknown[] }).toEqual(
      expect.objectContaining({
        tree: expect.arrayContaining([
          expect.objectContaining({ path: "link", mode: "120000", type: "blob" }),
          expect.objectContaining({ path: "module", mode: "160000", type: "commit", sha: submoduleSha }),
        ]),
      }),
    );

    const invalidEntries = [
      { path: "bad", mode: "100600", type: "blob", content: "bad" },
      { path: "bad", mode: "100644", type: "tree", sha: head.commit.tree.sha },
      { path: "bad", mode: "040000", type: "blob", content: "bad" },
      { path: "bad", mode: "160000", type: "blob", content: "bad" },
      { path: "bad", mode: "120000", type: "commit", sha: submoduleSha },
      { path: "bad", mode: "160000", type: "commit", sha: "not-a-sha" },
    ];
    for (const entry of invalidEntries) {
      const response = await app.request(`${base}/repos/octocat/hello-world/git/trees`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ tree: [entry] }),
      });
      expect(response.status, JSON.stringify(entry)).toBe(422);
    }
  });

  it("formats symlinks and submodules through the Contents API", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string; commit: { tree: { sha: string } } }>;
    const submoduleSha = "c".repeat(40);
    const gitmodules = [
      '[submodule "vendor/mod"]',
      "\tpath = vendor/mod",
      "\turl = https://github.com/acme/dependency.git",
      "",
    ].join("\n");
    const tree = await app.request(`${base}/repos/octocat/hello-world/git/trees`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        base_tree: head.commit.tree.sha,
        tree: [
          { path: ".gitmodules", mode: "100644", type: "blob", content: gitmodules },
          { path: "target.txt", mode: "100644", type: "blob", content: "target\n" },
          { path: "link.txt", mode: "120000", type: "blob", content: "target.txt" },
          { path: "broken-link", mode: "120000", type: "blob", content: "missing.txt" },
          { path: "vendor/mod", mode: "160000", type: "commit", sha: submoduleSha },
        ],
      }),
    });
    expect(tree.status).toBe(201);
    const treeBody = (await tree.json()) as { sha: string };
    const commit = await app.request(`${base}/repos/octocat/hello-world/git/commits`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Add special entries", tree: treeBody.sha, parents: [head.sha] }),
    });
    expect(commit.status).toBe(201);
    const commitBody = (await commit.json()) as { sha: string };
    const update = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/main`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sha: commitBody.sha }),
    });
    expect(update.status).toBe(200);

    const link = await app.request(`${base}/repos/octocat/hello-world/contents/link.txt`, {
      headers: authHeaders(),
    });
    expect(link.status).toBe(200);
    const linkBody = (await link.json()) as { type: string; content: string };
    expect(linkBody.type).toBe("file");
    expect(Buffer.from(linkBody.content, "base64").toString("utf8")).toBe("target\n");
    const rawLink = await app.request(`${base}/octocat/hello-world/raw/main/link.txt`, { headers: authHeaders() });
    expect(rawLink.status).toBe(200);
    expect(await rawLink.text()).toBe("target\n");

    const broken = await app.request(`${base}/repos/octocat/hello-world/contents/broken-link`, {
      headers: authHeaders(),
    });
    expect(broken.status).toBe(200);
    expect(await broken.json()).toEqual(
      expect.objectContaining({ type: "symlink", target: "missing.txt", size: "missing.txt".length }),
    );

    const submodule = await app.request(`${base}/repos/octocat/hello-world/contents/vendor/mod`, {
      headers: authHeaders(),
    });
    expect(submodule.status).toBe(200);
    expect(await submodule.json()).toEqual(
      expect.objectContaining({
        type: "submodule",
        submodule_git_url: "https://github.com/acme/dependency.git",
        sha: submoduleSha,
        download_url: null,
        git_url: `${base}/repos/acme/dependency/git/trees/${submoduleSha}`,
        html_url: `${base}/acme/dependency/tree/${submoduleSha}`,
      }),
    );
    const listing = await app.request(`${base}/repos/octocat/hello-world/contents/vendor`, {
      headers: authHeaders(),
    });
    expect(listing.status).toBe(200);
    expect(await listing.json()).toEqual([
      expect.objectContaining({
        type: "file",
        name: "mod",
        submodule_git_url: "https://github.com/acme/dependency.git",
        download_url: null,
      }),
    ]);
  });

  it("preserves submodules when Contents writes rebuild a neighboring tree", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string; commit: { tree: { sha: string } } }>;
    const submoduleSha = "b".repeat(40);
    const tree = await app.request(`${base}/repos/octocat/hello-world/git/trees`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        base_tree: head.commit.tree.sha,
        tree: [{ path: "vendor/mod", mode: "160000", type: "commit", sha: submoduleSha }],
      }),
    });
    expect(tree.status).toBe(201);
    const treeBody = (await tree.json()) as { sha: string };
    const commit = await app.request(`${base}/repos/octocat/hello-world/git/commits`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Add submodule", tree: treeBody.sha, parents: [head.sha] }),
    });
    expect(commit.status).toBe(201);
    const commitBody = (await commit.json()) as { sha: string };
    const update = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/main`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sha: commitBody.sha }),
    });
    expect(update.status).toBe(200);

    expect((await putFile(app, "vendor/other.txt", "neighbor\n")).status).toBe(201);
    const recursive = await app.request(`${base}/repos/octocat/hello-world/git/trees/main?recursive=1`, {
      headers: authHeaders(),
    });
    expect(recursive.status).toBe(200);
    expect((await recursive.json()) as { tree: unknown[] }).toEqual(
      expect.objectContaining({
        tree: expect.arrayContaining([
          expect.objectContaining({ path: "vendor/mod", mode: "160000", type: "commit", sha: submoduleSha }),
          expect.objectContaining({ path: "vendor/other.txt", mode: "100644", type: "blob" }),
        ]),
      }),
    );
  });

  it("gets trees by branch and tag refs", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string; commit: { tree: { sha: string } } }>;
    const tag = await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: "refs/tags/tree-test", sha: head.sha }),
    });
    expect(tag.status).toBe(201);

    for (const ref of ["main", "tree-test"]) {
      const response = await app.request(`${base}/repos/octocat/hello-world/git/trees/${ref}`, {
        headers: authHeaders(),
      });
      expect(response.status, ref).toBe(200);
      expect(await response.json()).toEqual(expect.objectContaining({ sha: head.commit.tree.sha }));
    }
  });

  it("deletes base-tree entries whose SHA is null", async () => {
    const created = await putFile(app, "src/remove.txt", "remove me\n");
    const createdBody = (await created.json()) as { commit: { sha: string; tree: { sha: string } } };

    const tree = await app.request(`${base}/repos/octocat/hello-world/git/trees`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        base_tree: createdBody.commit.tree.sha,
        tree: [{ path: "src/remove.txt", mode: "100644", type: "blob", sha: null }],
      }),
    });
    expect(tree.status).toBe(201);
    const treeBody = (await tree.json()) as { sha: string };

    const nonexistent = await app.request(`${base}/repos/octocat/hello-world/git/trees`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        base_tree: createdBody.commit.tree.sha,
        tree: [{ path: "src/missing.txt", mode: "100644", type: "blob", sha: null }],
      }),
    });
    expect(nonexistent.status).toBe(422);

    const commit = await app.request(`${base}/repos/octocat/hello-world/git/commits`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        message: "Delete through Git Data",
        tree: treeBody.sha,
        parents: [createdBody.commit.sha],
      }),
    });
    expect(commit.status).toBe(201);
    const commitBody = (await commit.json()) as { sha: string };

    const updateRef = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/main`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sha: commitBody.sha }),
    });
    expect(updateRef.status).toBe(200);

    const removed = await app.request(`${base}/repos/octocat/hello-world/contents/src/remove.txt`, {
      headers: authHeaders(),
    });
    expect(removed.status).toBe(404);
  });

  it("initializes an empty repository even when loose Git objects exist", async () => {
    const blob = await app.request(`${base}/repos/octocat/empty-repo/git/blobs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ content: "loose\n", encoding: "utf-8" }),
    });
    expect(blob.status).toBe(201);
    const blobBody = (await blob.json()) as { sha: string };
    const tree = await app.request(`${base}/repos/octocat/empty-repo/git/trees`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        tree: [{ path: "loose.txt", mode: "100644", type: "blob", sha: blobBody.sha }],
      }),
    });
    expect(tree.status).toBe(201);
    const treeBody = (await tree.json()) as { sha: string };
    const looseCommit = await app.request(`${base}/repos/octocat/empty-repo/git/commits`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Loose commit", tree: treeBody.sha, parents: [] }),
    });
    expect(looseCommit.status).toBe(201);

    const initialized = await app.request(`${base}/repos/octocat/empty-repo/contents/README.md`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({
        message: "Initialize repository",
        content: Buffer.from("# Empty\n", "utf8").toString("base64"),
      }),
    });
    expect(initialized.status).toBe(201);
    const initializedBody = (await initialized.json()) as { commit: { parents: unknown[] } };
    expect(initializedBody.commit.parents).toEqual([]);

    const contents = await app.request(`${base}/repos/octocat/empty-repo/contents/README.md`, {
      headers: authHeaders(),
    });
    expect(contents.status).toBe(200);
  });

  it("keeps archived repositories read-only across Contents and Git Data", async () => {
    const { app, store } = createTestApp();
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    gh.repos.update(repo.id, { archived: true });

    const read = await app.request(`${base}/repos/octocat/hello-world/contents/README.md`, {
      headers: authHeaders(),
    });
    expect(read.status).toBe(200);

    const contentsWrite = await putFile(app, "archived.txt", "blocked\n");
    expect(contentsWrite.status).toBe(403);
    expect((await contentsWrite.json()) as { message: string }).toEqual(
      expect.objectContaining({ message: "Repository was archived so is read-only." }),
    );

    const blobWrite = await app.request(`${base}/repos/octocat/hello-world/git/blobs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ content: "blocked", encoding: "utf-8" }),
    });
    expect(blobWrite.status).toBe(403);
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

  it("keeps the branch head before newer-dated parents", async () => {
    const list = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await list.json()) as Array<{ sha: string; commit: { tree: { sha: string } } }>;
    const oldIdentity = { name: "Old Commit", email: "old@example.com", date: "2000-01-02T03:04:05Z" };
    const created = await app.request(`${base}/repos/octocat/hello-world/git/commits`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        message: "Old-dated child",
        tree: head.commit.tree.sha,
        parents: [head.sha],
        author: oldIdentity,
        committer: oldIdentity,
      }),
    });
    const createdBody = (await created.json()) as { sha: string };
    const updated = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/main`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sha: createdBody.sha }),
    });
    expect(updated.status).toBe(200);

    const firstPage = await app.request(`${base}/repos/octocat/hello-world/commits?per_page=1`, {
      headers: authHeaders(),
    });
    expect(((await firstPage.json()) as Array<{ sha: string }>)[0].sha).toBe(createdBody.sha);
  });

  it("uses canonical Git identities for Git Data and Contents commits", async () => {
    const list = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await list.json()) as Array<{ sha: string; commit: { tree: { sha: string } } }>;
    const identity = { name: "Fixture User", email: "fixture@example.com", date: "2024-01-02T03:04:05Z" };
    const requestBody = {
      message: "Deterministic commit",
      tree: head.commit.tree.sha,
      parents: [head.sha],
      author: identity,
      committer: identity,
    };
    const createGitCommit = () =>
      app.request(`${base}/repos/octocat/hello-world/git/commits`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(requestBody),
      });

    const first = await createGitCommit();
    const firstBody = (await first.json()) as {
      sha: string;
      message: string;
      tree: { sha: string };
      parents: Array<{ sha: string }>;
      author: typeof identity;
      committer: typeof identity;
    };
    const second = await createGitCommit();
    const secondBody = (await second.json()) as { sha: string };
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(firstBody.sha).toBe(gitCommitSha(firstBody));
    expect(secondBody.sha).toBe(firstBody.sha);

    const contents = await putFile(app, "canonical.txt", "canonical\n", {
      author: identity,
      committer: identity,
    });
    const contentsBody = (await contents.json()) as {
      commit: {
        sha: string;
        message: string;
        tree: { sha: string };
        parents: Array<{ sha: string }>;
        author: typeof identity;
        committer: typeof identity;
      };
    };
    expect(contents.status).toBe(201);
    expect(contentsBody.commit.sha).toBe(gitCommitSha(contentsBody.commit));
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

  it("filters commits by directory path", async () => {
    await putFile(app, "src/index.ts", "one\n");
    await putFile(app, "src/nested/file.ts", "two\n");
    await putFile(app, "outside.ts", "outside\n");

    const res = await app.request(`${base}/repos/octocat/hello-world/commits?path=src`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ commit: { message: string } }>;
    expect(body.map((item) => item.commit.message)).toEqual(["Update src/nested/file.ts", "Update src/index.ts"]);
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

  it("reports sparse changes accurately in large files", async () => {
    const original = Array.from({ length: 1_000 }, (_, index) => `line ${index + 1}\n`);
    const created = await putFile(app, "large.txt", original.join(""));
    const createdBody = (await created.json()) as { content: { sha: string } };

    const changed = [...original];
    changed[99] = "changed line 100\n";
    changed[899] = "changed line 900\n";
    const updated = await putFile(app, "large.txt", changed.join(""), { sha: createdBody.content.sha });
    const updatedBody = (await updated.json()) as { commit: { sha: string } };

    const commit = await app.request(`${base}/repos/octocat/hello-world/commits/${updatedBody.commit.sha}`, {
      headers: authHeaders(),
    });
    expect(commit.status).toBe(200);
    const commitBody = (await commit.json()) as {
      stats: { additions: number; deletions: number };
      files: Array<{ additions: number; deletions: number; patch?: string }>;
    };
    expect(commitBody.stats).toEqual(expect.objectContaining({ additions: 2, deletions: 2 }));
    expect(commitBody.files[0]).toEqual(expect.objectContaining({ additions: 2, deletions: 2 }));
    expect(commitBody.files[0].patch).toContain("changed line 100");
    expect(commitBody.files[0].patch).toContain("changed line 900");
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

    const updateRef = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/main`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sha: createdBody.sha }),
    });
    expect(updateRef.status).toBe(200);

    const pathHistory = await app.request(`${base}/repos/octocat/hello-world/commits?path=README.md`, {
      headers: authHeaders(),
    });
    expect(pathHistory.status).toBe(200);
    expect(((await pathHistory.json()) as Array<{ sha: string }>).map((item) => item.sha)).toContain(createdBody.sha);

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

  it("reports exact blob moves as renames", async () => {
    const original = await putFile(app, "old-name.txt", "unchanged\n");
    const originalBody = (await original.json()) as { content: { sha: string } };
    const list = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await list.json()) as Array<{ sha: string; commit: { tree: { sha: string } } }>;

    const tree = await app.request(`${base}/repos/octocat/hello-world/git/trees`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        base_tree: head.commit.tree.sha,
        tree: [
          { path: "old-name.txt", mode: "100644", type: "blob", sha: null },
          { path: "new-name.txt", mode: "100644", type: "blob", sha: originalBody.content.sha },
        ],
      }),
    });
    const treeBody = (await tree.json()) as { sha: string };
    const created = await app.request(`${base}/repos/octocat/hello-world/git/commits`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "Rename file", tree: treeBody.sha, parents: [head.sha] }),
    });
    const createdBody = (await created.json()) as { sha: string };
    const updated = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/main`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sha: createdBody.sha }),
    });
    expect(updated.status).toBe(200);

    const detail = await app.request(`${base}/repos/octocat/hello-world/commits/${createdBody.sha}`, {
      headers: authHeaders(),
    });
    const detailBody = (await detail.json()) as {
      stats: { additions: number; deletions: number; total: number };
      files: Array<Record<string, unknown>>;
    };
    expect(detailBody.stats).toEqual({ additions: 0, deletions: 0, total: 0 });
    expect(detailBody.files).toEqual([
      expect.objectContaining({
        filename: "new-name.txt",
        previous_filename: "old-name.txt",
        status: "renamed",
        additions: 0,
        deletions: 0,
        changes: 0,
      }),
    ]);

    const comparison = await app.request(`${base}/repos/octocat/hello-world/compare/${head.sha}...${createdBody.sha}`, {
      headers: authHeaders(),
    });
    expect(((await comparison.json()) as { files: Array<Record<string, unknown>> }).files).toEqual([
      expect.objectContaining({
        filename: "new-name.txt",
        previous_filename: "old-name.txt",
        status: "renamed",
      }),
    ]);
  });

  it("rejects default and disallowed protected branch deletion", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string }>;
    const createBranch = await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: "refs/heads/protected", sha: head.sha }),
    });
    expect(createBranch.status).toBe(201);

    const protectionBody = {
      required_status_checks: null,
      enforce_admins: true,
      required_pull_request_reviews: null,
      restrictions: null,
      required_linear_history: false,
      allow_force_pushes: false,
      allow_deletions: false,
      required_signatures: false,
    };
    const protect = await app.request(`${base}/repos/octocat/hello-world/branches/protected/protection`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify(protectionBody),
    });
    expect(protect.status).toBe(200);

    const deleteDefault = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/main`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleteDefault.status).toBe(422);
    const defaultStillExists = await app.request(`${base}/repos/octocat/hello-world/git/ref/heads/main`, {
      headers: authHeaders(),
    });
    expect(defaultStillExists.status).toBe(200);

    const deleteProtected = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/protected`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleteProtected.status).toBe(409);

    const stillExists = await app.request(`${base}/repos/octocat/hello-world/git/ref/heads/protected`, {
      headers: authHeaders(),
    });
    expect(stillExists.status).toBe(200);

    const allowDeletion = await app.request(`${base}/repos/octocat/hello-world/branches/protected/protection`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({ ...protectionBody, allow_deletions: true }),
    });
    expect(allowDeletion.status).toBe(200);

    const deleted = await app.request(`${base}/repos/octocat/hello-world/git/refs/heads/protected`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleted.status).toBe(204);
    const noLongerExists = await app.request(`${base}/repos/octocat/hello-world/git/ref/heads/protected`, {
      headers: authHeaders(),
    });
    expect(noLongerExists.status).toBe(404);
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

  it("does not resolve an annotated tag object until a tag ref points to it", async () => {
    const list = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await list.json()) as Array<{ sha: string }>;
    const tag = await app.request(`${base}/repos/octocat/hello-world/git/tags`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        tag: "v1",
        message: "Version 1",
        object: head.sha,
        type: "commit",
        tagger: { name: "Octocat", email: "octocat@example.com", date: "2024-01-02T03:04:05Z" },
      }),
    });
    expect(tag.status).toBe(201);
    const tagBody = (await tag.json()) as { sha: string };

    expect(
      (
        await app.request(`${base}/repos/octocat/hello-world/commits/v1`, {
          headers: authHeaders(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`${base}/repos/octocat/hello-world/contents/README.md?ref=v1`, {
          headers: authHeaders(),
        })
      ).status,
    ).toBe(404);

    const ref = await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: "refs/tags/v1", sha: tagBody.sha }),
    });
    expect(ref.status).toBe(201);

    expect(
      (
        await app.request(`${base}/repos/octocat/hello-world/commits/v1`, {
          headers: authHeaders(),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`${base}/repos/octocat/hello-world/contents/README.md?ref=v1`, {
          headers: authHeaders(),
        })
      ).status,
    ).toBe(200);
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

  it("reports stored commit comment counts in list, detail, and comparison responses", async () => {
    const list = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await list.json()) as Array<{ sha: string; commit: { comment_count: number } }>;
    expect(head.commit.comment_count).toBe(0);

    const comment = await app.request(`${base}/repos/octocat/hello-world/commits/${head.sha}/comments`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ body: "A commit comment" }),
    });
    expect(comment.status).toBe(201);

    const updatedList = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [updatedHead] = (await updatedList.json()) as Array<{ commit: { comment_count: number } }>;
    expect(updatedHead.commit.comment_count).toBe(1);

    const detail = await app.request(`${base}/repos/octocat/hello-world/commits/${head.sha}`, {
      headers: authHeaders(),
    });
    expect(((await detail.json()) as { commit: { comment_count: number } }).commit.comment_count).toBe(1);

    const comparison = await app.request(`${base}/repos/octocat/hello-world/compare/main...main`, {
      headers: authHeaders(),
    });
    const comparisonBody = (await comparison.json()) as {
      base_commit: { commit: { comment_count: number } };
      merge_base_commit: { commit: { comment_count: number } };
    };
    expect(comparisonBody.base_commit.commit.comment_count).toBe(1);
    expect(comparisonBody.merge_base_commit.commit.comment_count).toBe(1);
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

  it("searches current default-branch paths and encodes result URLs", async () => {
    const { app } = createTestApp();
    expect((await putFile(app, "src/nested.txt", "nested-search-needle\n")).status).toBe(201);
    expect((await putFile(app, "My%20File%20%231.txt", "special-search-needle\n")).status).toBe(201);

    const deleted = await putFile(app, "deleted.txt", "deleted-search-needle\n");
    const deletedBody = (await deleted.json()) as { content: { sha: string } };
    expect(
      (
        await app.request(`${base}/repos/octocat/hello-world/contents/deleted.txt`, {
          method: "DELETE",
          headers: jsonHeaders(),
          body: JSON.stringify({ message: "Delete searchable file", sha: deletedBody.content.sha }),
        })
      ).status,
    ).toBe(200);

    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string }>;
    expect(
      (
        await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ ref: "refs/heads/search-feature", sha: head.sha }),
        })
      ).status,
    ).toBe(201);
    expect(
      (await putFile(app, "feature-only.txt", "feature-search-needle\n", { branch: "search-feature" })).status,
    ).toBe(201);

    const search = async (term: string) => {
      const query = encodeURIComponent(`${term} repo:octocat/hello-world`);
      const response = await app.request(`${base}/search/code?q=${query}`, { headers: authHeaders() });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        total_count: number;
        items: Array<{ path: string; url: string; html_url: string }>;
      };
    };

    const nested = await search("nested-search-needle");
    expect(nested.items).toHaveLength(1);
    expect(nested.items[0].path).toBe("src/nested.txt");
    expect((await app.request(nested.items[0].url, { headers: authHeaders() })).status).toBe(200);

    const special = await search("special-search-needle");
    expect(special.items).toHaveLength(1);
    expect(special.items[0].path).toBe("My File #1.txt");
    expect(special.items[0].url).toContain("My%20File%20%231.txt");
    expect(special.items[0].html_url).toContain("My%20File%20%231.txt");
    expect((await app.request(special.items[0].url, { headers: authHeaders() })).status).toBe(200);

    expect((await search("deleted-search-needle")).total_count).toBe(0);
    expect((await search("feature-search-needle")).total_count).toBe(0);
  });
});
