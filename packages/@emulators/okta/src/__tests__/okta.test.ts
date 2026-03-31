import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { getOktaStore, oktaPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("mgmt-token", { login: "admin@okta.local", id: 1, scopes: ["okta.*"] });
  tokenMap.set("ssws-token", { login: "admin@okta.local", id: 1, scopes: ["okta.*"] });

  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  oktaPlugin.register(app as any, store, webhooks, base, tokenMap);
  oktaPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "alice@example.com", first_name: "Alice", last_name: "Example" }],
    authorization_servers: [{ id: "custom-as", name: "Custom AS", audiences: ["api://custom"] }],
    oauth_clients: [
      {
        client_id: "custom-client",
        client_secret: "custom-secret",
        name: "Custom App",
        redirect_uris: ["http://localhost:3000/custom-callback"],
        auth_server_id: "custom-as",
      },
      {
        client_id: "org-client",
        client_secret: "org-secret",
        name: "Org App",
        redirect_uris: ["http://localhost:3000/org-callback"],
        auth_server_id: "org",
      },
    ],
  });
  return { app, store, tokenMap };
}

function managementHeaders(useSsws = false): Record<string, string> {
  return {
    Authorization: useSsws ? "SSWS ssws-token" : "Bearer mgmt-token",
    "Content-Type": "application/json",
  };
}

async function getAuthCode(
  app: Hono,
  store: Store,
  options: {
    authServerId?: string;
    userRef?: string;
    redirectUri?: string;
    clientId?: string;
    scope?: string;
    state?: string;
    nonce?: string;
    responseMode?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
  } = {},
): Promise<{ code: string; state: string; response: Response }> {
  const okta = getOktaStore(store);
  const userRef = options.userRef ?? okta.users.all()[0]?.okta_id ?? "";
  const authServerId = options.authServerId ?? "default";
  const redirectUri = options.redirectUri ?? "http://localhost:3000/callback";
  const clientId = options.clientId ?? "okta-test-client";
  const scope = options.scope ?? "openid profile email";
  const state = options.state ?? "state-1";
  const nonce = options.nonce ?? "nonce-1";
  const responseMode = options.responseMode ?? "query";
  const callbackPath = authServerId === "org"
    ? "/oauth2/v1/authorize/callback"
    : `/oauth2/${authServerId}/v1/authorize/callback`;

  const formData = new URLSearchParams({
    user_ref: userRef,
    redirect_uri: redirectUri,
    scope,
    state,
    nonce,
    client_id: clientId,
    response_mode: responseMode,
    code_challenge: options.codeChallenge ?? "",
    code_challenge_method: options.codeChallengeMethod ?? "",
    auth_server_id: authServerId,
  });

  const response = await app.request(`${base}${callbackPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

  if (responseMode === "form_post") {
    const html = await response.text();
    const code = html.match(/name="code" value="([^"]+)"/)?.[1] ?? "";
    const returnedState = html.match(/name="state" value="([^"]+)"/)?.[1] ?? "";
    return { code, state: returnedState, response };
  }

  const location = response.headers.get("location") ?? "";
  const locationUrl = new URL(location);
  return {
    code: locationUrl.searchParams.get("code") ?? "",
    state: locationUrl.searchParams.get("state") ?? "",
    response,
  };
}

async function exchangeCode(
  app: Hono,
  code: string,
  options: {
    authServerId?: string;
    clientId?: string;
    clientSecret?: string;
    includeClientSecret?: boolean;
    redirectUri?: string;
    codeVerifier?: string;
    useBasicAuth?: boolean;
  } = {},
): Promise<Response> {
  const authServerId = options.authServerId ?? "default";
  const tokenPath = authServerId === "org" ? "/oauth2/v1/token" : `/oauth2/${authServerId}/v1/token`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: options.clientId ?? "okta-test-client",
    redirect_uri: options.redirectUri ?? "http://localhost:3000/callback",
  });
  if (options.includeClientSecret ?? true) {
    body.set("client_secret", options.clientSecret ?? "okta-test-secret");
  }
  if (options.codeVerifier) {
    body.set("code_verifier", options.codeVerifier);
  }

  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (options.useBasicAuth) {
    const creds = Buffer.from(`${options.clientId ?? "okta-test-client"}:${options.clientSecret ?? "okta-test-secret"}`).toString("base64");
    headers.Authorization = `Basic ${creds}`;
    body.delete("client_id");
    body.delete("client_secret");
  }

  return app.request(`${base}${tokenPath}`, {
    method: "POST",
    headers,
    body: body.toString(),
  });
}

describe("Okta plugin integration", () => {
  let app: Hono;
  let store: Store;
  let tokenMap: TokenMap;

  beforeEach(() => {
    const setup = createTestApp();
    app = setup.app;
    store = setup.store;
    tokenMap = setup.tokenMap;
  });

  describe("OIDC discovery and keys", () => {
    it("returns org discovery document", async () => {
      const res = await app.request(`${base}/.well-known/openid-configuration`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.issuer).toBe(base);
      expect(body.authorization_endpoint).toBe(`${base}/oauth2/v1/authorize`);
      expect(body.token_endpoint).toBe(`${base}/oauth2/v1/token`);
      expect(body.jwks_uri).toBe(`${base}/oauth2/v1/keys`);
      expect(body.introspection_endpoint).toBe(`${base}/oauth2/v1/introspect`);
      expect(body.registration_endpoint).toBe(`${base}/oauth2/v1/clients`);
      expect(body.code_challenge_methods_supported).toEqual(["plain", "S256"]);
      expect(body.token_endpoint_auth_methods_supported).toEqual([
        "client_secret_post",
        "client_secret_basic",
        "none",
      ]);
      expect(body.request_parameter_supported).toBe(false);
    });

    it("returns default custom auth server discovery document", async () => {
      const res = await app.request(`${base}/oauth2/default/.well-known/openid-configuration`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.issuer).toBe(`${base}/oauth2/default`);
      expect(body.authorization_endpoint).toBe(`${base}/oauth2/default/v1/authorize`);
      expect(body.token_endpoint).toBe(`${base}/oauth2/default/v1/token`);
    });

    it("returns custom auth server discovery document", async () => {
      const res = await app.request(`${base}/oauth2/custom-as/.well-known/openid-configuration`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.issuer).toBe(`${base}/oauth2/custom-as`);
      expect(body.authorization_endpoint).toBe(`${base}/oauth2/custom-as/v1/authorize`);
      expect(body.token_endpoint).toBe(`${base}/oauth2/custom-as/v1/token`);
    });

    it("returns 404 for unknown custom auth server", async () => {
      const res = await app.request(`${base}/oauth2/does-not-exist/.well-known/openid-configuration`);
      expect(res.status).toBe(404);
    });

    it("returns JWKS for default custom auth server", async () => {
      const res = await app.request(`${base}/oauth2/default/v1/keys`);
      expect(res.status).toBe(200);
      const body = await res.json() as { keys: Array<Record<string, unknown>> };
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0].kty).toBe("RSA");
      expect(body.keys[0].kid).toBe("emulate-okta-1");
      expect(body.keys[0].alg).toBe("RS256");
      expect(body.keys[0].use).toBe("sig");
    });

    it("returns JWKS for org auth server path", async () => {
      const res = await app.request(`${base}/oauth2/v1/keys`);
      expect(res.status).toBe(200);
      const body = await res.json() as { keys: Array<Record<string, unknown>> };
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0].kid).toBe("emulate-okta-1");
    });
  });

  describe("authorization page and callback", () => {
    it("returns sign-in HTML page", async () => {
      const res = await app.request(
        `${base}/oauth2/default/v1/authorize?client_id=okta-test-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain("Sign in");
      expect(html).toContain("Okta");
    });

    it("returns 400 for unknown client when clients configured", async () => {
      const res = await app.request(
        `${base}/oauth2/default/v1/authorize?client_id=unknown-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code`,
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Application not found");
    });

    it("returns form_post response mode", async () => {
      const { code, state } = await getAuthCode(app, store, { responseMode: "form_post" });
      expect(code).toBeTruthy();
      expect(state).toBe("state-1");
    });
  });

  describe("full OAuth flows", () => {
    it("completes default auth server authorization_code flow", async () => {
      const { code, state } = await getAuthCode(app, store, { authServerId: "default" });
      expect(code).toBeTruthy();
      expect(state).toBe("state-1");

      const tokenRes = await exchangeCode(app, code, { authServerId: "default" });
      expect(tokenRes.status).toBe(200);
      const body = await tokenRes.json() as Record<string, unknown>;
      expect((body.access_token as string).startsWith("okta_")).toBe(true);
      expect((body.refresh_token as string).startsWith("r_okta_")).toBe(true);
      expect(body.token_type).toBe("Bearer");
      expect(body.expires_in).toBe(3600);
      expect(body.id_token).toBeDefined();

      const claims = decodeJwt(body.id_token as string);
      expect(claims.iss).toBe(`${base}/oauth2/default`);
      expect(claims.aud).toBe("okta-test-client");
      expect(claims.sub).toBeDefined();
      expect(claims.nonce).toBe("nonce-1");
      expect(claims.email).toBeDefined();
    });

    it("completes org authorization_code flow", async () => {
      const { code } = await getAuthCode(app, store, {
        authServerId: "org",
        redirectUri: "http://localhost:3000/org-callback",
        clientId: "org-client",
      });
      const tokenRes = await exchangeCode(app, code, {
        authServerId: "org",
        clientId: "org-client",
        clientSecret: "org-secret",
        redirectUri: "http://localhost:3000/org-callback",
      });
      expect(tokenRes.status).toBe(200);
      const body = await tokenRes.json() as Record<string, unknown>;
      const claims = decodeJwt(body.id_token as string);
      expect(claims.iss).toBe(base);
      expect(claims.aud).toBe("org-client");
    });

    it("refreshes token and rotates refresh token", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenRes = await exchangeCode(app, code);
      const tokenBody = await tokenRes.json() as Record<string, unknown>;
      const refreshToken = tokenBody.refresh_token as string;

      const refreshRes = await app.request(`${base}/oauth2/default/v1/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: "okta-test-client",
          client_secret: "okta-test-secret",
        }).toString(),
      });
      expect(refreshRes.status).toBe(200);
      const refreshBody = await refreshRes.json() as Record<string, unknown>;
      expect((refreshBody.access_token as string).startsWith("okta_")).toBe(true);
      expect((refreshBody.refresh_token as string).startsWith("r_okta_")).toBe(true);
      expect(refreshBody.refresh_token).not.toBe(refreshToken);
    });

    it("rejects second use of authorization code", async () => {
      const { code } = await getAuthCode(app, store);
      const first = await exchangeCode(app, code);
      expect(first.status).toBe(200);
      const second = await exchangeCode(app, code);
      expect(second.status).toBe(400);
      const body = await second.json() as Record<string, unknown>;
      expect(body.error).toBe("invalid_grant");
    });

    it("rejects unsupported grant type", async () => {
      const res = await app.request(`${base}/oauth2/default/v1/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: "okta-test-client",
          client_secret: "okta-test-secret",
        }).toString(),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("unsupported_grant_type");
    });
  });

  describe("PKCE", () => {
    it("supports S256 code challenge", async () => {
      const verifier = "pkce-verifier-12345";
      const challenge = createHash("sha256").update(verifier).digest("base64url");

      const { code } = await getAuthCode(app, store, {
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });
      const tokenRes = await exchangeCode(app, code, { codeVerifier: verifier });
      expect(tokenRes.status).toBe(200);
    });

    it("supports public clients without client_secret", async () => {
      const verifier = "public-pkce-verifier-12345";
      const challenge = createHash("sha256").update(verifier).digest("base64url");

      const { code } = await getAuthCode(app, store, {
        clientId: "okta-test-app",
        redirectUri: "http://localhost:3000/official-sdk/callback",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });
      const tokenRes = await exchangeCode(app, code, {
        clientId: "okta-test-app",
        redirectUri: "http://localhost:3000/official-sdk/callback",
        codeVerifier: verifier,
        includeClientSecret: false,
      });
      expect(tokenRes.status).toBe(200);
      const body = await tokenRes.json() as Record<string, unknown>;
      const claims = decodeJwt(body.id_token as string);
      expect(claims.aud).toBe("okta-test-app");
    });

    it("rejects incorrect S256 verifier", async () => {
      const verifier = "pkce-verifier-12345";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const { code } = await getAuthCode(app, store, {
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });

      const tokenRes = await exchangeCode(app, code, { codeVerifier: "wrong-verifier" });
      expect(tokenRes.status).toBe(400);
      const body = await tokenRes.json() as Record<string, unknown>;
      expect(body.error).toBe("invalid_grant");
    });

    it("supports plain challenge method", async () => {
      const verifier = "plain-verifier";
      const { code } = await getAuthCode(app, store, {
        codeChallenge: verifier,
        codeChallengeMethod: "plain",
      });
      const tokenRes = await exchangeCode(app, code, { codeVerifier: verifier });
      expect(tokenRes.status).toBe(200);
    });

    it("still requires client_secret for confidential clients", async () => {
      const verifier = "confidential-pkce-verifier-12345";
      const challenge = createHash("sha256").update(verifier).digest("base64url");

      const { code } = await getAuthCode(app, store, {
        clientId: "okta-test-client",
        redirectUri: "http://localhost:3000/callback",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });
      const tokenRes = await exchangeCode(app, code, {
        clientId: "okta-test-client",
        redirectUri: "http://localhost:3000/callback",
        codeVerifier: verifier,
        includeClientSecret: false,
      });
      expect(tokenRes.status).toBe(401);
      const body = await tokenRes.json() as Record<string, unknown>;
      expect(body.error).toBe("invalid_client");
    });
  });

  describe("client credentials", () => {
    it("issues access token without refresh or id token", async () => {
      const res = await app.request(`${base}/oauth2/default/v1/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "okta-test-client",
          client_secret: "okta-test-secret",
          scope: "custom.scope",
        }).toString(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect((body.access_token as string).startsWith("okta_")).toBe(true);
      expect(body.refresh_token).toBeUndefined();
      expect(body.id_token).toBeUndefined();
      expect(body.scope).toBe("custom.scope");
    });

    it("rejects wrong client secret", async () => {
      const res = await app.request(`${base}/oauth2/default/v1/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "okta-test-client",
          client_secret: "wrong-secret",
        }).toString(),
      });
      expect(res.status).toBe(401);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("invalid_client");
    });

    it("accepts client_secret_basic credentials", async () => {
      const creds = Buffer.from("okta-test-client:okta-test-secret").toString("base64");
      const res = await app.request(`${base}/oauth2/default/v1/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${creds}`,
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "foo.bar",
        }).toString(),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("userinfo / introspect / revoke / logout", () => {
    it("returns userinfo for valid user access token", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenRes = await exchangeCode(app, code);
      const tokenBody = await tokenRes.json() as Record<string, unknown>;
      const accessToken = tokenBody.access_token as string;

      const res = await app.request(`${base}/oauth2/default/v1/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.sub).toBeDefined();
      expect(body.email).toBeDefined();
      expect(body.preferred_username).toBeDefined();
    });

    it("returns 401 for userinfo without valid token", async () => {
      const res = await app.request(`${base}/oauth2/default/v1/userinfo`, {
        headers: { Authorization: "Bearer missing-token" },
      });
      expect(res.status).toBe(401);
    });

    it("introspects active access token then inactive after revoke", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenRes = await exchangeCode(app, code);
      const tokenBody = await tokenRes.json() as Record<string, unknown>;
      const accessToken = tokenBody.access_token as string;

      const introspect1 = await app.request(`${base}/oauth2/default/v1/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: accessToken,
          client_id: "okta-test-client",
          client_secret: "okta-test-secret",
        }).toString(),
      });
      expect(introspect1.status).toBe(200);
      const body1 = await introspect1.json() as Record<string, unknown>;
      expect(body1.active).toBe(true);
      expect(body1.client_id).toBe("okta-test-client");

      const revoke = await app.request(`${base}/oauth2/default/v1/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: accessToken }).toString(),
      });
      expect(revoke.status).toBe(200);

      const introspect2 = await app.request(`${base}/oauth2/default/v1/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: accessToken,
          client_id: "okta-test-client",
          client_secret: "okta-test-secret",
        }).toString(),
      });
      const body2 = await introspect2.json() as Record<string, unknown>;
      expect(body2.active).toBe(false);
    });

    it("introspects refresh token as active", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenRes = await exchangeCode(app, code);
      const tokenBody = await tokenRes.json() as Record<string, unknown>;
      const refreshToken = tokenBody.refresh_token as string;

      const introspect = await app.request(`${base}/oauth2/default/v1/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: refreshToken,
          client_id: "okta-test-client",
          client_secret: "okta-test-secret",
        }).toString(),
      });
      const body = await introspect.json() as Record<string, unknown>;
      expect(body.active).toBe(true);
      expect(body.token_type).toBe("refresh_token");
    });

    it("revocation removes access token from tokenMap", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenRes = await exchangeCode(app, code);
      const tokenBody = await tokenRes.json() as Record<string, unknown>;
      const accessToken = tokenBody.access_token as string;
      expect(tokenMap.has(accessToken)).toBe(true);

      await app.request(`${base}/oauth2/default/v1/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: accessToken }).toString(),
      });
      expect(tokenMap.has(accessToken)).toBe(false);
    });

    it("revocation returns 200 for unknown token", async () => {
      const res = await app.request(`${base}/oauth2/default/v1/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: "unknown-token" }).toString(),
      });
      expect(res.status).toBe(200);
    });

    it("logout redirects when post_logout_redirect_uri is allowed", async () => {
      const uri = "http://localhost:3000/callback";
      const res = await app.request(`${base}/oauth2/default/v1/logout?post_logout_redirect_uri=${encodeURIComponent(uri)}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(uri);
    });

    it("logout allows official SDK post_logout_redirect_uri for public clients", async () => {
      const uri = "http://localhost:3000/official-sdk";
      const res = await app.request(`${base}/oauth2/default/v1/logout?post_logout_redirect_uri=${encodeURIComponent(uri)}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(uri);
    });

    it("logout rejects unregistered redirect", async () => {
      const uri = "http://evil.local/callback";
      const res = await app.request(`${base}/oauth2/default/v1/logout?post_logout_redirect_uri=${encodeURIComponent(uri)}`);
      expect(res.status).toBe(400);
    });

    it("logout without redirect returns plain text", async () => {
      const res = await app.request(`${base}/oauth2/default/v1/logout`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("Logged out");
    });
  });

  describe("Users API", () => {
    it("lists users", async () => {
      const res = await app.request(`${base}/api/v1/users`, { headers: managementHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as Array<Record<string, unknown>>;
      expect(body.length).toBeGreaterThan(0);
    });

    it("creates STAGED user with activate=false", async () => {
      const res = await app.request(`${base}/api/v1/users?activate=false`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({
          profile: {
            login: "newuser@example.com",
            email: "newuser@example.com",
            firstName: "New",
            lastName: "User",
          },
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe("STAGED");
    });

    it("supports users/me endpoint", async () => {
      const res = await app.request(`${base}/api/v1/users/me`, { headers: managementHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect((body.profile as Record<string, unknown>).login).toBeDefined();
    });

    it("gets user by id and by login", async () => {
      const usersRes = await app.request(`${base}/api/v1/users`, { headers: managementHeaders() });
      const users = await usersRes.json() as Array<Record<string, unknown>>;
      const userId = users[0].id as string;
      const login = (users[0].profile as Record<string, unknown>).login as string;

      const byId = await app.request(`${base}/api/v1/users/${encodeURIComponent(userId)}`, { headers: managementHeaders() });
      expect(byId.status).toBe(200);

      const byLogin = await app.request(`${base}/api/v1/users/${encodeURIComponent(login)}`, { headers: managementHeaders() });
      expect(byLogin.status).toBe(200);
    });

    it("replaces and partially updates user profile", async () => {
      const create = await app.request(`${base}/api/v1/users`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({
          profile: {
            login: "replace@example.com",
            email: "replace@example.com",
            firstName: "Replace",
            lastName: "Me",
          },
        }),
      });
      const created = await create.json() as Record<string, unknown>;
      const userId = created.id as string;

      const put = await app.request(`${base}/api/v1/users/${userId}`, {
        method: "PUT",
        headers: managementHeaders(),
        body: JSON.stringify({
          profile: {
            login: "replace2@example.com",
            email: "replace2@example.com",
            firstName: "Replaced",
            lastName: "User",
          },
        }),
      });
      expect(put.status).toBe(200);
      const putBody = await put.json() as Record<string, unknown>;
      expect((putBody.profile as Record<string, unknown>).login).toBe("replace2@example.com");

      const post = await app.request(`${base}/api/v1/users/${userId}`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({
          profile: {
            firstName: "Partial",
          },
        }),
      });
      expect(post.status).toBe(200);
      const postBody = await post.json() as Record<string, unknown>;
      expect((postBody.profile as Record<string, unknown>).firstName).toBe("Partial");
    });

    it("runs lifecycle actions", async () => {
      const create = await app.request(`${base}/api/v1/users`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({
          profile: { login: "life@example.com", email: "life@example.com", firstName: "Life", lastName: "Cycle" },
        }),
      });
      const userId = (await create.json() as Record<string, unknown>).id as string;

      const suspend = await app.request(`${base}/api/v1/users/${userId}/lifecycle/suspend`, {
        method: "POST",
        headers: managementHeaders(),
      });
      expect(suspend.status).toBe(200);
      expect((await suspend.json() as Record<string, unknown>).status).toBe("SUSPENDED");

      const unsuspend = await app.request(`${base}/api/v1/users/${userId}/lifecycle/unsuspend`, {
        method: "POST",
        headers: managementHeaders(),
      });
      expect((await unsuspend.json() as Record<string, unknown>).status).toBe("ACTIVE");

      const deactivate = await app.request(`${base}/api/v1/users/${userId}/lifecycle/deactivate`, {
        method: "POST",
        headers: managementHeaders(),
      });
      expect((await deactivate.json() as Record<string, unknown>).status).toBe("DEPROVISIONED");

      const reactivate = await app.request(`${base}/api/v1/users/${userId}/lifecycle/reactivate`, {
        method: "POST",
        headers: managementHeaders(),
      });
      expect((await reactivate.json() as Record<string, unknown>).status).toBe("PROVISIONED");
    });

    it("returns groups for a user", async () => {
      const usersRes = await app.request(`${base}/api/v1/users`, { headers: managementHeaders() });
      const users = await usersRes.json() as Array<Record<string, unknown>>;
      const userId = users[0].id as string;
      const groupsRes = await app.request(`${base}/api/v1/users/${userId}/groups`, { headers: managementHeaders() });
      expect(groupsRes.status).toBe(200);
      const groups = await groupsRes.json() as Array<Record<string, unknown>>;
      expect(groups.length).toBeGreaterThan(0);
    });

    it("supports q search", async () => {
      const res = await app.request(`${base}/api/v1/users?q=alice`, { headers: managementHeaders() });
      expect(res.status).toBe(200);
      const users = await res.json() as Array<Record<string, unknown>>;
      expect(users.some((entry) => ((entry.profile as Record<string, unknown>).login as string).includes("alice"))).toBe(true);
    });

    it("supports search and filter", async () => {
      const bySearch = await app.request(`${base}/api/v1/users?search=alice`, { headers: managementHeaders() });
      expect(bySearch.status).toBe(200);
      const searchUsers = await bySearch.json() as Array<Record<string, unknown>>;
      expect(searchUsers.some((entry) => ((entry.profile as Record<string, unknown>).login as string).includes("alice"))).toBe(true);

      const byFilter = await app.request(`${base}/api/v1/users?filter=status eq ACTIVE`, { headers: managementHeaders() });
      expect(byFilter.status).toBe(200);
      const filterUsers = await byFilter.json() as Array<Record<string, unknown>>;
      expect(filterUsers.length).toBeGreaterThan(0);
      expect(filterUsers.every((entry) => entry.status === "ACTIVE")).toBe(true);
    });

    it("supports pagination with Link header", async () => {
      for (let i = 0; i < 3; i += 1) {
        await app.request(`${base}/api/v1/users`, {
          method: "POST",
          headers: managementHeaders(),
          body: JSON.stringify({
            profile: {
              login: `page-${i}@example.com`,
              email: `page-${i}@example.com`,
              firstName: "Page",
              lastName: String(i),
            },
          }),
        });
      }

      const res = await app.request(`${base}/api/v1/users?per_page=2&page=1`, { headers: managementHeaders() });
      expect(res.status).toBe(200);
      const link = res.headers.get("Link");
      expect(link).toBeTruthy();
      const users = await res.json() as Array<Record<string, unknown>>;
      expect(users.length).toBe(2);
    });

    it("deactivates first, then deletes on second request", async () => {
      const create = await app.request(`${base}/api/v1/users`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({
          profile: { login: "delete@example.com", email: "delete@example.com", firstName: "Delete", lastName: "Me" },
        }),
      });
      expect(create.status).toBe(201);
      const userId = (await create.json() as Record<string, unknown>).id as string;

      const firstDelete = await app.request(`${base}/api/v1/users/${userId}`, {
        method: "DELETE",
        headers: managementHeaders(),
      });
      expect(firstDelete.status).toBe(204);

      const afterFirst = await app.request(`${base}/api/v1/users/${userId}`, { headers: managementHeaders() });
      expect(afterFirst.status).toBe(200);
      const bodyAfterFirst = await afterFirst.json() as Record<string, unknown>;
      expect(bodyAfterFirst.status).toBe("DEPROVISIONED");

      const secondDelete = await app.request(`${base}/api/v1/users/${userId}`, {
        method: "DELETE",
        headers: managementHeaders(),
      });
      expect(secondDelete.status).toBe(204);

      const afterSecond = await app.request(`${base}/api/v1/users/${userId}`, { headers: managementHeaders() });
      expect(afterSecond.status).toBe(404);
    });
  });

  describe("Groups API", () => {
    it("creates, gets, updates, and deletes a group", async () => {
      const create = await app.request(`${base}/api/v1/groups`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({
          profile: { name: "Team Blue", description: "Blue team" },
        }),
      });
      expect(create.status).toBe(201);
      const created = await create.json() as Record<string, unknown>;
      const groupId = created.id as string;

      const get = await app.request(`${base}/api/v1/groups/${groupId}`, { headers: managementHeaders() });
      expect(get.status).toBe(200);

      const put = await app.request(`${base}/api/v1/groups/${groupId}`, {
        method: "PUT",
        headers: managementHeaders(),
        body: JSON.stringify({
          profile: { name: "Team Blue 2", description: "Blue team updated" },
        }),
      });
      expect(put.status).toBe(200);
      const putBody = await put.json() as Record<string, unknown>;
      expect(((putBody.profile as Record<string, unknown>).name)).toBe("Team Blue 2");

      const del = await app.request(`${base}/api/v1/groups/${groupId}`, {
        method: "DELETE",
        headers: managementHeaders(),
      });
      expect(del.status).toBe(204);
    });

    it("manages group membership", async () => {
      const users = await (await app.request(`${base}/api/v1/users`, { headers: managementHeaders() })).json() as Array<Record<string, unknown>>;
      const userId = users[0].id as string;

      const createGroup = await app.request(`${base}/api/v1/groups`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({ profile: { name: "Membership Group", description: "desc" } }),
      });
      expect(createGroup.status).toBe(201);
      const groupId = (await createGroup.json() as Record<string, unknown>).id as string;

      const add = await app.request(`${base}/api/v1/groups/${groupId}/users/${userId}`, {
        method: "PUT",
        headers: managementHeaders(),
      });
      expect(add.status).toBe(204);

      const list = await app.request(`${base}/api/v1/groups/${groupId}/users`, { headers: managementHeaders() });
      expect(list.status).toBe(200);
      const listBody = await list.json() as Array<Record<string, unknown>>;
      expect(listBody.length).toBeGreaterThan(0);

      const remove = await app.request(`${base}/api/v1/groups/${groupId}/users/${userId}`, {
        method: "DELETE",
        headers: managementHeaders(),
      });
      expect(remove.status).toBe(204);
    });
  });

  describe("Apps API", () => {
    it("creates, gets, updates app", async () => {
      const create = await app.request(`${base}/api/v1/apps`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({
          name: "oidc_client",
          label: "My App",
          signOnMode: "OPENID_CONNECT",
        }),
      });
      expect(create.status).toBe(201);
      const created = await create.json() as Record<string, unknown>;
      const appId = created.id as string;

      const get = await app.request(`${base}/api/v1/apps/${appId}`, { headers: managementHeaders() });
      expect(get.status).toBe(200);

      const update = await app.request(`${base}/api/v1/apps/${appId}`, {
        method: "PUT",
        headers: managementHeaders(),
        body: JSON.stringify({ label: "My App Updated", status: "INACTIVE" }),
      });
      expect(update.status).toBe(200);
      expect((await update.json() as Record<string, unknown>).label).toBe("My App Updated");
    });

    it("supports app lifecycle and assignment", async () => {
      const createApp = await app.request(`${base}/api/v1/apps`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({ name: "web", label: "Web App", signOnMode: "OPENID_CONNECT" }),
      });
      expect(createApp.status).toBe(201);
      const appId = (await createApp.json() as Record<string, unknown>).id as string;
      const users = await (await app.request(`${base}/api/v1/users`, { headers: managementHeaders() })).json() as Array<Record<string, unknown>>;
      const userId = users[0].id as string;

      const assign = await app.request(`${base}/api/v1/apps/${appId}/users/${userId}`, {
        method: "PUT",
        headers: managementHeaders(),
      });
      expect(assign.status).toBe(204);

      const list = await app.request(`${base}/api/v1/apps/${appId}/users`, { headers: managementHeaders() });
      expect(list.status).toBe(200);
      const listBody = await list.json() as Array<Record<string, unknown>>;
      expect(listBody.length).toBeGreaterThan(0);

      const deactivate = await app.request(`${base}/api/v1/apps/${appId}/lifecycle/deactivate`, {
        method: "POST",
        headers: managementHeaders(),
      });
      expect((await deactivate.json() as Record<string, unknown>).status).toBe("INACTIVE");

      const activate = await app.request(`${base}/api/v1/apps/${appId}/lifecycle/activate`, {
        method: "POST",
        headers: managementHeaders(),
      });
      expect((await activate.json() as Record<string, unknown>).status).toBe("ACTIVE");
    });

    it("only allows deleting inactive apps", async () => {
      const create = await app.request(`${base}/api/v1/apps`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({ name: "deletable", label: "Delete App", signOnMode: "OPENID_CONNECT" }),
      });
      expect(create.status).toBe(201);
      const appId = (await create.json() as Record<string, unknown>).id as string;

      const activeDelete = await app.request(`${base}/api/v1/apps/${appId}`, {
        method: "DELETE",
        headers: managementHeaders(),
      });
      expect(activeDelete.status).toBe(400);

      await app.request(`${base}/api/v1/apps/${appId}/lifecycle/deactivate`, {
        method: "POST",
        headers: managementHeaders(),
      });
      const inactiveDelete = await app.request(`${base}/api/v1/apps/${appId}`, {
        method: "DELETE",
        headers: managementHeaders(),
      });
      expect(inactiveDelete.status).toBe(204);
    });
  });

  describe("Authorization Servers API", () => {
    it("creates, gets, updates, lifecycle, and deletes authorization server", async () => {
      const create = await app.request(`${base}/api/v1/authorizationServers`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({
          id: "api-2",
          name: "API 2",
          description: "Secondary API",
          audiences: ["api://two"],
        }),
      });
      expect(create.status).toBe(201);
      const created = await create.json() as Record<string, unknown>;
      expect(created.id).toBe("api-2");

      const get = await app.request(`${base}/api/v1/authorizationServers/api-2`, { headers: managementHeaders() });
      expect(get.status).toBe(200);

      const update = await app.request(`${base}/api/v1/authorizationServers/api-2`, {
        method: "PUT",
        headers: managementHeaders(),
        body: JSON.stringify({ name: "API 2 Updated", status: "INACTIVE" }),
      });
      expect(update.status).toBe(200);
      expect((await update.json() as Record<string, unknown>).name).toBe("API 2 Updated");

      const activate = await app.request(`${base}/api/v1/authorizationServers/api-2/lifecycle/activate`, {
        method: "POST",
        headers: managementHeaders(),
      });
      expect((await activate.json() as Record<string, unknown>).status).toBe("ACTIVE");

      const deactivate = await app.request(`${base}/api/v1/authorizationServers/api-2/lifecycle/deactivate`, {
        method: "POST",
        headers: managementHeaders(),
      });
      expect((await deactivate.json() as Record<string, unknown>).status).toBe("INACTIVE");

      const del = await app.request(`${base}/api/v1/authorizationServers/api-2`, {
        method: "DELETE",
        headers: managementHeaders(),
      });
      expect(del.status).toBe(204);
    });
  });

  describe("SSWS auth", () => {
    it("accepts valid SSWS token for management APIs", async () => {
      const res = await app.request(`${base}/api/v1/users`, { headers: managementHeaders(true) });
      expect(res.status).toBe(200);
    });

    it("rejects invalid SSWS token", async () => {
      const res = await app.request(`${base}/api/v1/users`, {
        headers: {
          Authorization: "SSWS invalid-token",
        },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("seed from config", () => {
    it("seeds users, groups, apps, oauth clients, auth servers and deduplicates", () => {
      const seedStore = new Store();
      const webhooks = new WebhookDispatcher();
      const localTokenMap: TokenMap = new Map();
      const localApp = new Hono();
      localApp.use("*", authMiddleware(localTokenMap));
      oktaPlugin.register(localApp as any, seedStore, webhooks, base, localTokenMap);
      oktaPlugin.seed?.(seedStore, base);

      seedFromConfig(seedStore, base, {
        users: [
          { login: "config-user@example.com", first_name: "Config", last_name: "User" },
          { login: "config-user@example.com", first_name: "Config", last_name: "User" },
        ],
        groups: [{ name: "Config Group", description: "from seed" }],
        apps: [{ name: "config_app", label: "Config App" }],
        oauth_clients: [{
          client_id: "config-client",
          client_secret: "config-secret",
          name: "Config Client",
          redirect_uris: ["http://localhost:3000/config-callback"],
          auth_server_id: "default",
        }],
        authorization_servers: [{ id: "config-as", name: "Config AS", audiences: ["api://config"] }],
      });
      seedFromConfig(seedStore, base, {
        users: [{ login: "config-user@example.com", first_name: "Config", last_name: "User" }],
      });

      const okta = getOktaStore(seedStore);
      expect(okta.users.findBy("login", "config-user@example.com")).toHaveLength(1);
      expect(okta.groups.findBy("name", "Config Group")).toHaveLength(1);
      expect(okta.apps.findBy("name", "config_app")).toHaveLength(1);
      expect(okta.oauthClients.findBy("client_id", "config-client")).toHaveLength(1);
      expect(okta.authorizationServers.findBy("server_id", "config-as")).toHaveLength(1);
      expect(okta.groups.findBy("okta_id", "00g_everyone")).toHaveLength(1);
    });
  });
});
