import { createHash, randomBytes } from "crypto";
import type { RouteContext } from "@emulators/core";
import {
  renderCardPage,
  renderErrorPage,
  renderUserButton,
  matchesRedirectUri,
  escapeHtml,
  bodyStr,
  debug,
  type Store,
} from "@emulators/core";
import { getHeyGenStore } from "../store.js";

type PendingCode = {
  email: string;
  redirectUri: string;
  clientId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  created_at: number;
};

const PENDING_CODE_TTL_MS = 10 * 60 * 1000;
const TOKEN_EXPIRES_IN = 864_000;

type RefreshTokenRecord = {
  email: string;
  clientId: string;
};

function getPendingCodes(store: Store): Map<string, PendingCode> {
  let map = store.getData<Map<string, PendingCode>>("heygen.oauth.pendingCodes");
  if (!map) {
    map = new Map();
    store.setData("heygen.oauth.pendingCodes", map);
  }
  return map;
}

function getRefreshTokens(store: Store): Map<string, RefreshTokenRecord> {
  let map = store.getData<Map<string, RefreshTokenRecord>>("heygen.oauth.refreshTokens");
  if (!map) {
    map = new Map();
    store.setData("heygen.oauth.refreshTokens", map);
  }
  return map;
}

function isPendingCodeExpired(p: PendingCode): boolean {
  return Date.now() - p.created_at > PENDING_CODE_TTL_MS;
}

function parseBody(rawText: string, contentType: string): Record<string, unknown> {
  if (contentType.includes("application/json")) {
    try { return JSON.parse(rawText); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(rawText));
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

const SERVICE_LABEL = "HeyGen";

export function oauthRoutes({ app, store, tokenMap }: RouteContext): void {
  const hs = getHeyGenStore(store);

  app.get("/oauth/authorize", (c) => {
    const client_id = c.req.query("client_id") ?? "";
    const redirect_uri = c.req.query("redirect_uri") ?? "";
    const state = c.req.query("state") ?? "";
    const code_challenge = c.req.query("code_challenge") ?? "";
    const code_challenge_method = c.req.query("code_challenge_method") ?? "";

    const clientsConfigured = hs.oauthClients.all().length > 0;
    let clientName = "";
    if (clientsConfigured) {
      const client = hs.oauthClients.findOneBy("client_id", client_id);
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
      ? `Sign in to <strong>${escapeHtml(clientName)}</strong> with your HeyGen account.`
      : "Choose a seeded user to continue.";

    const users = hs.users.all();
    const userButtons = users
      .map((user) =>
        renderUserButton({
          letter: (user.email[0] ?? "?").toUpperCase(),
          login: user.email,
          name: user.name,
          email: user.email,
          formAction: "/oauth/authorize/callback",
          hiddenFields: {
            email: user.email,
            redirect_uri,
            state,
            client_id,
            code_challenge,
            code_challenge_method,
          },
        }),
      )
      .join("\n");

    const body =
      users.length === 0
        ? '<p class="empty">No users in the emulator store.</p>'
        : userButtons;

    return c.html(renderCardPage("Sign in to HeyGen", subtitleText, body, SERVICE_LABEL));
  });

  app.post("/oauth/authorize/callback", async (c) => {
    const formBody = await c.req.parseBody();
    const email = bodyStr(formBody.email);
    const redirect_uri = bodyStr(formBody.redirect_uri);
    const state = bodyStr(formBody.state);
    const client_id = bodyStr(formBody.client_id);
    const code_challenge = bodyStr(formBody.code_challenge);
    const code_challenge_method = bodyStr(formBody.code_challenge_method);

    const code = randomBytes(20).toString("hex");

    getPendingCodes(store).set(code, {
      email,
      redirectUri: redirect_uri,
      clientId: client_id,
      codeChallenge: code_challenge || "",
      codeChallengeMethod: code_challenge_method || "",
      created_at: Date.now(),
    });

    debug("heygen.oauth", `[HeyGen callback] code=${code.slice(0, 8)}... email=${email}`);

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);

    return c.redirect(url.toString(), 302);
  });

  app.post("/v1/oauth/token", async (c) => {
    const rawText = await c.req.text();
    const body = parseBody(rawText, c.req.header("Content-Type") ?? "");

    const code = str(body.code);
    const grant_type = str(body.grant_type);
    const code_verifier = str(body.code_verifier) || undefined;
    const redirect_uri = str(body.redirect_uri);
    const bodyClientId = str(body.client_id);

    if (grant_type !== "authorization_code") {
      return c.json({ error: "unsupported_grant_type", error_description: "Only authorization_code is supported on this endpoint." }, 400);
    }

    const clientsConfigured = hs.oauthClients.all().length > 0;
    if (clientsConfigured) {
      const client = hs.oauthClients.findOneBy("client_id", bodyClientId);
      if (!client) {
        return c.json({ error: "invalid_client", error_description: "The client_id is incorrect." }, 401);
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

    if (pending.redirectUri && redirect_uri && pending.redirectUri !== redirect_uri) {
      pendingMap.delete(code);
      return c.json({ error: "invalid_grant", error_description: "The redirect_uri does not match." }, 400);
    }

    if (pending.codeChallenge) {
      if (!code_verifier) {
        return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
      }
      const method = (pending.codeChallengeMethod || "S256").toUpperCase();
      if (method === "S256") {
        const expected = createHash("sha256").update(code_verifier).digest("base64url");
        if (expected !== pending.codeChallenge) {
          return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
        }
      } else if (method === "PLAIN") {
        if (code_verifier !== pending.codeChallenge) {
          return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
        }
      } else {
        return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
      }
    }

    pendingMap.delete(code);

    const user = hs.users.findOneBy("email", pending.email);
    if (!user) {
      return c.json({ error: "invalid_grant", error_description: "User not found." }, 400);
    }

    const accessToken = "heygen_" + randomBytes(20).toString("base64url");
    const refreshToken = "heygen_refresh_" + randomBytes(24).toString("base64url");

    if (tokenMap) {
      tokenMap.set(accessToken, { login: user.email, id: user.id, scopes: [] });
    }
    getRefreshTokens(store).set(refreshToken, {
      email: user.email,
      clientId: pending.clientId,
    });

    debug("heygen.oauth", `[HeyGen token] issued token for ${user.email}`);

    return c.json({
      token_type: "Bearer",
      access_token: accessToken,
      expires_in: TOKEN_EXPIRES_IN,
      refresh_token: refreshToken,
    });
  });

  app.post("/v1/oauth/refresh_token", async (c) => {
    const rawText = await c.req.text();
    const body = parseBody(rawText, c.req.header("Content-Type") ?? "");

    const grant_type = str(body.grant_type);
    const refreshToken = str(body.refresh_token);

    if (grant_type !== "refresh_token") {
      return c.json({ error: "unsupported_grant_type", error_description: "Only refresh_token is supported on this endpoint." }, 400);
    }

    const record = getRefreshTokens(store).get(refreshToken);
    if (!record) {
      return c.json({ error: "invalid_grant", error_description: "The refresh token is invalid." }, 400);
    }

    const user = hs.users.findOneBy("email", record.email);
    if (!user) {
      return c.json({ error: "invalid_grant", error_description: "User not found." }, 400);
    }

    const newAccessToken = "heygen_" + randomBytes(20).toString("base64url");
    const newRefreshToken = "heygen_refresh_" + randomBytes(24).toString("base64url");

    getRefreshTokens(store).delete(refreshToken);
    getRefreshTokens(store).set(newRefreshToken, {
      email: user.email,
      clientId: record.clientId,
    });

    if (tokenMap) {
      tokenMap.set(newAccessToken, { login: user.email, id: user.id, scopes: [] });
    }

    return c.json({
      token_type: "Bearer",
      access_token: newAccessToken,
      expires_in: TOKEN_EXPIRES_IN,
      refresh_token: newRefreshToken,
    });
  });

  app.get("/v1/user/me", (c) => {
    const authUser = c.get("authUser");
    if (!authUser) {
      return c.json({ error: "invalid_token", error_description: "Authentication required." }, 401);
    }

    const user = hs.users.findOneBy("email", authUser.login);
    if (!user) {
      return c.json({ error: "invalid_token", error_description: "User not found." }, 401);
    }

    return c.json({
      code: 100,
      data: {
        user: {
          user_id: user.user_id,
          email: user.email,
          username: user.name,
          email_verified: true,
        },
      },
      message: "Success",
    });
  });
}
