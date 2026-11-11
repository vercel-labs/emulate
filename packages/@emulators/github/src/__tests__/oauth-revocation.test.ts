import { describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const redirectUri = "http://localhost:3000/callback";
const apps = {
  portal: { client_id: "portal-client", client_secret: "portal-secret" },
  other: { client_id: "other-client", client_secret: "other-secret" },
};

function createTestApp() {
  const store = new Store();
  const tokenMap: TokenMap = new Map();
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "alice" }, { login: "bob" }],
    oauth_apps: Object.values(apps).map((oauthApp) => ({
      ...oauthApp,
      name: oauthApp.client_id,
      redirect_uris: [redirectUri],
    })),
  });
  return app;
}

async function issueToken(app: Hono<any>, login: string, oauthApp = apps.portal): Promise<string> {
  const callback = await app.request(`${base}/login/oauth/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login, client_id: oauthApp.client_id, redirect_uri: redirectUri, scope: "repo" }),
  });
  const code = new URL(callback.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const exchange = await app.request(`${base}/login/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...oauthApp, code, redirect_uri: redirectUri }),
  });
  return ((await exchange.json()) as { access_token: string }).access_token;
}

function revoke(app: Hono<any>, endpoint: "token" | "grant", token: string, credentials = apps.portal) {
  const basic = Buffer.from(`${credentials.client_id}:${credentials.client_secret}`).toString("base64");
  return app.request(`${base}/applications/${apps.portal.client_id}/${endpoint}`, {
    method: "DELETE",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: token }),
  });
}

async function userStatus(app: Hono<any>, token: string): Promise<number> {
  return (await app.request(`${base}/user`, { headers: { Authorization: `Bearer ${token}` } })).status;
}

describe("GitHub OAuth app token revocation", () => {
  it("revokes one token with DELETE /applications/:client_id/token", async () => {
    const app = createTestApp();
    const revoked = await issueToken(app, "alice");
    const kept = await issueToken(app, "alice");
    expect((await revoke(app, "token", revoked)).status).toBe(204);
    expect(await userStatus(app, revoked)).toBe(401);
    expect(await userStatus(app, kept)).toBe(200);
  });

  it("revokes every token of the grant with DELETE /applications/:client_id/grant", async () => {
    const app = createTestApp();
    const first = await issueToken(app, "alice");
    const second = await issueToken(app, "alice");
    const bob = await issueToken(app, "bob");
    const otherApp = await issueToken(app, "alice", apps.other);
    expect((await revoke(app, "grant", first)).status).toBe(204);
    expect(await userStatus(app, first)).toBe(401);
    expect(await userStatus(app, second)).toBe(401);
    expect(await userStatus(app, bob)).toBe(200);
    expect(await userStatus(app, otherApp)).toBe(200);
  });

  it("requires the app's client credentials", async () => {
    const app = createTestApp();
    const token = await issueToken(app, "alice");
    const wrongSecret = { ...apps.portal, client_secret: "wrong" };
    expect((await revoke(app, "token", token, wrongSecret)).status).toBe(404);
    expect(await userStatus(app, token)).toBe(200);
  });

  it("rejects a token that is unknown or belongs to another app", async () => {
    const app = createTestApp();
    const otherApp = await issueToken(app, "alice", apps.other);
    expect((await revoke(app, "token", "gho_never_issued")).status).toBe(422);
    expect((await revoke(app, "grant", otherApp)).status).toBe(422);
    expect(await userStatus(app, otherApp)).toBe(200);
  });
});
