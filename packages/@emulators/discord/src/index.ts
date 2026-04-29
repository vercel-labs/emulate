import type { Hono } from "hono";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { getDiscordStore } from "./store.js";
import { channelRoutes } from "./routes/channels.js";
import { guildRoutes } from "./routes/guilds.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { memberRoutes } from "./routes/members.js";
import { messageRoutes } from "./routes/messages.js";
import { oauthRoutes } from "./routes/oauth.js";
import { roleRoutes } from "./routes/roles.js";
import { usersRoutes } from "./routes/users.js";
import { generateSnowflake, installDiscordToken } from "./helpers.js";
import type { DiscordChannelType } from "./entities.js";

export { getDiscordStore, type DiscordStore } from "./store.js";
export * from "./entities.js";
export { generateSnowflake, snowflakeTimestamp } from "./helpers.js";

export interface DiscordSeedConfig {
  port?: number;
  applications?: Array<{
    id?: string;
    client_id?: string;
    client_secret?: string;
    name?: string;
    bot_token?: string;
    public_key?: string;
    redirect_uris?: string[];
  }>;
  users?: Array<{
    id?: string;
    username: string;
    global_name?: string;
    email?: string;
    bot?: boolean;
  }>;
  guilds?: Array<{
    id?: string;
    name: string;
    owner_id?: string;
    description?: string;
    roles?: Array<{
      id?: string;
      name: string;
      permissions?: string;
      color?: number;
      hoist?: boolean;
      mentionable?: boolean;
    }>;
    members?: Array<{
      user_id: string;
      nick?: string;
      roles?: string[];
    }>;
    channels?: Array<{
      id?: string;
      name: string;
      type?: DiscordChannelType | "GUILD_TEXT" | "GUILD_VOICE" | "GUILD_CATEGORY";
      topic?: string;
      nsfw?: boolean;
    }>;
  }>;
}

const DEFAULT_USER_ID = "100000000000000001";
const DEFAULT_GUILD_ID = "100000000000000100";
const DEFAULT_CHANNEL_ID = "100000000000000101";
const DEFAULT_BOT_USER_ID = "100000000000000002";

function seedDefaults(store: Store, _baseUrl: string): void {
  const ds = getDiscordStore(store);

  ds.users.insert({
    user_id: DEFAULT_USER_ID,
    username: "developer",
    discriminator: "0000",
    global_name: "Developer",
    avatar: null,
    bot: false,
    email: "dev@example.com",
  });

  ds.users.insert({
    user_id: DEFAULT_BOT_USER_ID,
    username: "emulate-bot",
    discriminator: "0000",
    global_name: "Emulate Bot",
    avatar: null,
    bot: true,
    email: null,
  });

  ds.applications.insert({
    application_id: "100000000000000010",
    client_id: "discord_emulate_client",
    client_secret: "discord_emulate_secret",
    name: "Emulate Discord App",
    bot_token: "discord_bot_token",
    bot_user_id: DEFAULT_BOT_USER_ID,
    redirect_uris: ["http://localhost:3000/api/auth/callback/discord"],
  });

  ds.guilds.insert({
    guild_id: DEFAULT_GUILD_ID,
    name: "Emulate Guild",
    icon: null,
    owner_id: DEFAULT_USER_ID,
    description: "Local Discord test guild",
  });

  ds.roles.insert({
    role_id: DEFAULT_GUILD_ID,
    guild_id: DEFAULT_GUILD_ID,
    name: "@everyone",
    color: 0,
    hoist: false,
    position: 0,
    permissions: "0",
    managed: false,
    mentionable: false,
  });

  ds.members.insert({
    guild_id: DEFAULT_GUILD_ID,
    user_id: DEFAULT_USER_ID,
    nick: null,
    roles: [],
    joined_at: new Date().toISOString(),
    deaf: false,
    mute: false,
  });

  ds.members.insert({
    guild_id: DEFAULT_GUILD_ID,
    user_id: DEFAULT_BOT_USER_ID,
    nick: null,
    roles: [],
    joined_at: new Date().toISOString(),
    deaf: false,
    mute: false,
  });

  ds.channels.insert({
    channel_id: DEFAULT_CHANNEL_ID,
    guild_id: DEFAULT_GUILD_ID,
    name: "general",
    type: 0,
    topic: "General discussion",
    position: 0,
    parent_id: null,
    nsfw: false,
    last_message_id: null,
  });
}

// Captured during plugin.register so seedFromConfig can install bot tokens
// without requiring a tokenMap parameter on the LoadedService.seedFromConfig
// signature shared across emulators.
let registeredTokenMap: TokenMap | undefined;

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: DiscordSeedConfig,
  _webhooks?: WebhookDispatcher,
): void {
  const tokenMap = registeredTokenMap;
  const ds = getDiscordStore(store);

  if (config.users) {
    for (const user of config.users) {
      const userId = user.id ?? generateSnowflake();
      if (ds.users.findOneBy("user_id", userId)) continue;
      ds.users.insert({
        user_id: userId,
        username: user.username,
        discriminator: "0000",
        global_name: user.global_name ?? user.username,
        avatar: null,
        bot: user.bot ?? false,
        email: user.email ?? null,
      });
    }
  }

  if (config.applications) {
    for (const application of config.applications) {
      const applicationId = application.id ?? generateSnowflake();
      if (ds.applications.findOneBy("application_id", applicationId)) continue;

      const botUserId = generateSnowflake();
      const botToken = application.bot_token ?? `discord_bot_${generateSnowflake()}`;
      ds.users.insert({
        user_id: botUserId,
        username: `${application.name ?? "discord"}-bot`,
        discriminator: "0000",
        global_name: application.name ?? "Discord Bot",
        avatar: null,
        bot: true,
        email: null,
      });
      ds.applications.insert({
        application_id: applicationId,
        client_id: application.client_id ?? applicationId,
        client_secret: application.client_secret ?? "discord_client_secret",
        name: application.name ?? "Discord App",
        bot_token: botToken,
        bot_user_id: botUserId,
        redirect_uris: application.redirect_uris ?? ["http://localhost:3000/api/auth/callback/discord"],
        public_key: application.public_key,
      });
      installDiscordToken(tokenMap, botToken, botUserId, ds.users.findOneBy("user_id", botUserId)?.id ?? 1);
    }
  }

  if (config.guilds) {
    for (const guildConfig of config.guilds) {
      const guildId = guildConfig.id ?? generateSnowflake();
      if (ds.guilds.findOneBy("guild_id", guildId)) continue;
      const ownerId = guildConfig.owner_id ?? ds.users.all().find((u) => !u.bot)?.user_id ?? DEFAULT_USER_ID;

      ds.guilds.insert({
        guild_id: guildId,
        name: guildConfig.name,
        icon: null,
        owner_id: ownerId,
        description: guildConfig.description ?? null,
      });

      ds.roles.insert({
        role_id: guildId,
        guild_id: guildId,
        name: "@everyone",
        color: 0,
        hoist: false,
        position: 0,
        permissions: "0",
        managed: false,
        mentionable: false,
      });

      for (const role of guildConfig.roles ?? []) {
        const roleId = role.id ?? generateSnowflake();
        ds.roles.insert({
          role_id: roleId,
          guild_id: guildId,
          name: role.name,
          color: role.color ?? 0,
          hoist: role.hoist ?? false,
          position: ds.roles.findBy("guild_id", guildId).length,
          permissions: role.permissions ?? "0",
          managed: false,
          mentionable: role.mentionable ?? false,
        });
      }

      for (const member of guildConfig.members ?? []) {
        if (!ds.users.findOneBy("user_id", member.user_id)) {
          ds.users.insert({
            user_id: member.user_id,
            username: `user-${member.user_id}`,
            discriminator: "0000",
            global_name: null,
            avatar: null,
            bot: false,
            email: null,
          });
        }
        ds.members.insert({
          guild_id: guildId,
          user_id: member.user_id,
          nick: member.nick ?? null,
          roles: member.roles ?? [],
          joined_at: new Date().toISOString(),
          deaf: false,
          mute: false,
        });
      }

      for (const channel of guildConfig.channels ?? []) {
        ds.channels.insert({
          channel_id: channel.id ?? generateSnowflake(),
          guild_id: guildId,
          name: channel.name,
          type: channelType(channel.type),
          topic: channel.topic ?? null,
          position: ds.channels.findBy("guild_id", guildId).length,
          parent_id: null,
          nsfw: channel.nsfw ?? false,
          last_message_id: null,
        });
      }
    }
  }
}

function channelType(
  type: DiscordChannelType | "GUILD_TEXT" | "GUILD_VOICE" | "GUILD_CATEGORY" | undefined,
): DiscordChannelType {
  if (typeof type === "number") return type;
  if (type === "GUILD_VOICE") return 2;
  if (type === "GUILD_CATEGORY") return 4;
  return 0;
}

export const discordPlugin: ServicePlugin = {
  name: "discord",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    registeredTokenMap = tokenMap;
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    installDiscordToken(tokenMap, "discord_bot_token", DEFAULT_BOT_USER_ID, 2);
    usersRoutes(ctx);
    guildRoutes(ctx);
    channelRoutes(ctx);
    messageRoutes(ctx);
    memberRoutes(ctx);
    roleRoutes(ctx);
    oauthRoutes(ctx);
    inspectorRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default discordPlugin;
