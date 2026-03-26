import { randomBytes } from "crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { RouteContext } from "@emulators/core";
import {
  escapeHtml,
  escapeAttr,
  renderCardPage,
  renderErrorPage,
  renderUserButton,
  matchesRedirectUri,
  bodyStr,
  debug,
} from "@emulators/core";
import { getAppleStore } from "../store.js";
import type { AppleUser } from "../entities.js";
import type { Store } from "@emulators/core";

// RSA key pair generated at module load for signing id_tokens
const keyPairPromise = generateKeyPair("RS256");
const KID = "emulate-apple-1";

type PendingCode = {
  email: string;
  scope: string;
  redirectUri: string;
  clientId: string;
  nonce: string | null;
  responseMode: string;
  created_at: number;
};

type StoredRefreshToken = {
  email: string;
  clientId: string;
  scope: string;
  nonce: string | null;
};

const PENDING_CODE_TTL_MS = 5 * 60 * 1000;

function getPendingCodes(store: Store): Map<string, PendingCode> {
  let map = store.getData<Map<string, PendingCode>>("apple.oauth.pendingCodes");
  if (!map) {
    map = new Map();
    store.setData("apple.oauth.pendingCodes", map);
  }
  return map;
}

function getRefreshTokens(store: Store): Map<string, StoredRefreshToken> {
  let map = store.getData<Map<string, StoredRefreshToken>>("apple.oauth.refreshTokens");
  if (!map) {
    map = new Map();
    store.setData("apple.oauth.refreshTokens", map);
  }
  return map;
}

function getFirstAuthTracker(store: Store): Set<string> {
  let set = store.getData<Set<string>>("apple.oauth.firstAuthTracker");
  if (!set) {
    set = new Set();
    store.setData("apple.oauth.firstAuthTracker", set);
  }
  return set;
}

function isPendingCodeExpired(p: PendingCode): boolean {
  return Date.now() - p.created_at > PENDING_CODE_TTL_MS;
}

const SERVICE_LABEL = "Apple";

async function createIdToken(
  user: AppleUser,
  clientId: string,
  nonce: string | null,
  baseUrl: string,
): Promise<string> {
  const { privateKey } = await keyPairPromise;

  const email = user.is_private_email && user.private_relay_email
    ? user.private_relay_email
    : user.email;

  const now = Math.floor(Date.now() / 1000);

  const builder = new SignJWT({
    sub: user.uid,
    email,
    email_verified: String(user.email_verified),
    is_private_email: String(user.is_private_email),
    real_user_status: user.real_user_status,
    nonce_supported: true,
    auth_time: now,
    ...(nonce ? { nonce } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .setIssuer(baseUrl)
    .setAudience(clientId)
    .setIssuedAt(now)
    .setExpirationTime("1h");

  return builder.sign(privateKey);
}

export function oauthRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const as = getAppleStore(store);

  // ---------- OIDC Discovery ----------

  app.get("/.well-known/openid-configuration", (c) => {
    return c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/auth/authorize`,
      token_endpoint: `${baseUrl}/auth/token`,
      revocation_endpoint: `${baseUrl}/auth/revoke`,
      jwks_uri: `${baseUrl}/auth/keys`,
      response_types_supported: ["code"],
      response_modes_supported: ["query", "fragment", "form_post"],
      subject_types_supported: ["pairwise"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "email", "name"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      claims_supported: [
        "aud", "email", "email_verified", "exp", "iat",
        "is_private_email", "iss", "nonce", "nonce_supported",
        "real_user_status", "sub", "transfer_sub",
      ],
    });
  });

  // ---------- JWKS ----------

  app.get("/auth/keys", async (c) => {
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

  app.get("/auth/authorize", (c) => {
    const client_id = c.req.query("client_id") ?? "";
    const redirect_uri = c.req.query("redirect_uri") ?? "";
    const scope = c.req.query("scope") ?? "";
    const state = c.req.query("state") ?? "";
    const nonce = c.req.query("nonce") ?? "";
    const response_mode = c.req.query("response_mode") ?? "query";

    const clientsConfigured = as.oauthClients.all().length > 0;
    let clientName = "";
    if (clientsConfigured) {
      const client = as.oauthClients.findOneBy("client_id", client_id);
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
      ? `Sign in to <strong>${escapeHtml(clientName)}</strong> with your Apple ID.`
      : "Choose a seeded user to continue.";

    const users = as.users.all();
    const userButtons = users
      .map((user) => {
        return renderUserButton({
          letter: (user.email[0] ?? "?").toUpperCase(),
          login: user.email,
          name: user.name,
          email: user.email,
          formAction: "/auth/authorize/callback",
          hiddenFields: {
            email: user.email,
            redirect_uri,
            scope,
            state,
            nonce,
            client_id,
            response_mode,
          },
        });
      })
      .join("\n");

    const body = users.length === 0
      ? '<p class="empty">No users in the emulator store.</p>'
      : userButtons;

    return c.html(renderCardPage("Sign in with Apple", subtitleText, body, SERVICE_LABEL));
  });

  // ---------- Authorization callback ----------

  app.post("/auth/authorize/callback", async (c) => {
    const body = await c.req.parseBody();
    const email = bodyStr(body.email);
    const redirect_uri = bodyStr(body.redirect_uri);
    const scope = bodyStr(body.scope);
    const state = bodyStr(body.state);
    const client_id = bodyStr(body.client_id);
    const nonce = bodyStr(body.nonce);
    const response_mode = bodyStr(body.response_mode) || "query";

    const code = randomBytes(20).toString("hex");

    getPendingCodes(store).set(code, {
      email,
      scope,
      redirectUri: redirect_uri,
      clientId: client_id,
      nonce: nonce || null,
      responseMode: response_mode,
      created_at: Date.now(),
    });

    debug("apple.oauth", `[Apple callback] code=${code.slice(0, 8)}... email=${email}`);

    // Track first authorization per user+client pair
    const tracker = getFirstAuthTracker(store);
    const pairKey = `${email}:${client_id}`;
    const isFirstAuth = !tracker.has(pairKey);
    if (isFirstAuth) {
      tracker.add(pairKey);
    }

    // Build user JSON blob (only on first auth)
    let userJson: string | undefined;
    if (isFirstAuth) {
      const user = as.users.findOneBy("email", email as AppleUser["email"]);
      if (user) {
        userJson = JSON.stringify({
          name: { firstName: user.given_name, lastName: user.family_name },
          email: user.email,
        });
      }
    }

    if (response_mode === "form_post") {
      // Return auto-submit form that POSTs to redirect_uri
      const html = `<!DOCTYPE html>
<html>
<head><title>Submit</title></head>
<body onload="document.forms[0].submit()">
<form method="POST" action="${escapeAttr(redirect_uri)}">
<input type="hidden" name="code" value="${escapeAttr(code)}" />
<input type="hidden" name="state" value="${escapeAttr(state)}" />${userJson ? `\n<input type="hidden" name="user" value="${escapeAttr(userJson)}" />` : ""}
</form>
</body>
</html>`;
      return c.html(html);
    }

    // Default: query mode redirect
    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    if (userJson) url.searchParams.set("user", userJson);

    return c.redirect(url.toString(), 302);
  });

  // ---------- Token exchange ----------

  app.post("/auth/token", async (c) => {
    const rawText = await c.req.text();
    const body = Object.fromEntries(new URLSearchParams(rawText));

    const grant_type = body.grant_type ?? "";
    const code = body.code ?? "";
    const client_id = body.client_id ?? "";
    const refresh_token = body.refresh_token ?? "";

    if (grant_type === "authorization_code") {
      const pendingMap = getPendingCodes(store);
      const pending = pendingMap.get(code);
      if (!pending) {
        return c.json({ error: "invalid_grant", error_description: "The code is incorrect or expired." }, 400);
      }
      if (isPendingCodeExpired(pending)) {
        pendingMap.delete(code);
        return c.json({ error: "invalid_grant", error_description: "The code is incorrect or expired." }, 400);
      }

      // Single-use: delete immediately
      pendingMap.delete(code);

      const user = as.users.findOneBy("email", pending.email as AppleUser["email"]);
      if (!user) {
        return c.json({ error: "invalid_grant", error_description: "User not found." }, 400);
      }

      const accessToken = "apple_" + randomBytes(20).toString("base64url");
      const refreshToken = "r_apple_" + randomBytes(20).toString("base64url");
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

      debug("apple.oauth", `[Apple token] issued token for ${user.email}`);

      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
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

      const user = as.users.findOneBy("email", stored.email as AppleUser["email"]);
      if (!user) {
        return c.json({ error: "invalid_grant", error_description: "User not found." }, 400);
      }

      const accessToken = "apple_" + randomBytes(20).toString("base64url");
      const scopes = stored.scope ? stored.scope.split(/\s+/).filter(Boolean) : [];

      if (tokenMap) {
        tokenMap.set(accessToken, { login: user.email, id: user.id, scopes });
      }

      const idToken = await createIdToken(user, stored.clientId || client_id, stored.nonce, baseUrl);

      debug("apple.oauth", `[Apple refresh] issued new token for ${user.email}`);

      // No new refresh_token for refresh grant
      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        id_token: idToken,
      });
    }

    return c.json({ error: "unsupported_grant_type", error_description: "Only authorization_code and refresh_token are supported." }, 400);
  });

  // ---------- Token revocation ----------

  app.post("/auth/revoke", async (c) => {
    const rawText = await c.req.text();
    const params = new URLSearchParams(rawText);
    const token = params.get("token") ?? "";

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
