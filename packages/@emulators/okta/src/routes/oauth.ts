import { createHash, randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { Context } from "hono";
import type { AppEnv, RouteContext, Store } from "@emulators/core";
import {
  bodyStr,
  constantTimeSecretEqual,
  debug,
  escapeAttr,
  escapeHtml,
  matchesRedirectUri,
  renderCardPage,
  renderErrorPage,
  renderUserButton,
} from "@emulators/core";
import type { OktaOAuthClient, OktaUser } from "../entities.js";
import {
  DEFAULT_AUDIENCE,
  DEFAULT_AUTH_SERVER_ID,
  ORG_AUTH_SERVER_ID,
  resolveOktaIssuer,
  userDisplayName,
} from "../helpers.js";
import {
  findUserByRef,
  oktaError,
} from "../route-helpers.js";
import { getOktaStore } from "../store.js";

const keyPairPromise = generateKeyPair("RS256");
const KID = "emulate-okta-1";

const CODE_TTL_MS = 10 * 60 * 1000;

type PendingCode = {
  userRef: string;
  scope: string;
  redirectUri: string;
  clientId: string;
  nonce: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  authServerId: string;
  createdAt: number;
};

type StoredAccessToken = {
  authServerId: string;
  clientId: string;
  scope: string;
  issuedAt: number;
  expiresAt: number;
  userOktaId: string | null;
  username: string | null;
};

type StoredRefreshToken = {
  authServerId: string;
  clientId: string;
  scope: string;
  userOktaId: string;
  username: string;
  nonce: string | null;
};

type ResolvedServer = {
  authServerId: string;
  issuer: string;
  audiences: string[];
};

function getPendingCodes(store: Store): Map<string, PendingCode> {
  let map = store.getData<Map<string, PendingCode>>("okta.oauth.pendingCodes");
  if (!map) {
    map = new Map();
    store.setData("okta.oauth.pendingCodes", map);
  }
  return map;
}

function getAccessTokens(store: Store): Map<string, StoredAccessToken> {
  let map = store.getData<Map<string, StoredAccessToken>>("okta.oauth.accessTokens");
  if (!map) {
    map = new Map();
    store.setData("okta.oauth.accessTokens", map);
  }
  return map;
}

function getRefreshTokens(store: Store): Map<string, StoredRefreshToken> {
  let map = store.getData<Map<string, StoredRefreshToken>>("okta.oauth.refreshTokens");
  if (!map) {
    map = new Map();
    store.setData("okta.oauth.refreshTokens", map);
  }
  return map;
}

function isCodeExpired(code: PendingCode): boolean {
  return Date.now() - code.createdAt > CODE_TTL_MS;
}

function buildOAuthBasePath(authServerId: string): string {
  if (authServerId === ORG_AUTH_SERVER_ID) return "/oauth2/v1";
  return `/oauth2/${encodeURIComponent(authServerId)}/v1`;
}

function getClientsForServer(
  clients: OktaOAuthClient[],
  authServerId: string,
): OktaOAuthClient[] {
  return clients.filter((client) => client.auth_server_id === authServerId);
}

function resolveServer(
  authServerId: string,
  baseUrl: string,
  store: ReturnType<typeof getOktaStore>,
): ResolvedServer | null {
  if (authServerId === ORG_AUTH_SERVER_ID) {
    return {
      authServerId,
      issuer: baseUrl,
      audiences: [DEFAULT_AUDIENCE],
    };
  }

  const server = store.authorizationServers.findOneBy("server_id", authServerId);
  if (!server) return null;
  return {
    authServerId,
    issuer: resolveOktaIssuer(baseUrl, authServerId),
    audiences: server.audiences.length > 0 ? server.audiences : [DEFAULT_AUDIENCE],
  };
}

function buildOidcConfiguration(baseUrl: string, server: ResolvedServer): Record<string, unknown> {
  const oauthBase = buildOAuthBasePath(server.authServerId);
  const oauthUrlBase = `${baseUrl}${oauthBase}`;
  const tokenEndpointAuthMethods = ["client_secret_post", "client_secret_basic", "none"];
  return {
    issuer: server.issuer,
    authorization_endpoint: `${oauthUrlBase}/authorize`,
    token_endpoint: `${oauthUrlBase}/token`,
    userinfo_endpoint: `${oauthUrlBase}/userinfo`,
    jwks_uri: `${oauthUrlBase}/keys`,
    end_session_endpoint: `${oauthUrlBase}/logout`,
    revocation_endpoint: `${oauthUrlBase}/revoke`,
    introspection_endpoint: `${oauthUrlBase}/introspect`,
    registration_endpoint: `${oauthUrlBase}/clients`,
    response_types_supported: ["code"],
    response_modes_supported: ["query", "fragment", "form_post"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "profile", "email", "offline_access", "groups"],
    token_endpoint_auth_methods_supported: tokenEndpointAuthMethods,
    revocation_endpoint_auth_methods_supported: tokenEndpointAuthMethods,
    introspection_endpoint_auth_methods_supported: tokenEndpointAuthMethods,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
    claims_parameter_supported: false,
    request_object_signing_alg_values_supported: ["RS256"],
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "nonce",
      "name",
      "preferred_username",
      "email",
      "email_verified",
      "locale",
      "zoneinfo",
      "groups",
    ],
    code_challenge_methods_supported: ["plain", "S256"],
  };
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

function validateClient(
  clients: OktaOAuthClient[],
  authServerId: string,
  clientId: string,
  clientSecret: string,
): { client: OktaOAuthClient | null; response: Response | null } {
  const scopedClients = getClientsForServer(clients, authServerId);
  if (scopedClients.length === 0) {
    return { client: null, response: null };
  }

  const client = scopedClients.find((entry) => entry.client_id === clientId);
  if (!client) {
    return {
      client: null,
      response: new Response(
        JSON.stringify({ error: "invalid_client", error_description: "Unknown client." }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  if (client.token_endpoint_auth_method === "none") {
    return { client, response: null };
  }

  if (!constantTimeSecretEqual(client.client_secret ?? "", clientSecret)) {
    return {
      client: null,
      response: new Response(
        JSON.stringify({ error: "invalid_client", error_description: "Invalid client credentials." }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  return { client, response: null };
}

function parseScope(scope: string): string[] {
  return scope.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

function collectUserGroups(
  oktaStore: ReturnType<typeof getOktaStore>,
  user: OktaUser,
): string[] {
  const memberships = oktaStore.groupMemberships.findBy("user_okta_id", user.okta_id);
  const names: string[] = [];
  for (const membership of memberships) {
    const group = oktaStore.groups.findOneBy("okta_id", membership.group_okta_id);
    if (group) names.push(group.name);
  }
  return names;
}

async function createIdToken(
  oktaStore: ReturnType<typeof getOktaStore>,
  user: OktaUser,
  clientId: string,
  nonce: string | null,
  issuer: string,
  scope: string,
): Promise<string> {
  const { privateKey } = await keyPairPromise;
  const now = Math.floor(Date.now() / 1000);
  const scopes = parseScope(scope);

  const claims: Record<string, unknown> = {
    sub: user.okta_id,
    name: userDisplayName(user),
    preferred_username: user.login,
    email: user.email,
    email_verified: true,
    locale: user.locale,
    zoneinfo: user.time_zone,
    auth_time: now,
  };

  if (nonce) claims.nonce = nonce;
  if (scopes.includes("groups")) {
    claims.groups = collectUserGroups(oktaStore, user);
  }

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setIssuedAt(now)
    .setExpirationTime("1h")
    .sign(privateKey);
}

function unauthorizedOAuthError(): Response {
  return new Response(
    JSON.stringify({ error: "invalid_token", error_description: "The access token is invalid." }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

export function oauthRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const oktaStore = getOktaStore(store);
  const SERVICE_LABEL = "Okta";

  app.get("/.well-known/openid-configuration", (c) => {
    const server = resolveServer(ORG_AUTH_SERVER_ID, baseUrl, oktaStore);
    if (!server) return oktaError(c, 404, "E0000007", "Not found: org authorization server");
    return c.json(buildOidcConfiguration(baseUrl, server));
  });

  app.get("/oauth2/:authServerId/.well-known/openid-configuration", (c) => {
    const authServerId = c.req.param("authServerId");
    const server = resolveServer(authServerId, baseUrl, oktaStore);
    if (!server) return oktaError(c, 404, "E0000007", `Not found: authorization server '${authServerId}'`);
    return c.json(buildOidcConfiguration(baseUrl, server));
  });

  app.get("/oauth2/v1/keys", async (c) => {
    const { publicKey } = await keyPairPromise;
    const jwk = await exportJWK(publicKey);
    return c.json({
      keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }],
    });
  });

  app.get("/oauth2/:authServerId/v1/keys", async (c) => {
    const authServerId = c.req.param("authServerId");
    const server = resolveServer(authServerId, baseUrl, oktaStore);
    if (!server) return oktaError(c, 404, "E0000007", `Not found: authorization server '${authServerId}'`);

    const { publicKey } = await keyPairPromise;
    const jwk = await exportJWK(publicKey);
    return c.json({
      keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }],
    });
  });

  const renderAuthorizePage = (
    c: Context<AppEnv>,
    authServerId: string,
  ): Response => {
    const server = resolveServer(authServerId, baseUrl, oktaStore);
    if (!server) return oktaError(c, 404, "E0000007", `Not found: authorization server '${authServerId}'`);

    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const scope = c.req.query("scope") ?? "openid profile email";
    const state = c.req.query("state") ?? "";
    const nonce = c.req.query("nonce") ?? "";
    const responseMode = c.req.query("response_mode") ?? "query";
    const responseType = c.req.query("response_type") ?? "code";
    const codeChallenge = c.req.query("code_challenge") ?? "";
    const codeChallengeMethod = c.req.query("code_challenge_method") ?? "";

    if (responseType !== "code") {
      return c.html(
        renderErrorPage("Unsupported response_type", "Only response_type=code is supported.", SERVICE_LABEL),
        400,
      );
    }

    if (!redirectUri) {
      return c.html(
        renderErrorPage("Missing redirect URI", "The redirect_uri parameter is required.", SERVICE_LABEL),
        400,
      );
    }

    const configuredClients = getClientsForServer(oktaStore.oauthClients.all(), authServerId);
    let clientName = "";
    if (configuredClients.length > 0) {
      const client = configuredClients.find((entry) => entry.client_id === clientId);
      if (!client) {
        return c.html(
          renderErrorPage("Application not found", `The client_id '${clientId}' is not registered.`, SERVICE_LABEL),
          400,
        );
      }
      if (!matchesRedirectUri(redirectUri, client.redirect_uris)) {
        return c.html(
          renderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", SERVICE_LABEL),
          400,
        );
      }
      clientName = client.name;
    }

    const users = oktaStore.users.all();
    const callbackPath = `${buildOAuthBasePath(authServerId)}/authorize/callback`;
    const buttons = users
      .map((user) => renderUserButton({
        letter: (user.login[0] ?? "?").toUpperCase(),
        login: user.login,
        name: userDisplayName(user),
        email: user.email,
        formAction: callbackPath,
        hiddenFields: {
          user_ref: user.okta_id,
          redirect_uri: redirectUri,
          scope,
          state,
          nonce,
          client_id: clientId,
          response_mode: responseMode,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          auth_server_id: authServerId,
        },
      }))
      .join("\n");

    const subtitle = clientName
      ? `Sign in to <strong>${escapeHtml(clientName)}</strong> with your Okta account.`
      : "Choose a seeded user to continue.";

    return c.html(
      renderCardPage(
        "Sign in with Okta",
        subtitle,
        users.length > 0 ? buttons : '<p class="empty">No users in the emulator store.</p>',
        SERVICE_LABEL,
      ),
    );
  };

  app.get("/oauth2/v1/authorize", (c) => renderAuthorizePage(c, ORG_AUTH_SERVER_ID));
  app.get("/oauth2/:authServerId/v1/authorize", (c) => renderAuthorizePage(c, c.req.param("authServerId")));

  const handleAuthorizeCallback = async (
    c: Context<AppEnv>,
    authServerId: string,
  ): Promise<Response> => {
    const server = resolveServer(authServerId, baseUrl, oktaStore);
    if (!server) return oktaError(c, 404, "E0000007", `Not found: authorization server '${authServerId}'`);

    const body = await c.req.parseBody();
    const userRef = bodyStr(body.user_ref);
    const redirectUri = bodyStr(body.redirect_uri);
    const scope = bodyStr(body.scope) || "openid profile email";
    const state = bodyStr(body.state);
    const nonce = bodyStr(body.nonce);
    const clientId = bodyStr(body.client_id);
    const responseMode = bodyStr(body.response_mode) || "query";
    const codeChallenge = bodyStr(body.code_challenge);
    const codeChallengeMethod = bodyStr(body.code_challenge_method);

    if (!redirectUri) {
      return c.html(
        renderErrorPage("Missing redirect URI", "The redirect_uri parameter is required.", SERVICE_LABEL),
        400,
      );
    }

    const user = findUserByRef(oktaStore, userRef);
    if (!user) {
      return c.html(
        renderErrorPage("Unknown user", "The selected user is not available.", SERVICE_LABEL),
        400,
      );
    }

    const configuredClients = getClientsForServer(oktaStore.oauthClients.all(), authServerId);
    if (configuredClients.length > 0) {
      const client = configuredClients.find((entry) => entry.client_id === clientId);
      if (!client) {
        return c.html(
          renderErrorPage("Application not found", `The client_id '${clientId}' is not registered.`, SERVICE_LABEL),
          400,
        );
      }
      if (!matchesRedirectUri(redirectUri, client.redirect_uris)) {
        return c.html(
          renderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", SERVICE_LABEL),
          400,
        );
      }
    }

    const code = randomBytes(20).toString("hex");
    getPendingCodes(store).set(code, {
      userRef: user.okta_id,
      scope,
      redirectUri,
      clientId,
      nonce: nonce || null,
      codeChallenge: codeChallenge || null,
      codeChallengeMethod: codeChallengeMethod || null,
      authServerId,
      createdAt: Date.now(),
    });

    debug("okta.oauth", `[callback] code=${code.slice(0, 8)}... user=${user.login} server=${authServerId}`);

    if (responseMode === "form_post") {
      const html = `<!DOCTYPE html>
<html>
<head><title>Submit</title></head>
<body onload="document.forms[0].submit()">
<form method="POST" action="${escapeAttr(redirectUri)}">
<input type="hidden" name="code" value="${escapeAttr(code)}" />
<input type="hidden" name="state" value="${escapeAttr(state)}" />
</form>
</body>
</html>`;
      return c.html(html);
    }

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  };

  app.post("/oauth2/v1/authorize/callback", (c) => handleAuthorizeCallback(c, ORG_AUTH_SERVER_ID));
  app.post("/oauth2/:authServerId/v1/authorize/callback", (c) => handleAuthorizeCallback(c, c.req.param("authServerId")));

  const handleToken = async (
    c: Context<AppEnv>,
    authServerId: string,
  ): Promise<Response> => {
    const server = resolveServer(authServerId, baseUrl, oktaStore);
    if (!server) return oktaError(c, 404, "E0000007", `Not found: authorization server '${authServerId}'`);

    const body = await parseTokenLikeBody(c);
    const grantType = body.grant_type ?? "";
    const code = body.code ?? "";
    const redirectUri = body.redirect_uri ?? "";
    const codeVerifier = body.code_verifier;
    const refreshToken = body.refresh_token ?? "";
    const requestedScope = body.scope ?? "";

    const creds = parseClientCredentials(c, body);
    const validation = validateClient(oktaStore.oauthClients.all(), authServerId, creds.clientId, creds.clientSecret);
    if (validation.response) {
      return c.json(
        JSON.parse(await validation.response.text()) as Record<string, unknown>,
        validation.response.status as 401,
      );
    }
    const validatedClient = validation.client;

    if (grantType === "authorization_code") {
      const pending = getPendingCodes(store).get(code);
      if (!pending || isCodeExpired(pending)) {
        if (pending) getPendingCodes(store).delete(code);
        return c.json({ error: "invalid_grant", error_description: "Authorization code is invalid or expired." }, 400);
      }
      if (pending.authServerId !== authServerId) {
        return c.json({ error: "invalid_grant", error_description: "Authorization server mismatch." }, 400);
      }
      if (redirectUri && redirectUri !== pending.redirectUri) {
        return c.json({ error: "invalid_grant", error_description: "redirect_uri does not match." }, 400);
      }
      if (validatedClient && validatedClient.client_id !== pending.clientId) {
        return c.json({ error: "invalid_grant", error_description: "Authorization code was not issued to this client." }, 400);
      }

      if (pending.codeChallenge !== null) {
        if (!codeVerifier) {
          return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
        }
        const method = (pending.codeChallengeMethod ?? "plain").toLowerCase();
        if (method === "s256") {
          const expected = createHash("sha256").update(codeVerifier).digest("base64url");
          if (expected !== pending.codeChallenge) {
            return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
          }
        } else if (method === "plain") {
          if (codeVerifier !== pending.codeChallenge) {
            return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
          }
        } else {
          return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
        }
      }

      const user = findUserByRef(oktaStore, pending.userRef);
      if (!user) return c.json({ error: "invalid_grant", error_description: "Unknown user." }, 400);
      getPendingCodes(store).delete(code);

      const now = Math.floor(Date.now() / 1000);
      const audienceClient = pending.clientId || creds.clientId || "okta-client";
      const scope = pending.scope || "openid profile email";
      const accessToken = `okta_${randomBytes(20).toString("base64url")}`;
      const newRefreshToken = `r_okta_${randomBytes(20).toString("base64url")}`;

      getAccessTokens(store).set(accessToken, {
        authServerId,
        clientId: audienceClient,
        scope,
        issuedAt: now,
        expiresAt: now + 3600,
        userOktaId: user.okta_id,
        username: user.login,
      });
      getRefreshTokens(store).set(newRefreshToken, {
        authServerId,
        clientId: audienceClient,
        scope,
        userOktaId: user.okta_id,
        username: user.login,
        nonce: pending.nonce,
      });

      tokenMap?.set(accessToken, {
        login: user.login,
        id: user.id,
        scopes: parseScope(scope),
      });

      const idToken = await createIdToken(
        oktaStore,
        user,
        audienceClient,
        pending.nonce,
        server.issuer,
        scope,
      );

      return c.json({
        token_type: "Bearer",
        expires_in: 3600,
        access_token: accessToken,
        refresh_token: newRefreshToken,
        id_token: idToken,
        scope,
      });
    }

    if (grantType === "refresh_token") {
      const existing = getRefreshTokens(store).get(refreshToken);
      if (!existing) {
        return c.json({ error: "invalid_grant", error_description: "Invalid refresh token." }, 400);
      }
      if (existing.authServerId !== authServerId) {
        return c.json({ error: "invalid_grant", error_description: "Authorization server mismatch." }, 400);
      }
      if (validatedClient && validatedClient.client_id !== existing.clientId) {
        return c.json({ error: "invalid_grant", error_description: "Refresh token was not issued to this client." }, 400);
      }

      const user = oktaStore.users.findOneBy("okta_id", existing.userOktaId);
      if (!user) return c.json({ error: "invalid_grant", error_description: "Unknown user." }, 400);
      getRefreshTokens(store).delete(refreshToken);

      const now = Math.floor(Date.now() / 1000);
      const nextAccessToken = `okta_${randomBytes(20).toString("base64url")}`;
      const nextRefreshToken = `r_okta_${randomBytes(20).toString("base64url")}`;
      const scope = requestedScope || existing.scope;

      getAccessTokens(store).set(nextAccessToken, {
        authServerId,
        clientId: existing.clientId,
        scope,
        issuedAt: now,
        expiresAt: now + 3600,
        userOktaId: user.okta_id,
        username: user.login,
      });
      getRefreshTokens(store).set(nextRefreshToken, {
        ...existing,
        scope,
      });

      tokenMap?.set(nextAccessToken, {
        login: user.login,
        id: user.id,
        scopes: parseScope(scope),
      });

      const response: Record<string, unknown> = {
        token_type: "Bearer",
        expires_in: 3600,
        access_token: nextAccessToken,
        refresh_token: nextRefreshToken,
        scope,
      };

      if (parseScope(scope).includes("openid")) {
        response.id_token = await createIdToken(
          oktaStore,
          user,
          existing.clientId,
          existing.nonce,
          server.issuer,
          scope,
        );
      }

      return c.json(response);
    }

    if (grantType === "client_credentials") {
      if (oktaStore.oauthClients.all().length > 0 && !validatedClient) {
        return c.json({ error: "invalid_client", error_description: "Unknown client." }, 401);
      }

      const scope = requestedScope || ".default";
      const now = Math.floor(Date.now() / 1000);
      const accessToken = `okta_${randomBytes(20).toString("base64url")}`;
      const clientId = validatedClient?.client_id ?? creds.clientId;

      if (!clientId) {
        return c.json({ error: "invalid_client", error_description: "client_id is required." }, 401);
      }

      getAccessTokens(store).set(accessToken, {
        authServerId,
        clientId,
        scope,
        issuedAt: now,
        expiresAt: now + 3600,
        userOktaId: null,
        username: null,
      });

      tokenMap?.set(accessToken, {
        login: clientId,
        id: 0,
        scopes: parseScope(scope),
      });

      return c.json({
        token_type: "Bearer",
        expires_in: 3600,
        access_token: accessToken,
        scope,
      });
    }

    return c.json({ error: "unsupported_grant_type" }, 400);
  };

  app.post("/oauth2/v1/token", (c) => handleToken(c, ORG_AUTH_SERVER_ID));
  app.post("/oauth2/:authServerId/v1/token", (c) => handleToken(c, c.req.param("authServerId")));

  const handleUserInfo = (c: Context<AppEnv>, authServerId: string): Response => {
    const server = resolveServer(authServerId, baseUrl, oktaStore);
    if (!server) return oktaError(c, 404, "E0000007", `Not found: authorization server '${authServerId}'`);

    const token = c.get("authToken") ?? "";
    const access = getAccessTokens(store).get(token);
    if (!access || access.authServerId !== authServerId || !access.userOktaId) {
      return unauthorizedOAuthError();
    }

    const user = oktaStore.users.findOneBy("okta_id", access.userOktaId);
    if (!user) return unauthorizedOAuthError();

    const claims: Record<string, unknown> = {
      sub: user.okta_id,
      name: userDisplayName(user),
      preferred_username: user.login,
      email: user.email,
      email_verified: true,
      locale: user.locale,
      zoneinfo: user.time_zone,
    };

    if (parseScope(access.scope).includes("groups")) {
      claims.groups = collectUserGroups(oktaStore, user);
    }

    return c.json(claims);
  };

  app.get("/oauth2/v1/userinfo", (c) => handleUserInfo(c, ORG_AUTH_SERVER_ID));
  app.get("/oauth2/:authServerId/v1/userinfo", (c) => handleUserInfo(c, c.req.param("authServerId")));

  const handleRevoke = async (
    c: Context<AppEnv>,
    authServerId: string,
  ): Promise<Response> => {
    const server = resolveServer(authServerId, baseUrl, oktaStore);
    if (!server) return oktaError(c, 404, "E0000007", `Not found: authorization server '${authServerId}'`);

    const body = await parseTokenLikeBody(c);
    const token = body.token ?? "";
    getAccessTokens(store).delete(token);
    getRefreshTokens(store).delete(token);
    tokenMap?.delete(token);
    return c.body("", 200);
  };

  app.post("/oauth2/v1/revoke", (c) => handleRevoke(c, ORG_AUTH_SERVER_ID));
  app.post("/oauth2/:authServerId/v1/revoke", (c) => handleRevoke(c, c.req.param("authServerId")));

  const handleIntrospect = async (
    c: Context<AppEnv>,
    authServerId: string,
  ): Promise<Response> => {
    const server = resolveServer(authServerId, baseUrl, oktaStore);
    if (!server) return oktaError(c, 404, "E0000007", `Not found: authorization server '${authServerId}'`);

    const body = await parseTokenLikeBody(c);
    const token = body.token ?? "";
    const creds = parseClientCredentials(c, body);

    const validation = validateClient(oktaStore.oauthClients.all(), authServerId, creds.clientId, creds.clientSecret);
    if (validation.response) {
      return c.json(
        JSON.parse(await validation.response.text()) as Record<string, unknown>,
        validation.response.status as 401,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const access = getAccessTokens(store).get(token);
    if (access && access.authServerId === authServerId && access.expiresAt > now) {
      return c.json({
        active: true,
        token_type: "Bearer",
        scope: access.scope,
        client_id: access.clientId,
        username: access.username,
        sub: access.userOktaId,
        aud: server.audiences,
        iss: server.issuer,
        exp: access.expiresAt,
        iat: access.issuedAt,
      });
    }

    const refresh = getRefreshTokens(store).get(token);
    if (refresh && refresh.authServerId === authServerId) {
      return c.json({
        active: true,
        token_type: "refresh_token",
        scope: refresh.scope,
        client_id: refresh.clientId,
        username: refresh.username,
        sub: refresh.userOktaId,
        aud: server.audiences,
        iss: server.issuer,
      });
    }

    return c.json({ active: false });
  };

  app.post("/oauth2/v1/introspect", (c) => handleIntrospect(c, ORG_AUTH_SERVER_ID));
  app.post("/oauth2/:authServerId/v1/introspect", (c) => handleIntrospect(c, c.req.param("authServerId")));

  const handleLogout = (
    c: Context<AppEnv>,
    authServerId: string,
  ): Response => {
    const server = resolveServer(authServerId, baseUrl, oktaStore);
    if (!server) return oktaError(c, 404, "E0000007", `Not found: authorization server '${authServerId}'`);

    const postLogoutRedirectUri = c.req.query("post_logout_redirect_uri");
    if (!postLogoutRedirectUri) return c.text("Logged out");

    const scopedClients = getClientsForServer(oktaStore.oauthClients.all(), authServerId);
    if (scopedClients.length > 0) {
      const isAllowed = scopedClients.some((client) =>
        matchesRedirectUri(postLogoutRedirectUri, client.redirect_uris),
      );
      if (!isAllowed) return c.text("Invalid post_logout_redirect_uri", 400);
    }

    return c.redirect(postLogoutRedirectUri, 302);
  };

  app.get("/oauth2/v1/logout", (c) => handleLogout(c, ORG_AUTH_SERVER_ID));
  app.get("/oauth2/:authServerId/v1/logout", (c) => handleLogout(c, c.req.param("authServerId")));
}

export { DEFAULT_AUTH_SERVER_ID };
