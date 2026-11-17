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

function createTestApp(strict: boolean, fallback = true) {
  const store = new Store();
  const tokenMap: TokenMap = new Map([["alice-token", { login: "alice", id: 2, scopes: ["repo", "user"] }]]);
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use(
    "*",
    authMiddleware(tokenMap, undefined, fallback ? { login: "admin", id: 1, scopes: ["repo", "user"] } : undefined),
  );
  githubPlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "admin" }, { login: "alice" }],
    oauth_apps: [{ client_id: "app-client", client_secret: "app-secret", name: "App", redirect_uris: [redirectUri] }],
    strict_scopes: strict,
  });
  return { app, tokenMap };
}

function getUser(app: Hono<any>, token: string) {
  return app.request(`${base}/user`, { headers: { Authorization: `Bearer ${token}` } });
}

function basic(credentials: string) {
  return { Authorization: `Basic ${Buffer.from(credentials).toString("base64")}` };
}

describe("GitHub strict mode tokens", () => {
  it("rejects a token the emulator never issued", async () => {
    const { app } = createTestApp(true);
    const res = await getUser(app, "ghp_never_issued");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toBe("Bad credentials");
  });

  it("accepts configured tokens and tokens issued by an OAuth exchange", async () => {
    const { app } = createTestApp(true);
    expect(((await (await getUser(app, "alice-token")).json()) as { login: string }).login).toBe("alice");

    const callback = await app.request(`${base}/login/oauth/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        login: "alice",
        client_id: "app-client",
        redirect_uri: redirectUri,
        scope: "repo",
      }),
    });
    const code = new URL(callback.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const exchange = await app.request(`${base}/login/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: "app-client", client_secret: "app-secret", code, redirect_uri: redirectUri }),
    });
    const { access_token: token } = (await exchange.json()) as { access_token: string };
    expect(((await (await getUser(app, token)).json()) as { login: string }).login).toBe("alice");
  });

  it("rejects an unknown token sent without a scheme", async () => {
    const { app } = createTestApp(true);
    const res = await app.request(`${base}/users/alice`, { headers: { Authorization: "ghp_never_issued" } });
    expect(res.status).toBe(401);
  });

  it("accepts HTTP Basic credentials only for a configured OAuth app", async () => {
    const { app } = createTestApp(true);
    expect((await app.request(`${base}/users/alice`, { headers: basic("app-client:wrong") })).status).toBe(401);
    expect((await app.request(`${base}/users/alice`, { headers: basic("app-client:app-secret") })).status).toBe(200);
  });

  it("does not give OAuth app credentials a user identity", async () => {
    const { app } = createTestApp(true);
    const res = await app.request(`${base}/user`, { headers: basic("app-client:app-secret") });
    expect(res.status).toBe(401);
  });

  it("keeps public endpoints open to anonymous requests", async () => {
    const { app } = createTestApp(true);
    expect((await app.request(`${base}/users/alice`)).status).toBe(200);
  });

  it("keeps the fallback user for unknown tokens by default", async () => {
    const { app } = createTestApp(false);
    const res = await getUser(app, "ghp_never_issued");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { login: string }).login).toBe("admin");
  });
});
