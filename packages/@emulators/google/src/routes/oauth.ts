import { createHash, randomBytes } from "crypto";
import { SignJWT } from "jose";
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
  type Store,
} from "@emulators/core";
import { getGoogleStore } from "../store.js";
import type { GoogleUser } from "../entities.js";

const JWT_SECRET = new TextEncoder().encode("emulate-google-jwt-secret");

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

const PENDING_CODE_TTL_MS = 10 * 60 * 1000;

type RefreshTokenRecord = {
  email: string;
  scope: string;
  clientId: string;
};

function getPendingCodes(store: Store): Map<string, PendingCode> {
  let map = store.getData<Map<string, PendingCode>>("google.oauth.pendingCodes");
  if (!map) {
    map = new Map();
    store.setData("google.oauth.pendingCodes", map);
  }
  return map;
}

function getRefreshTokens(store: Store): Map<string, RefreshTokenRecord> {
  let map = store.getData<Map<string, RefreshTokenRecord>>("google.oauth.refreshTokens");
  if (!map) {
    map = new Map();
    store.setData("google.oauth.refreshTokens", map);
  }
  return map;
}

function isPendingCodeExpired(p: PendingCode): boolean {
  return Date.now() - p.created_at > PENDING_CODE_TTL_MS;
}

const SERVICE_LABEL = "Google";

async function createIdToken(
  user: GoogleUser,
  clientId: string,
  nonce: string | null,
  baseUrl: string
): Promise<string> {
  const builder = new SignJWT({
    sub: user.uid,
    email: user.email,
    email_verified: user.email_verified,
    name: user.name,
    given_name: user.given_name,
    family_name: user.family_name,
    picture: user.picture,
    locale: user.locale,
    ...(nonce ? { nonce } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(baseUrl)
    .setAudience(clientId)
    .setIssuedAt()
    .setExpirationTime("1h");

  return builder.sign(JWT_SECRET);
}

export function oauthRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const gs = getGoogleStore(store);

  // ---------- OIDC Discovery ----------

  app.get("/.well-known/openid-configuration", (c) => {
    return c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/o/oauth2/v2/auth`,
      token_endpoint: `${baseUrl}/oauth2/token`,
      userinfo_endpoint: `${baseUrl}/oauth2/v2/userinfo`,
      revocation_endpoint: `${baseUrl}/oauth2/revoke`,
      jwks_uri: `${baseUrl}/oauth2/v3/certs`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["HS256"],
      scopes_supported: ["openid", "email", "profile"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      claims_supported: [
        "sub", "email", "email_verified", "name",
        "given_name", "family_name", "picture", "locale",
      ],
      code_challenge_methods_supported: ["plain", "S256"],
    });
  });

  // ---------- JWKS (stub) ----------

  app.get("/oauth2/v3/certs", (c) => {
    return c.json({ keys: [] });
  });

  // ---------- Authorization page ----------

  app.get("/o/oauth2/v2/auth", (c) => {
    const client_id = c.req.query("client_id") ?? "";
    const redirect_uri = c.req.query("redirect_uri") ?? "";
    const scope = c.req.query("scope") ?? "";
    const state = c.req.query("state") ?? "";
    const nonce = c.req.query("nonce") ?? "";
    const code_challenge = c.req.query("code_challenge") ?? "";
    const code_challenge_method = c.req.query("code_challenge_method") ?? "";

    const clientsConfigured = gs.oauthClients.all().length > 0;
    let clientName = "";
    if (clientsConfigured) {
      const client = gs.oauthClients.findOneBy("client_id", client_id);
      if (!client) {
        return c.html(
          renderErrorPage("Application not found", `The client_id '${client_id}' is not registered.`, SERVICE_LABEL),
          400
        );
      }
      if (redirect_uri && !matchesRedirectUri(redirect_uri, client.redirect_uris)) {
        return c.html(
          renderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", SERVICE_LABEL),
          400
        );
      }
      clientName = client.name;
    }

    const subtitleText = clientName
      ? `Sign in to <strong>${escapeHtml(clientName)}</strong> with your Google account.`
      : "Choose a seeded user to continue.";

    const users = gs.users.all();
    const userButtons = users
      .map((user) => {
        return renderUserButton({
          letter: (user.email[0] ?? "?").toUpperCase(),
          login: user.email,
          name: user.name,
          email: user.email,
          formAction: "/o/oauth2/v2/auth/callback",
          hiddenFields: {
            email: user.email,
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

    return c.html(renderCardPage("Sign in to Google", subtitleText, body, SERVICE_LABEL));
  });

  // ---------- Authorization callback ----------

  app.post("/o/oauth2/v2/auth/callback", async (c) => {
    const body = await c.req.parseBody();
    const email = bodyStr(body.email);
    const redirect_uri = bodyStr(body.redirect_uri);
    const scope = bodyStr(body.scope);
    const state = bodyStr(body.state);
    const client_id = bodyStr(body.client_id);
    const nonce = bodyStr(body.nonce);
    const code_challenge = bodyStr(body.code_challenge);
    const code_challenge_method = bodyStr(body.code_challenge_method);

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

    debug("google.oauth", `[Google callback] code=${code.slice(0, 8)}... email=${email}`);

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);

    return c.redirect(url.toString(), 302);
  });

  // ---------- Token exchange ----------

  app.post("/oauth2/token", async (c) => {
    const contentType = c.req.header("Content-Type") ?? "";
    const rawText = await c.req.text();

    let body: Record<string, unknown>;
    if (contentType.includes("application/json")) {
      try { body = JSON.parse(rawText); } catch { body = {}; }
    } else {
      body = Object.fromEntries(new URLSearchParams(rawText));
    }

    const code = typeof body.code === "string" ? body.code : "";
    const redirect_uri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
    const grant_type = typeof body.grant_type === "string" ? body.grant_type : "";
    const code_verifier = typeof body.code_verifier === "string" ? body.code_verifier : undefined;
    const bodyClientId = typeof body.client_id === "string" ? body.client_id : "";
    const bodyClientSecret = typeof body.client_secret === "string" ? body.client_secret : "";

    const clientsConfigured = gs.oauthClients.all().length > 0;
    if (clientsConfigured) {
      const client = gs.oauthClients.findOneBy("client_id", bodyClientId);
      if (!client) {
        return c.json({ error: "invalid_client", error_description: "The client_id is incorrect." }, 401);
      }
      if (!constantTimeSecretEqual(bodyClientSecret, client.client_secret)) {
        return c.json({ error: "invalid_client", error_description: "The client_secret is incorrect." }, 401);
      }
    }

    if (grant_type === "refresh_token") {
      const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
      const record = getRefreshTokens(store).get(refreshToken);
      if (!record) {
        return c.json({ error: "invalid_grant", error_description: "The refresh token is invalid." }, 400);
      }
      if (clientsConfigured && record.clientId !== bodyClientId) {
        return c.json({ error: "invalid_grant", error_description: "The refresh token is invalid." }, 400);
      }

      const user = gs.users.findOneBy("email", record.email as GoogleUser["email"]);
      if (!user) {
        return c.json({ error: "invalid_grant", error_description: "User not found." }, 400);
      }

      const accessToken = "google_" + randomBytes(20).toString("base64url");
      const scopes = record.scope ? record.scope.split(/\s+/).filter(Boolean) : [];

      if (tokenMap) {
        tokenMap.set(accessToken, { login: user.email, id: user.id, scopes });
      }

      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: record.scope || "openid email profile",
      });
    }

    if (grant_type !== "authorization_code") {
      return c.json({ error: "unsupported_grant_type", error_description: "Only authorization_code and refresh_token are supported." }, 400);
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

    if (pending.codeChallenge != null) {
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

    pendingMap.delete(code);

    const user = gs.users.findOneBy("email", pending.email as GoogleUser["email"]);
    if (!user) {
      return c.json({ error: "invalid_grant", error_description: "User not found." }, 400);
    }

    const accessToken = "google_" + randomBytes(20).toString("base64url");
    const refreshToken = "google_refresh_" + randomBytes(24).toString("base64url");
    const scopes = pending.scope ? pending.scope.split(/\s+/).filter(Boolean) : [];

    if (tokenMap) {
      tokenMap.set(accessToken, { login: user.email, id: user.id, scopes });
    }
    getRefreshTokens(store).set(refreshToken, {
      email: user.email,
      scope: pending.scope,
      clientId: pending.clientId,
    });

    const idToken = await createIdToken(user, pending.clientId, pending.nonce, baseUrl);

    debug("google.oauth", `[Google token] issued token for ${user.email}`);

    return c.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: pending.scope || "openid email profile",
    });
  });

  // ---------- User info ----------

  app.get("/oauth2/v2/userinfo", (c) => {
    const authUser = c.get("authUser");
    if (!authUser) {
      return c.json({ error: "invalid_token", error_description: "Authentication required." }, 401);
    }

    const user = gs.users.findOneBy("email", authUser.login as GoogleUser["email"]);
    if (!user) {
      return c.json({ error: "invalid_token", error_description: "User not found." }, 401);
    }

    return c.json({
      sub: user.uid,
      email: user.email,
      email_verified: user.email_verified,
      name: user.name,
      given_name: user.given_name,
      family_name: user.family_name,
      picture: user.picture,
      locale: user.locale,
    });
  });

  // ---------- Token revocation ----------

  app.post("/oauth2/revoke", async (c) => {
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
    if (token) {
      getRefreshTokens(store).delete(token);
    }

    return c.body(null, 200);
  });
}
