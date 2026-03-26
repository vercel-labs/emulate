import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { applePlugin, seedFromConfig } from "../index.js";
import { decodeJwt } from "jose";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();

  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  applePlugin.register(app as any, store, webhooks, base, tokenMap);
  applePlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ email: "testuser@example.com", name: "Test User" }],
  });

  return { app, store, webhooks, tokenMap };
}

async function getAuthCode(
  app: Hono,
  options: {
    email?: string;
    client_id?: string;
    redirect_uri?: string;
    scope?: string;
    state?: string;
    nonce?: string;
    response_mode?: string;
  } = {},
): Promise<{ code: string; state: string; userJson?: string }> {
  const email = options.email ?? "testuser@example.com";
  const redirect_uri = options.redirect_uri ?? "http://localhost:3000/callback";
  const scope = options.scope ?? "openid email name";
  const state = options.state ?? "test-state";
  const nonce = options.nonce ?? "test-nonce";
  const client_id = options.client_id ?? "test-client";
  const response_mode = options.response_mode ?? "query";

  const formData = new URLSearchParams({
    email,
    redirect_uri,
    scope,
    state,
    nonce,
    client_id,
    response_mode,
  });

  const res = await app.request(`${base}/auth/authorize/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

  if (response_mode === "form_post") {
    const html = await res.text();
    const codeMatch = html.match(/name="code" value="([^"]+)"/);
    const stateMatch = html.match(/name="state" value="([^"]+)"/);
    const userMatch = html.match(/name="user" value="([^"]+)"/);
    return {
      code: codeMatch?.[1] ?? "",
      state: stateMatch?.[1] ?? "",
      userJson: userMatch ? decodeHtmlEntities(userMatch[1]) : undefined,
    };
  }

  const location = res.headers.get("location") ?? "";
  const url = new URL(location);
  return {
    code: url.searchParams.get("code") ?? "",
    state: url.searchParams.get("state") ?? "",
    userJson: url.searchParams.get("user") ?? undefined,
  };
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

async function exchangeCode(
  app: Hono,
  code: string,
  options: {
    client_id?: string;
    redirect_uri?: string;
  } = {},
): Promise<Response> {
  const formData = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: options.client_id ?? "test-client",
    client_secret: "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ0ZWFtLWlkIiwiYXVkIjoiaHR0cHM6Ly9hcHBsZWlkLmFwcGxlLmNvbSIsInN1YiI6InRlc3QtY2xpZW50In0.fake",
    redirect_uri: options.redirect_uri ?? "http://localhost:3000/callback",
  });

  return app.request(`${base}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });
}

describe("Apple plugin integration", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const testApp = createTestApp();
    app = testApp.app;
    store = testApp.store;
  });

  // --- OIDC Discovery ---

  it("GET /.well-known/openid-configuration returns Apple OIDC discovery document", async () => {
    const res = await app.request(`${base}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.issuer).toBe(base);
    expect(body.authorization_endpoint).toBe(`${base}/auth/authorize`);
    expect(body.token_endpoint).toBe(`${base}/auth/token`);
    expect(body.revocation_endpoint).toBe(`${base}/auth/revoke`);
    expect(body.jwks_uri).toBe(`${base}/auth/keys`);
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.response_modes_supported).toEqual(["query", "fragment", "form_post"]);
    expect(body.subject_types_supported).toEqual(["pairwise"]);
    expect(body.id_token_signing_alg_values_supported).toEqual(["RS256"]);
    expect(body.scopes_supported).toEqual(["openid", "email", "name"]);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["client_secret_post"]);
    expect(body.claims_supported).toContain("is_private_email");
    expect(body.claims_supported).toContain("real_user_status");
    expect(body.claims_supported).toContain("nonce_supported");
  });

  // --- JWKS ---

  it("GET /auth/keys returns JWKS with proper RSA key structure", async () => {
    const res = await app.request(`${base}/auth/keys`);
    expect(res.status).toBe(200);
    const body = await res.json() as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    const key = body.keys[0];
    expect(key.kty).toBe("RSA");
    expect(key.kid).toBe("emulate-apple-1");
    expect(key.use).toBe("sig");
    expect(key.alg).toBe("RS256");
    expect(key.n).toBeDefined();
    expect(key.e).toBe("AQAB");
  });

  // --- Authorization page ---

  it("GET /auth/authorize returns an HTML sign-in page", async () => {
    const url = `${base}/auth/authorize?client_id=test-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&scope=openid%20email%20name`;
    const res = await app.request(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html.length).toBeGreaterThan(0);
    expect(html).toMatch(/Sign in/i);
  });

  // --- Full OAuth flow ---

  it("completes full OAuth authorization_code flow", async () => {
    const { code, state } = await getAuthCode(app);
    expect(code).toBeTruthy();
    expect(state).toBe("test-state");

    const tokenRes = await exchangeCode(app, code);
    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json() as Record<string, unknown>;
    expect(tokenBody.access_token).toBeDefined();
    expect((tokenBody.access_token as string).startsWith("apple_")).toBe(true);
    expect(tokenBody.refresh_token).toBeDefined();
    expect((tokenBody.refresh_token as string).startsWith("r_apple_")).toBe(true);
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.expires_in).toBe(3600);
    expect(tokenBody.id_token).toBeDefined();

    // Decode and verify id_token claims
    const claims = decodeJwt(tokenBody.id_token as string);
    expect(claims.iss).toBe(base);
    expect(claims.aud).toBe("test-client");
    expect(claims.sub).toBeDefined();
    expect(claims.email).toBe("testuser@example.com");
    // CRITICAL: email_verified and is_private_email must be STRINGS
    expect(claims.email_verified).toBe("true");
    expect(typeof claims.email_verified).toBe("string");
    expect(typeof claims.is_private_email).toBe("string");
    expect(claims.nonce_supported).toBe(true);
    expect(claims.nonce).toBe("test-nonce");
    expect(claims.real_user_status).toBe(2);
    expect(claims.auth_time).toBeDefined();
  });

  // --- Refresh token flow ---

  it("exchanges refresh_token for new access_token without new refresh_token", async () => {
    const { code } = await getAuthCode(app);
    const tokenRes = await exchangeCode(app, code);
    const tokenBody = await tokenRes.json() as Record<string, unknown>;
    const refreshToken = tokenBody.refresh_token as string;

    const refreshFormData = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "test-client",
      client_secret: "eyJhbGciOiJFUzI1NiJ9.fake.fake",
    });

    const refreshRes = await app.request(`${base}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshFormData.toString(),
    });

    expect(refreshRes.status).toBe(200);
    const refreshBody = await refreshRes.json() as Record<string, unknown>;
    expect(refreshBody.access_token).toBeDefined();
    expect((refreshBody.access_token as string).startsWith("apple_")).toBe(true);
    expect(refreshBody.id_token).toBeDefined();
    expect(refreshBody.token_type).toBe("Bearer");
    expect(refreshBody.expires_in).toBe(3600);
    // No new refresh_token in refresh grant
    expect(refreshBody.refresh_token).toBeUndefined();
  });

  // --- Token revocation ---

  it("POST /auth/revoke returns 200", async () => {
    const formData = new URLSearchParams({
      client_id: "test-client",
      client_secret: "eyJhbGciOiJFUzI1NiJ9.fake.fake",
      token: "some-token",
      token_type_hint: "access_token",
    });

    const res = await app.request(`${base}/auth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    expect(res.status).toBe(200);
  });

  // --- Authorization code is single-use ---

  it("rejects second use of authorization code", async () => {
    const { code } = await getAuthCode(app);

    // First exchange succeeds
    const res1 = await exchangeCode(app, code);
    expect(res1.status).toBe(200);

    // Second exchange fails
    const res2 = await exchangeCode(app, code);
    expect(res2.status).toBe(400);
    const body = await res2.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_grant");
  });

  // --- User JSON blob only on first auth ---

  it("sends user JSON blob only on first authorization per user+client pair", async () => {
    // First auth should include user blob
    const first = await getAuthCode(app, { response_mode: "query" });
    expect(first.userJson).toBeDefined();
    const parsed = JSON.parse(first.userJson!);
    expect(parsed.name.firstName).toBe("Test");
    expect(parsed.name.lastName).toBe("User");
    expect(parsed.email).toBe("testuser@example.com");

    // Second auth for same user+client should NOT include user blob
    const second = await getAuthCode(app, { response_mode: "query" });
    expect(second.userJson).toBeUndefined();
  });

  // --- form_post response mode ---

  it("returns auto-submit form for form_post response mode", async () => {
    const result = await getAuthCode(app, { response_mode: "form_post" });
    expect(result.code).toBeTruthy();
    expect(result.state).toBe("test-state");
  });

  // --- Unsupported grant type ---

  it("rejects unsupported grant type", async () => {
    const formData = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "test-client",
      client_secret: "eyJhbGciOiJFUzI1NiJ9.fake.fake",
    });

    const res = await app.request(`${base}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("unsupported_grant_type");
  });
});
