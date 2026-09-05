import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store, WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig, getGitHubStore } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("owner-token", { login: "octocat", id: 1, scopes: ["repo", "admin:org"] });
  tokenMap.set("stranger-token", { login: "lurker", id: 3, scopes: ["repo"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "lurker" }],
    orgs: [{ login: "my-org" }],
    repos: [
      { owner: "my-org", name: "public-a" },
      { owner: "my-org", name: "public-b" },
      { owner: "my-org", name: "secret", private: true },
    ],
  });
  // octocat is an organization member; lurker is not.
  const gh = getGitHubStore(store);
  const org = gh.orgs.findOneBy("login", "my-org")!;
  const octocat = gh.users.findOneBy("login", "octocat")!;
  const team = gh.teams.insert({
    node_id: "T1",
    name: "Members",
    slug: "members",
    description: null,
    privacy: "closed",
    permission: "pull",
    org_id: org.id,
    parent_id: null,
    members_count: 1,
    repos_count: 0,
  });
  gh.teamMembers.insert({ team_id: team.id, user_id: octocat.id, role: "maintainer" });
  return { app, store };
}

async function names(
  app: Hono,
  query: string,
  token?: string,
): Promise<{ status: number; names: string[]; link: string | null }> {
  const res = await app.request(`${base}/orgs/my-org/repos${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status !== 200) return { status: res.status, names: [], link: null };
  const body = (await res.json()) as Array<{ name: string }>;
  return { status: 200, names: body.map((r) => r.name), link: res.headers.get("Link") };
}

describe("GET /orgs/:org/repos", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("lists only public repositories to anonymous callers and non-members", async () => {
    expect((await names(app, "?sort=full_name")).names).toEqual(["public-a", "public-b"]);
    expect((await names(app, "?sort=full_name", "stranger-token")).names).toEqual(["public-a", "public-b"]);
  });

  it("lists private repositories to members", async () => {
    expect((await names(app, "?sort=full_name", "owner-token")).names).toEqual(["public-a", "public-b", "secret"]);
  });

  it("filters by type", async () => {
    expect((await names(app, "?type=private", "owner-token")).names).toEqual(["secret"]);
    expect((await names(app, "?type=public&sort=full_name", "owner-token")).names).toEqual(["public-a", "public-b"]);
    expect((await names(app, "?type=bogus", "owner-token")).status).toBe(422);
  });

  it("paginates with a Link header", async () => {
    const first = await names(app, "?sort=full_name&per_page=2&page=1", "owner-token");
    expect(first.names).toEqual(["public-a", "public-b"]);
    expect(first.link).toContain('rel="next"');
    const second = await names(app, "?sort=full_name&per_page=2&page=2", "owner-token");
    expect(second.names).toEqual(["secret"]);
  });

  it("returns 404 for an unknown organization", async () => {
    const res = await app.request(`${base}/orgs/nope/repos`, { headers: { Authorization: "Bearer owner-token" } });
    expect(res.status).toBe(404);
  });
});
