import { generateKeyPairSync, sign } from "crypto";
import { describe, it, expect } from "vitest";
import { Hono } from "@emulators/core";
import { Store, WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig, getGitHubStore } from "../index.js";

const base = "http://localhost:4000";
const APP_ID = 4242;

function createTestApp() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
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
    users: [{ login: "octocat" }],
    orgs: [{ login: "my-org", name: "My Organization" }],
    repos: [{ owner: "my-org", name: "secret", private: true, auto_init: true }],
    apps: [
      {
        app_id: APP_ID,
        slug: "my-app",
        name: "My App",
        private_key: privateKey,
        permissions: { contents: "write", issues: "write", pull_requests: "write" },
        installations: [{ installation_id: 100, account: "my-org", repository_selection: "all" }],
      },
    ],
  });
  return { app, store, privateKey };
}

function appJwt(privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: String(APP_ID) })}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}

async function installationToken(app: Hono, privateKey: string): Promise<string> {
  const res = await app.request(`${base}/app/installations/100/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${appJwt(privateKey)}` },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

function json(method: string, token: string, body: unknown): RequestInit {
  return {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("writes with an org-installed App token", () => {
  it("creates issues, milestones, labels and comments as the app bot", async () => {
    const { app, privateKey } = createTestApp();
    const token = await installationToken(app, privateKey);

    const issue = await app.request(`${base}/repos/my-org/secret/issues`, json("POST", token, { title: "hello" }));
    expect(issue.status).toBe(201);
    const created = (await issue.json()) as { number: number; user: { login: string; type: string } };
    expect(created.user.login).toBe("my-app[bot]");
    expect(created.user.type).toBe("Bot");

    const milestone = await app.request(`${base}/repos/my-org/secret/milestones`, json("POST", token, { title: "m1" }));
    expect(milestone.status).toBe(201);

    const labels = await app.request(
      `${base}/repos/my-org/secret/issues/${created.number}/labels`,
      json("POST", token, { labels: ["bug"] }),
    );
    expect(labels.status).toBe(200);

    const comment = await app.request(
      `${base}/repos/my-org/secret/issues/${created.number}/comments`,
      json("POST", token, { body: "from the bot" }),
    );
    expect(comment.status).toBe(201);
    expect(((await comment.json()) as { user: { login: string } }).user.login).toBe("my-app[bot]");
  });

  it("opens a pull request from a branch it pushed", async () => {
    const { app, privateKey } = createTestApp();
    const token = await installationToken(app, privateKey);
    const head = await app.request(`${base}/repos/my-org/secret/git/ref/heads/main`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(head.status).toBe(200);
    const sha = ((await head.json()) as { object: { sha: string } }).object.sha;
    const ref = await app.request(
      `${base}/repos/my-org/secret/git/refs`,
      json("POST", token, { ref: "refs/heads/feat", sha }),
    );
    expect(ref.status).toBe(201);
    const pr = await app.request(
      `${base}/repos/my-org/secret/pulls`,
      json("POST", token, { title: "feat", head: "feat", base: "main" }),
    );
    expect(pr.status).toBe(201);
    expect(((await pr.json()) as { user: { login: string } }).user.login).toBe("my-app[bot]");
  });

  it("still rejects writes without a token", async () => {
    const { app } = createTestApp();
    const res = await app.request(`${base}/repos/my-org/secret/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "nope" }),
    });
    expect(res.status).toBe(401);
  });
});
