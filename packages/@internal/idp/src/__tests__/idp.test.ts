import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { Hono } from "hono";
import type { AppEnv, TokenMap } from "@internal/core";
import { Store, WebhookDispatcher, authMiddleware } from "@internal/core";
import { idpPlugin, seedFromConfig, type IdpSeedConfig } from "../index.js";
import { getIdpStore } from "../store.js";
import { generateSigningKeySync } from "../crypto.js";

describe("idpPlugin", () => {
  it("has correct name", () => {
    expect(idpPlugin.name).toBe("idp");
  });

  it("has register function", () => {
    expect(typeof idpPlugin.register).toBe("function");
  });

  it("has seed function", () => {
    expect(typeof idpPlugin.seed).toBe("function");
  });
});

describe("seedDefaults", () => {
  it("creates default user and signing key", () => {
    const store = new Store();
    idpPlugin.seed!(store, "http://localhost:4003");
    const idp = getIdpStore(store);
    const users = idp.users.all();
    expect(users.length).toBe(1);
    expect(users[0].email).toBe("testuser@example.com");
    expect(users[0].name).toBe("Test User");
    expect(users[0].groups).toEqual([]);
    expect(users[0].roles).toEqual([]);

    const keys = idp.signingKeys.all();
    expect(keys.length).toBe(1);
    expect(keys[0].alg).toBe("RS256");
    expect(keys[0].active).toBe(true);
  });
});

describe("seedFromConfig", () => {
  it("seeds users with correct fields", () => {
    const store = new Store();
    const config: IdpSeedConfig = {
      users: [
        { email: "alice@example.com", name: "Alice", groups: ["admins"], roles: ["owner"], attributes: { dept: "Eng" } },
        { email: "bob@example.com" },
      ],
    };
    seedFromConfig(store, "http://localhost:4003", config);
    const idp = getIdpStore(store);
    const users = idp.users.all();
    expect(users.length).toBe(2);
    expect(users[0].email).toBe("alice@example.com");
    expect(users[0].name).toBe("Alice");
    expect(users[0].groups).toEqual(["admins"]);
    expect(users[0].roles).toEqual(["owner"]);
    expect(users[0].attributes).toEqual({ dept: "Eng" });
    expect(users[0].uid).toBeTruthy();

    expect(users[1].email).toBe("bob@example.com");
    expect(users[1].name).toBe("bob"); // derived from email
    expect(users[1].groups).toEqual([]);
    expect(users[1].roles).toEqual([]);
  });

  it("skips duplicate emails", () => {
    const store = new Store();
    seedFromConfig(store, "http://localhost:4003", {
      users: [{ email: "alice@example.com" }],
    });
    seedFromConfig(store, "http://localhost:4003", {
      users: [{ email: "alice@example.com" }],
    });
    const idp = getIdpStore(store);
    expect(idp.users.all().length).toBe(1);
  });

  it("seeds clients with defaults for optional fields", () => {
    const store = new Store();
    seedFromConfig(store, "http://localhost:4003", {
      oidc: {
        clients: [{
          client_id: "my-app",
          client_secret: "my-secret",
          redirect_uris: ["http://localhost:3000/callback"],
        }],
      },
    });
    const idp = getIdpStore(store);
    const clients = idp.clients.all();
    expect(clients.length).toBe(1);
    expect(clients[0].client_id).toBe("my-app");
    expect(clients[0].client_secret).toBe("my-secret");
    expect(clients[0].redirect_uris).toEqual(["http://localhost:3000/callback"]);
    expect(clients[0].name).toBe("my-app"); // defaults to client_id
    expect(clients[0].post_logout_redirect_uris).toEqual([]);
    expect(clients[0].scopes).toEqual(["openid", "email", "profile"]);
    expect(clients[0].claim_mappings).toEqual({});
    expect(clients[0].access_token_ttl).toBe(3600);
    expect(clients[0].id_token_ttl).toBe(3600);
    expect(clients[0].refresh_token_ttl).toBe(86400);
  });

  it("auto-generates signing key when none provided", () => {
    const store = new Store();
    seedFromConfig(store, "http://localhost:4003", { users: [{ email: "test@test.com" }] });
    const idp = getIdpStore(store);
    expect(idp.signingKeys.all().length).toBe(1);
  });

  it("uses provided signing keys", () => {
    const store = new Store();
    const generated = generateSigningKeySync("provided-kid");
    seedFromConfig(store, "http://localhost:4003", {
      oidc: {
        signing_keys: [{ kid: "provided-kid", private_key_pem: generated.private_key_pem }],
      },
    });
    const idp = getIdpStore(store);
    const keys = idp.signingKeys.all();
    expect(keys.length).toBe(1);
    expect(keys[0].kid).toBe("provided-kid");
  });

  it("stores strict flag", () => {
    const store = new Store();
    seedFromConfig(store, "http://localhost:4003", { strict: true });
    expect(store.getData<boolean>("idp.strict")).toBe(true);
  });

  it("stores custom issuer", () => {
    const store = new Store();
    seedFromConfig(store, "http://localhost:4003", {
      oidc: { issuer: "https://custom-issuer.example.com" },
    });
    expect(store.getData<string>("idp.issuer")).toBe("https://custom-issuer.example.com");
  });

  it("seeds groups", () => {
    const store = new Store();
    seedFromConfig(store, "http://localhost:4003", {
      groups: [{ name: "engineering", display_name: "Engineering Team" }],
    });
    const idp = getIdpStore(store);
    const groups = idp.groups.all();
    expect(groups.length).toBe(1);
    expect(groups[0].name).toBe("engineering");
    expect(groups[0].display_name).toBe("Engineering Team");
  });
});

// ---------------------------------------------------------------------------
// OIDC Integration Tests
// ---------------------------------------------------------------------------

function createTestApp(config?: IdpSeedConfig) {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();

  // Pre-seeded token for userinfo tests
  tokenMap.set("test-bearer-token", { login: "alice@example.com", id: 1, scopes: ["openid", "email", "profile", "groups", "roles"] });

  const app = new Hono<AppEnv>();

  // Add auth middleware
  app.use("*", authMiddleware(tokenMap));

  // Register plugin
  idpPlugin.register(app as any, store, webhooks, "http://localhost:4003", tokenMap);

  // Seed defaults
  idpPlugin.seed!(store, "http://localhost:4003");
  if (config) {
    seedFromConfig(store, "http://localhost:4003", config);
  }

  return { app, store, tokenMap };
}

/** Helper: look up the uid for a seeded user by email */
function getUserUid(store: Store, email: string): string {
  const idp = getIdpStore(store);
  const user = idp.users.findOneBy("email", email);
  if (!user) throw new Error(`Test setup: no user with email ${email}`);
  return user.uid;
}

describe("OIDC Discovery", () => {
  it("returns valid openid-configuration", async () => {
    const { app } = createTestApp();
    const res = await app.request("/.well-known/openid-configuration");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBe("http://localhost:4003");
    expect(body.authorization_endpoint).toBe("http://localhost:4003/authorize");
    expect(body.token_endpoint).toBe("http://localhost:4003/token");
    expect(body.userinfo_endpoint).toBe("http://localhost:4003/userinfo");
    expect(body.jwks_uri).toBe("http://localhost:4003/jwks.json");
    expect(body.id_token_signing_alg_values_supported).toContain("RS256");
    expect(body.grant_types_supported).toContain("authorization_code");
    expect(body.grant_types_supported).toContain("refresh_token");
    expect(body.code_challenge_methods_supported).toContain("S256");
  });

  it("uses custom issuer when configured", async () => {
    const { app } = createTestApp({ oidc: { issuer: "https://custom.example.com" } });
    const res = await app.request("/.well-known/openid-configuration");
    const body = await res.json();
    expect(body.issuer).toBe("https://custom.example.com");
  });
});

describe("JWKS", () => {
  it("returns RSA public keys", async () => {
    const { app } = createTestApp();
    const res = await app.request("/jwks.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys.length).toBeGreaterThan(0);
    expect(body.keys[0].kty).toBe("RSA");
    expect(body.keys[0].alg).toBe("RS256");
    expect(body.keys[0].use).toBe("sig");
    expect(body.keys[0].kid).toBeDefined();
    expect(body.keys[0].n).toBeDefined();
    expect(body.keys[0].e).toBeDefined();
  });
});

describe("Authorize", () => {
  it("renders sign-in page with seeded users", async () => {
    const { app } = createTestApp({
      users: [
        { email: "alice@example.com", name: "Alice" },
        { email: "bob@example.com", name: "Bob" },
      ],
    });
    const res = await app.request("/authorize?response_type=code&client_id=test&redirect_uri=http://localhost:3000/cb&scope=openid&state=xyz");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("alice@example.com");
    expect(html).toContain("bob@example.com");
  });

  it("rejects unknown client_id in strict mode", async () => {
    const { app } = createTestApp({
      strict: true,
      oidc: { clients: [{ client_id: "known", client_secret: "s", redirect_uris: ["http://localhost/cb"] }] },
    });
    const res = await app.request("/authorize?response_type=code&client_id=unknown&redirect_uri=http://localhost/cb");
    expect(res.status).toBe(400);
  });

  it("rejects unsupported response_type", async () => {
    const { app } = createTestApp();
    const res = await app.request("/authorize?response_type=token&client_id=test&redirect_uri=http://localhost:3000/cb");
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Unsupported Response Type");
  });

  it("rejects unregistered redirect_uri in strict mode", async () => {
    const { app } = createTestApp({
      strict: true,
      oidc: { clients: [{ client_id: "known", client_secret: "s", redirect_uris: ["http://localhost/cb"] }] },
    });
    const res = await app.request("/authorize?response_type=code&client_id=known&redirect_uri=http://evil.com/cb");
    expect(res.status).toBe(400);
  });
});

describe("Authorization Code Flow", () => {
  it("completes full auth code exchange", async () => {
    const { app, store } = createTestApp({
      users: [{ email: "alice@example.com", name: "Alice" }],
      oidc: { clients: [{ client_id: "app", client_secret: "secret", redirect_uris: ["http://localhost:3000/cb"] }] },
    });
    const uid = getUserUid(store, "alice@example.com");

    // Step 1: POST callback to get auth code
    const callbackRes = await app.request("/authorize/callback", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        uid,
        redirect_uri: "http://localhost:3000/cb",
        scope: "openid email profile offline_access",
        state: "test-state",
        client_id: "app",
      }).toString(),
    });
    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get("Location")!;
    expect(location).toContain("code=");
    expect(location).toContain("state=test-state");

    const url = new URL(location);
    const code = url.searchParams.get("code")!;

    // Step 2: Exchange code for tokens
    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:3000/cb",
        client_id: "app",
        client_secret: "secret",
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens.access_token).toBeDefined();
    expect(tokens.access_token).toMatch(/^idp_/);
    expect(tokens.id_token).toBeDefined();
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBeDefined();
    expect(tokens.refresh_token).toBeDefined();
    expect(tokens.refresh_token).toMatch(/^idprt_/);
  });

  it("rejects unknown uid instead of falling back to wrong user", async () => {
    const { app } = createTestApp({
      users: [{ email: "alice@example.com", name: "Alice" }],
    });

    const cbRes = await app.request("/authorize/callback", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        uid: "nonexistent-uid",
        redirect_uri: "http://localhost:3000/cb",
        scope: "openid",
        client_id: "test",
      }).toString(),
    });
    const code = new URL(cbRes.headers.get("Location")!).searchParams.get("code")!;

    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: "http://localhost:3000/cb", client_id: "test",
      }).toString(),
    });
    expect(tokenRes.status).toBe(400);
    const body = await tokenRes.json();
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toContain("User not found");
  });

  it("rejects invalid code", async () => {
    const { app } = createTestApp();
    const res = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "invalid-code",
        redirect_uri: "http://localhost:3000/cb",
      }).toString(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
  });

  it("rejects code reuse", async () => {
    const { app, store } = createTestApp({
      users: [{ email: "test@test.com" }],
    });
    const uid = getUserUid(store, "test@test.com");

    const cbRes = await app.request("/authorize/callback", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        uid,
        redirect_uri: "http://localhost:3000/cb",
        scope: "openid",
        client_id: "test",
      }).toString(),
    });
    const loc = cbRes.headers.get("Location")!;
    const code = new URL(loc).searchParams.get("code")!;

    // First use succeeds
    const firstRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:3000/cb", client_id: "test" }).toString(),
    });
    expect(firstRes.status).toBe(200);

    // Second use fails
    const secondRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:3000/cb", client_id: "test" }).toString(),
    });
    expect(secondRes.status).toBe(400);
  });

  it("accepts application/json on token endpoint", async () => {
    const { app, store } = createTestApp({ users: [{ email: "test@test.com" }] });
    const uid = getUserUid(store, "test@test.com");
    const cbRes = await app.request("/authorize/callback", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        uid, redirect_uri: "http://localhost:3000/cb", scope: "openid", client_id: "test",
      }).toString(),
    });
    const code = new URL(cbRes.headers.get("Location")!).searchParams.get("code")!;

    const res = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:3000/cb",
        client_id: "test",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBeDefined();
  });

  it("rejects unsupported grant type", async () => {
    const { app } = createTestApp();
    const res = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("unsupported_grant_type");
  });

  it("supports client_secret_basic auth", async () => {
    const { app, store } = createTestApp({
      users: [{ email: "alice@example.com" }],
      oidc: { clients: [{ client_id: "app", client_secret: "secret", redirect_uris: ["http://localhost:3000/cb"] }] },
    });
    const uid = getUserUid(store, "alice@example.com");

    const cbRes = await app.request("/authorize/callback", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        uid, redirect_uri: "http://localhost:3000/cb", scope: "openid", client_id: "app",
      }).toString(),
    });
    const code = new URL(cbRes.headers.get("Location")!).searchParams.get("code")!;

    const basicAuth = Buffer.from("app:secret").toString("base64");
    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:3000/cb" }).toString(),
    });
    expect(tokenRes.status).toBe(200);
  });
});

describe("PKCE", () => {
  it("validates S256 with correct verifier", async () => {
    const { app, store } = createTestApp({ users: [{ email: "test@test.com" }] });
    const uid = getUserUid(store, "test@test.com");
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const cbRes = await app.request("/authorize/callback", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        uid, redirect_uri: "http://localhost:3000/cb", scope: "openid",
        client_id: "test", code_challenge: challenge, code_challenge_method: "S256",
      }).toString(),
    });
    const code = new URL(cbRes.headers.get("Location")!).searchParams.get("code")!;

    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: "http://localhost:3000/cb", code_verifier: verifier, client_id: "test",
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
  });

  it("rejects missing PKCE in strict mode", async () => {
    const { app, store } = createTestApp({
      strict: true,
      users: [{ email: "test@test.com" }],
      oidc: { clients: [{ client_id: "app", client_secret: "secret", redirect_uris: ["http://localhost:3000/cb"] }] },
    });
    // Authorize without code_challenge
    const cbRes = await app.request("/authorize/callback", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        uid: getUserUid(store, "test@test.com"), redirect_uri: "http://localhost:3000/cb", scope: "openid", client_id: "app",
      }).toString(),
    });
    const code = new URL(cbRes.headers.get("Location")!).searchParams.get("code")!;

    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: "http://localhost:3000/cb",
        client_id: "app", client_secret: "secret",
      }).toString(),
    });
    expect(tokenRes.status).toBe(400);
    const body = await tokenRes.json();
    expect(body.error).toBe("invalid_grant");
  });

  it("rejects S256 with wrong verifier", async () => {
    const { app, store } = createTestApp({ users: [{ email: "test@test.com" }] });
    const uid = getUserUid(store, "test@test.com");
    const challenge = createHash("sha256").update("correct").digest("base64url");

    const cbRes = await app.request("/authorize/callback", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        uid, redirect_uri: "http://localhost:3000/cb", scope: "openid",
        client_id: "test", code_challenge: challenge, code_challenge_method: "S256",
      }).toString(),
    });
    const code = new URL(cbRes.headers.get("Location")!).searchParams.get("code")!;

    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: "http://localhost:3000/cb", code_verifier: "wrong", client_id: "test",
      }).toString(),
    });
    expect(tokenRes.status).toBe(400);
    const body = await tokenRes.json();
    expect(body.error).toBe("invalid_grant");
  });
});

describe("Refresh Token", () => {
  async function getTokensWithRefresh(app: any, uid: string) {
    const cbRes = await app.request("/authorize/callback", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        uid, redirect_uri: "http://localhost:3000/cb", scope: "openid offline_access", client_id: "app",
      }).toString(),
    });
    const code = new URL(cbRes.headers.get("Location")!).searchParams.get("code")!;
    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: "http://localhost:3000/cb", client_id: "app", client_secret: "secret",
      }).toString(),
    });
    return tokenRes.json();
  }

  it("issues refresh token with offline_access scope", async () => {
    const { app, store } = createTestApp({
      users: [{ email: "alice@example.com" }],
      oidc: { clients: [{ client_id: "app", client_secret: "secret", redirect_uris: ["http://localhost:3000/cb"] }] },
    });
    const uid = getUserUid(store, "alice@example.com");
    const tokens = await getTokensWithRefresh(app, uid);
    expect(tokens.refresh_token).toBeDefined();
    expect(tokens.refresh_token).toMatch(/^idprt_/);
  });

  it("exchanges refresh token for new tokens", async () => {
    const { app, store } = createTestApp({
      users: [{ email: "alice@example.com" }],
      oidc: { clients: [{ client_id: "app", client_secret: "secret", redirect_uris: ["http://localhost:3000/cb"] }] },
    });
    const uid = getUserUid(store, "alice@example.com");
    const tokens = await getTokensWithRefresh(app, uid);

    const refreshRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: "app", client_secret: "secret",
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const newTokens = await refreshRes.json();
    expect(newTokens.access_token).toBeDefined();
    expect(newTokens.access_token).not.toBe(tokens.access_token);
    expect(newTokens.refresh_token).toBeDefined();
    expect(newTokens.refresh_token).not.toBe(tokens.refresh_token); // rotated
  });

  it("rejects invalid refresh token", async () => {
    const { app } = createTestApp();
    const res = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "invalid" }).toString(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
  });
});

describe("Userinfo", () => {
  it("returns user claims with valid bearer token", async () => {
    const { app, store, tokenMap } = createTestApp({
      users: [{ email: "alice@example.com", name: "Alice Example", groups: ["admins"], roles: ["owner"] }],
    });

    // Register a token for the user
    tokenMap.set("test-token", { login: "alice@example.com", id: 1, scopes: ["openid", "email", "profile", "groups", "roles"] });

    const res = await app.request("/userinfo", {
      headers: { "Authorization": "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("alice@example.com");
    expect(body.name).toBe("Alice Example");
    expect(body.groups).toEqual(["admins"]);
    expect(body.roles).toEqual(["owner"]);
  });

  it("returns 401 without auth", async () => {
    const { app } = createTestApp();
    const res = await app.request("/userinfo");
    expect(res.status).toBe(401);
  });
});

describe("Revoke", () => {
  it("revokes access token and returns 200", async () => {
    const { app, tokenMap } = createTestApp();
    tokenMap.set("idp_to_revoke", { login: "test@test.com", id: 1, scopes: [] });

    const res = await app.request("/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "idp_to_revoke" }).toString(),
    });
    expect(res.status).toBe(200);
    expect(tokenMap.has("idp_to_revoke")).toBe(false);
  });

  it("revoked token is rejected at /userinfo", async () => {
    const { app, tokenMap } = createTestApp({
      users: [{ email: "alice@example.com", name: "Alice" }],
    });
    tokenMap.set("idp_revoke_me", { login: "alice@example.com", id: 1, scopes: ["openid", "email"] });

    // Verify token works before revocation
    const beforeRes = await app.request("/userinfo", {
      headers: { "Authorization": "Bearer idp_revoke_me" },
    });
    expect(beforeRes.status).toBe(200);

    // Revoke the token
    await app.request("/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "idp_revoke_me" }).toString(),
    });

    // Verify token is rejected after revocation
    const afterRes = await app.request("/userinfo", {
      headers: { "Authorization": "Bearer idp_revoke_me" },
    });
    expect(afterRes.status).toBe(401);
    const body = await afterRes.json();
    expect(body.error).toBe("invalid_token");
  });

  it("returns 200 for unknown token (per RFC 7009)", async () => {
    const { app } = createTestApp();
    const res = await app.request("/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "nonexistent" }).toString(),
    });
    expect(res.status).toBe(200);
  });
});

describe("Debug", () => {
  it("returns state in permissive mode", async () => {
    const { app } = createTestApp();
    const res = await app.request("/_debug/state");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users_count).toBeDefined();
    expect(body.clients_count).toBeDefined();
    expect(body.signing_keys).toBeDefined();
  });

  it("returns 403 in strict mode", async () => {
    const { app } = createTestApp({ strict: true });
    const res = await app.request("/_debug/state");
    expect(res.status).toBe(403);
  });
});

describe("Logout", () => {
  it("renders signed-out page when no redirect URI provided", async () => {
    const { app } = createTestApp();
    const res = await app.request("/logout");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Signed out");
  });

  it("redirects to post_logout_redirect_uri", async () => {
    const { app } = createTestApp();
    const res = await app.request("/logout?post_logout_redirect_uri=http://localhost:3000/logged-out&state=abc");
    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location).toContain("http://localhost:3000/logged-out");
    expect(location).toContain("state=abc");
  });

  it("rejects invalid post_logout_redirect_uri", async () => {
    const { app } = createTestApp();
    const res = await app.request("/logout?post_logout_redirect_uri=not-a-url");
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Invalid URI");
  });

  it("rejects unregistered post_logout_redirect_uri in strict mode with id_token_hint", async () => {
    const { app, store } = createTestApp({
      strict: true,
      users: [{ email: "alice@example.com" }],
      oidc: {
        clients: [{
          client_id: "app",
          client_secret: "secret",
          redirect_uris: ["http://localhost:3000/cb"],
          post_logout_redirect_uris: ["http://localhost:3000/signed-out"],
        }],
      },
    });

    // Create a fake id_token_hint with aud=app
    const fakePayload = Buffer.from(JSON.stringify({ aud: "app", sub: "test" })).toString("base64url");
    const fakeIdToken = `eyJhbGciOiJSUzI1NiJ9.${fakePayload}.fake-sig`;

    const res = await app.request(`/logout?post_logout_redirect_uri=http://evil.com/logout&id_token_hint=${fakeIdToken}`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Invalid redirect");
  });

  it("allows registered post_logout_redirect_uri in strict mode", async () => {
    const { app } = createTestApp({
      strict: true,
      users: [{ email: "alice@example.com" }],
      oidc: {
        clients: [{
          client_id: "app",
          client_secret: "secret",
          redirect_uris: ["http://localhost:3000/cb"],
          post_logout_redirect_uris: ["http://localhost:3000/signed-out"],
        }],
      },
    });

    const fakePayload = Buffer.from(JSON.stringify({ aud: "app", sub: "test" })).toString("base64url");
    const fakeIdToken = `eyJhbGciOiJSUzI1NiJ9.${fakePayload}.fake-sig`;

    const res = await app.request(`/logout?post_logout_redirect_uri=http://localhost:3000/signed-out&id_token_hint=${fakeIdToken}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location).toContain("http://localhost:3000/signed-out");
  });
});

describe("ID Token Validation", () => {
  it("ID token verifies against JWKS public key", async () => {
    const { app, store } = createTestApp({
      users: [{ email: "alice@example.com" }],
    });
    const uid = getUserUid(store, "alice@example.com");

    // Get auth code
    const cbRes = await app.request("/authorize/callback", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        uid, redirect_uri: "http://localhost:3000/cb", scope: "openid", client_id: "test", nonce: "test-nonce",
      }).toString(),
    });
    const code = new URL(cbRes.headers.get("Location")!).searchParams.get("code")!;

    // Exchange for tokens
    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:3000/cb", client_id: "test" }).toString(),
    });
    const tokens = await tokenRes.json();

    // Fetch JWKS
    const jwksRes = await app.request("/jwks.json");
    const jwks = await jwksRes.json();

    // Verify ID token against JWKS
    const { importJWK, jwtVerify } = await import("jose");
    const pubKey = await importJWK(jwks.keys[0], "RS256");
    const { payload } = await jwtVerify(tokens.id_token, pubKey);
    expect(payload.iss).toBe("http://localhost:4003");
    expect(payload.nonce).toBe("test-nonce");
  });
});
