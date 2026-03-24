import { randomBytes } from "crypto";
import type { Context } from "hono";
import type { RouteContext, Store, TokenMap } from "@internal/core";
import {
  renderCardPage,
  renderErrorPage,
  renderUserButton,
  matchesRedirectUri,
  constantTimeSecretEqual,
  escapeHtml,
  bodyStr,
  debug,
} from "@internal/core";
import { getIdpStore } from "../store.js";
import { createIdToken, verifyPkce, resolvePath } from "../crypto.js";
import {
  getStrict,
  getIssuer,
  getPendingCodes,
  isPendingCodeExpired,
  getRefreshTokens,
  getRevokedTokens,
  getSessions,
  getTokenClients,
} from "../helpers.js";
import type { IdpUser } from "../entities.js";

const SERVICE_LABEL = "Identity Provider";

export function oidcRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const idp = getIdpStore(store);

  // ---------- OIDC Discovery ----------

  app.get("/.well-known/openid-configuration", (c) => {
    const issuer = getIssuer(store, baseUrl);
    return c.json({
      issuer,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      userinfo_endpoint: `${baseUrl}/userinfo`,
      revocation_endpoint: `${baseUrl}/revoke`,
      jwks_uri: `${baseUrl}/jwks.json`,
      end_session_endpoint: `${baseUrl}/logout`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "email", "profile", "groups", "roles", "offline_access"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      claims_supported: [
        "sub", "email", "email_verified", "name",
        "given_name", "family_name", "picture", "locale",
        "groups", "roles",
      ],
      code_challenge_methods_supported: ["plain", "S256"],
    });
  });

  // ---------- JWKS ----------

  app.get("/jwks.json", (c) => {
    const keys = idp.signingKeys.all().filter((k) => k.active).map((k) => k.public_key_jwk);
    return c.json({ keys });
  });

  // ---------- Authorize ----------

  app.get("/authorize", (c) => {
    const response_type = c.req.query("response_type") ?? "";
    const client_id = c.req.query("client_id") ?? "";
    const redirect_uri = c.req.query("redirect_uri") ?? "";
    const scope = c.req.query("scope") ?? "";
    const state = c.req.query("state") ?? "";
    const nonce = c.req.query("nonce") ?? "";
    const code_challenge = c.req.query("code_challenge") ?? "";
    const code_challenge_method = c.req.query("code_challenge_method") ?? "";

    const strict = getStrict(store);
    const clientsConfigured = idp.clients.all().length > 0;
    let clientName = "";

    if (clientsConfigured || strict) {
      const client = idp.clients.findOneBy("client_id", client_id);
      if (!client) {
        return c.html(
          renderErrorPage("Application not found", `The client_id '${client_id}' is not registered.`, SERVICE_LABEL),
          400,
        );
      }
      if (redirect_uri && !matchesRedirectUri(redirect_uri, client.redirect_uris)) {
        return c.html(
          renderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", SERVICE_LABEL),
          400,
        );
      }
      clientName = client.name;
    }

    const subtitleText = clientName
      ? `Sign in to <strong>${escapeHtml(clientName)}</strong> with your account.`
      : "Choose a seeded user to continue.";

    const users = idp.users.all();
    const userButtons = users
      .map((user) => {
        return renderUserButton({
          letter: (user.email[0] ?? "?").toUpperCase(),
          login: user.email,
          name: user.name,
          email: user.email,
          formAction: "/authorize/callback",
          hiddenFields: {
            uid: user.uid,
            redirect_uri,
            scope,
            state,
            nonce,
            client_id,
            code_challenge,
            code_challenge_method,
          },
        });
      })
      .join("\n");

    const body = users.length === 0
      ? '<p class="empty">No users in the emulator store.</p>'
      : userButtons;

    return c.html(renderCardPage("Sign in", subtitleText, body, SERVICE_LABEL));
  });

  // ---------- Authorize callback ----------

  app.post("/authorize/callback", async (c) => {
    const body = await c.req.parseBody();
    const uid = bodyStr(body.uid);
    const redirect_uri = bodyStr(body.redirect_uri);
    const scope = bodyStr(body.scope);
    const state = bodyStr(body.state);
    const client_id = bodyStr(body.client_id);
    const nonce = bodyStr(body.nonce);
    const code_challenge = bodyStr(body.code_challenge);
    const code_challenge_method = bodyStr(body.code_challenge_method);

    const code = randomBytes(20).toString("hex");

    getPendingCodes(store).set(code, {
      uid,
      scope,
      redirectUri: redirect_uri,
      clientId: client_id,
      nonce: nonce || null,
      codeChallenge: code_challenge || null,
      codeChallengeMethod: code_challenge_method || null,
      created_at: Date.now(),
    });

    debug("idp.oidc", `[IDP callback] code=${code.slice(0, 8)}... uid=${uid}`);

    let url: URL;
    try {
      url = new URL(redirect_uri);
    } catch {
      return c.html(
        renderErrorPage("Invalid redirect_uri", "The redirect_uri is not a valid URL.", SERVICE_LABEL),
        400,
      );
    }
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);

    return c.redirect(url.toString(), 302);
  });

  // ---------- Token exchange ----------

  app.post("/token", async (c) => {
    const contentType = c.req.header("Content-Type") ?? "";
    const rawText = await c.req.text();

    let body: Record<string, unknown>;
    if (contentType.includes("application/json")) {
      try { body = JSON.parse(rawText); } catch { body = {}; }
    } else {
      body = Object.fromEntries(new URLSearchParams(rawText));
    }

    const grant_type = typeof body.grant_type === "string" ? body.grant_type : "";
    const code = typeof body.code === "string" ? body.code : "";
    const redirect_uri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
    const code_verifier = typeof body.code_verifier === "string" ? body.code_verifier : undefined;
    const bodyRefreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";

    // Parse client credentials from Basic auth or body
    let clientId = typeof body.client_id === "string" ? body.client_id : "";
    let clientSecret = typeof body.client_secret === "string" ? body.client_secret : "";

    const authHeader = c.req.header("Authorization") ?? "";
    if (authHeader.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
      const colonIdx = decoded.indexOf(":");
      if (colonIdx >= 0) {
        clientId = decoded.slice(0, colonIdx);
        clientSecret = decoded.slice(colonIdx + 1);
      }
    }

    // Validate client if configured or strict
    const strict = getStrict(store);
    const clientsConfigured = idp.clients.all().length > 0;

    if (clientsConfigured || strict) {
      const client = idp.clients.findOneBy("client_id", clientId);
      if (!client) {
        return c.json({ error: "invalid_client", error_description: "The client_id is incorrect." }, 401);
      }
      if (!constantTimeSecretEqual(clientSecret, client.client_secret)) {
        return c.json({ error: "invalid_client", error_description: "The client_secret is incorrect." }, 401);
      }
    }

    if (grant_type === "authorization_code") {
      return handleAuthCodeGrant(c, store, idp, code, redirect_uri, code_verifier, clientId, baseUrl, tokenMap);
    } else if (grant_type === "refresh_token") {
      return handleRefreshTokenGrant(c, store, idp, bodyRefreshToken, clientId, baseUrl, tokenMap);
    } else {
      return c.json({ error: "unsupported_grant_type", error_description: "Only authorization_code and refresh_token are supported." }, 400);
    }
  });

  // ---------- Userinfo ----------

  app.get("/userinfo", (c) => {
    const authUser = c.get("authUser");
    if (!authUser) {
      return c.json({ error: "invalid_token", error_description: "Authentication required." }, 401);
    }

    const user = idp.users.findOneBy("email", authUser.login as IdpUser["email"]);
    if (!user) {
      return c.json({ error: "invalid_token", error_description: "User not found." }, 401);
    }

    const scopes = authUser.scopes ?? [];
    const claims: Record<string, unknown> = { sub: user.uid };

    if (scopes.includes("email")) {
      claims.email = user.email;
      claims.email_verified = user.email_verified;
    }
    if (scopes.includes("profile")) {
      claims.name = user.name;
      claims.given_name = user.given_name;
      claims.family_name = user.family_name;
      claims.picture = user.picture;
      claims.locale = user.locale;
    }
    if (scopes.includes("groups")) {
      claims.groups = user.groups;
    }
    if (scopes.includes("roles")) {
      claims.roles = user.roles;
    }

    // Apply claim_mappings from client if available
    const authToken = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const tcMap = getTokenClients(store);
    const mappedClientId = tcMap.get(authToken);
    if (mappedClientId) {
      const client = idp.clients.findOneBy("client_id", mappedClientId);
      if (client && client.claim_mappings) {
        for (const [claimName, path] of Object.entries(client.claim_mappings)) {
          const value = resolvePath(user, path);
          if (value !== undefined) {
            claims[claimName] = value;
          }
        }
      }
    }

    return c.json(claims);
  });

  // ---------- Revoke ----------

  app.post("/revoke", async (c) => {
    const contentType = c.req.header("Content-Type") ?? "";
    const rawText = await c.req.text();

    let token: string;
    if (contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(rawText);
        token = typeof parsed.token === "string" ? parsed.token : "";
      } catch {
        token = "";
      }
    } else {
      const params = new URLSearchParams(rawText);
      token = params.get("token") ?? "";
    }

    if (token) {
      if (tokenMap) {
        tokenMap.delete(token);
      }
      const refreshTokens = getRefreshTokens(store);
      refreshTokens.delete(token);
      getRevokedTokens(store).add(token);
    }

    return c.body(null, 200);
  });

  // ---------- Logout ----------

  app.get("/logout", (c) => {
    const id_token_hint = c.req.query("id_token_hint") ?? "";
    const post_logout_redirect_uri = c.req.query("post_logout_redirect_uri") ?? "";
    const state = c.req.query("state") ?? "";

    if (post_logout_redirect_uri) {
      const strict = getStrict(store);
      if (strict && id_token_hint) {
        // Decode token to get client_id (aud), validate redirect
        try {
          const payload = JSON.parse(Buffer.from(id_token_hint.split(".")[1], "base64url").toString());
          const aud = typeof payload.aud === "string" ? payload.aud : "";
          const client = idp.clients.findOneBy("client_id", aud);
          if (client && !matchesRedirectUri(post_logout_redirect_uri, client.post_logout_redirect_uris)) {
            return c.html(
              renderErrorPage("Invalid redirect", "The post_logout_redirect_uri is not registered.", SERVICE_LABEL),
              400,
            );
          }
        } catch {
          // ignore decode errors
        }
      }

      const url = new URL(post_logout_redirect_uri);
      if (state) url.searchParams.set("state", state);
      return c.redirect(url.toString(), 302);
    }

    return c.html(renderCardPage("Signed out", "You have been signed out.", "", SERVICE_LABEL));
  });

  // ---------- Debug ----------

  app.get("/_debug/state", (c) => {
    if (getStrict(store)) {
      return c.json({ error: "forbidden" }, 403);
    }

    const users = idp.users.all();
    const clients = idp.clients.all();
    const keys = idp.signingKeys.all();

    return c.json({
      users_count: users.length,
      clients_count: clients.length,
      signing_keys: keys.map((k) => ({ kid: k.kid, alg: k.alg, active: k.active })),
      pending_codes_count: getPendingCodes(store).size,
      refresh_tokens_count: getRefreshTokens(store).size,
      sessions_count: getSessions(store).size,
    });
  });
}

// ---------- Grant handlers ----------

async function handleAuthCodeGrant(
  c: Context,
  store: Store,
  idp: ReturnType<typeof getIdpStore>,
  code: string,
  redirect_uri: string,
  code_verifier: string | undefined,
  clientId: string,
  baseUrl: string,
  tokenMap?: TokenMap,
) {
  const pendingMap = getPendingCodes(store);
  const pending = pendingMap.get(code);
  if (!pending) {
    return c.json({ error: "invalid_grant", error_description: "The code is incorrect or expired." }, 400);
  }
  if (isPendingCodeExpired(pending)) {
    pendingMap.delete(code);
    return c.json({ error: "invalid_grant", error_description: "The code is incorrect or expired." }, 400);
  }

  // Validate redirect_uri matches the one stored during authorize
  if (redirect_uri && redirect_uri !== pending.redirectUri) {
    return c.json({ error: "invalid_grant", error_description: "The redirect_uri does not match." }, 400);
  }

  // Validate client_id matches the one stored during authorize
  if (clientId && pending.clientId && clientId !== pending.clientId) {
    return c.json({ error: "invalid_grant", error_description: "The client_id does not match." }, 400);
  }

  // Strict mode requires PKCE
  const strict = getStrict(store);
  if (strict && pending.codeChallenge == null) {
    return c.json({ error: "invalid_grant", error_description: "PKCE is required in strict mode." }, 400);
  }

  // PKCE verification
  if (pending.codeChallenge != null) {
    if (code_verifier === undefined) {
      return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
    }
    const method = (pending.codeChallengeMethod ?? "plain").toLowerCase();
    if (!verifyPkce(code_verifier, pending.codeChallenge, method)) {
      return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
    }
  }

  pendingMap.delete(code);

  // Look up user by uid from pending code; fall back to first user
  let user = idp.users.findOneBy("uid", pending.uid);
  if (!user) {
    const allUsers = idp.users.all();
    user = allUsers[0] ?? null;
  }
  if (!user) {
    return c.json({ error: "invalid_grant", error_description: "User not found." }, 400);
  }

  const scopes = pending.scope ? pending.scope.split(/\s+/).filter(Boolean) : [];
  const accessToken = "idp_" + randomBytes(20).toString("base64url");

  if (tokenMap) {
    tokenMap.set(accessToken, { login: user.email, id: user.id, scopes });
  }

  // Track client for this token
  const tcMap = getTokenClients(store);
  tcMap.set(accessToken, clientId || pending.clientId);

  // Get signing key
  const signingKey = idp.signingKeys.all().find((k) => k.active);
  if (!signingKey) {
    return c.json({ error: "server_error", error_description: "No active signing key." }, 500);
  }

  // Get client for TTL and claim_mappings
  const client = idp.clients.findOneBy("client_id", clientId || pending.clientId);
  const idTokenTtl = client?.id_token_ttl ?? 3600;
  const accessTokenTtl = client?.access_token_ttl ?? 3600;
  const refreshTokenTtl = client?.refresh_token_ttl ?? 86400;
  const claimMappings = client?.claim_mappings ?? {};

  const issuer = getIssuer(store, baseUrl);
  const idToken = await createIdToken(user, clientId || pending.clientId, pending.nonce, issuer, signingKey, idTokenTtl, claimMappings);

  debug("idp.oidc", `[IDP token] issued token for ${user.email}`);

  const result: Record<string, unknown> = {
    access_token: accessToken,
    id_token: idToken,
    token_type: "Bearer",
    expires_in: accessTokenTtl,
    scope: pending.scope || "openid email profile",
  };

  // Issue refresh token if offline_access requested
  if (scopes.includes("offline_access")) {
    const refreshToken = "idprt_" + randomBytes(32).toString("base64url");
    const refreshTokens = getRefreshTokens(store);
    refreshTokens.set(refreshToken, {
      token: refreshToken,
      uid: user.uid,
      clientId: clientId || pending.clientId,
      scope: pending.scope,
      created_at: Date.now(),
      expires_at: Date.now() + refreshTokenTtl * 1000,
    });
    result.refresh_token = refreshToken;
  }

  return c.json(result);
}

async function handleRefreshTokenGrant(
  c: Context,
  store: Store,
  idp: ReturnType<typeof getIdpStore>,
  refreshToken: string,
  clientId: string,
  baseUrl: string,
  tokenMap?: TokenMap,
) {
  const refreshTokens = getRefreshTokens(store);
  const rtData = refreshTokens.get(refreshToken);
  if (!rtData) {
    return c.json({ error: "invalid_grant", error_description: "The refresh_token is invalid or expired." }, 400);
  }

  // Check expiry
  if (Date.now() > rtData.expires_at) {
    refreshTokens.delete(refreshToken);
    return c.json({ error: "invalid_grant", error_description: "The refresh_token is invalid or expired." }, 400);
  }

  // Validate client_id matches the one bound to the refresh token
  if (clientId && rtData.clientId && clientId !== rtData.clientId) {
    return c.json({ error: "invalid_grant", error_description: "The client_id does not match the refresh token." }, 400);
  }

  // Rotate: delete old, issue new
  refreshTokens.delete(refreshToken);

  const user = idp.users.findOneBy("uid", rtData.uid);
  if (!user) {
    const allUsers = idp.users.all();
    if (allUsers.length === 0) {
      return c.json({ error: "invalid_grant", error_description: "User not found." }, 400);
    }
  }
  const resolvedUser = user ?? idp.users.all()[0];

  const scopes = rtData.scope ? rtData.scope.split(/\s+/).filter(Boolean) : [];
  const accessToken = "idp_" + randomBytes(20).toString("base64url");

  if (tokenMap) {
    tokenMap.set(accessToken, { login: resolvedUser.email, id: resolvedUser.id, scopes });
  }

  const tcMap = getTokenClients(store);
  tcMap.set(accessToken, clientId || rtData.clientId);

  const signingKey = idp.signingKeys.all().find((k) => k.active);
  if (!signingKey) {
    return c.json({ error: "server_error", error_description: "No active signing key." }, 500);
  }

  const client = idp.clients.findOneBy("client_id", clientId || rtData.clientId);
  const idTokenTtl = client?.id_token_ttl ?? 3600;
  const accessTokenTtl = client?.access_token_ttl ?? 3600;
  const refreshTokenTtl = client?.refresh_token_ttl ?? 86400;
  const claimMappings = client?.claim_mappings ?? {};

  const issuer = getIssuer(store, baseUrl);
  const idToken = await createIdToken(resolvedUser, clientId || rtData.clientId, null, issuer, signingKey, idTokenTtl, claimMappings);

  // Issue new refresh token
  const newRefreshToken = "idprt_" + randomBytes(32).toString("base64url");
  refreshTokens.set(newRefreshToken, {
    token: newRefreshToken,
    uid: resolvedUser.uid,
    clientId: clientId || rtData.clientId,
    scope: rtData.scope,
    created_at: Date.now(),
    expires_at: Date.now() + refreshTokenTtl * 1000,
  });

  return c.json({
    access_token: accessToken,
    id_token: idToken,
    token_type: "Bearer",
    expires_in: accessTokenTtl,
    scope: rtData.scope || "openid email profile",
    refresh_token: newRefreshToken,
  });
}
