import { generateKeyPairSync, sign } from "crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store, WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig, getGitHubStore } from "../index.js";

const base = "http://localhost:4000";
const APP_ID = 4242;

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PRIVATE_KEY = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("octocat-token", { login: "octocat", id: 1, scopes: ["repo", "user", "admin:org"] });
  tokenMap.set("hubot-token", { login: "hubot", id: 2, scopes: ["repo", "user"] });

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
    users: [{ login: "octocat", name: "The Octocat", email: "octocat@github.com" }, { login: "hubot" }],
    orgs: [{ login: "my-org" }],
    repos: [
      { owner: "octocat", name: "template", description: "Starter files", is_template: true, language: "TypeScript" },
      { owner: "octocat", name: "plain" },
    ],
    apps: [
      {
        app_id: APP_ID,
        slug: "provisioner",
        name: "Provisioner",
        private_key: APP_PRIVATE_KEY,
        permissions: { administration: "write", contents: "read", metadata: "read" },
        installations: [{ installation_id: 100, account: "my-org", repository_selection: "all" }],
      },
    ],
  });

  return { app, store, webhooks, tokenMap };
}

function headers(token = "octocat-token"): Record<string, string> {
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

async function readme(app: Hono, fullName: string): Promise<string> {
  const res = await app.request(`${base}/repos/${fullName}/contents/README.md`, { headers: headers() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { content: string };
  return Buffer.from(body.content, "base64").toString("utf8");
}

describe("POST /repos/:owner/:repo/generate", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("creates a repository holding the template's files", async () => {
    const res = await app.request(`${base}/repos/octocat/template/generate`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ owner: "octocat", name: "from-template", description: "Generated" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, any>;
    expect(body.full_name).toBe("octocat/from-template");
    expect(body.description).toBe("Generated");
    expect(body.is_template).toBe(false);
    expect(body.language).toBe("TypeScript");
    expect(body.template_repository.full_name).toBe("octocat/template");

    expect(await readme(app, "octocat/from-template")).toBe(await readme(app, "octocat/template"));

    const commits = await app.request(`${base}/repos/octocat/from-template/commits`, { headers: headers() });
    expect(commits.status).toBe(200);
    const list = (await commits.json()) as Array<{ parents: unknown[] }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.parents).toHaveLength(0);
  });

  it("defaults the owner to the authenticated user", async () => {
    const res = await app.request(`${base}/repos/octocat/template/generate`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "mine" }),
    });

    expect(res.status).toBe(201);
    expect(((await res.json()) as { full_name: string }).full_name).toBe("octocat/mine");
  });

  it("copies only the default branch unless include_all_branches is set", async () => {
    const main = await app.request(`${base}/repos/octocat/template/branches/main`, { headers: headers() });
    expect(main.status).toBe(200);
    const sha = ((await main.json()) as { commit: { sha: string } }).commit.sha;
    const ref = await app.request(`${base}/repos/octocat/template/git/refs`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ref: "refs/heads/dev", sha }),
    });
    expect(ref.status).toBe(201);

    for (const [name, includeAll, expected] of [
      ["one-branch", false, ["main"]],
      ["all-branches", true, ["dev", "main"]],
    ] as const) {
      const res = await app.request(`${base}/repos/octocat/template/generate`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name, include_all_branches: includeAll }),
      });
      expect(res.status).toBe(201);
      const branches = await app.request(`${base}/repos/octocat/${name}/branches`, { headers: headers() });
      expect(branches.status).toBe(200);
      const names = ((await branches.json()) as Array<{ name: string }>).map((b) => b.name).sort();
      expect(names).toEqual([...expected]);
    }
  });

  it("rejects a source repository that is not a template", async () => {
    const res = await app.request(`${base}/repos/octocat/plain/generate`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "nope" }),
    });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { message: string }).message).toMatch(/not a template/i);
  });

  it("returns 404 for an unknown template", async () => {
    const res = await app.request(`${base}/repos/octocat/missing/generate`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "nope" }),
    });

    expect(res.status).toBe(404);
  });

  it("refuses to create under an organization the user is not a member of", async () => {
    const res = await app.request(`${base}/repos/octocat/template/generate`, {
      method: "POST",
      headers: headers("hubot-token"),
      body: JSON.stringify({ owner: "my-org", name: "nope" }),
    });

    expect(res.status).toBe(403);
  });

  it("lets a GitHub App installation with administration write generate into its account", async () => {
    const token = await installationToken(app);
    const res = await app.request(`${base}/repos/octocat/template/generate`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ owner: "my-org", name: "service", private: true }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, any>;
    expect(body.full_name).toBe("my-org/service");
    expect(body.private).toBe(true);
    expect(body.owner.login).toBe("my-org");
  });

  it("refuses an installation token without administration write", async () => {
    const token = await installationToken(app, { contents: "read" });
    const res = await app.request(`${base}/repos/octocat/template/generate`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ owner: "my-org", name: "nope" }),
    });

    expect(res.status).toBe(403);
  });
});
