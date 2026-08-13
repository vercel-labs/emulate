import { createHash, randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { Context } from "@emulators/core";
import type { AppEnv, RouteContext, Store, TokenMap } from "@emulators/core";
import {
  bodyStr,
  debug,
  escapeHtml,
  matchesRedirectUri,
  constantTimeSecretEqual,
  renderCardPage,
  renderErrorPage,
  renderFormPostPage,
  renderUserButton,
} from "@emulators/core";
import type { ApsClient, ApsUser } from "../entities.js";
import {
  analyticsIdFor,
  generateAuthorizationCode,
  generateJti,
  generateRefreshToken,
  isSupportedScope,
  parseScope,
  userNameFor,
  SUPPORTED_SCOPES,
} from "../helpers.js";
import { getApsStore, type ApsStore } from "../store.js";

const SERVICE_LABEL = "Autodesk Platform Services";
const KID = "emulate-aps-1";
const TOKEN_ISSUER = "https://developer.api.autodesk.com";
const TOKEN_AUDIENCE = "https://autodesk.com";
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const ACCESS_TOKEN_EXPIRES_IN = 3599;
const ID_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_MS = 15 * 24 * 60 * 60 * 1000;

type PendingCode = {
  userId: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  nonce: string | null;
  codeChallenge: string | null;
  createdAt: number;
};

type StoredAccessToken = {
  clientId: string;
  scope: string;
  issuedAt: number;
  expiresAt: number;
  apsUserId: string | null;
  familyId: string | null;
};

type StoredRefreshToken = {
  clientId: string;
  scope: string;
  apsUserId: string;
  familyId: string;
  expiresAt: number;
};

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

function getKeyPair(store: Store): Promise<KeyPair> {
  let pair = store.getData<Promise<KeyPair>>("aps.oauth.keyPair");
  if (!pair) {
    pair = generateKeyPair("RS256");
    store.setData("aps.oauth.keyPair", pair);
  }
  return pair;
}

function getPendingCodes(store: Store): Map<string, PendingCode> {
  let map = store.getData<Map<string, PendingCode>>("aps.oauth.pendingCodes");
  if (!map) {
    map = new Map();
    store.setData("aps.oauth.pendingCodes", map);
  }
  return map;
}

function getAccessTokens(store: Store): Map<string, StoredAccessToken> {
  let map = store.getData<Map<string, StoredAccessToken>>("aps.oauth.accessTokens");
  if (!map) {
    map = new Map();
    store.setData("aps.oauth.accessTokens", map);
  }
  return map;
}

function getRefreshTokens(store: Store): Map<string, StoredRefreshToken> {
  let map = store.getData<Map<string, StoredRefreshToken>>("aps.oauth.refreshTokens");
  if (!map) {
    map = new Map();
    store.setData("aps.oauth.refreshTokens", map);
  }
  return map;
}

function getConsumedRefreshTokens(store: Store): Map<string, string> {
  let map = store.getData<Map<string, string>>("aps.oauth.consumedRefreshTokens");
  if (!map) {
    map = new Map();
    store.setData("aps.oauth.consumedRefreshTokens", map);
  }
  return map;
}

function invalidateGrantFamily(store: Store, tokenMap: TokenMap | undefined, familyId: string): void {
  const refreshTokens = getRefreshTokens(store);
  for (const [token, record] of refreshTokens) {
    if (record.familyId === familyId) refreshTokens.delete(token);
  }
  const accessTokens = getAccessTokens(store);
  for (const [token, record] of accessTokens) {
    if (record.familyId === familyId) {
      accessTokens.delete(token);
      tokenMap?.delete(token);
    }
  }
}

async function parseTokenLikeBody(c: Context<AppEnv>): Promise<Record<string, string>> {
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

function oauthError(c: Context<AppEnv>, status: 400, error: string, description: string): Response {
  return c.json({ error, error_description: description }, status);
}

function invalidClient(c: Context<AppEnv>, description: string): Response {
  c.header("WWW-Authenticate", "Basic");
  return c.json({ error: "invalid_client", error_description: description }, 401);
}

function parseBasicAuth(header: string): { clientId: string; clientSecret: string } | null {
  if (!header.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep === -1) return null;
  return { clientId: decoded.slice(0, sep), clientSecret: decoded.slice(sep + 1) };
}

function authenticateClient(
  c: Context<AppEnv>,
  aps: ApsStore,
  body: Record<string, string>,
): { client: ApsClient } | { response: Response } {
  const authHeader = c.req.header("Authorization") ?? "";
  if (authHeader && body.client_id) {
    return {
      response: oauthError(
        c,
        400,
        "invalid_request",
        "The 'client_id' is not supported in the request body when Authorization headers are present.",
      ),
    };
  }

  const basic = parseBasicAuth(authHeader);
  const clientId = basic ? basic.clientId : (body.client_id ?? "");
  const clientSecret = basic ? basic.clientSecret : (body.client_secret ?? "");

  if (!clientId) {
    return { response: invalidClient(c, "No client credentials found.") };
  }

  const client = aps.clients.findOneBy("client_id", clientId);
  if (!client) {
    return { response: invalidClient(c, "The client credentials are invalid.") };
  }

  if (client.type === "confidential" && !constantTimeSecretEqual(client.client_secret, clientSecret)) {
    return { response: invalidClient(c, "The client credentials are invalid.") };
  }

  return { client };
}

function userProfileError(c: Context<AppEnv>): Response {
  return c.json(
    {
      developerMessage: "The provided access token is invalid, expired, or does not carry a user context.",
      userMessage: " ",
      errorCode: "AUTH-006",
      "more info": "https://developer.api.autodesk.com/documentation/v2/errors/AUTH-006",
    },
    401,
  );
}

async function signAccessToken(
  store: Store,
  options: { clientId: string; scope: string; apsUserId: string | null; now: number },
): Promise<string> {
  const { privateKey } = await getKeyPair(store);
  const claims: Record<string, unknown> = {
    scope: parseScope(options.scope),
    client_id: options.clientId,
    jti: generateJti(),
  };
  if (options.apsUserId) claims.userid = options.apsUserId;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setExpirationTime(options.now + ACCESS_TOKEN_TTL_SECONDS)
    .sign(privateKey);
}

async function createIdToken(
  store: Store,
  user: ApsUser,
  clientId: string,
  nonce: string | null,
  baseUrl: string,
  now: number,
): Promise<string> {
  const { privateKey } = await getKeyPair(store);
  const claims: Record<string, unknown> = {
    sub: user.user_id,
    first_name: user.first_name,
    last_name: user.last_name,
    user_name: userNameFor(user),
    user_email: user.email,
    userid: user.user_id,
    analytics_id: analyticsIdFor(user.user_id),
  };
  if (nonce) claims.nonce = nonce;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .setIssuer(baseUrl)
    .setAudience(clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + ID_TOKEN_TTL_SECONDS)
    .sign(privateKey);
}

export function oauthRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const aps = getApsStore(store);

  app.get("/.well-known/openid-configuration", (c) => {
    return c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authentication/v2/authorize`,
      token_endpoint: `${baseUrl}/authentication/v2/token`,
      userinfo_endpoint: `${baseUrl}/userinfo`,
      jwks_uri: `${baseUrl}/authentication/v2/keys`,
      revoke_endpoint: `${baseUrl}/authentication/v2/revoke`,
      introspect_endpoint: `${baseUrl}/authentication/v2/introspect`,
      scopes_supported: SUPPORTED_SCOPES,
      response_types_supported: ["code", "code id_token", "id_token"],
      response_modes_supported: ["fragment", "form_post", "query"],
      grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    });
  });

  app.get("/authentication/v2/keys", async (c) => {
    const { publicKey } = await getKeyPair(store);
    const jwk = await exportJWK(publicKey);
    c.header("Cache-Control", "max-age=604800");
    return c.json({
      keys: [{ kty: jwk.kty, kid: KID, use: "sig", n: jwk.n, e: jwk.e }],
    });
  });

  app.get("/authentication/v2/authorize", (c) => {
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const responseType = c.req.query("response_type") ?? "";
    const scope = c.req.query("scope") ?? "";
    const state = c.req.query("state") ?? "";
    const nonce = c.req.query("nonce") ?? "";
    const responseMode = c.req.query("response_mode") ?? "query";
    const codeChallenge = c.req.query("code_challenge") ?? "";
    const codeChallengeMethod = c.req.query("code_challenge_method") ?? "";

    if (!clientId) {
      return c.html(renderErrorPage("Missing client_id", "The client_id parameter is required.", SERVICE_LABEL), 400);
    }
    if (!redirectUri) {
      return c.html(
        renderErrorPage("Missing redirect URI", "The redirect_uri parameter is required.", SERVICE_LABEL),
        400,
      );
    }
    const client = aps.clients.findOneBy("client_id", clientId);
    if (!client) {
      return c.html(
        renderErrorPage("Application not found", `The client_id '${clientId}' is not registered.`, SERVICE_LABEL),
        400,
      );
    }
    if (!matchesRedirectUri(redirectUri, client.redirect_uris)) {
      return c.html(
        renderErrorPage(
          "Redirect URI mismatch",
          "The redirect_uri does not match the callback URL registered for this application.",
          SERVICE_LABEL,
        ),
        400,
      );
    }

    const redirectWithError = (error: string, description: string): Response => {
      const url = new URL(redirectUri);
      url.searchParams.set("error", error);
      url.searchParams.set("error_description", description);
      url.searchParams.set("state", state);
      return c.redirect(url.toString(), 302);
    };

    if (responseType !== "code") {
      return redirectWithError("unsupported_response_type", "The response_type must be 'code'.");
    }
    if (codeChallenge && codeChallengeMethod !== "S256") {
      return redirectWithError("invalid_request", "The 'code_challenge_method' must be the string 'S256'.");
    }
    if (!codeChallenge && client.type === "public") {
      return redirectWithError("invalid_request", "A 'code_challenge' is required for public clients.");
    }
    const invalidScope = parseScope(scope).find((entry) => !isSupportedScope(entry));
    if (invalidScope) {
      return redirectWithError("invalid_scope", "The scope is invalid.");
    }

    const users = aps.users.all();
    const buttons = users
      .map((user) =>
        renderUserButton({
          letter: (user.name[0] ?? user.email[0] ?? "?").toUpperCase(),
          login: user.email,
          name: user.name,
          email: user.email,
          formAction: "/authentication/v2/authorize/callback",
          hiddenFields: {
            user_id: user.user_id,
            redirect_uri: redirectUri,
            scope,
            state,
            nonce,
            client_id: clientId,
            response_mode: responseMode,
            code_challenge: codeChallenge,
          },
        }),
      )
      .join("\n");

    const subtitle = `Sign in to <strong>${escapeHtml(client.name)}</strong> with your Autodesk account.`;

    return c.html(
      renderCardPage(
        "Sign in with Autodesk",
        subtitle,
        users.length > 0 ? buttons : '<p class="empty">No users in the emulator store.</p>',
        SERVICE_LABEL,
      ),
    );
  });

  app.post("/authentication/v2/authorize/callback", async (c) => {
    const body = await c.req.parseBody();
    const userId = bodyStr(body.user_id);
    const redirectUri = bodyStr(body.redirect_uri);
    const scope = bodyStr(body.scope);
    const state = bodyStr(body.state);
    const nonce = bodyStr(body.nonce);
    const clientId = bodyStr(body.client_id);
    const responseMode = bodyStr(body.response_mode) || "query";
    const codeChallenge = bodyStr(body.code_challenge);

    if (!redirectUri) {
      return c.html(
        renderErrorPage("Missing redirect URI", "The redirect_uri parameter is required.", SERVICE_LABEL),
        400,
      );
    }
    const client = aps.clients.findOneBy("client_id", clientId);
    if (!client) {
      return c.html(
        renderErrorPage("Application not found", `The client_id '${clientId}' is not registered.`, SERVICE_LABEL),
        400,
      );
    }
    if (!matchesRedirectUri(redirectUri, client.redirect_uris)) {
      return c.html(
        renderErrorPage(
          "Redirect URI mismatch",
          "The redirect_uri does not match the callback URL registered for this application.",
          SERVICE_LABEL,
        ),
        400,
      );
    }
    const user = aps.users.findOneBy("user_id", userId);
    if (!user) {
      return c.html(renderErrorPage("Unknown user", "The selected user is not available.", SERVICE_LABEL), 400);
    }

    const code = generateAuthorizationCode();
    getPendingCodes(store).set(code, {
      userId: user.user_id,
      clientId,
      redirectUri,
      scope,
      nonce: nonce || null,
      codeChallenge: codeChallenge || null,
      createdAt: Date.now(),
    });

    debug("aps.oauth", `[callback] code=${code.slice(0, 8)}... user=${user.email}`);

    if (responseMode === "form_post") {
      return c.html(renderFormPostPage(redirectUri, { code, state }, SERVICE_LABEL));
    }
    if (responseMode === "fragment") {
      const url = new URL(redirectUri);
      url.hash = new URLSearchParams({ code, state }).toString();
      return c.redirect(url.toString(), 302);
    }
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  app.post("/authentication/v2/token", async (c) => {
    const body = await parseTokenLikeBody(c);
    const auth = authenticateClient(c, aps, body);
    if ("response" in auth) return auth.response;
    const client = auth.client;
    const grantType = body.grant_type ?? "";

    if (grantType === "authorization_code") {
      const code = body.code ?? "";
      const redirectUri = body.redirect_uri ?? "";
      const codeVerifier = body.code_verifier ?? "";

      if (!code) {
        return oauthError(c, 400, "invalid_request", "The request is missing a required parameter 'code'.");
      }
      if (!redirectUri) {
        return oauthError(c, 400, "invalid_request", "The request is missing a required parameter 'redirect_uri'.");
      }

      const pendingCodes = getPendingCodes(store);
      const pending = pendingCodes.get(code);
      if (!pending || Date.now() - pending.createdAt > AUTHORIZATION_CODE_TTL_MS) {
        if (pending) pendingCodes.delete(code);
        return oauthError(c, 400, "invalid_grant", "The authorization code is invalid or has expired.");
      }
      if (pending.clientId !== client.client_id) {
        return oauthError(c, 400, "invalid_grant", "The grant was issued to another client.");
      }
      if (redirectUri !== pending.redirectUri) {
        return oauthError(c, 400, "invalid_grant", "The 'redirect_uri' is invalid.");
      }
      if (pending.codeChallenge) {
        if (!codeVerifier) {
          return oauthError(c, 400, "invalid_request", "The request is missing a required parameter 'code_verifier'.");
        }
        const expected = createHash("sha256").update(codeVerifier).digest("base64url");
        if (expected !== pending.codeChallenge) {
          return oauthError(c, 400, "invalid_grant", "PKCE verification failed.");
        }
      }
      const user = aps.users.findOneBy("user_id", pending.userId);
      if (!user) {
        return oauthError(c, 400, "invalid_grant", "The authorization code is invalid or has expired.");
      }
      pendingCodes.delete(code);

      const now = Math.floor(Date.now() / 1000);
      const scope = pending.scope || "data:read";
      const familyId = randomBytes(16).toString("hex");
      const accessToken = await signAccessToken(store, {
        clientId: client.client_id,
        scope,
        apsUserId: user.user_id,
        now,
      });
      const refreshToken = generateRefreshToken();

      getAccessTokens(store).set(accessToken, {
        clientId: client.client_id,
        scope,
        issuedAt: now,
        expiresAt: now + ACCESS_TOKEN_TTL_SECONDS,
        apsUserId: user.user_id,
        familyId,
      });
      getRefreshTokens(store).set(refreshToken, {
        clientId: client.client_id,
        scope,
        apsUserId: user.user_id,
        familyId,
        expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
      });
      tokenMap?.set(accessToken, { login: user.email, id: user.id, scopes: parseScope(scope) });

      debug("aps.oauth", `[token] issued 3-legged token for ${user.email}`);

      const response: Record<string, unknown> = {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_EXPIRES_IN,
        refresh_token: refreshToken,
      };
      if (parseScope(scope).includes("openid")) {
        response.id_token = await createIdToken(store, user, client.client_id, pending.nonce, baseUrl, now);
      }
      return c.json(response);
    }

    if (grantType === "refresh_token") {
      const refreshToken = body.refresh_token ?? "";
      if (!refreshToken) {
        return oauthError(c, 400, "invalid_request", "The request is missing a required parameter 'refresh_token'.");
      }

      const consumed = getConsumedRefreshTokens(store);
      const replayedFamily = consumed.get(refreshToken);
      if (replayedFamily) {
        invalidateGrantFamily(store, tokenMap, replayedFamily);
        return oauthError(c, 400, "invalid_grant", "The refresh token is invalid or expired.");
      }

      const refreshTokens = getRefreshTokens(store);
      const record = refreshTokens.get(refreshToken);
      if (!record || record.expiresAt <= Date.now()) {
        if (record) refreshTokens.delete(refreshToken);
        return oauthError(c, 400, "invalid_grant", "The refresh token is invalid or expired.");
      }
      if (record.clientId !== client.client_id) {
        return oauthError(c, 400, "invalid_grant", "The grant was issued to another client.");
      }

      let scope = record.scope;
      const requestedScope = body.scope ?? "";
      if (requestedScope) {
        const granted = new Set(parseScope(record.scope));
        const requested = parseScope(requestedScope);
        if (requested.some((entry) => !granted.has(entry))) {
          return oauthError(
            c,
            400,
            "invalid_scope",
            "The requested scope is invalid, unknown, malformed or exceeds the scope granted by the resource owner.",
          );
        }
        scope = requested.join(" ");
      }

      const user = aps.users.findOneBy("user_id", record.apsUserId);
      if (!user) {
        return oauthError(c, 400, "invalid_grant", "The refresh token is invalid or expired.");
      }

      refreshTokens.delete(refreshToken);
      consumed.set(refreshToken, record.familyId);

      const now = Math.floor(Date.now() / 1000);
      const accessToken = await signAccessToken(store, {
        clientId: client.client_id,
        scope,
        apsUserId: user.user_id,
        now,
      });
      const nextRefreshToken = generateRefreshToken();

      getAccessTokens(store).set(accessToken, {
        clientId: client.client_id,
        scope,
        issuedAt: now,
        expiresAt: now + ACCESS_TOKEN_TTL_SECONDS,
        apsUserId: user.user_id,
        familyId: record.familyId,
      });
      refreshTokens.set(nextRefreshToken, {
        clientId: client.client_id,
        scope,
        apsUserId: user.user_id,
        familyId: record.familyId,
        expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
      });
      tokenMap?.set(accessToken, { login: user.email, id: user.id, scopes: parseScope(scope) });

      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_EXPIRES_IN,
        refresh_token: nextRefreshToken,
      });
    }

    if (grantType === "client_credentials") {
      if (client.type !== "confidential") {
        return invalidClient(c, "The client credentials are invalid.");
      }
      const scope = body.scope ?? "";
      const scopes = parseScope(scope);
      if (scopes.length === 0 || scopes.some((entry) => !isSupportedScope(entry))) {
        return oauthError(
          c,
          400,
          "invalid_scope",
          "The requested scope is invalid, unknown, malformed or exceeds the scope granted by the resource owner.",
        );
      }

      const now = Math.floor(Date.now() / 1000);
      const accessToken = await signAccessToken(store, {
        clientId: client.client_id,
        scope,
        apsUserId: null,
        now,
      });

      getAccessTokens(store).set(accessToken, {
        clientId: client.client_id,
        scope,
        issuedAt: now,
        expiresAt: now + ACCESS_TOKEN_TTL_SECONDS,
        apsUserId: null,
        familyId: null,
      });
      tokenMap?.set(accessToken, { login: client.client_id, id: 0, scopes });

      debug("aps.oauth", `[token] issued 2-legged token for ${client.client_id}`);

      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_EXPIRES_IN,
      });
    }

    return oauthError(c, 400, "invalid_request", "The token request must specify a valid 'grant_type'.");
  });

  app.post("/authentication/v2/revoke", async (c) => {
    const body = await parseTokenLikeBody(c);
    const auth = authenticateClient(c, aps, body);
    if ("response" in auth) return auth.response;
    const client = auth.client;

    const token = body.token ?? "";
    if (!token) {
      return oauthError(c, 400, "invalid_request", "The request is missing a required parameter 'token'.");
    }

    const accessTokens = getAccessTokens(store);
    const accessRecord = accessTokens.get(token);
    if (accessRecord && accessRecord.clientId === client.client_id) {
      accessTokens.delete(token);
      tokenMap?.delete(token);
    }
    const refreshTokens = getRefreshTokens(store);
    const refreshRecord = refreshTokens.get(token);
    if (refreshRecord && refreshRecord.clientId === client.client_id) {
      refreshTokens.delete(token);
    }

    return c.body(null, 200);
  });

  app.post("/authentication/v2/introspect", async (c) => {
    const body = await parseTokenLikeBody(c);
    const auth = authenticateClient(c, aps, body);
    if ("response" in auth) return auth.response;

    const token = body.token ?? "";
    if (!token) {
      return oauthError(c, 400, "invalid_request", "The request is missing a required parameter 'token'.");
    }

    const now = Math.floor(Date.now() / 1000);
    const access = getAccessTokens(store).get(token);
    if (access && access.expiresAt > now) {
      return c.json({
        active: true,
        scope: access.scope,
        client_id: access.clientId,
        exp: access.expiresAt,
        ...(access.apsUserId ? { userid: access.apsUserId } : {}),
      });
    }

    const refresh = getRefreshTokens(store).get(token);
    if (refresh && refresh.expiresAt > Date.now()) {
      return c.json({
        active: true,
        scope: refresh.scope,
        client_id: refresh.clientId,
        exp: Math.floor(refresh.expiresAt / 1000),
        userid: refresh.apsUserId,
      });
    }

    return c.json({ active: false });
  });

  app.get("/authentication/v2/logout", (c) => {
    const postLogoutRedirectUri = c.req.query("post_logout_redirect_uri");
    if (!postLogoutRedirectUri) {
      return c.html(renderCardPage("Signed out", "Your Autodesk session has ended.", "", SERVICE_LABEL));
    }

    let allowed = false;
    try {
      const target = new URL(postLogoutRedirectUri);
      allowed = aps.clients.all().some((client) =>
        client.redirect_uris.some((uri) => {
          try {
            return new URL(uri).host === target.host;
          } catch {
            return false;
          }
        }),
      );
    } catch {
      allowed = false;
    }
    if (!allowed) {
      return c.html(
        renderErrorPage(
          "Redirect not allowed",
          "The post_logout_redirect_uri domain is not in the allowed list.",
          SERVICE_LABEL,
        ),
        400,
      );
    }
    return c.redirect(postLogoutRedirectUri, 302);
  });

  app.get("/userinfo", (c) => {
    const authHeader = c.req.header("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const record = token ? getAccessTokens(store).get(token) : undefined;
    const now = Math.floor(Date.now() / 1000);
    if (!record || record.expiresAt <= now || !record.apsUserId) {
      return userProfileError(c);
    }
    const user = aps.users.findOneBy("user_id", record.apsUserId);
    if (!user) return userProfileError(c);

    const response: Record<string, unknown> = {
      sub: user.user_id,
      name: user.name,
      given_name: user.first_name,
      family_name: user.last_name,
      preferred_username: userNameFor(user),
      email: user.email,
      email_verified: true,
      locale: "en-US",
      updated_at: Math.floor(new Date(user.updated_at).getTime() / 1000),
      eidm_guid: user.user_id,
    };
    if (user.picture) {
      response.picture = user.picture;
      response.thumbnails = { sizeX200: user.picture };
    }
    return c.json(response);
  });
}
