import { Store, type Collection } from "@emulators/core";
import type {
  DiscordApplication,
  DiscordChannel,
  DiscordGuild,
  DiscordMember,
  DiscordMessage,
  DiscordRole,
  DiscordUser,
} from "./entities.js";

export interface DiscordStore {
  applications: Collection<DiscordApplication>;
  users: Collection<DiscordUser>;
  guilds: Collection<DiscordGuild>;
  channels: Collection<DiscordChannel>;
  members: Collection<DiscordMember>;
  roles: Collection<DiscordRole>;
  messages: Collection<DiscordMessage>;
}

export function getDiscordStore(store: Store): DiscordStore {
  return {
    applications: store.collection<DiscordApplication>("discord.applications", [
      "application_id",
      "client_id",
      "bot_token",
    ]),
    users: store.collection<DiscordUser>("discord.users", ["user_id", "username", "email"]),
    guilds: store.collection<DiscordGuild>("discord.guilds", ["guild_id", "name"]),
    channels: store.collection<DiscordChannel>("discord.channels", ["channel_id", "guild_id", "name"]),
    members: store.collection<DiscordMember>("discord.members", ["guild_id", "user_id"]),
    roles: store.collection<DiscordRole>("discord.roles", ["role_id", "guild_id", "name"]),
    messages: store.collection<DiscordMessage>("discord.messages", ["message_id", "channel_id"]),
  };
}
