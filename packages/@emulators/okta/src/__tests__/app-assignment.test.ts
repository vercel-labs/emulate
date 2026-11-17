import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware } from "@emulators/core";
import type { TokenMap } from "@emulators/core";
import { oktaPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
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
    oauth_clients: [
      {
        client_id: "portal",
        client_secret: "s",
        name: "Portal",
        redirect_uris: [redirectUri],
        auth_server_id: "default",
      },
      {
        client_id: "unlinked",
        client_secret: "s",
        name: "Unlinked",
        redirect_uris: [redirectUri],
        auth_server_id: "default",
      },
    ],
    apps: [{ okta_id: "0oa_portal", name: "portal", credentials: { oauthClient: { client_id: "portal" } } }],
    app_assignments: [{ app_okta_id: "0oa_portal", user_okta_id: "00u_alice" }],
  });
  return app;
}

async function signIn(app: Hono<any>, userRef: string, clientId = "portal"): Promise<URL> {
  const response = await app.request(`${base}/oauth2/default/v1/authorize/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ user_ref: userRef, client_id: clientId, redirect_uri: redirectUri, state: "s1" }),
  });
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location") ?? "");
}

describe("Okta app assignment", () => {
  it("lets an assigned user sign in", async () => {
    expect((await signIn(createTestApp(), "00u_alice")).searchParams.get("code")).toBeTruthy();
  });

  it("redirects an unassigned user with access_denied", async () => {
    const location = await signIn(createTestApp(), "00u_bob");
    expect(location.searchParams.get("code")).toBeNull();
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("s1");
  });

  it("posts the denial back when response_mode is form_post", async () => {
    const response = await createTestApp().request(`${base}/oauth2/default/v1/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_ref: "00u_bob",
        client_id: "portal",
        redirect_uri: redirectUri,
        state: "s1",
        response_mode: "form_post",
      }),
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<form method="POST" action="${redirectUri}">`);
    expect(html).toContain('name="error" value="access_denied"');
    expect(html).toContain('name="state" value="s1"');
    expect(html).not.toContain('name="code"');
  });

  it("refuses a user once unassigned from the app", async () => {
    const app = createTestApp();
    const removed = await app.request(`${base}/api/v1/apps/0oa_portal/users/00u_alice`, {
      method: "DELETE",
      headers: admin,
    });
    expect(removed.status).toBe(204);
    expect((await signIn(app, "00u_alice")).searchParams.get("error")).toBe("access_denied");
  });

  it("does not check clients that no app links to", async () => {
    expect((await signIn(createTestApp(), "00u_bob", "unlinked")).searchParams.get("code")).toBeTruthy();
  });
});
