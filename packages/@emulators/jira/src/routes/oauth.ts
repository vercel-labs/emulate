import type { AppEnv, Context, RouteContext, Store } from "@emulators/core";
import {
  bodyStr,
  constantTimeSecretEqual,
  escapeHtml,
  matchesRedirectUri,
  renderCardPage,
  renderErrorPage,
  renderUserButton,
} from "@emulators/core";
import { getJiraStore } from "../store.js";
import { secretToken } from "../ids.js";
import { authenticate, JiraError, jiraErrorResponse } from "../context.js";
import { avatarUrls } from "../formatters.js";

const SERVICE_LABEL = "Jira";
const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const AUDIENCE = "api.atlassian.com";

interface PendingCode {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  accountId: string;
  createdAt: number;
}

function pendingCodes(store: Store): Map<string, PendingCode> {
  let map = store.getData<Map<string, PendingCode>>("jira.oauth.pending_codes");
  if (!map) {
    map = new Map();
    store.setData("jira.oauth.pending_codes", map);
  }
  return map;
}

export function splitScopes(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((scope) => scope.trim()).filter(Boolean);
  return (value ?? "")
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function oauthError(c: Context<AppEnv>, status: number, error: string, description: string): Response {
  return c.json({ error, error_description: description }, status);
}

export function oauthRoutes({ app, store, baseUrl }: RouteContext): void {
  const js = () => getJiraStore(store);

  const validateRequest = (clientId: string, redirectUri: string, scopes: string[]) => {
    const oauthApp = js().oauthApps.findOneBy("client_id", clientId);
    if (!oauthApp)
      return { error: ["Application not found", `The client_id '${clientId}' is not registered.`] as const };
    if (!redirectUri || !matchesRedirectUri(redirectUri, oauthApp.redirect_uris)) {
      return { error: ["Redirect URI mismatch", "The redirect_uri is not registered for this app."] as const };
    }
    const invalid = scopes.filter((scope) => !oauthApp.scopes.includes(scope));
    if (invalid.length > 0) {
      return { error: ["Invalid scope", `The app is not registered for scopes: ${invalid.join(", ")}.`] as const };
    }
    return { oauthApp };
  };

  app.get("/authorize", (c) => {
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const state = c.req.query("state") ?? "";
    const scopes = splitScopes(c.req.query("scope"));
    if ((c.req.query("audience") ?? AUDIENCE) !== AUDIENCE) {
      return c.html(renderErrorPage("Invalid audience", `The audience must be ${AUDIENCE}.`, SERVICE_LABEL), 400);
    }
    if ((c.req.query("response_type") ?? "code") !== "code") {
      return c.html(
        renderErrorPage("Unsupported response_type", "Only response_type=code is supported.", SERVICE_LABEL),
        400,
      );
    }
    const checked = validateRequest(clientId, redirectUri, scopes);
    if (checked.error) return c.html(renderErrorPage(checked.error[0], checked.error[1], SERVICE_LABEL), 400);

    const buttons = js()
      .users.all()
      .filter((user) => user.active && user.account_type === "atlassian")
      .map((user) =>
        renderUserButton({
          letter: (user.display_name[0] ?? "U").toUpperCase(),
          login: user.email,
          name: user.display_name,
          email: user.email,
          formAction: "/authorize/callback",
          hiddenFields: {
            account_id: user.account_id,
            client_id: clientId,
            redirect_uri: redirectUri,
            scope: scopes.join(" "),
            state,
          },
        }),
      )
      .join("\n");

    return c.html(
      renderCardPage(
        "Authorize Atlassian app",
        `<strong>${escapeHtml(checked.oauthApp!.name)}</strong> is requesting access to your Jira site with scopes <strong>${escapeHtml(scopes.join(", ") || "none")}</strong>.`,
        buttons || '<p class="empty">No users in the Jira emulator store.</p>',
        SERVICE_LABEL,
      ),
    );
  });

  app.post("/authorize/callback", async (c) => {
    const body = await c.req.parseBody();
    const clientId = bodyStr(body.client_id);
    const redirectUri = bodyStr(body.redirect_uri);
    const scopes = splitScopes(bodyStr(body.scope));
    const state = bodyStr(body.state);
    const checked = validateRequest(clientId, redirectUri, scopes);
    if (checked.error) return c.html(renderErrorPage(checked.error[0], checked.error[1], SERVICE_LABEL), 400);
    const user = js().users.findOneBy("account_id", bodyStr(body.account_id));
    if (!user || !user.active) {
      return c.html(renderErrorPage("Unknown user", "Pick a user from the consent screen.", SERVICE_LABEL), 400);
    }
    const code = secretToken("jira_code");
    pendingCodes(store).set(code, { clientId, redirectUri, scopes, accountId: user.account_id, createdAt: Date.now() });
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  const issueTokens = (clientId: string, accountId: string, scopes: string[]) => {
    const access = secretToken("jira_at");
    js().oauthTokens.insert({
      token: access,
      type: "access",
      account_id: accountId,
      client_id: clientId,
      scopes,
      expires_at: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
      revoked: false,
    });
    let refresh: string | undefined;
    if (scopes.includes("offline_access")) {
      refresh = secretToken("jira_rt");
      js().oauthTokens.insert({
        token: refresh,
        type: "refresh",
        account_id: accountId,
        client_id: clientId,
        scopes,
        expires_at: null,
        revoked: false,
      });
    }
    return {
      access_token: access,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      token_type: "Bearer",
      ...(refresh ? { refresh_token: refresh } : {}),
      scope: scopes.join(" "),
    };
  };

  app.post("/oauth/token", async (c) => {
    const contentType = c.req.header("Content-Type") ?? "";
    let body: Record<string, unknown>;
    if (contentType.includes("application/json")) {
      body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    } else {
      body = await c.req.parseBody();
    }
    const clientId = bodyStr(body.client_id);
    const clientSecret = bodyStr(body.client_secret);
    const oauthApp = js().oauthApps.findOneBy("client_id", clientId);
    if (!oauthApp || !constantTimeSecretEqual(clientSecret, oauthApp.client_secret)) {
      return oauthError(c, 401, "access_denied", "Unauthorized");
    }

    const grantType = bodyStr(body.grant_type);
    if (grantType === "authorization_code") {
      const code = bodyStr(body.code);
      const pending = pendingCodes(store).get(code);
      pendingCodes(store).delete(code);
      if (!pending || pending.clientId !== clientId || Date.now() - pending.createdAt > CODE_TTL_MS) {
        return oauthError(c, 403, "invalid_grant", "Invalid authorization code");
      }
      if (bodyStr(body.redirect_uri) !== pending.redirectUri) {
        return oauthError(c, 403, "invalid_grant", "redirect_uri does not match the authorization request");
      }
      return c.json(issueTokens(clientId, pending.accountId, pending.scopes));
    }

    if (grantType === "refresh_token") {
      const record = js().oauthTokens.findOneBy("token", bodyStr(body.refresh_token));
      if (!record || record.type !== "refresh" || record.revoked || record.client_id !== clientId) {
        return oauthError(c, 403, "invalid_grant", "Unknown or invalid refresh token.");
      }
      // Atlassian rotates refresh tokens: the old one stops working.
      js().oauthTokens.update(record.id, { revoked: true });
      return c.json(issueTokens(clientId, record.account_id, record.scopes));
    }

    return oauthError(c, 400, "unsupported_grant_type", `Unsupported grant_type '${grantType}'.`);
  });

  const requireOAuthUser = (c: Context<AppEnv>) => {
    const auth = authenticate(c, js());
    if (!auth) throw new JiraError(401, ["Unauthorized"]);
    return auth;
  };

  app.get("/oauth/token/accessible-resources", (c) => {
    try {
      const auth = requireOAuthUser(c);
      const scopes = auth.scopes ?? js().oauthApps.all()[0]?.scopes ?? [];
      return c.json(
        js()
          .sites.all()
          .map((site) => ({
            id: site.cloud_id,
            url: baseUrl,
            name: site.name,
            scopes: scopes.filter((scope) => scope !== "offline_access"),
            avatarUrl: "https://site-admin-avatar-cdn.prod.public.atl-paas.net/avatars/240/rocket.png",
          })),
      );
    } catch (err) {
      if (err instanceof JiraError) return jiraErrorResponse(c, err);
      throw err;
    }
  });

  app.get("/me", (c) => {
    try {
      const { user } = requireOAuthUser(c);
      return c.json({
        account_type: user.account_type,
        account_id: user.account_id,
        email: user.email,
        email_verified: true,
        name: user.display_name,
        picture: avatarUrls(user.account_id)["48x48"],
        account_status: user.active ? "active" : "inactive",
        nickname: user.display_name,
        zoneinfo: user.time_zone,
        locale: user.locale.replace("_", "-"),
        extended_profile: {},
      });
    } catch (err) {
      if (err instanceof JiraError) return jiraErrorResponse(c, err);
      throw err;
    }
  });
}
