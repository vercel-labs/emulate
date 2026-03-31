import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { microsoftPlugin, seedFromConfig, getMicrosoftStore } from "../index.js";
import { decodeJwt } from "jose";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();

  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  microsoftPlugin.register(app as any, store, webhooks, base, tokenMap);
  microsoftPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ email: "testuser@example.com", name: "Test User" }],
    oauth_clients: [
      {
        client_id: "test-client",
        client_secret: "test-secret",
        name: "Test App",
        redirect_uris: ["http://localhost:3000/callback"],
      },
    ],
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
): Promise<{ code: string; state: string }> {
  const email = options.email ?? "testuser@example.com";
  const redirect_uri = options.redirect_uri ?? "http://localhost:3000/callback";
  const scope = options.scope ?? "openid email profile";
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
    code_challenge: "",
    code_challenge_method: "",
  });

  const res = await app.request(`${base}/oauth2/v2.0/authorize/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

  if (response_mode === "form_post") {
    const html = await res.text();
    const codeMatch = html.match(/name="code" value="([^"]+)"/);
    const stateMatch = html.match(/name="state" value="([^"]+)"/);
    return {
      code: codeMatch?.[1] ?? "",
      state: stateMatch?.[1] ?? "",
    };
  }

  const location = res.headers.get("location") ?? "";
  const url = new URL(location);
  return {
    code: url.searchParams.get("code") ?? "",
    state: url.searchParams.get("state") ?? "",
  };
}

async function exchangeCode(
  app: Hono,
  code: string,
  options: {
    client_id?: string;
    client_secret?: string;
    redirect_uri?: string;
  } = {},
): Promise<Response> {
  const formData = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: options.client_id ?? "test-client",
    client_secret: options.client_secret ?? "test-secret",
    redirect_uri: options.redirect_uri ?? "http://localhost:3000/callback",
  });

  return app.request(`${base}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });
}

describe("Microsoft plugin integration", () => {
  let app: Hono;
  let store: Store;
  let tokenMap: TokenMap;

  beforeEach(() => {
    const testApp = createTestApp();
    app = testApp.app;
    store = testApp.store;
    tokenMap = testApp.tokenMap;
  });

  // --- OIDC Discovery ---

  it("GET /.well-known/openid-configuration returns Microsoft OIDC discovery document", async () => {
    const res = await app.request(`${base}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.issuer).toContain("/v2.0");
    expect(body.authorization_endpoint).toBe(`${base}/oauth2/v2.0/authorize`);
    expect(body.token_endpoint).toBe(`${base}/oauth2/v2.0/token`);
    expect(body.userinfo_endpoint).toBe(`${base}/oidc/userinfo`);
    expect(body.end_session_endpoint).toBe(`${base}/oauth2/v2.0/logout`);
    expect(body.jwks_uri).toBe(`${base}/discovery/v2.0/keys`);
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.response_modes_supported).toEqual(["query", "fragment", "form_post"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token", "client_credentials"]);
    expect(body.subject_types_supported).toEqual(["pairwise"]);
    expect(body.scopes_supported).toContain("openid");
    expect(body.scopes_supported).toContain("User.Read");
    expect(body.claims_supported).toContain("oid");
    expect(body.claims_supported).toContain("tid");
    expect(body.claims_supported).toContain("preferred_username");
    expect(body.code_challenge_methods_supported).toEqual(["plain", "S256"]);
  });

  it("GET /:tenant/v2.0/.well-known/openid-configuration returns tenant-specific OIDC discovery", async () => {
    const tenantId = "my-tenant-id";
    const res = await app.request(`${base}/${tenantId}/v2.0/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.issuer).toBe(`${base}/${tenantId}/v2.0`);
  });

  // --- JWKS ---

  it("GET /discovery/v2.0/keys returns JWKS with RSA public key", async () => {
    const res = await app.request(`${base}/discovery/v2.0/keys`);
    expect(res.status).toBe(200);
    const body = await res.json() as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    const key = body.keys[0];
    expect(key.kty).toBe("RSA");
    expect(key.kid).toBe("emulate-microsoft-1");
    expect(key.use).toBe("sig");
    expect(key.alg).toBe("RS256");
  });

  // --- Authorization page ---

  it("GET /oauth2/v2.0/authorize returns an HTML sign-in page", async () => {
    const url = `${base}/oauth2/v2.0/authorize?client_id=test-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&scope=openid%20email%20profile`;
    const res = await app.request(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html.length).toBeGreaterThan(0);
    expect(html).toMatch(/Sign in/i);
    expect(html).toMatch(/Microsoft/i);
  });

  it("returns error for unknown client_id when clients are configured", async () => {
    const url = `${base}/oauth2/v2.0/authorize?client_id=unknown-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}`;
    const res = await app.request(url);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Application not found");
  });

  it("callback rejects unknown client_id when clients are configured", async () => {
    const formData = new URLSearchParams({
      email: "testuser@example.com",
      redirect_uri: "http://localhost:3000/callback",
      scope: "openid",
      state: "s",
      nonce: "",
      client_id: "unknown-client",
      response_mode: "query",
      code_challenge: "",
      code_challenge_method: "",
    });

    const res = await app.request(`${base}/oauth2/v2.0/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Application not found");
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
    expect((tokenBody.access_token as string).startsWith("microsoft_")).toBe(true);
    expect(tokenBody.refresh_token).toBeDefined();
    expect((tokenBody.refresh_token as string).startsWith("r_microsoft_")).toBe(true);
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.expires_in).toBe(3600);
    expect(tokenBody.id_token).toBeDefined();
    expect(tokenBody.scope).toBeDefined();

    // Decode and verify id_token claims
    const claims = decodeJwt(tokenBody.id_token as string);
    expect(claims.iss).toContain("/v2.0");
    expect(claims.aud).toBe("test-client");
    expect(claims.sub).toBeDefined();
    expect(claims.email).toBe("testuser@example.com");
    expect(claims.name).toBe("Test User");
    expect(claims.preferred_username).toBe("testuser@example.com");
    expect(claims.oid).toBeDefined();
    expect(claims.tid).toBeDefined();
    expect(claims.ver).toBe("2.0");
    expect(claims.nonce).toBe("test-nonce");
  });

  // --- Refresh token flow ---

  it("exchanges refresh_token for new access_token with rotated refresh_token", async () => {
    const { code } = await getAuthCode(app);
    const tokenRes = await exchangeCode(app, code);
    const tokenBody = await tokenRes.json() as Record<string, unknown>;
    const refreshToken = tokenBody.refresh_token as string;

    const refreshFormData = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "test-client",
      client_secret: "test-secret",
    });

    const refreshRes = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshFormData.toString(),
    });

    expect(refreshRes.status).toBe(200);
    const refreshBody = await refreshRes.json() as Record<string, unknown>;
    expect(refreshBody.access_token).toBeDefined();
    expect((refreshBody.access_token as string).startsWith("microsoft_")).toBe(true);
    expect(refreshBody.id_token).toBeDefined();
    expect(refreshBody.token_type).toBe("Bearer");
    expect(refreshBody.expires_in).toBe(3600);
    // Microsoft rotates refresh tokens
    expect(refreshBody.refresh_token).toBeDefined();
    expect(refreshBody.refresh_token).not.toBe(refreshToken);
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

  // --- form_post response mode ---

  it("returns auto-submit form for form_post response mode", async () => {
    const result = await getAuthCode(app, { response_mode: "form_post" });
    expect(result.code).toBeTruthy();
    expect(result.state).toBe("test-state");
  });

  // --- Unsupported grant type ---

  it("rejects unsupported grant type", async () => {
    const formData = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "test-client",
      client_secret: "test-secret",
    });

    const res = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("unsupported_grant_type");
  });

  // --- UserInfo endpoint ---

  it("GET /oidc/userinfo returns user info when authenticated", async () => {
    const { code } = await getAuthCode(app);
    const tokenRes = await exchangeCode(app, code);
    const tokenBody = await tokenRes.json() as Record<string, unknown>;
    const accessToken = tokenBody.access_token as string;

    const res = await app.request(`${base}/oidc/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.sub).toBeDefined();
    expect(body.email).toBe("testuser@example.com");
    expect(body.name).toBe("Test User");
    expect(body.preferred_username).toBe("testuser@example.com");
  });

  // --- Graph /me endpoint ---

  it("GET /v1.0/me returns Graph-style user profile when authenticated", async () => {
    const { code } = await getAuthCode(app);
    const tokenRes = await exchangeCode(app, code);
    const tokenBody = await tokenRes.json() as Record<string, unknown>;
    const accessToken = tokenBody.access_token as string;

    const res = await app.request(`${base}/v1.0/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.displayName).toBe("Test User");
    expect(body.mail).toBe("testuser@example.com");
    expect(body.userPrincipalName).toBe("testuser@example.com");
    expect(body.id).toBeDefined();
    expect(body["@odata.context"]).toContain("$metadata#users");
  });

  // --- Logout endpoint ---

  it("GET /oauth2/v2.0/logout redirects when post_logout_redirect_uri is registered", async () => {
    const redirectUri = "http://localhost:3000/callback";
    const res = await app.request(`${base}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(redirectUri)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(redirectUri);
  });

  it("GET /oauth2/v2.0/logout rejects unregistered post_logout_redirect_uri", async () => {
    const redirectUri = "http://evil.example.com/phishing";
    const res = await app.request(`${base}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(redirectUri)}`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toBe("Invalid post_logout_redirect_uri");
  });

  it("GET /oauth2/v2.0/logout returns text without redirect URI", async () => {
    const res = await app.request(`${base}/oauth2/v2.0/logout`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("Logged out");
  });

  // --- Token revocation ---

  it("POST /oauth2/v2.0/revoke returns 200", async () => {
    const formData = new URLSearchParams({
      token: "some-token",
    });

    const res = await app.request(`${base}/oauth2/v2.0/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    expect(res.status).toBe(200);
  });

  // --- Client secret validation ---

  it("rejects incorrect client_secret", async () => {
    const { code } = await getAuthCode(app);
    const res = await exchangeCode(app, code, { client_secret: "wrong-secret" });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_client");
  });

  // --- client_secret_basic authentication ---

  it("accepts client credentials via Authorization Basic header", async () => {
    const { code } = await getAuthCode(app);

    const credentials = Buffer.from("test-client:test-secret").toString("base64");
    const formData = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:3000/callback",
    });

    const res = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: formData.toString(),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.access_token).toBeDefined();
    expect((body.access_token as string).startsWith("microsoft_")).toBe(true);
  });

  it("rejects incorrect secret via Authorization Basic header", async () => {
    const { code } = await getAuthCode(app);

    const credentials = Buffer.from("test-client:wrong-secret").toString("base64");
    const formData = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:3000/callback",
    });

    const res = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: formData.toString(),
    });

    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_client");
  });

  // --- client_credentials grant type ---

  it("issues token for client_credentials grant", async () => {
    const formData = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "test-client",
      client_secret: "test-secret",
      scope: "https://graph.microsoft.com/.default",
    });

    const res = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.access_token).toBeDefined();
    expect((body.access_token as string).startsWith("microsoft_")).toBe(true);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe("https://graph.microsoft.com/.default");
    // client_credentials should NOT return refresh_token or id_token
    expect(body.refresh_token).toBeUndefined();
    expect(body.id_token).toBeUndefined();
  });

  it("rejects client_credentials with wrong secret", async () => {
    const formData = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "test-client",
      client_secret: "wrong-secret",
    });

    const res = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_client");
  });

  it("supports client_credentials with Basic auth header", async () => {
    const credentials = Buffer.from("test-client:test-secret").toString("base64");
    const formData = new URLSearchParams({
      grant_type: "client_credentials",
      scope: ".default",
    });

    const res = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: formData.toString(),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.access_token).toBeDefined();
  });

  // --- Seed from config ---

  it("seeds users and clients from config", () => {
    const testStore = new Store();
    const webhooks = new WebhookDispatcher();
    const testTokenMap: TokenMap = new Map();
    const testApp = new Hono();
    testApp.use("*", authMiddleware(testTokenMap));
    microsoftPlugin.register(testApp as any, testStore, webhooks, base, testTokenMap);

    seedFromConfig(testStore, base, {
      users: [
        { email: "alice@outlook.com", name: "Alice Smith" },
        { email: "bob@live.com", name: "Bob Jones", tenant_id: "custom-tenant" },
      ],
      oauth_clients: [
        {
          client_id: "my-app",
          client_secret: "my-secret",
          name: "My App",
          redirect_uris: ["http://localhost:3000/callback"],
        },
      ],
    });

    const ms = getMicrosoftStore(testStore);

    const alice = ms.users.findOneBy("email", "alice@outlook.com");
    expect(alice).toBeDefined();
    expect(alice!.name).toBe("Alice Smith");
    expect(alice!.preferred_username).toBe("alice@outlook.com");

    const bob = ms.users.findOneBy("email", "bob@live.com");
    expect(bob).toBeDefined();
    expect(bob!.tenant_id).toBe("custom-tenant");

    const client = ms.oauthClients.findOneBy("client_id", "my-app");
    expect(client).toBeDefined();
    expect(client!.name).toBe("My App");
  });
});
