import { beforeEach, describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type AppEnv,
  type TokenMap,
} from "@emulators/core";
import { githubPlugin, getGitHubStore, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const app = new Hono<AppEnv>();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app, store, webhooks, base, tokenMap);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "bob" }, { login: "outsider" }],
    orgs: [{ login: "acme", members: [{ login: "octocat" }] }],
    repos: [
      { owner: "octocat", name: "owned", private: true },
      { owner: "acme", name: "selected", private: true },
      { owner: "acme", name: "unselected", private: true },
      { owner: "bob", name: "shared", private: true },
      { owner: "bob", name: "private", private: true },
      { owner: "bob", name: "public" },
      { owner: "outsider", name: "public" },
    ],
    apps: [
      {
        app_id: 100,
        slug: "test-app",
        name: "Test App",
        private_key: "fake-key",
        permissions: { contents: "read" },
        installations: [
          { installation_id: 1, account: "octocat" },
          { installation_id: 2, account: "acme", repository_selection: "selected", repositories: ["selected"] },
          { installation_id: 3, account: "bob" },
          { installation_id: 4, account: "outsider" },
        ],
      },
    ],
  });
  const gh = getGitHubStore(store);
  for (const user of gh.users.all()) {
    tokenMap.set(`${user.login}-token`, { login: user.login, id: user.id, scopes: ["repo", "user"] });
  }
  tokenMap.set("installation-token", {
    ...tokenMap.get("octocat-token")!,
    installation: {
      installationId: 1,
      appId: 100,
      accountId: gh.users.findOneBy("login", "octocat")!.id,
      accountType: "User",
      permissions: { contents: "read" },
      repositoryIds: [],
      repositorySelection: "all",
    },
  });
  return app;
}

describe("user installation discovery", () => {
  let app: Hono<AppEnv>;
  const get = (path: string, token = "octocat-token") =>
    app.request(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });

  beforeEach(async () => {
    app = createTestApp();
    const response = await app.request(`${base}/repos/bob/shared/collaborators/octocat`, {
      method: "PUT",
      headers: { Authorization: "Bearer bob-token", "Content-Type": "application/json" },
      body: JSON.stringify({ permission: "pull" }),
    });
    expect(response.status).toBe(201);
  });

  it("lists owned, organization, and collaborator installations with pagination", async () => {
    const response = await get("/user/installations?per_page=2");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total_count: 3,
      installations: [
        { id: 1, account: { login: "octocat" }, permissions: { contents: "read" } },
        { id: 2, account: { login: "acme" }, repository_selection: "selected" },
      ],
    });
    expect(response.headers.get("Link")).toContain('page=2>; rel="next"');
    const next = await get("/user/installations?per_page=2&page=2");
    expect(await next.json()).toMatchObject({ total_count: 3, installations: [{ id: 3 }] });
  });

  it("intersects selected repositories with the user's explicit access", async () => {
    const response = await get("/user/installations/2/repositories");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total_count: 1,
      repositories: [{ full_name: "acme/selected", private: true, permissions: { pull: true } }],
    });

    const collaborator = await get("/user/installations/3/repositories");
    expect(await collaborator.json()).toMatchObject({
      total_count: 1,
      repositories: [{ full_name: "bob/shared", permissions: { admin: false, push: false, pull: true } }],
    });
  });

  it("paginates all-repository installations and includes newly created repositories", async () => {
    const created = await app.request(`${base}/user/repos`, {
      method: "POST",
      headers: { Authorization: "Bearer octocat-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new-repo", private: true }),
    });
    expect(created.status).toBe(201);
    const response = await get("/user/installations/1/repositories?per_page=1");
    expect(await response.json()).toMatchObject({
      total_count: 2,
      repositories: [{ full_name: "octocat/owned", permissions: { admin: true } }],
    });
    expect(response.headers.get("Link")).toContain('page=2>; rel="next"');
    const next = await get("/user/installations/1/repositories?per_page=1&page=2");
    expect(await next.json()).toMatchObject({ total_count: 2, repositories: [{ full_name: "octocat/new-repo" }] });
  });

  it("does not expose unknown installations or grant discovery through public visibility", async () => {
    expect((await get("/user/installations/999/repositories")).status).toBe(404);
    expect((await get("/user/installations/4/repositories")).status).toBe(404);
  });

  it.each(["/user/installations", "/user/installations/1/repositories"])(
    "requires a user token at %s",
    async (path) => {
      expect((await app.request(`${base}${path}`)).status).toBe(401);
      expect((await get(path, "invalid-token")).status).toBe(401);
      expect((await get(path, "installation-token")).status).toBe(403);
    },
  );
});
