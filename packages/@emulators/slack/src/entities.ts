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

export type SlackJsonObject = Record<string, unknown>;

export interface SlackMessage extends Entity {
  ts: string;
  channel_id: string;
  user: string;
  text: string;
  type: "message";
  subtype?: string;
  blocks?: SlackJsonObject[];
  attachments?: SlackJsonObject[];
  metadata?: SlackJsonObject;
  mrkdwn?: boolean;
  parse?: string;
  link_names?: boolean;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
  username?: string;
  icon_url?: string;
  icon_emoji?: string;
  bot_id?: string;
  app_id?: string;
  client_msg_id?: string;
  reply_broadcast?: boolean;
  topic?: string;
  purpose?: string;
  old_name?: string;
  name?: string;
  edited?: { user: string; ts: string };
  thread_ts?: string;
  reply_count: number;
  reply_users: string[];
  reactions: Array<{ name: string; users: string[]; count: number }>;
}

export interface SlackEphemeralMessage extends SlackMessage {
  target_user: string;
}

export interface SlackScheduledMessage extends Entity {
  scheduled_message_id: string;
  channel_id: string;
  user: string;
  text: string;
  type: "delayed_message";
  subtype: "bot_message";
  blocks?: SlackJsonObject[];
  attachments?: SlackJsonObject[];
  metadata?: SlackJsonObject;
  mrkdwn?: boolean;
  parse?: string;
  link_names?: boolean;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
  username?: string;
  icon_url?: string;
  icon_emoji?: string;
  bot_id?: string;
  app_id?: string;
  client_msg_id?: string;
  reply_broadcast?: boolean;
  thread_ts?: string;
  post_at: number;
  date_created: number;
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
