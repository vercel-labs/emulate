import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { linkedinPlugin, seedFromConfig, getLinkedInStore } from "../index.js";
import { decodeJwt } from "jose";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();

  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  linkedinPlugin.register(app as any, store, webhooks, base, tokenMap);
  linkedinPlugin.seed?.(store, base);
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
  } = {},
): Promise<{ code: string; state: string }> {
  const email = options.email ?? "testuser@example.com";
  const redirect_uri = options.redirect_uri ?? "http://localhost:3000/callback";
  const scope = options.scope ?? "openid email profile";
  const state = options.state ?? "test-state";
  const nonce = options.nonce ?? "test-nonce";
  const client_id = options.client_id ?? "test-client";

  const formData = new URLSearchParams({
    email,
    redirect_uri,
    scope,
    state,
    nonce,
    client_id,
    code_challenge: "",
    code_challenge_method: "",
  });

  const res = await app.request(`${base}/oauth/v2/authorization/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

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

  return app.request(`${base}/oauth/v2/accessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });
}

describe("LinkedIn plugin integration", () => {
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

  it("GET /.well-known/openid-configuration returns LinkedIn OIDC discovery document", async () => {
    const res = await app.request(`${base}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.issuer).toBe(base);
    expect(body.authorization_endpoint).toBe(`${base}/oauth/v2/authorization`);
    expect(body.token_endpoint).toBe(`${base}/oauth/v2/accessToken`);
    expect(body.userinfo_endpoint).toBe(`${base}/v2/userinfo`);
    expect(body.revocation_endpoint).toBe(`${base}/oauth/v2/revoke`);
    expect(body.jwks_uri).toBe(`${base}/oauth2/v3/certs`);
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.subject_types_supported).toEqual(["public"]);
    expect(body.id_token_signing_alg_values_supported).toEqual(["HS256"]);
    expect(body.scopes_supported).toContain("openid");
    expect(body.scopes_supported).toContain("email");
    expect(body.scopes_supported).toContain("profile");
    expect(body.claims_supported).toContain("sub");
    expect(body.claims_supported).toContain("email");
    expect(body.claims_supported).toContain("picture");
    expect(body.code_challenge_methods_supported).toEqual(["plain", "S256"]);
  });

  // --- JWKS ---

  it("GET /oauth2/v3/certs returns empty JWKS", async () => {
    const res = await app.request(`${base}/oauth2/v3/certs`);
    expect(res.status).toBe(200);
    const body = await res.json() as { keys: unknown[] };
    expect(body.keys).toEqual([]);
  });

  // --- Authorization page ---

  it("GET /oauth/v2/authorization returns an HTML sign-in page", async () => {
    const url = `${base}/oauth/v2/authorization?client_id=test-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&scope=openid%20email%20profile`;
    const res = await app.request(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html.length).toBeGreaterThan(0);
    expect(html).toMatch(/Sign in/i);
    expect(html).toMatch(/LinkedIn/i);
  });

  it("returns error for unknown client_id when clients are configured", async () => {
    const url = `${base}/oauth/v2/authorization?client_id=unknown-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}`;
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
      code_challenge: "",
      code_challenge_method: "",
    });

    const res = await app.request(`${base}/oauth/v2/authorization/callback`, {
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
    expect((tokenBody.access_token as string).startsWith("linkedin_")).toBe(true);
    expect(tokenBody.refresh_token).toBeDefined();
    expect((tokenBody.refresh_token as string).startsWith("linkedin_refresh_")).toBe(true);
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.expires_in).toBe(3600);
    expect(tokenBody.id_token).toBeDefined();
    expect(tokenBody.scope).toBeDefined();

    const claims = decodeJwt(tokenBody.id_token as string);
    expect(claims.iss).toBe(base);
    expect(claims.aud).toBe("test-client");
    expect(claims.sub).toBeDefined();
    expect(claims.email).toBe("testuser@example.com");
    expect(claims.name).toBe("Test User");
    expect(claims.email_verified).toBe(true);
    expect(claims.nonce).toBe("test-nonce");
  });

  // --- Refresh token flow ---

  it("exchanges refresh_token for new access_token", async () => {
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

    const refreshRes = await app.request(`${base}/oauth/v2/accessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshFormData.toString(),
    });

    expect(refreshRes.status).toBe(200);
    const refreshBody = await refreshRes.json() as Record<string, unknown>;
    expect(refreshBody.access_token).toBeDefined();
    expect((refreshBody.access_token as string).startsWith("linkedin_")).toBe(true);
    expect(refreshBody.token_type).toBe("Bearer");
    expect(refreshBody.expires_in).toBe(3600);
  });

  // --- Authorization code is single-use ---

  it("rejects second use of authorization code", async () => {
    const { code } = await getAuthCode(app);

    const res1 = await exchangeCode(app, code);
    expect(res1.status).toBe(200);

    const res2 = await exchangeCode(app, code);
    expect(res2.status).toBe(400);
    const body = await res2.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_grant");
  });

  // --- Unsupported grant type ---

  it("rejects unsupported grant type", async () => {
    const formData = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "test-client",
      client_secret: "test-secret",
    });

    const res = await app.request(`${base}/oauth/v2/accessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("unsupported_grant_type");
  });

  // --- UserInfo endpoint ---

  it("GET /v2/userinfo returns user info when authenticated", async () => {
    const { code } = await getAuthCode(app);
    const tokenRes = await exchangeCode(app, code);
    const tokenBody = await tokenRes.json() as Record<string, unknown>;
    const accessToken = tokenBody.access_token as string;

    const res = await app.request(`${base}/v2/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.sub).toBeDefined();
    expect(body.email).toBe("testuser@example.com");
    expect(body.name).toBe("Test User");
    expect(body.email_verified).toBe(true);
    expect(body.given_name).toBe("Test");
    expect(body.family_name).toBe("User");
    expect(body.locale).toBe("en_US");
  });

  // --- Token revocation ---

  it("POST /oauth/v2/revoke returns 200", async () => {
    const formData = new URLSearchParams({
      token: "some-token",
    });

    const res = await app.request(`${base}/oauth/v2/revoke`, {
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

    const res = await app.request(`${base}/oauth/v2/accessToken`, {
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
    expect((body.access_token as string).startsWith("linkedin_")).toBe(true);
  });

  it("rejects incorrect secret via Authorization Basic header", async () => {
    const { code } = await getAuthCode(app);

    const credentials = Buffer.from("test-client:wrong-secret").toString("base64");
    const formData = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:3000/callback",
    });

    const res = await app.request(`${base}/oauth/v2/accessToken`, {
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

  // --- Seed from config ---

  it("seeds users and clients from config", () => {
    const testStore = new Store();
    const webhooks = new WebhookDispatcher();
    const testTokenMap: TokenMap = new Map();
    const testApp = new Hono();
    testApp.use("*", authMiddleware(testTokenMap));
    linkedinPlugin.register(testApp as any, testStore, webhooks, base, testTokenMap);

    seedFromConfig(testStore, base, {
      users: [
        { email: "alice@linkedin.com", name: "Alice Smith" },
        { email: "bob@linkedin.com", name: "Bob Jones", locale: "de_DE" },
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

    const li = getLinkedInStore(testStore);

    const alice = li.users.findOneBy("email", "alice@linkedin.com");
    expect(alice).toBeDefined();
    expect(alice!.name).toBe("Alice Smith");
    expect(alice!.given_name).toBe("Alice");
    expect(alice!.family_name).toBe("Smith");
    expect(alice!.locale).toBe("en_US");

    const bob = li.users.findOneBy("email", "bob@linkedin.com");
    expect(bob).toBeDefined();
    expect(bob!.locale).toBe("de_DE");

    const client = li.oauthClients.findOneBy("client_id", "my-app");
    expect(client).toBeDefined();
    expect(client!.name).toBe("My App");
  });
});
