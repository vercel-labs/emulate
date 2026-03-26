import { randomBytes } from "crypto";
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
import { getSlackStore } from "../store.js";

type PendingCode = {
  userId: string;
  scope: string;
  redirectUri: string;
  clientId: string;
  created_at: number;
};

const PENDING_CODE_TTL_MS = 10 * 60 * 1000;
const SERVICE_LABEL = "Slack";

function getPendingCodes(store: import("@emulators/core").Store): Map<string, PendingCode> {
  let map = store.getData<Map<string, PendingCode>>("slack.oauth.pendingCodes");
  if (!map) {
    map = new Map();
    store.setData("slack.oauth.pendingCodes", map);
  }
  return map;
}

function isPendingCodeExpired(p: PendingCode): boolean {
  return Date.now() - p.created_at > PENDING_CODE_TTL_MS;
}

export function oauthRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const ss = () => getSlackStore(store);

  // Authorization page - renders the consent UI
  app.get("/oauth/v2/authorize", (c) => {
    const client_id = c.req.query("client_id") ?? "";
    const redirect_uri = c.req.query("redirect_uri") ?? "";
    const scope = c.req.query("scope") ?? "";
    const state = c.req.query("state") ?? "";

    const appsConfigured = ss().oauthApps.all().length > 0;
    let appName = "";
    if (appsConfigured) {
      const oauthApp = ss().oauthApps.findOneBy("client_id", client_id);
      if (!oauthApp) {
        return c.html(
          renderErrorPage("Application not found", `The client_id '${client_id}' is not registered.`, SERVICE_LABEL),
          400
        );
      }
      if (redirect_uri && !matchesRedirectUri(redirect_uri, oauthApp.redirect_uris)) {
        return c.html(
          renderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", SERVICE_LABEL),
          400
        );
      }
      appName = oauthApp.name;
    }

    const subtitleText = appName
      ? `Authorize <strong>${escapeHtml(appName)}</strong> to access your Slack workspace.`
      : "Choose a user to authorize.";

    const users = ss().users.all().filter((u) => !u.deleted && !u.is_bot);
    const userButtons = users
      .map((user) => {
        return renderUserButton({
          letter: (user.name[0] ?? "?").toUpperCase(),
          login: user.name,
          name: user.real_name,
          email: user.email,
          formAction: "/oauth/v2/authorize/callback",
          hiddenFields: {
            user_id: user.user_id,
            redirect_uri,
            scope,
            state,
            client_id,
          },
        });
      })
      .join("\n");

    const body = users.length === 0
      ? '<p class="empty">No users in the emulator store.</p>'
      : userButtons;

    return c.html(renderCardPage("Sign in to Slack", subtitleText, body, SERVICE_LABEL));
  });

  // Authorization callback
  app.post("/oauth/v2/authorize/callback", async (c) => {
    const body = await c.req.parseBody();
    const userId = bodyStr(body.user_id);
    const redirect_uri = bodyStr(body.redirect_uri);
    const scope = bodyStr(body.scope);
    const state = bodyStr(body.state);
    const client_id = bodyStr(body.client_id);

    const code = randomBytes(20).toString("hex");

    getPendingCodes(store).set(code, {
      userId,
      scope,
      redirectUri: redirect_uri,
      clientId: client_id,
      created_at: Date.now(),
    });

    debug("slack.oauth", `[Slack callback] code=${code.slice(0, 8)}... user=${userId}`);

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);

    return c.redirect(url.toString(), 302);
  });

  // oauth.v2.access - token exchange
  app.post("/api/oauth.v2.access", async (c) => {
    const contentType = c.req.header("Content-Type") ?? "";
    const rawText = await c.req.text();

    let body: Record<string, unknown>;
    if (contentType.includes("application/json")) {
      try { body = JSON.parse(rawText); } catch { body = {}; }
    } else {
      body = Object.fromEntries(new URLSearchParams(rawText));
    }

    const code = typeof body.code === "string" ? body.code : "";
    const client_id = typeof body.client_id === "string" ? body.client_id : "";
    const client_secret = typeof body.client_secret === "string" ? body.client_secret : "";

    const appsConfigured = ss().oauthApps.all().length > 0;
    if (appsConfigured) {
      const oauthApp = ss().oauthApps.findOneBy("client_id", client_id);
      if (!oauthApp) {
        return c.json({ ok: false, error: "invalid_client_id" });
      }
      if (!constantTimeSecretEqual(client_secret, oauthApp.client_secret)) {
        return c.json({ ok: false, error: "invalid_client_id" });
      }
    }

    const pendingMap = getPendingCodes(store);
    const pending = pendingMap.get(code);
    if (!pending) {
      return c.json({ ok: false, error: "invalid_code" });
    }
    if (isPendingCodeExpired(pending)) {
      pendingMap.delete(code);
      return c.json({ ok: false, error: "invalid_code" });
    }

    pendingMap.delete(code);

    const user = ss().users.findOneBy("user_id", pending.userId);
    if (!user) {
      return c.json({ ok: false, error: "invalid_code" });
    }

    const accessToken = "xoxb-" + randomBytes(20).toString("base64url");
    const team = ss().teams.all()[0];

    if (tokenMap) {
      const scopes = pending.scope ? pending.scope.split(/[,\s]+/).filter(Boolean) : [];
      tokenMap.set(accessToken, { login: user.user_id, id: user.id, scopes });
    }

    debug("slack.oauth", `[Slack token] issued token for ${user.name}`);

    return c.json({
      ok: true,
      access_token: accessToken,
      token_type: "bot",
      scope: pending.scope || "chat:write,channels:read",
      bot_user_id: user.user_id,
      app_id: client_id,
      team: {
        id: team?.team_id ?? "T000000001",
        name: team?.name ?? "Emulate",
      },
      authed_user: {
        id: user.user_id,
      },
    });
  });
}
