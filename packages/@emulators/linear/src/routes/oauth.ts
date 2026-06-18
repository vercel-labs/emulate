import { createHash } from "node:crypto";
import type { RouteContext, Store } from "@emulators/core";
import {
  bodyStr,
  constantTimeSecretEqual,
  escapeHtml,
  matchesRedirectUri,
  renderCardPage,
  renderErrorPage,
  renderUserButton,
} from "@emulators/core";
import { getLinearStore } from "../store.js";
import { token } from "../ids.js";
import { normalizeScopes } from "../index.js";
import type { LinearOAuthApp, LinearTokenActorType } from "../entities.js";

const SERVICE_LABEL = "Linear";
const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 3600;

interface PendingCode {
  appId: string | null;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  userId: string | null;
  actor: LinearTokenActorType;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  createdAt: number;
}

function pendingCodes(store: Store): Map<string, PendingCode> {
  let map = store.getData<Map<string, PendingCode>>("linear.oauth.pending_codes");
  if (!map) {
    map = new Map();
    store.setData("linear.oauth.pending_codes", map);
  }
  return map;
}

export function oauthRoutes({ app, store, tokenMap }: RouteContext): void {
  const ls = () => getLinearStore(store);

  app.get("/oauth/authorize", (c) => {
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const responseType = c.req.query("response_type") ?? "code";
    const state = c.req.query("state") ?? "";
    const scope = c.req.query("scope") ?? "read";
    const actor = normalizeActor(c.req.query("actor")) ?? "user";
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

    const oauthApp = resolveOAuthApp(clientId);
    if (ls().oauthApps.all().length > 0) {
      if (!oauthApp) {
        return c.html(
          renderErrorPage("Application not found", `The client_id '${clientId}' is not registered.`, SERVICE_LABEL),
          400,
        );
      }
      if (!matchesRedirectUri(redirectUri, oauthApp.redirect_uris)) {
        return c.html(
          renderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this app.", SERVICE_LABEL),
          400,
        );
      }
    }

    const requestedScopes = normalizeScopes(scope, oauthApp?.scopes ?? ["read"]);
    const title = actor === "app" ? "Install Linear App" : "Authorize Linear App";
    const appName = oauthApp?.name ?? "Linear App";

    const buttons =
      actor === "app"
        ? renderUserButton({
            letter: "L",
            login: appName,
            name: `Install ${appName}`,
            email: requestedScopes.join(", "),
            formAction: "/oauth/authorize/callback",
            hiddenFields: {
              user_ref: oauthApp?.app_user_id ?? "",
              actor,
              redirect_uri: redirectUri,
              scope: requestedScopes.join(" "),
              state,
              client_id: clientId,
              code_challenge: codeChallenge,
              code_challenge_method: codeChallengeMethod,
            },
          })
        : ls()
            .users.all()
            .filter((user) => !user.app && user.active)
            .map((user) =>
              renderUserButton({
                letter: (user.display_name[0] ?? "U").toUpperCase(),
                login: user.email,
                name: user.display_name,
                email: user.email,
                formAction: "/oauth/authorize/callback",
                hiddenFields: {
                  user_ref: user.linear_id,
                  actor,
                  redirect_uri: redirectUri,
                  scope: requestedScopes.join(" "),
                  state,
                  client_id: clientId,
                  code_challenge: codeChallenge,
                  code_challenge_method: codeChallengeMethod,
                },
              }),
            )
            .join("\n");

    return c.html(
      renderCardPage(
        title,
        `Continue to <strong>${escapeHtml(appName)}</strong> with scopes <strong>${escapeHtml(requestedScopes.join(", "))}</strong>.`,
        buttons || '<p class="empty">No users in the Linear emulator store.</p>',
        SERVICE_LABEL,
      ),
    );
  });

  app.post("/oauth/authorize/callback", async (c) => {
    const body = await c.req.parseBody();
    const clientId = bodyStr(body.client_id);
    const redirectUri = bodyStr(body.redirect_uri);
    const state = bodyStr(body.state);
    const scopes = normalizeScopes(bodyStr(body.scope), ["read"]);
    const actor = normalizeActor(bodyStr(body.actor)) ?? "user";
    const userRef = bodyStr(body.user_ref);
    const codeChallenge = bodyStr(body.code_challenge);
    const codeChallengeMethod = bodyStr(body.code_challenge_method);

    const oauthApp = resolveOAuthApp(clientId);
    if (ls().oauthApps.all().length > 0) {
      if (!oauthApp) {
        return c.html(renderErrorPage("Application not found", "The OAuth app is not registered.", SERVICE_LABEL), 400);
      }
      if (!matchesRedirectUri(redirectUri, oauthApp.redirect_uris)) {
        return c.html(
          renderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this app.", SERVICE_LABEL),
          400,
        );
      }
    }

    const user =
      userRef && actor === "app"
        ? ls().users.findOneBy("linear_id", userRef)
        : (ls().users.findOneBy("linear_id", userRef) ??
          ls()
            .users.all()
            .find((u) => !u.app));
    const appUser =
      actor === "app" ? (oauthApp?.app_user_id ? ls().users.findOneBy("linear_id", oauthApp.app_user_id) : user) : user;
    if (!appUser) {
      return c.html(
        renderErrorPage("No Linear actor", "No matching user or app actor is available.", SERVICE_LABEL),
        400,
      );
    }

    const code = token("lin_code");
    pendingCodes(store).set(code, {
      appId: oauthApp?.linear_id ?? null,
      clientId,
      redirectUri,
      scopes,
      userId: appUser.linear_id,
      actor,
      codeChallenge: codeChallenge || null,
      codeChallengeMethod: codeChallengeMethod || null,
      createdAt: Date.now(),
    });

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    return c.redirect(url.toString());
  });

  app.post("/oauth/token", async (c) => {
    const body = await c.req.parseBody();
    const grantType = bodyStr(body.grant_type);
    const clientAuth = clientCredentials(c.req.header("Authorization"), body);
    const oauthApp = resolveOAuthApp(clientAuth.clientId);

    if (ls().oauthApps.all().length > 0) {
      if (!oauthApp) return oauthError("invalid_client", "The OAuth app is not registered.");
      if (!constantTimeSecretEqual(clientAuth.clientSecret, oauthApp.client_secret)) {
        return oauthError("invalid_client", "Invalid client credentials.");
      }
    }

    if (grantType === "authorization_code") {
      const code = bodyStr(body.code);
      const pending = pendingCodes(store).get(code);
      if (!pending) return oauthError("invalid_grant", "Authorization code is invalid.");
      if (Date.now() - pending.createdAt > CODE_TTL_MS) {
        pendingCodes(store).delete(code);
        return oauthError("invalid_grant", "Authorization code has expired.");
      }
      if (pending.redirectUri !== bodyStr(body.redirect_uri)) {
        return oauthError("invalid_grant", "redirect_uri does not match the authorization request.");
      }
      if (pending.clientId !== clientAuth.clientId) {
        return oauthError("invalid_grant", "client_id does not match the authorization request.");
      }
      if (!verifyPkce(pending, bodyStr(body.code_verifier))) {
        return oauthError("invalid_grant", "PKCE verification failed.");
      }
      pendingCodes(store).delete(code);
      return c.json(issueTokens(pending.userId, pending.appId, pending.actor, pending.scopes));
    }

    if (grantType === "refresh_token") {
      const refreshToken = bodyStr(body.refresh_token);
      const existing = ls().tokens.findOneBy("token", refreshToken);
      if (!existing || existing.type !== "oauth_refresh" || existing.revoked) {
        return oauthError("invalid_grant", "Refresh token is invalid.");
      }
      ls().tokens.update(existing.id, { revoked: true });
      return c.json(issueTokens(existing.user_id, existing.app_id, existing.actor_type, existing.scopes));
    }

    if (grantType === "client_credentials") {
      const scopes = normalizeScopes(bodyStr(body.scope), oauthApp?.scopes ?? ["read"]);
      const appUserId =
        oauthApp?.app_user_id ??
        ls()
          .users.all()
          .find((user) => user.app)?.linear_id ??
        null;
      return c.json(issueTokens(appUserId, oauthApp?.linear_id ?? null, "app", scopes, false));
    }

    return oauthError(
      "unsupported_grant_type",
      "Only authorization_code, refresh_token, and client_credentials are supported.",
    );
  });

  app.post("/oauth/revoke", async (c) => {
    const body = await c.req.parseBody();
    const value = bodyStr(body.token) || bodyStr(body.access_token) || bodyStr(body.refresh_token);
    if (value) {
      const record = ls().tokens.findOneBy("token", value);
      if (record) {
        ls().tokens.update(record.id, { revoked: true });
        tokenMap?.delete(value);
      }
    }
    return c.body(null, 200);
  });

  function issueTokens(
    userId: string | null,
    appId: string | null,
    actor: LinearTokenActorType,
    scopes: string[],
    includeRefresh = true,
  ) {
    const accessToken = token("lin");
    const refreshToken = includeRefresh ? token("lin_refresh") : null;
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
    const access = ls().tokens.insert({
      token: accessToken,
      type: actor === "app" && !includeRefresh ? "client_credentials" : "oauth_access",
      actor_type: actor,
      user_id: userId,
      app_id: appId,
      scopes,
      expires_at: expiresAt,
      revoked: false,
      refresh_token: refreshToken,
    });
    tokenMap?.set(accessToken, {
      login: userId ? (ls().users.findOneBy("linear_id", userId)?.email ?? userId) : (appId ?? "linear-app"),
      id: access.id,
      scopes,
    });
    if (refreshToken) {
      ls().tokens.insert({
        token: refreshToken,
        type: "oauth_refresh",
        actor_type: actor,
        user_id: userId,
        app_id: appId,
        scopes,
        expires_at: null,
        revoked: false,
        refresh_token: null,
      });
    }
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: scopes.join(" "),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  }

  function resolveOAuthApp(clientId: string): LinearOAuthApp | undefined {
    return ls().oauthApps.findOneBy("client_id", clientId);
  }
}

function oauthError(error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

function clientCredentials(
  authHeader: string | undefined,
  body: Record<string, unknown>,
): { clientId: string; clientSecret: string } {
  if (authHeader?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice("Basic ".length), "base64").toString("utf-8");
      const [clientId, clientSecret] = decoded.split(":");
      return { clientId: decodeURIComponent(clientId ?? ""), clientSecret: decodeURIComponent(clientSecret ?? "") };
    } catch {
      return { clientId: "", clientSecret: "" };
    }
  }
  return {
    clientId: bodyStr(body.client_id),
    clientSecret: bodyStr(body.client_secret),
  };
}

function normalizeActor(value: string | undefined): LinearTokenActorType | undefined {
  if (value === "app" || value === "user") return value;
  return undefined;
}

function verifyPkce(code: PendingCode, verifier: string): boolean {
  if (!code.codeChallenge) return true;
  if (!verifier) return false;
  if (code.codeChallengeMethod === "S256") {
    const hashed = createHash("sha256").update(verifier).digest("base64url");
    return hashed === code.codeChallenge;
  }
  return verifier === code.codeChallenge;
}
