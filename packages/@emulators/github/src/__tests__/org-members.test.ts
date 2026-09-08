import { describe, it, expect } from "vitest";
import { Hono } from "@emulators/core";
import { Store, WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig, getGitHubStore } from "../index.js";

const base = "http://localhost:4000";

function createTestApp(seedConfig: Parameters<typeof seedFromConfig>[2]) {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const scopes = ["repo", "user", "admin:org", "admin:repo_hook"];
  tokenMap.set("octocat-token", { login: "octocat", id: 1, scopes });
  tokenMap.set("hubot-token", { login: "hubot", id: 2, scopes });
  tokenMap.set("outsider-token", { login: "outsider", id: 3, scopes });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use(
    "*",
    authMiddleware(tokenMap, () => null),
  );
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, seedConfig);
  return { app, store };
}

const SEED = {
  users: [{ login: "octocat" }, { login: "hubot" }, { login: "outsider" }],
  orgs: [
    {
      login: "my-org",
      name: "My Organization",
      members: [{ login: "octocat", role: "admin" as const }, { login: "hubot" }],
    },
  ],
  repos: [{ owner: "my-org", name: "secret", private: true }],
};

async function get(app: Hono, path: string, token: string) {
  return app.request(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

describe("seeded org membership", () => {
  it("lists seeded members with their org roles", async () => {
    const { app, store } = createTestApp(SEED);
    const gh = getGitHubStore(store);
    const org = gh.orgs.findOneBy("login", "my-org")!;
    const members = gh.teams.findBy("org_id", org.id).find((t) => t.slug === "members")!;
    expect(members.members_count).toBe(2);

    const list = await get(app, "/orgs/my-org/members", "octocat-token");
    expect(list.status).toBe(200);
    const logins = ((await list.json()) as Array<{ login: string }>).map((m) => m.login).sort();
    expect(logins).toEqual(["hubot", "octocat"]);

    const admin = await get(app, "/orgs/my-org/memberships/octocat", "octocat-token");
    expect(admin.status).toBe(200);
    expect(((await admin.json()) as { role: string }).role).toBe("admin");

    const member = await get(app, "/orgs/my-org/memberships/hubot", "octocat-token");
    expect(member.status).toBe(200);
    expect(((await member.json()) as { role: string }).role).toBe("member");
  });

  it("lets seeded members read a private org repo and keeps outsiders out", async () => {
    const { app } = createTestApp(SEED);
    expect((await get(app, "/repos/my-org/secret", "octocat-token")).status).toBe(200);
    expect((await get(app, "/repos/my-org/secret", "hubot-token")).status).toBe(200);
    expect((await get(app, "/repos/my-org/secret", "outsider-token")).status).toBe(403);
  });

  it("lets a seeded admin use the org-admin endpoints (membership grant)", async () => {
    const { app } = createTestApp(SEED);
    const res = await app.request(`${base}/orgs/my-org/memberships/outsider`, {
      method: "PUT",
      headers: { Authorization: "Bearer octocat-token", "Content-Type": "application/json" },
      body: JSON.stringify({ role: "member" }),
    });
    expect(res.status).toBe(200);
    expect((await get(app, "/repos/my-org/secret", "outsider-token")).status).toBe(200);
  });

  it("rejects a member login that is not a seeded user", () => {
    expect(() =>
      createTestApp({
        users: [{ login: "octocat" }],
        orgs: [{ login: "my-org", members: [{ login: "nobody-here" }] }],
      }),
    ).toThrow(/member "nobody-here" is not a seeded user/);
  });
});
