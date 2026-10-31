import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig, type GitHubSeedConfig } from "../index.js";

const base = "http://localhost:4000";

const seedConfig: GitHubSeedConfig = {
  users: [{ login: "org-admin" }, { login: "org-member" }, { login: "outsider" }],
  orgs: [
    {
      login: "acme",
      name: "Acme",
      members: [{ login: "org-admin", role: "admin" }, { login: "org-member" }, { login: "missing-user" }],
    },
  ],
  repos: [{ owner: "acme", name: "private-repo", private: true }],
};

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map([
    ["admin-token", { login: "org-admin", id: 3, scopes: ["repo", "user", "admin:org"] }],
    ["member-token", { login: "org-member", id: 4, scopes: ["repo", "user"] }],
    ["outsider-token", { login: "outsider", id: 5, scopes: ["repo", "user"] }],
  ]);

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, seedConfig);

  return { app, store };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("GitHub organization seed memberships", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  it("seeds member and admin roles through organization membership endpoints", async () => {
    const allMembers = await app.request(`${base}/orgs/acme/members`, { headers: authHeaders("member-token") });
    expect(allMembers.status).toBe(200);
    const allMemberUsers = (await allMembers.json()) as Array<{ login: string }>;
    expect(allMemberUsers.map((user) => user.login)).toEqual(["org-admin", "org-member"]);

    const adminMembers = await app.request(`${base}/orgs/acme/members?role=admin`, {
      headers: authHeaders("member-token"),
    });
    expect(adminMembers.status).toBe(200);
    const adminMemberUsers = (await adminMembers.json()) as Array<{ login: string }>;
    expect(adminMemberUsers.map((user) => user.login)).toEqual(["org-admin"]);

    const memberMembership = await app.request(`${base}/orgs/acme/memberships/org-member`, {
      headers: authHeaders("member-token"),
    });
    expect(memberMembership.status).toBe(200);
    expect(((await memberMembership.json()) as { role: string }).role).toBe("member");

    const adminMembership = await app.request(`${base}/orgs/acme/memberships/org-admin`, {
      headers: authHeaders("member-token"),
    });
    expect(adminMembership.status).toBe(200);
    expect(((await adminMembership.json()) as { role: string }).role).toBe("admin");

    const gh = getGitHubStore(store);
    const org = gh.orgs.findOneBy("login", "acme")!;
    const membersTeam = gh.teams.findOneBy("org_id", org.id)!;
    const teamMembers = gh.teamMembers.findBy("team_id", membersTeam.id);
    expect(membersTeam.slug).toBe("members");
    expect(membersTeam.name).toBe("Members");
    expect(membersTeam.members_count).toBe(2);
    expect(teamMembers).toHaveLength(2);
    expect(teamMembers.map((member) => member.role)).toEqual(["maintainer", "member"]);
  });

  it("derives organization listings and private repository access from seeded memberships", async () => {
    const orgs = await app.request(`${base}/user/orgs`, { headers: authHeaders("member-token") });
    expect(orgs.status).toBe(200);
    const memberOrgs = (await orgs.json()) as Array<{ login: string }>;
    expect(memberOrgs.map((org) => org.login)).toEqual(["acme"]);

    const userOrgs = await app.request(`${base}/users/org-member/orgs`, { headers: authHeaders("member-token") });
    expect(userOrgs.status).toBe(200);
    const userOrgList = (await userOrgs.json()) as Array<{ login: string }>;
    expect(userOrgList.map((org) => org.login)).toEqual(["acme"]);

    const memberRepo = await app.request(`${base}/repos/acme/private-repo`, {
      headers: authHeaders("member-token"),
    });
    expect(memberRepo.status).toBe(200);

    const outsiderRepo = await app.request(`${base}/repos/acme/private-repo`, {
      headers: authHeaders("outsider-token"),
    });
    expect(outsiderRepo.status).toBe(403);

    const adminUpdate = await app.request(`${base}/orgs/acme`, {
      method: "PATCH",
      headers: { ...authHeaders("admin-token"), "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Updated by org admin" }),
    });
    expect(adminUpdate.status).toBe(200);

    const memberUpdate = await app.request(`${base}/orgs/acme`, {
      method: "PATCH",
      headers: { ...authHeaders("member-token"), "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Should be forbidden" }),
    });
    expect(memberUpdate.status).toBe(403);
  });

  it("is idempotent and ignores missing user references", () => {
    seedFromConfig(store, base, seedConfig);

    const gh = getGitHubStore(store);
    const org = gh.orgs.findOneBy("login", "acme")!;
    const membersTeam = gh.teams.findBy("org_id", org.id).find((team) => team.slug === "members")!;
    expect(gh.teamMembers.findBy("team_id", membersTeam.id)).toHaveLength(2);
    expect(gh.teams.get(membersTeam.id)!.members_count).toBe(2);
  });
});
