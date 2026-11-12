import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware } from "@emulators/core";
import type { TokenMap } from "@emulators/core";
import { oktaPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const client = { client_id: "portal", client_secret: "portal-secret" };
const redirectUri = "http://localhost:3000/callback";
const admin = { Authorization: "SSWS ssws-token" };

function createTestApp() {
  const tokenMap: TokenMap = new Map([["ssws-token", { login: "admin@okta.local", id: 1, scopes: ["okta.*"] }]]);
  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  const store = new Store();
  oktaPlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  oktaPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [
      { okta_id: "00u_alice", login: "alice@example.com" },
      { okta_id: "00u_bob", login: "bob@example.com" },
    ],
    oauth_clients: [{ ...client, name: "Portal", redirect_uris: [redirectUri], auth_server_id: "default" }],
  });
  return app;
}

function form(body: Record<string, string>) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  };
}

async function authorize(app: Hono<any>, userRef: string): Promise<string> {
  const callback = await app.request(
    `${base}/oauth2/default/v1/authorize/callback`,
    form({ user_ref: userRef, client_id: client.client_id, redirect_uri: redirectUri, scope: "openid offline_access" }),
  );
  return new URL(callback.headers.get("location") ?? "").searchParams.get("code") ?? "";
}

function exchange(app: Hono<any>, code: string) {
  return app.request(
    `${base}/oauth2/default/v1/token`,
    form({ ...client, grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  );
}

async function issue(app: Hono<any>, userRef: string): Promise<{ access: string; refresh: string }> {
  const response = await exchange(app, await authorize(app, userRef));
  const tokens = (await response.json()) as { access_token: string; refresh_token: string };
  return { access: tokens.access_token, refresh: tokens.refresh_token };
}

async function userinfo(app: Hono<any>, token: string): Promise<number> {
  return (await app.request(`${base}/oauth2/default/v1/userinfo`, { headers: { Authorization: `Bearer ${token}` } }))
    .status;
}

async function refresh(app: Hono<any>, token: string): Promise<number> {
  return (
    await app.request(
      `${base}/oauth2/default/v1/token`,
      form({ ...client, grant_type: "refresh_token", refresh_token: token, scope: "openid offline_access" }),
    )
  ).status;
}

function revokeSessions(app: Hono<any>, userId: string, query = "") {
  return app.request(`${base}/api/v1/users/${userId}/sessions${query}`, { method: "DELETE", headers: admin });
}

describe("Okta user sessions", () => {
  it("revokes the user's access and refresh tokens with oauthTokens=true", async () => {
    const app = createTestApp();
    const alice = await issue(app, "00u_alice");
    const bob = await issue(app, "00u_bob");
    expect((await revokeSessions(app, "00u_alice", "?oauthTokens=true")).status).toBe(204);
    expect(await userinfo(app, alice.access)).toBe(401);
    expect(await refresh(app, alice.refresh)).toBe(400);
    expect(await userinfo(app, bob.access)).toBe(200);
  });

  it("invalidates the user's unexchanged authorization codes with oauthTokens=true", async () => {
    const app = createTestApp();
    const aliceCode = await authorize(app, "00u_alice");
    const bobCode = await authorize(app, "00u_bob");
    expect((await revokeSessions(app, "00u_alice", "?oauthTokens=true")).status).toBe(204);
    const response = await exchange(app, aliceCode);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect((await exchange(app, bobCode)).status).toBe(200);
  });

  it("keeps OAuth tokens without oauthTokens, which defaults to false", async () => {
    const app = createTestApp();
    const alice = await issue(app, "00u_alice");
    expect((await revokeSessions(app, "00u_alice")).status).toBe(204);
    expect(await userinfo(app, alice.access)).toBe(200);
  });

  it("returns 404 for an unknown user", async () => {
    expect((await revokeSessions(createTestApp(), "00u_nobody")).status).toBe(404);
  });

  it("requires management authentication", async () => {
    const app = createTestApp();
    const response = await app.request(`${base}/api/v1/users/00u_alice/sessions`, { method: "DELETE" });
    expect(response.status).toBe(401);
  });
});
