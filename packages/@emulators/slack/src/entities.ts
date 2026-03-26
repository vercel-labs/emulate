import type { Entity } from "@emulators/core";

export interface SlackTeam extends Entity {
  team_id: string;
  name: string;
  domain: string;
}

export interface SlackUser extends Entity {
  user_id: string;
  team_id: string;
  name: string;
  real_name: string;
  email: string;
  is_admin: boolean;
  is_bot: boolean;
  deleted: boolean;
  profile: {
    display_name: string;
    real_name: string;
    email: string;
    image_48: string;
    image_192: string;
  };
}

export interface SlackChannel extends Entity {
  channel_id: string;
  team_id: string;
  name: string;
  is_channel: boolean;
  is_private: boolean;
  is_archived: boolean;
  topic: { value: string; creator: string; last_set: number };
  purpose: { value: string; creator: string; last_set: number };
  members: string[];
  creator: string;
  num_members: number;
}

export interface SlackMessage extends Entity {
  ts: string;
  channel_id: string;
  user: string;
  text: string;
  type: "message";
  subtype?: string;
  thread_ts?: string;
  reply_count: number;
  reply_users: string[];
  reactions: Array<{ name: string; users: string[]; count: number }>;
}

export interface SlackBot extends Entity {
  bot_id: string;
  name: string;
  deleted: boolean;
  icons: { image_48: string };
}

export interface SlackOAuthApp extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
}

export interface SlackIncomingWebhook extends Entity {
  token: string;
  team_id: string;
  bot_id: string;
  default_channel: string;
  label: string;
  url: string;
}
