import type { Entity } from "@emulators/core";

export type DiscordChannelType = 0 | 2 | 4 | 5 | 10 | 11 | 12 | 13 | 15 | 16;

export interface DiscordUser extends Entity {
  user_id: string;
  username: string;
  discriminator: string;
  global_name?: string | null;
  avatar?: string | null;
  bot: boolean;
  email?: string | null;
}

export interface DiscordApplication extends Entity {
  application_id: string;
  client_id: string;
  client_secret: string;
  name: string;
  bot_token: string;
  bot_user_id: string;
  redirect_uris: string[];
  public_key?: string;
}

export interface DiscordGuild extends Entity {
  guild_id: string;
  name: string;
  icon?: string | null;
  owner_id: string;
  description?: string | null;
}

export interface DiscordRole extends Entity {
  role_id: string;
  guild_id: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  permissions: string;
  managed: boolean;
  mentionable: boolean;
}

export interface DiscordMember extends Entity {
  guild_id: string;
  user_id: string;
  nick?: string | null;
  roles: string[];
  joined_at: string;
  deaf: boolean;
  mute: boolean;
}

export interface DiscordChannel extends Entity {
  channel_id: string;
  guild_id?: string;
  name: string;
  type: DiscordChannelType;
  topic?: string | null;
  position: number;
  parent_id?: string | null;
  nsfw: boolean;
  last_message_id?: string | null;
}

export interface DiscordMessage extends Entity {
  message_id: string;
  channel_id: string;
  guild_id?: string;
  author_id: string;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  tts: boolean;
  mention_everyone: boolean;
  mention_roles: string[];
  type: number;
  pinned: boolean;
}
