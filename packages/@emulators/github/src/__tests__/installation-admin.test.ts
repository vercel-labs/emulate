import { generateKeyPairSync, sign } from "crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store, WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig, getGitHubStore } from "../index.js";

const base = "http://localhost:4000";
const APP_ID = 777;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PRIVATE_KEY = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("octocat-token", { login: "octocat", id: 1, scopes: ["repo", "admin:org"] });
  tokenMap.set("hubot-token", { login: "hubot", id: 2, scopes: ["repo"] });
  tokenMap.set("lurker-token", { login: "lurker", id: 3, scopes: ["repo"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use(
    "*",
    authMiddleware(tokenMap, (appId) => {
      const gh = getGitHubStore(store);
      const ghApp = gh.apps.all().find((a) => a.app_id === appId);
      if (!ghApp) return null;
      return { privateKey: ghApp.private_key, slug: ghApp.slug, name: ghApp.name };
    }),
  );
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "hubot" }, { login: "lurker" }],
    orgs: [
      {
        login: "my-org",
        default_repository_permission: "none",
        members: [{ login: "octocat", role: "admin" }, { login: "hubot" }],
      },
      {
        login: "open-org",
        default_repository_permission: "read",
        members: [{ login: "hubot" }],
      },
    ],
    repos: [
      { owner: "my-org", name: "private-repo", private: true, collaborators: [{ login: "lurker", permission: "pull" }] },
      { owner: "my-org", name: "open" },
      { owner: "open-org", name: "priv", private: true },
    ],
    apps: [
      {
        app_id: APP_ID,
        slug: "provisioner",
        name: "Provisioner",
        private_key: APP_PRIVATE_KEY,
        permissions: { administration: "write", members: "write", contents: "read", metadata: "read" },
        installations: [{ installation_id: 100, account: "my-org", repository_selection: "all" }],
      },
    ],
  });
  return { app, store };
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({ iat: now - 60, exp: now + 540, iss: String(APP_ID) })}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), APP_PRIVATE_KEY).toString("base64url")}`;
}

async function installationToken(app: Hono, permissions?: Record<string, string>): Promise<string> {
  const res = await app.request(`${base}/app/installations/100/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${appJwt()}`, "Content-Type": "application/json" },
    body: permissions ? JSON.stringify({ permissions }) : undefined,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

async function permissionOf(app: Hono, repo: string, user: string, asToken = "octocat-token") {
  const res = await app.request(`${base}/repos/${repo}/collaborators/${user}/permission`, {
    headers: headers(asToken),
  });
  if (res.status !== 200) return { status: res.status };
  const body = (await res.json()) as { permission: string; role_name: string };
  return { status: 200, permission: body.permission, role_name: body.role_name };
}

describe("GitHub App installations administer the account they are installed on", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("creates an organization repository with administration: write", async () => {
    const token = await installationToken(app);
    const res = await app.request(`${base}/orgs/my-org/repos`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ name: "service", private: true }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { full_name: string; private: boolean };
    expect(body.full_name).toBe("my-org/service");
    expect(body.private).toBe(true);
  });

  it("is refused without administration: write", async () => {
    const token = await installationToken(app, { contents: "read", metadata: "read" });
    const res = await app.request(`${base}/orgs/my-org/repos`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ name: "nope" }),
    });
    expect(res.status).toBe(403);
  });

  it("adds and removes collaborators", async () => {
    const token = await installationToken(app);
    const put = await app.request(`${base}/repos/my-org/private-repo/collaborators/hubot`, {
      method: "PUT",
      headers: headers(token),
      body: JSON.stringify({ permission: "push" }),
    });
    expect(put.status).toBe(201);
    expect(await permissionOf(app, "my-org/private-repo", "hubot")).toEqual({
      status: 200,
      permission: "write",
      role_name: "write",
    });

    const del = await app.request(`${base}/repos/my-org/private-repo/collaborators/hubot`, {
      method: "DELETE",
      headers: headers(token),
    });
    expect(del.status).toBe(204);
    expect(await permissionOf(app, "my-org/private-repo", "hubot")).toEqual({
      status: 200,
      permission: "none",
      role_name: "none",
    });
  });

  it("manages organization membership with members: write", async () => {
    const token = await installationToken(app);
    const put = await app.request(`${base}/orgs/my-org/memberships/lurker`, {
      method: "PUT",
      headers: headers(token),
      body: JSON.stringify({ role: "member" }),
    });
    expect(put.status).toBe(200);
    const get = await app.request(`${base}/orgs/my-org/memberships/lurker`, { headers: headers("octocat-token") });
    expect(get.status).toBe(200);
    expect(((await get.json()) as { role: string }).role).toBe("member");
  });
});

describe("Repository permissions follow GitHub's model", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("answers for any user: owner admin, member below base permission none, collaborator read, unknown 404", async () => {
    expect(await permissionOf(app, "my-org/private-repo", "octocat")).toEqual({
      status: 200,
      permission: "admin",
      role_name: "admin",
    });
    expect(await permissionOf(app, "my-org/private-repo", "hubot")).toEqual({
      status: 200,
      permission: "none",
      role_name: "none",
    });
    expect(await permissionOf(app, "my-org/private-repo", "lurker")).toEqual({
      status: 200,
      permission: "read",
      role_name: "read",
    });
    expect(await permissionOf(app, "my-org/private-repo", "nobody")).toEqual({ status: 404 });
  });

  it("gives members the organization's base permission", async () => {
    expect(await permissionOf(app, "open-org/priv", "hubot", "hubot-token")).toEqual({
      status: 200,
      permission: "read",
      role_name: "read",
    });
    const visible = await app.request(`${base}/repos/open-org/priv`, { headers: headers("hubot-token") });
    expect(visible.status).toBe(200);
    const hidden = await app.request(`${base}/repos/my-org/private-repo`, { headers: headers("hubot-token") });
    expect(hidden.status).toBe(403);
  });

  it("reads public repositories for everyone", async () => {
    expect(await permissionOf(app, "my-org/open", "lurker")).toEqual({
      status: 200,
      permission: "read",
      role_name: "read",
    });
  });

  it("lets owners, not members, manage collaborators", async () => {
    const asMember = await app.request(`${base}/repos/my-org/private-repo/collaborators/lurker`, {
      method: "PUT",
      headers: headers("hubot-token"),
      body: JSON.stringify({ permission: "push" }),
    });
    expect(asMember.status).toBe(403);

    const asOwner = await app.request(`${base}/repos/my-org/private-repo/collaborators/lurker`, {
      method: "PUT",
      headers: headers("octocat-token"),
      body: JSON.stringify({ permission: "maintain" }),
    });
    expect(asOwner.status).toBe(201);
    expect(await permissionOf(app, "my-org/private-repo", "lurker")).toEqual({
      status: 200,
      permission: "write",
      role_name: "maintain",
    });
  });

  it("seeds organization members and their roles", async () => {
    const members = await app.request(`${base}/orgs/my-org/members`, { headers: headers("octocat-token") });
    expect(members.status).toBe(200);
    const logins = ((await members.json()) as Array<{ login: string }>).map((m) => m.login).sort();
    expect(logins).toEqual(["hubot", "octocat"]);
    const owner = await app.request(`${base}/orgs/my-org/memberships/octocat`, { headers: headers("octocat-token") });
    expect(((await owner.json()) as { role: string }).role).toBe("admin");
  });
});
