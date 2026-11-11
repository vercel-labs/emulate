import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { oktaPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const client = { client_id: "portal", client_secret: "portal-secret" };
const redirectUri = "http://localhost:3000/callback";

function createTestApp() {
  const tokenMap: TokenMap = new Map([["ssws-token", { login: "admin@okta.local", id: 1, scopes: ["okta.*"] }]]);
  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  const store = new Store();
  oktaPlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  oktaPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ okta_id: "00u_alice", login: "alice@example.com" }],
    oauth_clients: [{ ...client, name: "Portal", redirect_uris: [redirectUri], auth_server_id: "default" }],
  });
  return app;
}

function signIn(app: Hono) {
  return app.request(`${base}/oauth2/default/v1/authorize/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      user_ref: "00u_alice",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: "openid offline_access",
    }),
  });
}

function token(app: Hono, grant: Record<string, string>) {
  return app.request(`${base}/oauth2/default/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...client, redirect_uri: redirectUri, ...grant }),
  });
}

async function issue(app: Hono): Promise<{ code: string; refresh: string }> {
  const code = new URL((await signIn(app)).headers.get("location") ?? "").searchParams.get("code") ?? "";
  const tokens = (await (await token(app, { grant_type: "authorization_code", code })).json()) as {
    refresh_token: string;
  };
  const secondCode = new URL((await signIn(app)).headers.get("location") ?? "").searchParams.get("code") ?? "";
  return { code: secondCode, refresh: tokens.refresh_token };
}

function lifecycle(app: Hono, action: string) {
  return app.request(`${base}/api/v1/users/00u_alice/lifecycle/${action}`, {
    method: "POST",
    headers: { Authorization: "SSWS ssws-token" },
  });
}

describe("Okta inactive users", () => {
  for (const action of ["suspend", "deactivate"]) {
    it(`refuses sign-in, code exchange, and refresh after ${action}`, async () => {
      const app = createTestApp();
      const { code, refresh } = await issue(app);
      expect((await lifecycle(app, action)).status).toBe(200);

      expect((await signIn(app)).status).toBe(403);
      const grants: Record<string, string>[] = [
        { grant_type: "authorization_code", code },
        { grant_type: "refresh_token", refresh_token: refresh },
      ];
      for (const grant of grants) {
        const response = await token(app, grant);
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toBe("invalid_grant");
      }
    });
  }

  it("allows sign-in again after unsuspend", async () => {
    const app = createTestApp();
    await lifecycle(app, "suspend");
    await lifecycle(app, "unsuspend");
    expect((await signIn(app)).status).toBe(302);
  });
});
