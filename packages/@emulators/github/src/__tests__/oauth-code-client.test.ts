import { describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
} from "@emulators/core";
import type { TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const redirectUri = "http://localhost:3000/callback";
const portal = { client_id: "portal-client", client_secret: "portal-secret" };
const other = { client_id: "other-client", client_secret: "other-secret" };

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
    users: [{ login: "alice" }],
    oauth_apps: [portal, other].map((oauthApp) => ({
      ...oauthApp,
      name: oauthApp.client_id,
      redirect_uris: [redirectUri],
    })),
  });
  return app;
}

async function authorize(app: Hono<any>, clientId: string): Promise<string> {
  const callback = await app.request(`${base}/login/oauth/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login: "alice", client_id: clientId, redirect_uri: redirectUri, scope: "repo" }),
  });
  return new URL(callback.headers.get("location") ?? "").searchParams.get("code") ?? "";
}

async function exchange(app: Hono<any>, code: string, credentials: typeof portal) {
  const res = await app.request(`${base}/login/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...credentials, code, redirect_uri: redirectUri }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

describe("GitHub OAuth code bound to its client", () => {
  it("refuses a code issued to another OAuth app", async () => {
    const app = createTestApp();
    const code = await authorize(app, portal.client_id);
    const res = await exchange(app, code, other);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      error: "bad_verification_code",
      error_description: "The code passed is incorrect or expired.",
    });
  });

  it("keeps the code usable by the app it was issued to", async () => {
    const app = createTestApp();
    const code = await authorize(app, portal.client_id);
    expect((await exchange(app, code, other)).body.error).toBe("bad_verification_code");
    const res = await exchange(app, code, portal);
    expect(res.body.access_token).toMatch(/^gho_/);
    expect(res.body.scope).toBe("repo");
  });

  it("still exchanges each app's own code once", async () => {
    const app = createTestApp();
    const portalCode = await authorize(app, portal.client_id);
    const otherCode = await authorize(app, other.client_id);
    expect((await exchange(app, portalCode, portal)).body.access_token).toMatch(/^gho_/);
    expect((await exchange(app, otherCode, other)).body.access_token).toMatch(/^gho_/);
    expect((await exchange(app, portalCode, portal)).body.error).toBe("bad_verification_code");
  });
});
