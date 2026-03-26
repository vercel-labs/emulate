import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getSlackStore } from "./store.js";
import { generateSlackId } from "./helpers.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { conversationsRoutes } from "./routes/conversations.js";
import { usersRoutes } from "./routes/users.js";
import { reactionsRoutes } from "./routes/reactions.js";
import { teamRoutes } from "./routes/team.js";
import { oauthRoutes } from "./routes/oauth.js";
import { webhookRoutes } from "./routes/webhooks.js";
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
    client_id: string;
    client_secret: string;
    name: string;
    redirect_uris: string[];
  }>;
  incoming_webhooks?: Array<{
    channel: string;
    label?: string;
  }>;
  signing_secret?: string;
}

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
    },
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
    purpose: { value: "A place for non-work-related chatter", creator: userId, last_set: Math.floor(Date.now() / 1000) },
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
      const email = u.email ?? `${u.name}@emulate.dev`;
      ss.users.insert({
        user_id: userId,
        team_id: teamId,
        name: u.name,
        real_name: u.real_name ?? u.name,
        email,
        is_admin: u.is_admin ?? false,
        is_bot: false,
        deleted: false,
        profile: {
          display_name: u.name,
          real_name: u.real_name ?? u.name,
          email,
          image_48: "",
          image_192: "",
        },
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
      if (existing) continue;

      ss.oauthApps.insert({
        client_id: oa.client_id,
        client_secret: oa.client_secret,
        name: oa.name,
        redirect_uris: oa.redirect_uris,
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
}

export const slackPlugin: ServicePlugin = {
  name: "slack",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    authRoutes(ctx);
    chatRoutes(ctx);
    conversationsRoutes(ctx);
    usersRoutes(ctx);
    reactionsRoutes(ctx);
    teamRoutes(ctx);
    oauthRoutes(ctx);
    webhookRoutes(ctx);
    inspectorRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default slackPlugin;
