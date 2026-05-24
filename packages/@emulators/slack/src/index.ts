import type { Context, Hono } from "@emulators/core";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getSlackStore } from "./store.js";
import { generateSlackId } from "./helpers.js";
import type { SlackOAuthApp, SlackPresence, SlackTokenType, SlackUserProfile } from "./entities.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { conversationsRoutes } from "./routes/conversations.js";
import { usersRoutes } from "./routes/users.js";
import { reactionsRoutes } from "./routes/reactions.js";
import { teamRoutes } from "./routes/team.js";
import { oauthRoutes } from "./routes/oauth.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { filesRoutes } from "./routes/files.js";
import { pinsRoutes } from "./routes/pins.js";
import { bookmarksRoutes } from "./routes/bookmarks.js";
import { viewsRoutes } from "./routes/views.js";
import { inspectorRoutes } from "./routes/inspector.js";

export { getSlackStore, type SlackStore } from "./store.js";
export * from "./entities.js";

export interface SlackSeedConfig {
  port?: number;
  team?: {
    name?: string;
    domain?: string;
  };
  users?: Array<{
    name: string;
    real_name?: string;
    email?: string;
    is_admin?: boolean;
    profile?: Partial<SlackUserProfile>;
    presence?: SlackPresence;
  }>;
  channels?: Array<{
    name: string;
    topic?: string;
    purpose?: string;
    is_private?: boolean;
  }>;
  bots?: Array<{
    name: string;
  }>;
  oauth_apps?: Array<{
    app_id?: string;
    client_id: string;
    client_secret: string;
    name: string;
    redirect_uris: string[];
    scopes?: string[] | string;
    user_scopes?: string[] | string;
    bot_id?: string;
    bot_user_id?: string;
    bot_name?: string;
  }>;
  tokens?: Array<{
    token: string;
    type?: SlackTokenType;
    user?: string;
    user_id?: string;
    scopes?: string[] | string;
    app_id?: string;
    client_id?: string;
    team_id?: string;
    bot_id?: string;
    bot_user_id?: string;
    authed_user_id?: string;
  }>;
  incoming_webhooks?: Array<{
    channel: string;
    label?: string;
  }>;
  strict_scopes?: boolean;
  signing_secret?: string;
}

const DEFAULT_SLACK_SCOPES = [
  "chat:write",
  "channels:read",
  "channels:history",
  "channels:join",
  "channels:manage",
  "channels:write",
  "groups:read",
  "groups:history",
  "groups:write",
  "im:read",
  "im:history",
  "im:write",
  "mpim:read",
  "mpim:history",
  "mpim:write",
  "users:read",
  "users:read.email",
  "users.profile:read",
  "users.profile:write",
  "users:write",
  "files:read",
  "files:write",
  "pins:read",
  "pins:write",
  "bookmarks:read",
  "bookmarks:write",
  "reactions:read",
  "reactions:write",
  "team:read",
];

function seedDefaults(store: Store, _baseUrl: string): void {
  const ss = getSlackStore(store);

  const teamId = "T000000001";

  ss.teams.insert({
    team_id: teamId,
    name: "Emulate",
    domain: "emulate",
  });

  const userId = "U000000001";
  ss.users.insert({
    user_id: userId,
    team_id: teamId,
    name: "admin",
    real_name: "Admin User",
    email: "admin@emulate.dev",
    is_admin: true,
    is_bot: false,
    deleted: false,
    profile: {
      display_name: "admin",
      real_name: "Admin User",
      email: "admin@emulate.dev",
      image_48: "",
      image_192: "",
      real_name_normalized: "Admin User",
      display_name_normalized: "admin",
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

  ss.channels.insert({
    channel_id: "C000000001",
    team_id: teamId,
    name: "general",
    is_channel: true,
    is_private: false,
    is_archived: false,
    topic: { value: "General discussion", creator: userId, last_set: Math.floor(Date.now() / 1000) },
    purpose: { value: "A place for general discussion", creator: userId, last_set: Math.floor(Date.now() / 1000) },
    members: [userId],
    creator: userId,
    num_members: 1,
  });

  ss.channels.insert({
    channel_id: "C000000002",
    team_id: teamId,
    name: "random",
    is_channel: true,
    is_private: false,
    is_archived: false,
    topic: { value: "Random stuff", creator: userId, last_set: Math.floor(Date.now() / 1000) },
    purpose: {
      value: "A place for non-work-related chatter",
      creator: userId,
      last_set: Math.floor(Date.now() / 1000),
    },
    members: [userId],
    creator: userId,
    num_members: 1,
  });

  // Default incoming webhook for #general
  ss.incomingWebhooks.insert({
    token: "X000000001",
    team_id: teamId,
    bot_id: "B000000001",
    default_channel: "general",
    label: "Default Webhook",
    url: `/services/${teamId}/B000000001/X000000001`,
  });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: SlackSeedConfig): void {
  const ss = getSlackStore(store);

  if (config.team) {
    const existing = ss.teams.all()[0];
    if (existing) {
      ss.teams.update(existing.id, {
        name: config.team.name ?? existing.name,
        domain: config.team.domain ?? existing.domain,
      });
    }
  }

  const team = ss.teams.all()[0];
  const teamId = team?.team_id ?? "T000000001";

  if (config.users) {
    for (const u of config.users) {
      const existing = ss.users.all().find((eu) => eu.name === u.name);
      if (existing) continue;

      const userId = generateSlackId("U");
      const email = u.profile?.email ?? u.email ?? `${u.name}@emulate.dev`;
      const realName = u.real_name ?? u.name;
      const profile = normalizeSeedProfile({
        display_name: u.name,
        real_name: realName,
        email,
        image_48: "",
        image_192: "",
        ...u.profile,
      });
      ss.users.insert({
        user_id: userId,
        team_id: teamId,
        name: u.name,
        real_name: profile.real_name,
        email: profile.email,
        is_admin: u.is_admin ?? false,
        is_bot: false,
        deleted: false,
        profile,
        presence: u.presence ?? "active",
        manual_presence: u.presence === "away" ? "away" : "auto",
        connection_count: u.presence === "away" ? 0 : 1,
        last_activity: u.presence === "away" ? undefined : Math.floor(Date.now() / 1000),
      });
    }
  }

  if (config.channels) {
    for (const ch of config.channels) {
      const existing = ss.channels.findOneBy("name", ch.name);
      if (existing) continue;

      const creator = ss.users.all()[0]?.user_id ?? "U000000001";
      const now = Math.floor(Date.now() / 1000);
      const isPrivate = ch.is_private ?? false;

      ss.channels.insert({
        channel_id: generateSlackId("C"),
        team_id: teamId,
        name: ch.name,
        is_channel: !isPrivate,
        is_private: isPrivate,
        is_archived: false,
        topic: { value: ch.topic ?? "", creator, last_set: now },
        purpose: { value: ch.purpose ?? "", creator, last_set: now },
        members: ss.users.all().map((u) => u.user_id),
        creator,
        num_members: ss.users.all().length,
      });
    }
  }

  if (config.bots) {
    for (const b of config.bots) {
      const existing = ss.bots.all().find((eb) => eb.name === b.name);
      if (existing) continue;

      ss.bots.insert({
        bot_id: generateSlackId("B"),
        name: b.name,
        deleted: false,
        icons: { image_48: "" },
      });
    }
  }

  if (config.oauth_apps) {
    for (const oa of config.oauth_apps) {
      const existing = ss.oauthApps.findOneBy("client_id", oa.client_id);
      if (existing) {
        if (!existing.app_id) {
          ss.oauthApps.update(existing.id, { app_id: oa.app_id ?? generateSlackId("A") });
        }
        continue;
      }

      ss.oauthApps.insert({
        app_id: oa.app_id ?? generateSlackId("A"),
        client_id: oa.client_id,
        client_secret: oa.client_secret,
        name: oa.name,
        redirect_uris: oa.redirect_uris,
        scopes: normalizeScopes(oa.scopes),
        user_scopes: normalizeScopes(oa.user_scopes),
        bot_id: oa.bot_id,
        bot_user_id: oa.bot_user_id,
        bot_name: oa.bot_name,
      });
    }

    const installer = ss.users.all().find((user) => !user.deleted && !user.is_bot) ?? ss.users.all()[0];
    for (const appRecord of ss.oauthApps.all()) {
      seedOAuthInstallation(ss, teamId, installer?.user_id ?? "U000000001", appRecord);
    }
  }

  if (config.tokens) {
    for (const token of config.tokens) {
      const value = token.token.trim();
      if (!value || ss.tokens.findOneBy("token", value)) continue;

      const userId =
        resolveSeedTokenUserId(ss, token.user_id ?? token.user) ?? ss.users.all()[0]?.user_id ?? "U000000001";
      ss.tokens.insert({
        token: value,
        token_type: token.type ?? "test",
        team_id: token.team_id ?? teamId,
        user_id: userId,
        scopes: normalizeScopes(token.scopes, DEFAULT_SLACK_SCOPES),
        app_id: token.app_id,
        client_id: token.client_id,
        bot_id: token.bot_id,
        bot_user_id: token.bot_user_id,
        authed_user_id: token.authed_user_id,
      });
    }
  }

  if (config.incoming_webhooks) {
    const firstBot = ss.bots.all()[0];
    const botId = firstBot?.bot_id ?? "B000000001";

    for (const wh of config.incoming_webhooks) {
      const token = generateSlackId("X");
      ss.incomingWebhooks.insert({
        token,
        team_id: teamId,
        bot_id: botId,
        default_channel: wh.channel,
        label: wh.label ?? wh.channel,
        url: `/services/${teamId}/${botId}/${token}`,
      });
    }
  }

  if (config.signing_secret) {
    store.setData("slack.signing_secret", config.signing_secret);
  }

  if (config.strict_scopes !== undefined) {
    store.setData("slack.strict_scopes", config.strict_scopes);
  }
}

export const slackPlugin: ServicePlugin = {
  name: "slack",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    app.use("*", async (c, next) => {
      applySlackTokenAuth(c, store);
      await next();
    });

    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    authRoutes(ctx);
    chatRoutes(ctx);
    conversationsRoutes(ctx);
    usersRoutes(ctx);
    reactionsRoutes(ctx);
    teamRoutes(ctx);
    oauthRoutes(ctx);
    webhookRoutes(ctx);
    filesRoutes(ctx);
    pinsRoutes(ctx);
    bookmarksRoutes(ctx);
    viewsRoutes(ctx);
    inspectorRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default slackPlugin;

export function normalizeScopes(value: string[] | string | undefined, fallback: string[] = []): string[] {
  if (Array.isArray(value)) return value.map((scope) => scope.trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
  }
  return [...fallback];
}

function applySlackTokenAuth(c: Context, store: Store): void {
  const token = slackRequestToken(c);
  if (!token) return;

  const record = getSlackStore(store).tokens.findOneBy("token", token);
  if (!record) return;

  c.set("authToken", record.token);
  c.set("authScopes", record.scopes);
  c.set("authUser", {
    login: record.user_id,
    id: record.id,
    scopes: record.scopes,
  });
}

function slackRequestToken(c: Context): string | undefined {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) return undefined;
  const token = authHeader.replace(/^(Bearer|token)\s+/i, "").trim();
  return token || undefined;
}

function seedOAuthInstallation(
  ss: ReturnType<typeof getSlackStore>,
  teamId: string,
  installerUserId: string,
  app: SlackOAuthApp,
): void {
  const appId = app.app_id ?? generateSlackId("A");
  if (!app.app_id) ss.oauthApps.update(app.id, { app_id: appId });

  const botName = app.bot_name ?? slugifySlackBotName(app.name);
  const existingBot =
    (app.bot_id ? ss.bots.findOneBy("bot_id", app.bot_id) : undefined) ??
    ss.bots.all().find((bot) => bot.name === botName);
  const botId = app.bot_id ?? existingBot?.bot_id ?? generateSlackId("B");
  const botUserId = app.bot_user_id ?? existingBot?.user_id ?? generateSlackId("U");
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

  if (bot.app_id !== appId || bot.user_id !== botUserId) {
    ss.bots.update(bot.id, { app_id: appId, user_id: botUserId });
  }
  if (!app.bot_id || !app.bot_user_id || !app.bot_name) {
    ss.oauthApps.update(app.id, {
      bot_id: botId,
      bot_user_id: botUserId,
      bot_name: botName,
    });
  }

  if (!ss.users.findOneBy("user_id", botUserId)) {
    ss.users.insert({
      user_id: botUserId,
      team_id: teamId,
      name: botName,
      real_name: app.name,
      email: `${botName}@bots.emulate.dev`,
      is_admin: false,
      is_bot: true,
      deleted: false,
      profile: {
        display_name: botName,
        real_name: app.name,
        email: `${botName}@bots.emulate.dev`,
        image_48: "",
        image_192: "",
        real_name_normalized: app.name,
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
  }

  const existingInstallation = ss.installations
    .all()
    .find((installation) => installation.app_id === appId && installation.team_id === teamId);
  const data = {
    app_id: appId,
    client_id: app.client_id,
    team_id: teamId,
    app_name: app.name,
    installer_user_id: installerUserId,
    bot_id: botId,
    bot_user_id: botUserId,
    scopes: app.scopes ?? [],
    user_scopes: app.user_scopes ?? [],
  };

  if (existingInstallation) {
    ss.installations.update(existingInstallation.id, data);
  } else {
    ss.installations.insert({
      installation_id: generateSlackId("I"),
      ...data,
    });
  }
}

function resolveSeedTokenUserId(ss: ReturnType<typeof getSlackStore>, userRef: string | undefined): string | undefined {
  if (!userRef) return undefined;
  return ss.users.findOneBy("user_id", userRef)?.user_id ?? ss.users.findOneBy("name", userRef)?.user_id ?? userRef;
}

function slugifySlackBotName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "slack-app";
}

function normalizeSeedProfile(profile: SlackUserProfile): SlackUserProfile {
  return {
    ...profile,
    real_name_normalized: profile.real_name_normalized ?? profile.real_name,
    display_name_normalized: profile.display_name_normalized ?? profile.display_name,
    status_text: profile.status_text ?? "",
    status_emoji: profile.status_emoji ?? "",
    status_emoji_display_info: profile.status_emoji_display_info ?? [],
    status_expiration: profile.status_expiration ?? 0,
  };
}
