import { createHash } from "node:crypto";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { Hono } from "@emulators/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { apsPlugin, getApsStore, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();

  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  apsPlugin.register(app as any, store, webhooks, base, tokenMap);
  apsPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ email: "alice@example.com", name: "Alice Example" }],
    clients: [
      {
        client_id: "custom-client",
        client_secret: "custom-secret",
        name: "Custom App",
        redirect_uris: ["http://localhost:3000/custom-callback"],
      },
    ],
  });
  return { app, store, tokenMap };
}

async function getAuthCode(
  app: Hono,
  store: Store,
  options: {
    userId?: string;
    redirectUri?: string;
    clientId?: string;
    scope?: string;
    state?: string;
    nonce?: string;
    responseMode?: string;
    codeChallenge?: string;
  } = {},
): Promise<{ code: string; state: string; response: Response }> {
  const aps = getApsStore(store);
  const userId = options.userId ?? aps.users.all()[0]?.user_id ?? "";
  const redirectUri = options.redirectUri ?? "http://localhost:3000/callback";
  const clientId = options.clientId ?? "aps-test-client";
  const scope = options.scope ?? "data:read openid";
  const state = options.state ?? "state-1";
  const nonce = options.nonce ?? "nonce-1";
  const responseMode = options.responseMode ?? "query";

  const formData = new URLSearchParams({
    user_id: userId,
    redirect_uri: redirectUri,
    scope,
    state,
    nonce,
    client_id: clientId,
    response_mode: responseMode,
    code_challenge: options.codeChallenge ?? "",
  });

  const response = await app.request(`${base}/authentication/v2/authorize/callback`, {
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
    clientId?: string;
    clientSecret?: string;
    includeClientSecret?: boolean;
    redirectUri?: string;
    codeVerifier?: string;
    useBasicAuth?: boolean;
  } = {},
): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: options.clientId ?? "aps-test-client",
    redirect_uri: options.redirectUri ?? "http://localhost:3000/callback",
  });
  if (options.includeClientSecret ?? true) {
    body.set("client_secret", options.clientSecret ?? "aps-test-secret");
  }
  if (options.codeVerifier) {
    body.set("code_verifier", options.codeVerifier);
  }

  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (options.useBasicAuth) {
    const creds = Buffer.from(
      `${options.clientId ?? "aps-test-client"}:${options.clientSecret ?? "aps-test-secret"}`,
    ).toString("base64");
    headers.Authorization = `Basic ${creds}`;
    body.delete("client_id");
    body.delete("client_secret");
  }

  return app.request(`${base}/authentication/v2/token`, {
    method: "POST",
    headers,
    body: body.toString(),
  });
}

async function refreshGrant(app: Hono, refreshToken: string, options: { scope?: string } = {}): Promise<Response> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  if (options.scope) body.set("scope", options.scope);
  const creds = Buffer.from("aps-test-client:aps-test-secret").toString("base64");
  return app.request(`${base}/authentication/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${creds}` },
    body: body.toString(),
  });
}

async function introspect(app: Hono, token: string): Promise<Record<string, unknown>> {
  const res = await app.request(`${base}/authentication/v2/introspect`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token,
      client_id: "aps-test-client",
      client_secret: "aps-test-secret",
    }).toString(),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("APS plugin integration", () => {
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
    it("returns discovery document with emulator URLs", async () => {
      const res = await app.request(`${base}/.well-known/openid-configuration`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.issuer).toBe(base);
      expect(body.authorization_endpoint).toBe(`${base}/authentication/v2/authorize`);
      expect(body.token_endpoint).toBe(`${base}/authentication/v2/token`);
      expect(body.userinfo_endpoint).toBe(`${base}/userinfo`);
      expect(body.jwks_uri).toBe(`${base}/authentication/v2/keys`);
      expect(body.revoke_endpoint).toBe(`${base}/authentication/v2/revoke`);
      expect(body.introspect_endpoint).toBe(`${base}/authentication/v2/introspect`);
      expect(body.response_types_supported).toEqual(["code", "code id_token", "id_token"]);
      expect(body.grant_types_supported).toEqual(["authorization_code", "client_credentials", "refresh_token"]);
      expect(body.id_token_signing_alg_values_supported).toEqual(["RS256"]);
      expect(body.scopes_supported).toContain("data:read");
      expect(body.scopes_supported).toContain("openid");
    });

    it("returns JWKS with the signing key", async () => {
      const res = await app.request(`${base}/authentication/v2/keys`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("max-age=604800");
      const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0].kty).toBe("RSA");
      expect(body.keys[0].kid).toBe("emulate-aps-1");
      expect(body.keys[0].use).toBe("sig");
      expect(body.keys[0].n).toBeDefined();
      expect(body.keys[0].e).toBe("AQAB");
    });
  });

  describe("authorization page and callback", () => {
    it("returns sign-in HTML page with seeded users", async () => {
      const res = await app.request(
        `${base}/authentication/v2/authorize?client_id=aps-test-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&scope=data:read`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain("Sign in with Autodesk");
      expect(html).toContain("testuser@autodesk.local");
      expect(html).toContain("alice@example.com");
    });

    it("renders error page for unknown client without redirecting", async () => {
      const res = await app.request(
        `${base}/authentication/v2/authorize?client_id=unknown-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code`,
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Application not found");
    });

    it("renders error page for unregistered redirect_uri without redirecting", async () => {
      const res = await app.request(
        `${base}/authentication/v2/authorize?client_id=aps-test-client&redirect_uri=${encodeURIComponent("http://evil.local/callback")}&response_type=code`,
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Redirect URI mismatch");
    });

    it("redirects with error for an unsupported response_type", async () => {
      const res = await app.request(
        `${base}/authentication/v2/authorize?client_id=aps-test-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=token&state=abc`,
      );
      expect(res.status).toBe(302);
      const url = new URL(res.headers.get("location") ?? "");
      expect(url.searchParams.get("error")).toBe("unsupported_response_type");
      expect(url.searchParams.get("state")).toBe("abc");
    });

    it("redirects with error for an invalid scope", async () => {
      const res = await app.request(
        `${base}/authentication/v2/authorize?client_id=aps-test-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&scope=bogus:scope&state=xyz`,
      );
      expect(res.status).toBe(302);
      const url = new URL(res.headers.get("location") ?? "");
      expect(url.searchParams.get("error")).toBe("invalid_scope");
      expect(url.searchParams.get("state")).toBe("xyz");
    });

    it("redirects with error when a public client omits code_challenge", async () => {
      const res = await app.request(
        `${base}/authentication/v2/authorize?client_id=aps-test-app&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&scope=data:read`,
      );
      expect(res.status).toBe(302);
      const url = new URL(res.headers.get("location") ?? "");
      expect(url.searchParams.get("error")).toBe("invalid_request");
    });

    it("redirects with error for a non-S256 code_challenge_method", async () => {
      const res = await app.request(
        `${base}/authentication/v2/authorize?client_id=aps-test-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&code_challenge=abc&code_challenge_method=plain`,
      );
      expect(res.status).toBe(302);
      const url = new URL(res.headers.get("location") ?? "");
      expect(url.searchParams.get("error")).toBe("invalid_request");
    });

    it("issues a 40 character code and echoes state on the redirect", async () => {
      const { code, state, response } = await getAuthCode(app, store, { state: "round-trip" });
      expect(response.status).toBe(302);
      expect(code).toHaveLength(40);
      expect(state).toBe("round-trip");
    });

    it("preserves existing query params on the redirect_uri", async () => {
      const { response } = await getAuthCode(app, store, {
        redirectUri: "http://localhost:3000/callback?foo=bar",
      });
      const url = new URL(response.headers.get("location") ?? "");
      expect(url.searchParams.get("foo")).toBe("bar");
      expect(url.searchParams.get("code")).toBeTruthy();
    });

    it("supports form_post response mode", async () => {
      const { code, state } = await getAuthCode(app, store, { responseMode: "form_post" });
      expect(code).toBeTruthy();
      expect(state).toBe("state-1");
    });
  });

  describe("authorization_code grant", () => {
    it("completes the 3-legged flow with PKCE and body credentials", async () => {
      const verifier = "pkce-verifier-1234567890-1234567890-1234567890";
      const challenge = createHash("sha256").update(verifier).digest("base64url");

      const { code } = await getAuthCode(app, store, { codeChallenge: challenge });
      const tokenRes = await exchangeCode(app, code, { codeVerifier: verifier });
      expect(tokenRes.status).toBe(200);
      const body = (await tokenRes.json()) as Record<string, unknown>;
      expect(body.token_type).toBe("Bearer");
      expect(body.expires_in).toBe(3599);
      expect(body.access_token).toBeDefined();
      expect(body.refresh_token).toHaveLength(42);

      const claims = decodeJwt(body.access_token as string);
      expect(claims.scope).toEqual(["data:read", "openid"]);
      expect(claims.client_id).toBe("aps-test-client");
      expect(claims.iss).toBe("https://developer.api.autodesk.com");
      expect(claims.aud).toBe("https://autodesk.com");
      expect(claims.jti).toHaveLength(64);
      expect(claims.userid).toMatch(/^[A-Z0-9]{12}$/);
      expect(claims.exp).toBeDefined();
      expect(claims.iat).toBeUndefined();
    });

    it("completes the flow with Basic header credentials", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenRes = await exchangeCode(app, code, { useBasicAuth: true });
      expect(tokenRes.status).toBe(200);
    });

    it("returns an id_token when scope includes openid", async () => {
      const { code } = await getAuthCode(app, store, { scope: "data:read openid", nonce: "nonce-42" });
      const tokenRes = await exchangeCode(app, code);
      const body = (await tokenRes.json()) as Record<string, unknown>;
      expect(body.id_token).toBeDefined();

      const claims = decodeJwt(body.id_token as string);
      expect(claims.iss).toBe(base);
      expect(claims.aud).toBe("aps-test-client");
      expect(claims.nonce).toBe("nonce-42");
      expect(claims.user_email).toBe("testuser@autodesk.local");
      expect(claims.first_name).toBe("Test");
      expect(claims.last_name).toBe("User");
      expect(claims.userid).toBeDefined();
      expect(claims.analytics_id).toBeDefined();
    });

    it("omits the id_token when scope does not include openid", async () => {
      const { code } = await getAuthCode(app, store, { scope: "data:read" });
      const tokenRes = await exchangeCode(app, code);
      const body = (await tokenRes.json()) as Record<string, unknown>;
      expect(body.id_token).toBeUndefined();
    });

    it("signs access tokens verifiable against the JWKS endpoint", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenRes = await exchangeCode(app, code);
      const body = (await tokenRes.json()) as Record<string, unknown>;

      const keysRes = await app.request(`${base}/authentication/v2/keys`);
      const jwks = createLocalJWKSet((await keysRes.json()) as Parameters<typeof createLocalJWKSet>[0]);
      const { payload, protectedHeader } = await jwtVerify(body.access_token as string, jwks, {
        issuer: "https://developer.api.autodesk.com",
        audience: "https://autodesk.com",
      });
      expect(protectedHeader.alg).toBe("RS256");
      expect(protectedHeader.kid).toBe("emulate-aps-1");
      expect(payload.client_id).toBe("aps-test-client");
    });

    it("rejects a second use of the authorization code", async () => {
      const { code } = await getAuthCode(app, store);
      const first = await exchangeCode(app, code);
      expect(first.status).toBe(200);
      const second = await exchangeCode(app, code);
      expect(second.status).toBe(400);
      const body = (await second.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toBe("The authorization code is invalid or has expired.");
    });

    it("rejects an expired authorization code", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const { code } = await getAuthCode(app, store);
        vi.setSystemTime(new Date("2026-01-01T00:05:01Z"));
        const res = await exchangeCode(app, code);
        expect(res.status).toBe(400);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.error).toBe("invalid_grant");
        expect(body.error_description).toBe("The authorization code is invalid or has expired.");
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects a code issued to another client", async () => {
      const { code } = await getAuthCode(app, store);
      const res = await exchangeCode(app, code, { clientId: "custom-client", clientSecret: "custom-secret" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toBe("The grant was issued to another client.");
    });

    it("rejects a mismatched redirect_uri", async () => {
      const { code } = await getAuthCode(app, store);
      const res = await exchangeCode(app, code, { redirectUri: "http://localhost:3000/other" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toBe("The 'redirect_uri' is invalid.");
    });

    it("rejects a missing code parameter", async () => {
      const res = await exchangeCode(app, "");
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toBe("The request is missing a required parameter 'code'.");
    });

    it("rejects an invalid grant_type", async () => {
      const res = await app.request(`${base}/authentication/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "aps-test-client",
          client_secret: "aps-test-secret",
        }).toString(),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toBe("The token request must specify a valid 'grant_type'.");
    });

    it("rejects client_id in the body when an Authorization header is present", async () => {
      const creds = Buffer.from("aps-test-client:aps-test-secret").toString("base64");
      const res = await app.request(`${base}/authentication/v2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${creds}`,
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "aps-test-client",
          scope: "data:read",
        }).toString(),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toBe(
        "The 'client_id' is not supported in the request body when Authorization headers are present.",
      );
    });
  });

  describe("PKCE", () => {
    it("requires code_verifier when a code_challenge was specified", async () => {
      const verifier = "pkce-verifier-1234567890-1234567890-1234567890";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const { code } = await getAuthCode(app, store, { codeChallenge: challenge });

      const res = await exchangeCode(app, code);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toBe("The request is missing a required parameter 'code_verifier'.");
    });

    it("rejects an incorrect code_verifier", async () => {
      const verifier = "pkce-verifier-1234567890-1234567890-1234567890";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const { code } = await getAuthCode(app, store, { codeChallenge: challenge });

      const res = await exchangeCode(app, code, { codeVerifier: "wrong-verifier-1234567890-1234567890-12345" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toBe("PKCE verification failed.");
    });

    it("supports public clients with PKCE and no client_secret", async () => {
      const verifier = "public-pkce-verifier-1234567890-1234567890-123";
      const challenge = createHash("sha256").update(verifier).digest("base64url");

      const { code } = await getAuthCode(app, store, {
        clientId: "aps-test-app",
        codeChallenge: challenge,
      });
      const tokenRes = await exchangeCode(app, code, {
        clientId: "aps-test-app",
        codeVerifier: verifier,
        includeClientSecret: false,
      });
      expect(tokenRes.status).toBe(200);
      const body = (await tokenRes.json()) as Record<string, unknown>;
      const claims = decodeJwt(body.access_token as string);
      expect(claims.client_id).toBe("aps-test-app");
    });

    it("still requires the client_secret for confidential clients", async () => {
      const verifier = "confidential-pkce-verifier-1234567890-123456";
      const challenge = createHash("sha256").update(verifier).digest("base64url");

      const { code } = await getAuthCode(app, store, { codeChallenge: challenge });
      const res = await exchangeCode(app, code, { codeVerifier: verifier, includeClientSecret: false });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_client");
    });
  });

  describe("refresh_token grant", () => {
    it("rotates the refresh token on every refresh", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenBody = (await (await exchangeCode(app, code)).json()) as Record<string, unknown>;
      const refreshToken = tokenBody.refresh_token as string;

      const refreshRes = await refreshGrant(app, refreshToken);
      expect(refreshRes.status).toBe(200);
      const refreshBody = (await refreshRes.json()) as Record<string, unknown>;
      expect(refreshBody.token_type).toBe("Bearer");
      expect(refreshBody.expires_in).toBe(3599);
      expect(refreshBody.refresh_token).toHaveLength(42);
      expect(refreshBody.refresh_token).not.toBe(refreshToken);
      expect(refreshBody.id_token).toBeUndefined();
    });

    it("rejects a replayed refresh token and invalidates the grant family", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenBody = (await (await exchangeCode(app, code)).json()) as Record<string, unknown>;
      const firstRefreshToken = tokenBody.refresh_token as string;

      const refreshBody = (await (await refreshGrant(app, firstRefreshToken)).json()) as Record<string, unknown>;
      const secondRefreshToken = refreshBody.refresh_token as string;
      const secondAccessToken = refreshBody.access_token as string;

      const replay = await refreshGrant(app, firstRefreshToken);
      expect(replay.status).toBe(400);
      const replayBody = (await replay.json()) as Record<string, unknown>;
      expect(replayBody.error).toBe("invalid_grant");
      expect(replayBody.error_description).toBe("The refresh token is invalid or expired.");

      const afterReplay = await refreshGrant(app, secondRefreshToken);
      expect(afterReplay.status).toBe(400);
      const afterReplayBody = (await afterReplay.json()) as Record<string, unknown>;
      expect(afterReplayBody.error).toBe("invalid_grant");

      const introspection = await introspect(app, secondAccessToken);
      expect(introspection).toEqual({ active: false });
    });

    it("rejects an unknown refresh token", async () => {
      const res = await refreshGrant(app, "not-a-real-refresh-token");
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toBe("The refresh token is invalid or expired.");
    });

    it("allows downscoping on refresh", async () => {
      const { code } = await getAuthCode(app, store, { scope: "data:read data:write openid" });
      const tokenBody = (await (await exchangeCode(app, code)).json()) as Record<string, unknown>;

      const refreshRes = await refreshGrant(app, tokenBody.refresh_token as string, { scope: "data:read" });
      expect(refreshRes.status).toBe(200);
      const refreshBody = (await refreshRes.json()) as Record<string, unknown>;
      const claims = decodeJwt(refreshBody.access_token as string);
      expect(claims.scope).toEqual(["data:read"]);
    });

    it("rejects a scope superset on refresh", async () => {
      const { code } = await getAuthCode(app, store, { scope: "data:read" });
      const tokenBody = (await (await exchangeCode(app, code)).json()) as Record<string, unknown>;

      const refreshRes = await refreshGrant(app, tokenBody.refresh_token as string, {
        scope: "data:read bucket:read",
      });
      expect(refreshRes.status).toBe(400);
      const body = (await refreshRes.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_scope");
      expect(body.error_description).toBe(
        "The requested scope is invalid, unknown, malformed or exceeds the scope granted by the resource owner.",
      );
    });

    it("rejects a refresh token issued to another client", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenBody = (await (await exchangeCode(app, code)).json()) as Record<string, unknown>;

      const res = await app.request(`${base}/authentication/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokenBody.refresh_token as string,
          client_id: "custom-client",
          client_secret: "custom-secret",
        }).toString(),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toBe("The grant was issued to another client.");
    });

    it("rejects a missing refresh_token parameter", async () => {
      const res = await refreshGrant(app, "");
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toBe("The request is missing a required parameter 'refresh_token'.");
    });
  });

  describe("client_credentials grant", () => {
    it("issues a 2-legged access token without refresh or id token", async () => {
      const res = await app.request(`${base}/authentication/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "aps-test-client",
          client_secret: "aps-test-secret",
          scope: "data:read bucket:read",
        }).toString(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.token_type).toBe("Bearer");
      expect(body.expires_in).toBe(3599);
      expect(body.refresh_token).toBeUndefined();
      expect(body.id_token).toBeUndefined();

      const claims = decodeJwt(body.access_token as string);
      expect(claims.scope).toEqual(["data:read", "bucket:read"]);
      expect(claims.userid).toBeUndefined();
    });

    it("rejects public clients", async () => {
      const res = await app.request(`${base}/authentication/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "aps-test-app",
          scope: "data:read",
        }).toString(),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_client");
      expect(body.error_description).toBe("The client credentials are invalid.");
    });

    it("rejects a wrong client secret", async () => {
      const res = await app.request(`${base}/authentication/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "aps-test-client",
          client_secret: "wrong-secret",
          scope: "data:read",
        }).toString(),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_client");
      expect(body.error_description).toBe("The client credentials are invalid.");
    });

    it("rejects a request without client credentials", async () => {
      const res = await app.request(`${base}/authentication/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", scope: "data:read" }).toString(),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_client");
      expect(body.error_description).toBe("No client credentials found.");
      expect(res.headers.get("WWW-Authenticate")).toBe("Basic");
    });

    it("rejects a request without scope", async () => {
      const res = await app.request(`${base}/authentication/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "aps-test-client",
          client_secret: "aps-test-secret",
        }).toString(),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_scope");
    });
  });

  describe("introspect and revoke", () => {
    it("introspects an active 3-legged token with the documented shape", async () => {
      const { code } = await getAuthCode(app, store, { scope: "data:read" });
      const tokenBody = (await (await exchangeCode(app, code)).json()) as Record<string, unknown>;
      const accessToken = tokenBody.access_token as string;

      const body = await introspect(app, accessToken);
      expect(body.active).toBe(true);
      expect(body.scope).toBe("data:read");
      expect(body.client_id).toBe("aps-test-client");
      expect(typeof body.exp).toBe("number");
      expect(body.userid).toMatch(/^[A-Z0-9]{12}$/);
    });

    it("introspects a 2-legged token without userid", async () => {
      const res = await app.request(`${base}/authentication/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "aps-test-client",
          client_secret: "aps-test-secret",
          scope: "data:read",
        }).toString(),
      });
      const tokenBody = (await res.json()) as Record<string, unknown>;

      const body = await introspect(app, tokenBody.access_token as string);
      expect(body.active).toBe(true);
      expect(body.userid).toBeUndefined();
    });

    it("returns only active false for an unknown token", async () => {
      const body = await introspect(app, "unknown-token");
      expect(body).toEqual({ active: false });
    });

    it("returns active false after revocation", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenBody = (await (await exchangeCode(app, code)).json()) as Record<string, unknown>;
      const accessToken = tokenBody.access_token as string;
      expect(tokenMap.has(accessToken)).toBe(true);

      const creds = Buffer.from("aps-test-client:aps-test-secret").toString("base64");
      const revoke = await app.request(`${base}/authentication/v2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${creds}` },
        body: new URLSearchParams({ token: accessToken, token_type_hint: "access_token" }).toString(),
      });
      expect(revoke.status).toBe(200);
      expect(await revoke.text()).toBe("");
      expect(tokenMap.has(accessToken)).toBe(false);

      const body = await introspect(app, accessToken);
      expect(body).toEqual({ active: false });
    });

    it("revokes refresh tokens", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenBody = (await (await exchangeCode(app, code)).json()) as Record<string, unknown>;
      const refreshToken = tokenBody.refresh_token as string;

      const creds = Buffer.from("aps-test-client:aps-test-secret").toString("base64");
      const revoke = await app.request(`${base}/authentication/v2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${creds}` },
        body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token" }).toString(),
      });
      expect(revoke.status).toBe(200);

      const refreshRes = await refreshGrant(app, refreshToken);
      expect(refreshRes.status).toBe(400);
    });

    it("returns 200 when revoking an unknown token", async () => {
      const creds = Buffer.from("aps-test-client:aps-test-secret").toString("base64");
      const res = await app.request(`${base}/authentication/v2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${creds}` },
        body: new URLSearchParams({ token: "unknown-token" }).toString(),
      });
      expect(res.status).toBe(200);
    });

    it("rejects revocation without a token parameter", async () => {
      const creds = Buffer.from("aps-test-client:aps-test-secret").toString("base64");
      const res = await app.request(`${base}/authentication/v2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${creds}` },
        body: "",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toBe("The request is missing a required parameter 'token'.");
    });
  });

  describe("userinfo and logout", () => {
    it("returns userinfo for a valid 3-legged token", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenBody = (await (await exchangeCode(app, code)).json()) as Record<string, unknown>;

      const res = await app.request(`${base}/userinfo`, {
        headers: { Authorization: `Bearer ${tokenBody.access_token as string}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.sub).toMatch(/^[A-Z0-9]{12}$/);
      expect(body.email).toBe("testuser@autodesk.local");
      expect(body.given_name).toBe("Test");
      expect(body.family_name).toBe("User");
      expect(body.email_verified).toBe(true);
    });

    it("returns 401 for userinfo with a 2-legged token", async () => {
      const res = await app.request(`${base}/authentication/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "aps-test-client",
          client_secret: "aps-test-secret",
          scope: "data:read",
        }).toString(),
      });
      const tokenBody = (await res.json()) as Record<string, unknown>;

      const userinfoRes = await app.request(`${base}/userinfo`, {
        headers: { Authorization: `Bearer ${tokenBody.access_token as string}` },
      });
      expect(userinfoRes.status).toBe(401);
      const body = (await userinfoRes.json()) as Record<string, unknown>;
      expect(body.errorCode).toBe("AUTH-006");
    });

    it("returns 401 for userinfo without a valid token", async () => {
      const res = await app.request(`${base}/userinfo`, {
        headers: { Authorization: "Bearer missing-token" },
      });
      expect(res.status).toBe(401);
    });

    it("logout redirects to an allow-listed post_logout_redirect_uri", async () => {
      const uri = "http://localhost:3000/goodbye";
      const res = await app.request(
        `${base}/authentication/v2/logout?post_logout_redirect_uri=${encodeURIComponent(uri)}`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(uri);
    });

    it("logout renders an error screen for a non allow-listed domain", async () => {
      const uri = "http://evil.local/callback";
      const res = await app.request(
        `${base}/authentication/v2/logout?post_logout_redirect_uri=${encodeURIComponent(uri)}`,
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Redirect not allowed");
    });

    it("logout without a redirect renders a signed out page", async () => {
      const res = await app.request(`${base}/authentication/v2/logout`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Signed out");
    });
  });

  describe("seed from config", () => {
    it("seeds clients and users and deduplicates", () => {
      const seedStore = new Store();
      const webhooks = new WebhookDispatcher();
      const localTokenMap: TokenMap = new Map();
      const localApp = new Hono();
      localApp.use("*", authMiddleware(localTokenMap));
      apsPlugin.register(localApp as any, seedStore, webhooks, base, localTokenMap);
      apsPlugin.seed?.(seedStore, base);

      seedFromConfig(seedStore, base, {
        users: [
          { email: "config-user@example.com", name: "Config User" },
          { email: "config-user@example.com", name: "Config User" },
        ],
        clients: [
          {
            client_id: "config-client",
            client_secret: "config-secret",
            name: "Config Client",
            redirect_uris: ["http://localhost:3000/config-callback"],
          },
          {
            client_id: "config-public",
            name: "Config Public Client",
            redirect_uris: ["http://localhost:3000/config-callback"],
          },
        ],
      });
      seedFromConfig(seedStore, base, {
        users: [{ email: "config-user@example.com", name: "Config User" }],
      });

      const aps = getApsStore(seedStore);
      expect(aps.users.findBy("email", "config-user@example.com")).toHaveLength(1);
      expect(aps.clients.findBy("client_id", "config-client")).toHaveLength(1);
      expect(aps.clients.findOneBy("client_id", "config-client")?.type).toBe("confidential");
      expect(aps.clients.findOneBy("client_id", "config-public")?.type).toBe("public");
      expect(aps.clients.findOneBy("client_id", "aps-test-client")).toBeDefined();
      expect(aps.clients.findOneBy("client_id", "aps-test-app")?.type).toBe("public");
      expect(aps.users.findOneBy("email", "testuser@autodesk.local")).toBeDefined();
    });
  });
});
