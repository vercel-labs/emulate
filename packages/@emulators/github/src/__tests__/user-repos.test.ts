import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig, type GitHubSeedConfig } from "../index.js";
import type { GitHubCollaborator } from "../entities.js";

const base = "http://localhost:4000";

const seedConfig: GitHubSeedConfig = {
  users: [{ login: "octocat" }, { login: "org-member" }, { login: "collaborator" }, { login: "outsider" }],
  orgs: [{ login: "acme", members: [{ login: "org-member" }] }],
  repos: [
    { owner: "octocat", name: "hello-world" },
    { owner: "acme", name: "private-repo", private: true },
    { owner: "acme", name: "public-repo" },
  ],
};

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map([
    ["member-token", { login: "org-member", id: 2, scopes: ["repo", "user"] }],
    ["collaborator-token", { login: "collaborator", id: 3, scopes: ["repo", "user"] }],
    ["outsider-token", { login: "outsider", id: 4, scopes: ["repo", "user"] }],
  ]);

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, seedConfig);

  const gh = getGitHubStore(store);
  const collaborator = gh.users.findOneBy("login", "collaborator")!;
  const hello = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
  gh.collaborators.insert({
    repo_id: hello.id,
    user_id: collaborator.id,
    permission: "push",
  } as Omit<GitHubCollaborator, "id" | "created_at" | "updated_at">);

  return { app };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function listRepos(app: Hono, token: string, query = "") {
  const res = await app.request(`${base}/user/repos${query}`, { headers: authHeaders(token) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Array<{ full_name: string }>;
  return body.map((repo) => repo.full_name).sort();
}

describe("GET /user/repos", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("includes repositories of organizations the user belongs to", async () => {
    expect(await listRepos(app, "member-token")).toEqual(["acme/private-repo", "acme/public-repo"]);
    expect(await listRepos(app, "outsider-token")).toEqual([]);
  });

  it("filters by affiliation", async () => {
    expect(await listRepos(app, "member-token", "?affiliation=owner")).toEqual([]);
    expect(await listRepos(app, "member-token", "?affiliation=organization_member")).toEqual([
      "acme/private-repo",
      "acme/public-repo",
    ]);
    expect(await listRepos(app, "collaborator-token", "?affiliation=collaborator")).toEqual(["octocat/hello-world"]);
    expect(await listRepos(app, "collaborator-token", "?affiliation=owner,collaborator")).toEqual([
      "octocat/hello-world",
    ]);
    expect(await listRepos(app, "collaborator-token", "?affiliation=owner")).toEqual([]);
  });

  it("filters by visibility", async () => {
    expect(await listRepos(app, "member-token", "?visibility=public")).toEqual(["acme/public-repo"]);
    expect(await listRepos(app, "member-token", "?visibility=private")).toEqual(["acme/private-repo"]);
    expect(await listRepos(app, "member-token", "?visibility=all")).toEqual([
      "acme/private-repo",
      "acme/public-repo",
    ]);
  });

  it("keeps the legacy type parameter", async () => {
    expect(await listRepos(app, "member-token", "?type=owner")).toEqual([]);
    expect(await listRepos(app, "member-token", "?type=member")).toEqual([
      "acme/private-repo",
      "acme/public-repo",
    ]);
    expect(await listRepos(app, "collaborator-token", "?type=all")).toEqual(["octocat/hello-world"]);
  });

  it("rejects unknown affiliations and visibilities", async () => {
    const affiliation = await app.request(`${base}/user/repos?affiliation=frenemy`, {
      headers: authHeaders("member-token"),
    });
    expect(affiliation.status).toBe(422);

    const visibility = await app.request(`${base}/user/repos?visibility=secret`, {
      headers: authHeaders("member-token"),
    });
    expect(visibility.status).toBe(422);
  });
});
