import { randomBytes } from "crypto";
import type { RouteContext } from "@emulators/core";
import {
  escapeHtml,
  renderCardPage,
  renderErrorPage,
  renderUserButton,
  matchesRedirectUri,
  constantTimeSecretEqual,
  bodyStr,
  debug,
} from "@emulators/core";
import { getSlackStore } from "../store.js";
import { generateSlackId } from "../helpers.js";
import type { SlackBot, SlackInstallation, SlackOAuthApp, SlackUser } from "../entities.js";
import type { SlackStore } from "../store.js";

type PendingCode = {
  userId: string;
  scope: string;
  userScope: string;
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

export function oauthRoutes({ app, store, tokenMap }: RouteContext): void {
  const ss = () => getSlackStore(store);

  // Authorization page - renders the consent UI
  app.get("/oauth/v2/authorize", (c) => {
    const client_id = c.req.query("client_id") ?? "";
    const redirect_uri = c.req.query("redirect_uri") ?? "";
    const scope = c.req.query("scope") ?? "";
    const user_scope = c.req.query("user_scope") ?? "";
    const state = c.req.query("state") ?? "";

    const appsConfigured = ss().oauthApps.all().length > 0;
    let appName = "";
    if (appsConfigured) {
      const oauthApp = ss().oauthApps.findOneBy("client_id", client_id);
      if (!oauthApp) {
        return c.html(
          renderErrorPage("Application not found", `The client_id '${client_id}' is not registered.`, SERVICE_LABEL),
          400,
        );
      }
      if (redirect_uri && !matchesRedirectUri(redirect_uri, oauthApp.redirect_uris)) {
        return c.html(
          renderErrorPage(
            "Redirect URI mismatch",
            "The redirect_uri is not registered for this application.",
            SERVICE_LABEL,
          ),
          400,
        );
      }
      appName = oauthApp.name;
    }

    const subtitleText = appName
      ? `Authorize <strong>${escapeHtml(appName)}</strong> to access your Slack workspace.`
      : "Choose a user to authorize.";

    const users = ss()
      .users.all()
      .filter((u) => !u.deleted && !u.is_bot);
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
            user_scope,
            state,
            client_id,
          },
        });
      })
      .join("\n");

    const body = users.length === 0 ? '<p class="empty">No users in the emulator store.</p>' : userButtons;

    return c.html(renderCardPage("Sign in to Slack", subtitleText, body, SERVICE_LABEL));
  });

  // Authorization callback
  app.post("/oauth/v2/authorize/callback", async (c) => {
    const body = await c.req.parseBody();
    const userId = bodyStr(body.user_id);
    const redirect_uri = bodyStr(body.redirect_uri);
    const scope = bodyStr(body.scope);
    const userScope = bodyStr(body.user_scope);
    const state = bodyStr(body.state);
    const client_id = bodyStr(body.client_id);

    const code = randomBytes(20).toString("hex");

    getPendingCodes(store).set(code, {
      userId,
      scope,
      userScope,
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
      try {
        body = JSON.parse(rawText);
      } catch {
        body = {};
      }
    } else {
      body = Object.fromEntries(new URLSearchParams(rawText));
    }

    const code = typeof body.code === "string" ? body.code : "";
    const basicAuth = parseBasicAuth(c.req.header("Authorization"));
    const client_id = typeof body.client_id === "string" ? body.client_id : (basicAuth?.clientId ?? "");
    const client_secret = typeof body.client_secret === "string" ? body.client_secret : (basicAuth?.clientSecret ?? "");
    const redirect_uri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";

    const appsConfigured = ss().oauthApps.all().length > 0;
    let oauthApp: SlackOAuthApp | undefined;
    if (appsConfigured) {
      oauthApp = ss().oauthApps.findOneBy("client_id", client_id);
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

    if (client_id && pending.clientId && client_id !== pending.clientId) {
      return c.json({ ok: false, error: "invalid_client_id" });
    }
    if (redirect_uri && pending.redirectUri && redirect_uri !== pending.redirectUri) {
      return c.json({ ok: false, error: "bad_redirect_uri" });
    }

    const user = ss().users.findOneBy("user_id", pending.userId);
    if (!user) {
      return c.json({ ok: false, error: "invalid_code" });
    }

    const accessToken = "xoxb-" + randomBytes(20).toString("base64url");
    const userAccessToken = "xoxp-" + randomBytes(20).toString("base64url");
    const team = ss().teams.all()[0];
    const teamId = team?.team_id ?? "T000000001";
    const appId = ensureOAuthAppId(ss(), oauthApp, client_id || pending.clientId);
    const requestedScopes = normalizeScopes(pending.scope, oauthApp?.scopes ?? ["chat:write", "channels:read"]);
    const userScopes = pending.userScope ? normalizeScopes(pending.userScope, []) : [];
    const bot = ensureBotForApp(ss(), oauthApp, appId, teamId);
    const installation = upsertInstallation(ss(), {
      appId,
      clientId: client_id || pending.clientId,
      teamId,
      appName: oauthApp?.name ?? "Slack App",
      installerUserId: user.user_id,
      bot,
      scopes: requestedScopes,
      userScopes,
    });

    ss().tokens.insert({
      token: accessToken,
      token_type: "bot",
      team_id: teamId,
      user_id: bot.user.user_id,
      scopes: requestedScopes,
      app_id: appId,
      client_id: client_id || pending.clientId,
      installation_id: installation.installation_id,
      bot_id: bot.bot.bot_id,
      bot_user_id: bot.user.user_id,
      authed_user_id: user.user_id,
    });

    if (tokenMap) {
      tokenMap.set(accessToken, { login: bot.user.user_id, id: bot.user.id, scopes: requestedScopes });
    }

    if (userScopes.length > 0) {
      ss().tokens.insert({
        token: userAccessToken,
        token_type: "user",
        team_id: teamId,
        user_id: user.user_id,
        scopes: userScopes,
        app_id: appId,
        client_id: client_id || pending.clientId,
        installation_id: installation.installation_id,
        bot_id: bot.bot.bot_id,
        bot_user_id: bot.user.user_id,
        authed_user_id: user.user_id,
      });
      tokenMap?.set(userAccessToken, { login: user.user_id, id: user.id, scopes: userScopes });
    }

    debug("slack.oauth", `[Slack token] issued token for ${oauthApp?.name ?? "Slack App"} as ${bot.user.name}`);

    return c.json({
      ok: true,
      access_token: accessToken,
      token_type: "bot",
      scope: requestedScopes.join(","),
      bot_user_id: bot.user.user_id,
      app_id: appId,
      team: {
        id: teamId,
        name: team?.name ?? "Emulate",
      },
      enterprise: null,
      is_enterprise_install: false,
      authed_user: {
        id: user.user_id,
        ...(userScopes.length > 0
          ? { scope: userScopes.join(","), access_token: userAccessToken, token_type: "user" }
          : {}),
      },
    });
  });
}

function parseBasicAuth(value: string | undefined): { clientId: string; clientSecret: string } | undefined {
  if (!value?.startsWith("Basic ")) return undefined;
  try {
    const decoded = Buffer.from(value.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return undefined;
    return {
      clientId: decoded.slice(0, separator),
      clientSecret: decoded.slice(separator + 1),
    };
  } catch {
    return undefined;
  }
}

function ensureOAuthAppId(ss: SlackStore, oauthApp: SlackOAuthApp | undefined, fallback: string): string {
  if (!oauthApp) return fallback || generateSlackId("A");
  if (oauthApp.app_id) return oauthApp.app_id;

  const appId = generateSlackId("A");
  ss.oauthApps.update(oauthApp.id, { app_id: appId });
  return appId;
}

function ensureBotForApp(
  ss: SlackStore,
  oauthApp: SlackOAuthApp | undefined,
  appId: string,
  teamId: string,
): { bot: SlackBot; user: SlackUser } {
  const botId = oauthApp?.bot_id ?? generateSlackId("B");
  const botUserId = oauthApp?.bot_user_id ?? generateSlackId("U");
  const botName = oauthApp?.bot_name ?? slugifyBotName(oauthApp?.name ?? "Slack App");

  if (oauthApp && (!oauthApp.bot_id || !oauthApp.bot_user_id || !oauthApp.bot_name)) {
    ss.oauthApps.update(oauthApp.id, {
      bot_id: botId,
      bot_user_id: botUserId,
      bot_name: botName,
    });
  }

  const existingBot = ss.bots.findOneBy("bot_id", botId);
  const bot =
    existingBot ??
    ss.bots.insert({
      bot_id: botId,
      app_id: appId,
      user_id: botUserId,
      name: botName,
      deleted: false,
      icons: { image_48: "" },
    });

  // Installing again reactivates a bot user that auth.revoke deactivated.
  if (existingBot && (existingBot.app_id !== appId || existingBot.user_id !== botUserId || existingBot.deleted)) {
    ss.bots.update(existingBot.id, { app_id: appId, user_id: botUserId, deleted: false });
  }

  const existingUser = ss.users.findOneBy("user_id", botUserId);
  const user =
    (existingUser?.deleted ? ss.users.update(existingUser.id, { deleted: false }) : existingUser) ??
    ss.users.insert({
      user_id: botUserId,
      team_id: teamId,
      name: botName,
      real_name: oauthApp?.name ?? botName,
      email: `${botName}@bots.emulate.dev`,
      is_admin: false,
      is_bot: true,
      deleted: false,
      profile: {
        display_name: botName,
        real_name: oauthApp?.name ?? botName,
        email: `${botName}@bots.emulate.dev`,
        image_48: "",
        image_192: "",
        real_name_normalized: oauthApp?.name ?? botName,
        display_name_normalized: botName,
        status_text: "",
        status_emoji: "",
        status_emoji_display_info: [],
        status_expiration: 0,
      },
      presence: "active",
      manual_presence: "auto",
      connection_count: 1,
      last_activity: Math.floor(Date.now() / 1000),
    });

  return {
    bot: ss.bots.findOneBy("bot_id", bot.bot_id) ?? bot,
    user,
  };
}

function upsertInstallation(
  ss: SlackStore,
  input: {
    appId: string;
    clientId: string;
    teamId: string;
    appName: string;
    installerUserId: string;
    bot: { bot: SlackBot; user: SlackUser };
    scopes: string[];
    userScopes: string[];
  },
): SlackInstallation {
  const existing = ss.installations.all().find((item) => item.app_id === input.appId && item.team_id === input.teamId);
  const data = {
    app_id: input.appId,
    client_id: input.clientId,
    team_id: input.teamId,
    app_name: input.appName,
    installer_user_id: input.installerUserId,
    bot_id: input.bot.bot.bot_id,
    bot_user_id: input.bot.user.user_id,
    scopes: input.scopes,
    user_scopes: input.userScopes,
  };

  if (existing) {
    return ss.installations.update(existing.id, data)!;
  }

  return ss.installations.insert({
    installation_id: generateSlackId("I"),
    ...data,
  });
}

function normalizeScopes(value: string | undefined, fallback: string[]): string[] {
  if (!value) return [...fallback];
  return value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function slugifyBotName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "slack-app";
}
