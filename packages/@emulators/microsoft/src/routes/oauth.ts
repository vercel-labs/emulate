import { createHash, randomBytes } from "crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { RouteContext } from "@emulators/core";
import {
  escapeHtml,
  escapeAttr,
  renderCardPage,
  renderErrorPage,
  renderUserButton,
  matchesRedirectUri,
  constantTimeSecretEqual,
  bodyStr,
  debug,
} from "@emulators/core";
import { getMicrosoftStore } from "../store.js";
import { DEFAULT_TENANT_ID } from "../helpers.js";
import type { MicrosoftUser } from "../entities.js";
import type { Store } from "@emulators/core";

// RSA key pair generated at module load for signing id_tokens
const keyPairPromise = generateKeyPair("RS256");
const KID = "emulate-microsoft-1";

type PendingCode = {
  email: string;
  scope: string;
  redirectUri: string;
  clientId: string;
  nonce: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  created_at: number;
};

type StoredRefreshToken = {
  email: string;
  clientId: string;
  scope: string;
  nonce: string | null;
};

const PENDING_CODE_TTL_MS = 10 * 60 * 1000;

function getPendingCodes(store: Store): Map<string, PendingCode> {
  let map = store.getData<Map<string, PendingCode>>("microsoft.oauth.pendingCodes");
  if (!map) {
    map = new Map();
    store.setData("microsoft.oauth.pendingCodes", map);
  }
  return map;
}

function getRefreshTokens(store: Store): Map<string, StoredRefreshToken> {
  let map = store.getData<Map<string, StoredRefreshToken>>("microsoft.oauth.refreshTokens");
  if (!map) {
    map = new Map();
    store.setData("microsoft.oauth.refreshTokens", map);
  }
  return map;
}

function isPendingCodeExpired(p: PendingCode): boolean {
  return Date.now() - p.created_at > PENDING_CODE_TTL_MS;
}

const SERVICE_LABEL = "Microsoft";

async function createIdToken(
  user: MicrosoftUser,
  clientId: string,
  nonce: string | null,
  baseUrl: string,
): Promise<string> {
  const { privateKey } = await keyPairPromise;
  const now = Math.floor(Date.now() / 1000);

  const builder = new SignJWT({
    sub: user.oid,
    email: user.email,
    name: user.name,
    given_name: user.given_name,
    family_name: user.family_name,
    preferred_username: user.preferred_username,
    oid: user.oid,
    tid: user.tenant_id,
    ver: "2.0",
    ...(nonce ? { nonce } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .setIssuer(`${baseUrl}/${user.tenant_id}/v2.0`)
    .setAudience(clientId)
    .setIssuedAt(now)
    .setExpirationTime("1h");

  return builder.sign(privateKey);
}

export function oauthRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const ms = getMicrosoftStore(store);

  // ---------- OpenID Configuration ----------
  // Microsoft uses /{tenant}/v2.0/.well-known/openid-configuration
  // We also serve at /.well-known/openid-configuration for convenience.

  const oidcConfig = (tenantId: string) => ({
    issuer: `${baseUrl}/${tenantId}/v2.0`,
    authorization_endpoint: `${baseUrl}/oauth2/v2.0/authorize`,
    token_endpoint: `${baseUrl}/oauth2/v2.0/token`,
    userinfo_endpoint: `${baseUrl}/oidc/userinfo`,
    end_session_endpoint: `${baseUrl}/oauth2/v2.0/logout`,
    jwks_uri: `${baseUrl}/discovery/v2.0/keys`,
    response_types_supported: ["code"],
    response_modes_supported: ["query", "fragment", "form_post"],
    subject_types_supported: ["pairwise"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "email", "profile", "offline_access", "User.Read", ".default"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    claims_supported: [
      "sub", "iss", "aud", "exp", "iat", "nonce",
      "name", "email", "given_name", "family_name",
      "preferred_username", "oid", "tid", "ver",
    ],
    code_challenge_methods_supported: ["plain", "S256"],
  });

  app.get("/.well-known/openid-configuration", (c) => {
    return c.json(oidcConfig(DEFAULT_TENANT_ID));
  });

  app.get("/:tenant/v2.0/.well-known/openid-configuration", (c) => {
    const tenant = c.req.param("tenant");
    return c.json(oidcConfig(tenant === "common" || tenant === "organizations" || tenant === "consumers" ? DEFAULT_TENANT_ID : tenant));
  });

  // ---------- JWKS ----------

  app.get("/discovery/v2.0/keys", async (c) => {
    const { publicKey } = await keyPairPromise;
    const jwk = await exportJWK(publicKey);
    return c.json({
      keys: [{
        ...jwk,
        kid: KID,
        use: "sig",
        alg: "RS256",
      }],
    });
  });

  // ---------- Authorization page ----------

  app.get("/oauth2/v2.0/authorize", (c) => {
    const client_id = c.req.query("client_id") ?? "";
    const redirect_uri = c.req.query("redirect_uri") ?? "";
    const scope = c.req.query("scope") ?? "";
    const state = c.req.query("state") ?? "";
    const nonce = c.req.query("nonce") ?? "";
    const response_mode = c.req.query("response_mode") ?? "query";
    const code_challenge = c.req.query("code_challenge") ?? "";
    const code_challenge_method = c.req.query("code_challenge_method") ?? "";

    const clientsConfigured = ms.oauthClients.all().length > 0;
    let clientName = "";
    if (clientsConfigured) {
      const client = ms.oauthClients.findOneBy("client_id", client_id);
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
      ? `Sign in to <strong>${escapeHtml(clientName)}</strong> with your Microsoft account.`
      : "Choose a seeded user to continue.";

    const users = ms.users.all();
    const userButtons = users
      .map((user) => {
        return renderUserButton({
          letter: (user.email[0] ?? "?").toUpperCase(),
          login: user.email,
          name: user.name,
          email: user.email,
          formAction: "/oauth2/v2.0/authorize/callback",
          hiddenFields: {
            email: user.email,
            redirect_uri,
            scope,
            state,
            nonce,
            client_id,
            response_mode,
            code_challenge,
            code_challenge_method,
          },
        });
      })
      .join("\n");

    const body = users.length === 0
      ? '<p class="empty">No users in the emulator store.</p>'
      : userButtons;

    return c.html(renderCardPage("Sign in with Microsoft", subtitleText, body, SERVICE_LABEL));
  });

  // ---------- Authorization callback ----------

  app.post("/oauth2/v2.0/authorize/callback", async (c) => {
    const body = await c.req.parseBody();
    const email = bodyStr(body.email);
    const redirect_uri = bodyStr(body.redirect_uri);
    const scope = bodyStr(body.scope);
    const state = bodyStr(body.state);
    const client_id = bodyStr(body.client_id);
    const nonce = bodyStr(body.nonce);
    const response_mode = bodyStr(body.response_mode) || "query";
    const code_challenge = bodyStr(body.code_challenge);
    const code_challenge_method = bodyStr(body.code_challenge_method);

    // Validate redirect_uri against registered client
    const clientsConfigured = ms.oauthClients.all().length > 0;
    if (clientsConfigured) {
      const client = ms.oauthClients.findOneBy("client_id", client_id);
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
    }

    const code = randomBytes(20).toString("hex");

    getPendingCodes(store).set(code, {
      email,
      scope,
      redirectUri: redirect_uri,
      clientId: client_id,
      nonce: nonce || null,
      codeChallenge: code_challenge || null,
      codeChallengeMethod: code_challenge_method || null,
      created_at: Date.now(),
    });

    debug("microsoft.oauth", `[Microsoft callback] code=${code.slice(0, 8)}... email=${email}`);

    if (response_mode === "form_post") {
      const html = `<!DOCTYPE html>
<html>
<head><title>Submit</title></head>
<body onload="document.forms[0].submit()">
<form method="POST" action="${escapeAttr(redirect_uri)}">
<input type="hidden" name="code" value="${escapeAttr(code)}" />
<input type="hidden" name="state" value="${escapeAttr(state)}" />
</form>
</body>
</html>`;
      return c.html(html);
    }

    // Default: query mode redirect
    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);

    return c.redirect(url.toString(), 302);
  });

  // ---------- Token exchange ----------

  app.post("/oauth2/v2.0/token", async (c) => {
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
    let client_id = typeof body.client_id === "string" ? body.client_id : "";
    let client_secret = typeof body.client_secret === "string" ? body.client_secret : "";
    const refresh_token = typeof body.refresh_token === "string" ? body.refresh_token : "";
    const redirect_uri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
    const code_verifier = typeof body.code_verifier === "string" ? body.code_verifier : undefined;
    const scope = typeof body.scope === "string" ? body.scope : "";

    // Support client_secret_basic: credentials in Authorization header
    const authHeader = c.req.header("Authorization") ?? "";
    if (authHeader.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
      const sep = decoded.indexOf(":");
      if (sep !== -1) {
        const headerId = decodeURIComponent(decoded.slice(0, sep));
        const headerSecret = decodeURIComponent(decoded.slice(sep + 1));
        if (!client_id) client_id = headerId;
        if (!client_secret) client_secret = headerSecret;
      }
    }

    if (grant_type === "authorization_code") {
      const clientsConfigured = ms.oauthClients.all().length > 0;
      if (clientsConfigured) {
        const client = ms.oauthClients.findOneBy("client_id", client_id);
        if (!client) {
          return c.json({ error: "invalid_client", error_description: "The client_id is incorrect." }, 401);
        }
        if (!constantTimeSecretEqual(client_secret, client.client_secret)) {
          return c.json({ error: "invalid_client", error_description: "The client_secret is incorrect." }, 401);
        }
      }

      const pendingMap = getPendingCodes(store);
      const pending = pendingMap.get(code);
      if (!pending) {
        return c.json({ error: "invalid_grant", error_description: "The code is incorrect or expired." }, 400);
      }
      if (isPendingCodeExpired(pending)) {
        pendingMap.delete(code);
        return c.json({ error: "invalid_grant", error_description: "The code is incorrect or expired." }, 400);
      }

      // Verify redirect_uri matches the one used in the authorization request (RFC 6749 §4.1.3)
      if (pending.redirectUri && redirect_uri && pending.redirectUri !== redirect_uri) {
        pendingMap.delete(code);
        return c.json({ error: "invalid_grant", error_description: "The redirect_uri does not match the one used in the authorization request." }, 400);
      }

      // PKCE verification
      if (pending.codeChallenge !== null) {
        if (code_verifier === undefined) {
          return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
        }
        const method = (pending.codeChallengeMethod ?? "plain").toLowerCase();
        if (method === "s256") {
          const expected = createHash("sha256").update(code_verifier).digest("base64url");
          if (expected !== pending.codeChallenge) {
            return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
          }
        } else if (method === "plain") {
          if (code_verifier !== pending.codeChallenge) {
            return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
          }
        } else {
          return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
        }
      }

      // Single-use: delete immediately
      pendingMap.delete(code);

      const user = ms.users.findOneBy("email", pending.email as MicrosoftUser["email"]);
      if (!user) {
        return c.json({ error: "invalid_grant", error_description: "User not found." }, 400);
      }

      const accessToken = "microsoft_" + randomBytes(20).toString("base64url");
      const refreshToken = "r_microsoft_" + randomBytes(20).toString("base64url");
      const scopes = pending.scope ? pending.scope.split(/\s+/).filter(Boolean) : [];

      if (tokenMap) {
        tokenMap.set(accessToken, { login: user.email, id: user.id, scopes });
      }

      // Store refresh token
      getRefreshTokens(store).set(refreshToken, {
        email: user.email,
        clientId: pending.clientId,
        scope: pending.scope,
        nonce: pending.nonce,
      });

      const idToken = await createIdToken(user, pending.clientId, pending.nonce, baseUrl);

      debug("microsoft.oauth", `[Microsoft token] issued token for ${user.email}`);

      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: pending.scope || "openid email profile",
        refresh_token: refreshToken,
        id_token: idToken,
      });
    }

    if (grant_type === "refresh_token") {
      const refreshMap = getRefreshTokens(store);
      const stored = refreshMap.get(refresh_token);
      if (!stored) {
        return c.json({ error: "invalid_grant", error_description: "The refresh_token is invalid." }, 400);
      }

      const user = ms.users.findOneBy("email", stored.email as MicrosoftUser["email"]);
      if (!user) {
        return c.json({ error: "invalid_grant", error_description: "User not found." }, 400);
      }

      const accessToken = "microsoft_" + randomBytes(20).toString("base64url");
      const newRefreshToken = "r_microsoft_" + randomBytes(20).toString("base64url");
      const scopes = stored.scope ? stored.scope.split(/\s+/).filter(Boolean) : [];

      if (tokenMap) {
        tokenMap.set(accessToken, { login: user.email, id: user.id, scopes });
      }

      // Rotate refresh token
      refreshMap.delete(refresh_token);
      refreshMap.set(newRefreshToken, {
        email: stored.email,
        clientId: stored.clientId,
        scope: stored.scope,
        nonce: stored.nonce,
      });

      const idToken = await createIdToken(user, stored.clientId || client_id, stored.nonce, baseUrl);

      debug("microsoft.oauth", `[Microsoft refresh] issued new token for ${user.email}`);

      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: stored.scope || "openid email profile",
        refresh_token: newRefreshToken,
        id_token: idToken,
      });
    }

    if (grant_type === "client_credentials") {
      const clientsConfigured = ms.oauthClients.all().length > 0;
      if (clientsConfigured) {
        const client = ms.oauthClients.findOneBy("client_id", client_id);
        if (!client) {
          return c.json({ error: "invalid_client", error_description: "The client_id is incorrect." }, 401);
        }
        if (!constantTimeSecretEqual(client_secret, client.client_secret)) {
          return c.json({ error: "invalid_client", error_description: "The client_secret is incorrect." }, 401);
        }
      }

      const accessToken = "microsoft_" + randomBytes(20).toString("base64url");
      const scopes = scope ? scope.split(/\s+/).filter(Boolean) : [".default"];

      if (tokenMap) {
        tokenMap.set(accessToken, { login: client_id, id: 0, scopes });
      }

      debug("microsoft.oauth", `[Microsoft client_credentials] issued token for ${client_id}`);

      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: scope || ".default",
      });
    }

    return c.json({ error: "unsupported_grant_type", error_description: "Only authorization_code, refresh_token, and client_credentials are supported." }, 400);
  });

  // ---------- UserInfo (Microsoft Graph /oidc/userinfo) ----------

  app.get("/oidc/userinfo", (c) => {
    const authUser = c.get("authUser");
    if (!authUser) {
      return c.json({ error: "invalid_token", error_description: "Authentication required." }, 401);
    }

    const user = ms.users.findOneBy("email", authUser.login as MicrosoftUser["email"]);
    if (!user) {
      return c.json({ error: "invalid_token", error_description: "User not found." }, 401);
    }

    return c.json({
      sub: user.oid,
      email: user.email,
      name: user.name,
      given_name: user.given_name,
      family_name: user.family_name,
      preferred_username: user.preferred_username,
    });
  });

  // ---------- Microsoft Graph /me endpoint ----------

  app.get("/v1.0/me", (c) => {
    const authUser = c.get("authUser");
    if (!authUser) {
      return c.json({ error: { code: "InvalidAuthenticationToken", message: "Authentication required." } }, 401);
    }

    const user = ms.users.findOneBy("email", authUser.login as MicrosoftUser["email"]);
    if (!user) {
      return c.json({ error: { code: "Request_ResourceNotFound", message: "User not found." } }, 404);
    }

    return c.json({
      "@odata.context": `${baseUrl}/v1.0/$metadata#users/$entity`,
      id: user.oid,
      displayName: user.name,
      givenName: user.given_name,
      surname: user.family_name,
      mail: user.email,
      userPrincipalName: user.preferred_username,
    });
  });

  // ---------- Logout ----------

  app.get("/oauth2/v2.0/logout", (c) => {
    const post_logout_redirect_uri = c.req.query("post_logout_redirect_uri");
    if (post_logout_redirect_uri) {
      // Validate against registered client redirect URIs
      const allClients = ms.oauthClients.all();
      if (allClients.length > 0) {
        const allowed = allClients.some((client) =>
          matchesRedirectUri(post_logout_redirect_uri, client.redirect_uris),
        );
        if (!allowed) {
          return c.text("Invalid post_logout_redirect_uri", 400);
        }
      }
      return c.redirect(post_logout_redirect_uri, 302);
    }
    return c.text("Logged out", 200);
  });

  // ---------- Token revocation ----------

  app.post("/oauth2/v2.0/revoke", async (c) => {
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

    if (token && tokenMap) {
      tokenMap.delete(token);
    }

    // Also check refresh tokens
    if (token) {
      getRefreshTokens(store).delete(token);
    }

    return c.body(null, 200);
  });
}
