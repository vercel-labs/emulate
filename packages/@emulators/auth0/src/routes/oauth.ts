import { randomBytes } from "node:crypto";
import {
  SignJWT,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  type CryptoKey as JoseCryptoKey,
} from "jose";
import type { Context } from "hono";
import type { AppEnv, RouteContext, Store } from "@emulators/core";
import { debug } from "@emulators/core";
import type { Auth0User } from "../entities.js";
import { generateToken, verifyPassword } from "../helpers.js";
import { AUTH0_ERRORS, authenticationApiError } from "../route-helpers.js";
import { getAuth0Store } from "../store.js";

const DEFAULT_KID = "emulate-auth0-1";

type ResolvedKeyPair = {
  privateKey: JoseCryptoKey;
  publicKey: JoseCryptoKey;
  kid: string;
};

export type SigningKeyConfig = {
  private_key_pem: string;
  public_key_pem: string;
  kid: string;
};

// Cache the Promise (not the resolved value) to prevent race conditions when
// concurrent requests both trigger key resolution before the first completes.
function getSigningKeyPair(store: Store): Promise<ResolvedKeyPair> {
  const cached = store.getData<Promise<ResolvedKeyPair>>("auth0.signing.pending");
  if (cached) return cached;

  const pending = resolveSigningKeyPair(store);
  store.setData("auth0.signing.pending", pending);
  return pending;
}

async function resolveSigningKeyPair(store: Store): Promise<ResolvedKeyPair> {
  const config = store.getData<SigningKeyConfig>("auth0.signing.config");

  if (config) {
    try {
      const privateKey = await importPKCS8(config.private_key_pem, "RS256");
      const publicKey = await importSPKI(config.public_key_pem, "RS256");
      return { privateKey, publicKey, kid: config.kid };
    } catch (e) {
      throw new Error(`Invalid signing_key PEM: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  return { privateKey, publicKey, kid: DEFAULT_KID };
}

type StoredAccessToken = {
  clientId: string;
  scope: string;
  issuedAt: number;
  expiresAt: number;
  userAuth0Id: string | null;
  audience: string;
};

type StoredRefreshToken = {
  clientId: string;
  scope: string;
  userAuth0Id: string;
  audience: string;
};

function getAccessTokens(store: Store): Map<string, StoredAccessToken> {
  let map = store.getData<Map<string, StoredAccessToken>>("auth0.oauth.accessTokens");
  if (!map) {
    map = new Map();
    store.setData("auth0.oauth.accessTokens", map);
  }
  return map;
}

function getRefreshTokens(store: Store): Map<string, StoredRefreshToken> {
  let map = store.getData<Map<string, StoredRefreshToken>>("auth0.oauth.refreshTokens");
  if (!map) {
    map = new Map();
    store.setData("auth0.oauth.refreshTokens", map);
  }
  return map;
}

async function parseTokenBody(c: Context<AppEnv>): Promise<Record<string, string>> {
  const contentType = c.req.header("Content-Type") ?? "";
  const raw = await c.req.text();

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  return Object.fromEntries(new URLSearchParams(raw));
}

function parseClientCredentials(
  c: Context<AppEnv>,
  body: Record<string, string>,
): { clientId: string; clientSecret: string } {
  let clientId = body.client_id ?? "";
  let clientSecret = body.client_secret ?? "";

  const authHeader = c.req.header("Authorization") ?? "";
  if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep !== -1) {
      const headerId = decodeURIComponent(decoded.slice(0, sep));
      const headerSecret = decodeURIComponent(decoded.slice(sep + 1));
      if (!clientId) clientId = headerId;
      if (!clientSecret) clientSecret = headerSecret;
    }
  }

  return { clientId, clientSecret };
}

async function createIdToken(store: Store, user: Auth0User, clientId: string, issuer: string): Promise<string> {
  const { privateKey, kid } = await getSigningKeyPair(store);
  const now = Math.floor(Date.now() / 1000);

  const claims: Record<string, unknown> = {
    sub: user.user_id,
    name: user.name,
    given_name: user.given_name,
    family_name: user.family_name,
    nickname: user.nickname,
    email: user.email,
    email_verified: user.email_verified,
    picture: user.picture,
  };

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setIssuedAt(now)
    .setExpirationTime("1h")
    .sign(privateKey);
}

export function oauthRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const auth0Store = getAuth0Store(store);

  // OIDC Discovery
  app.get("/.well-known/openid-configuration", (c) => {
    return c.json({
      issuer: `${baseUrl}/`,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      userinfo_endpoint: `${baseUrl}/userinfo`,
      jwks_uri: `${baseUrl}/.well-known/jwks.json`,
      revocation_endpoint: `${baseUrl}/oauth/revoke`,
      response_types_supported: ["code", "token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "profile", "email", "offline_access"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      claims_supported: [
        "sub",
        "iss",
        "aud",
        "exp",
        "iat",
        "name",
        "given_name",
        "family_name",
        "nickname",
        "email",
        "email_verified",
        "picture",
      ],
    });
  });

  // JWKS
  app.get("/.well-known/jwks.json", async (c) => {
    const { publicKey, kid } = await getSigningKeyPair(store);
    const jwk = await exportJWK(publicKey);
    return c.json({
      keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }],
    });
  });

  // Public key PEM export
  app.get("/_emulate/public-key.pem", async (c) => {
    const { publicKey } = await getSigningKeyPair(store);
    const pem = await exportSPKI(publicKey);
    return c.text(pem, 200, { "Content-Type": "text/plain" });
  });

  // Token endpoint — uses OAuth2 error format: { error, error_description }
  app.post("/oauth/token", async (c) => {
    const body = await parseTokenBody(c);
    const grantType = body.grant_type ?? "";
    const creds = parseClientCredentials(c, body);

    // Validate client
    const clients = auth0Store.oauthClients.all();
    if (clients.length > 0) {
      const client = clients.find((entry) => entry.client_id === creds.clientId);
      if (!client) {
        return authenticationApiError(c, 401, "access_denied", "Unauthorized");
      }
      if (client.client_secret && client.client_secret !== creds.clientSecret) {
        return authenticationApiError(c, 401, "access_denied", "Unauthorized");
      }
    }

    // client_credentials grant — used to get Management API tokens
    if (grantType === "client_credentials") {
      const audience = body.audience ?? "";
      const now = Math.floor(Date.now() / 1000);
      const accessToken = generateToken("auth0_m2m");

      getAccessTokens(store).set(accessToken, {
        clientId: creds.clientId,
        scope: body.scope ?? "",
        issuedAt: now,
        expiresAt: now + 86400,
        userAuth0Id: null,
        audience,
      });

      tokenMap?.set(accessToken, {
        login: creds.clientId,
        id: 0,
        scopes: (body.scope ?? "").split(/\s+/).filter(Boolean),
      });

      debug("auth0.oauth", `[client_credentials] client=${creds.clientId} audience=${audience}`);

      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 86400,
        scope: body.scope ?? "",
      });
    }

    // password-realm grant (Auth0's ROPG extension)
    // password-realm grant (Auth0's ROPG extension)
    if (grantType === "http://auth0.com/oauth/grant-type/password-realm" || grantType === "password") {
      const username = body.username ?? "";
      const password = body.password ?? "";
      const realm = body.realm ?? "Username-Password-Authentication";
      const audience = body.audience ?? "";
      const scope = body.scope ?? "openid profile email";

      const user = auth0Store.users.findOneBy("email", username);
      if (!user || user.connection !== realm || !verifyPassword(password, user.password_hash)) {
        return authenticationApiError(c, 403, "invalid_grant", AUTH0_ERRORS.WRONG_CREDENTIALS);
      }
      if (user.blocked) {
        return authenticationApiError(c, 403, "unauthorized", AUTH0_ERRORS.USER_BLOCKED);
      }

      const now = Math.floor(Date.now() / 1000);
      const accessToken = generateToken("auth0_at");
      const includeRefresh = scope.includes("offline_access");
      const refreshToken = includeRefresh ? generateToken("auth0_rt") : null;
      const issuer = `${baseUrl}/`;

      getAccessTokens(store).set(accessToken, {
        clientId: creds.clientId,
        scope,
        issuedAt: now,
        expiresAt: now + 86400,
        userAuth0Id: user.user_id,
        audience,
      });

      if (refreshToken) {
        getRefreshTokens(store).set(refreshToken, {
          clientId: creds.clientId,
          scope,
          userAuth0Id: user.user_id,
          audience,
        });
      }

      tokenMap?.set(accessToken, {
        login: user.email,
        id: user.id,
        scopes: scope.split(/\s+/).filter(Boolean),
      });

      const idToken = await createIdToken(store, user, creds.clientId, issuer);

      debug("auth0.oauth", `[password-realm] user=${user.email}`);

      const response: Record<string, unknown> = {
        access_token: accessToken,
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 86400,
        scope,
      };
      if (refreshToken) response.refresh_token = refreshToken;

      return c.json(response);
    }

    // refresh_token grant
    if (grantType === "refresh_token") {
      const refreshToken = body.refresh_token ?? "";
      const existing = getRefreshTokens(store).get(refreshToken);
      if (!existing) {
        return authenticationApiError(c, 403, "invalid_grant", AUTH0_ERRORS.INVALID_REFRESH_TOKEN);
      }

      const user = auth0Store.users.findOneBy("user_id", existing.userAuth0Id);
      if (!user) {
        return authenticationApiError(c, 403, "invalid_grant", AUTH0_ERRORS.INVALID_REFRESH_TOKEN);
      }

      getRefreshTokens(store).delete(refreshToken);

      const now = Math.floor(Date.now() / 1000);
      const nextAccessToken = generateToken("auth0_at");
      const nextRefreshToken = generateToken("auth0_rt");
      const scope = existing.scope;
      const issuer = `${baseUrl}/`;

      getAccessTokens(store).set(nextAccessToken, {
        clientId: existing.clientId,
        scope,
        issuedAt: now,
        expiresAt: now + 86400,
        userAuth0Id: user.user_id,
        audience: existing.audience,
      });

      getRefreshTokens(store).set(nextRefreshToken, {
        ...existing,
      });

      tokenMap?.set(nextAccessToken, {
        login: user.email,
        id: user.id,
        scopes: scope.split(/\s+/).filter(Boolean),
      });

      const response: Record<string, unknown> = {
        access_token: nextAccessToken,
        refresh_token: nextRefreshToken,
        token_type: "Bearer",
        expires_in: 86400,
        scope,
      };

      if (scope.includes("openid")) {
        response.id_token = await createIdToken(store, user, existing.clientId, issuer);
      }

      debug("auth0.oauth", `[refresh_token] user=${user.email}`);

      return c.json(response);
    }

    return authenticationApiError(c, 400, "unsupported_grant_type", `Grant type '${grantType}' not allowed.`);
  });

  // Userinfo — uses OAuth2 error format
  app.get("/userinfo", (c) => {
    const token = c.get("authToken") ?? "";
    const access = getAccessTokens(store).get(token);
    if (!access || !access.userAuth0Id) {
      return authenticationApiError(c, 401, "invalid_token", "The access token is invalid.");
    }

    const user = auth0Store.users.findOneBy("user_id", access.userAuth0Id);
    if (!user) {
      return authenticationApiError(c, 401, "invalid_token", "The access token is invalid.");
    }

    return c.json({
      sub: user.user_id,
      name: user.name,
      given_name: user.given_name,
      family_name: user.family_name,
      nickname: user.nickname,
      email: user.email,
      email_verified: user.email_verified,
      picture: user.picture,
    });
  });

  // Revoke token
  app.post("/oauth/revoke", async (c) => {
    const body = await parseTokenBody(c);
    const token = body.token ?? "";
    getAccessTokens(store).delete(token);
    getRefreshTokens(store).delete(token);
    tokenMap?.delete(token);
    return c.body("", 200);
  });
}
