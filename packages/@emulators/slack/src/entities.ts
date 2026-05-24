import type { Entity } from "@emulators/core";

export interface SlackTeam extends Entity {
  team_id: string;
  name: string;
  domain: string;
}

export interface SlackUserProfile {
  display_name: string;
  real_name: string;
  email: string;
  image_48: string;
  image_192: string;
  title?: string;
  phone?: string;
  skype?: string;
  real_name_normalized?: string;
  display_name_normalized?: string;
  fields?: Record<string, { value: string; alt?: string; label?: string }>;
  status_text?: string;
  status_emoji?: string;
  status_emoji_display_info?: Record<string, unknown>[];
  status_expiration?: number;
  avatar_hash?: string;
  start_date?: string;
  pronouns?: string;
  huddle_state?: string;
  huddle_state_expiration_ts?: number;
  first_name?: string;
  last_name?: string;
  image_24?: string;
  image_32?: string;
  image_72?: string;
  image_512?: string;
}

export type SlackPresence = "active" | "away";
export type SlackManualPresence = "auto" | "away";

export interface SlackUser extends Entity {
  user_id: string;
  team_id: string;
  name: string;
  real_name: string;
  email: string;
  is_admin: boolean;
  is_bot: boolean;
  deleted: boolean;
  profile: SlackUserProfile;
  presence?: SlackPresence;
  manual_presence?: SlackManualPresence;
  connection_count?: number;
  last_activity?: number;
}

export interface SlackChannel extends Entity {
  channel_id: string;
  team_id: string;
  name: string;
  is_channel: boolean;
  is_private: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_open?: boolean;
  is_open_by_user?: Record<string, boolean>;
  user?: string;
  is_archived: boolean;
  topic: { value: string; creator: string; last_set: number };
  purpose: { value: string; creator: string; last_set: number };
  members: string[];
  creator: string;
  num_members: number;
  last_read?: Record<string, string>;
}

export type SlackJsonObject = Record<string, unknown>;

export interface SlackMessage extends Entity {
  ts: string;
  channel_id: string;
  user: string;
  text: string;
  type: "message";
  subtype?: string;
  files?: SlackFile[];
  upload?: boolean;
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
  app_id?: string;
  user_id?: string;
  name: string;
  deleted: boolean;
  icons: { image_48: string };
}

export interface SlackOAuthApp extends Entity {
  app_id?: string;
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
  scopes?: string[];
  user_scopes?: string[];
  bot_id?: string;
  bot_user_id?: string;
  bot_name?: string;
}

export interface SlackInstallation extends Entity {
  installation_id: string;
  app_id: string;
  client_id: string;
  team_id: string;
  app_name: string;
  installer_user_id: string;
  bot_id: string;
  bot_user_id: string;
  scopes: string[];
  user_scopes: string[];
}

export type SlackTokenType = "bot" | "user" | "test";

export interface SlackToken extends Entity {
  token: string;
  token_type: SlackTokenType;
  team_id: string;
  user_id: string;
  scopes: string[];
  app_id?: string;
  client_id?: string;
  installation_id?: string;
  bot_id?: string;
  bot_user_id?: string;
  authed_user_id?: string;
}

export interface SlackIncomingWebhook extends Entity {
  token: string;
  team_id: string;
  bot_id: string;
  default_channel: string;
  label: string;
  url: string;
}

export interface SlackFileShare {
  ts: string;
  channel_name?: string;
  team_id: string;
  share_user_id: string;
  source: "UNKNOWN" | "UPLOAD";
  thread_ts?: string;
  latest_reply?: string;
  reply_count: number;
  reply_users: string[];
  reply_users_count: number;
  is_silent_share: boolean;
}

export interface SlackFile extends Entity {
  file_id: string;
  team_id: string;
  user: string;
  name: string;
  title: string;
  mimetype: string;
  filetype: string;
  pretty_type: string;
  mode: "hosted" | "snippet";
  size: number;
  created: number;
  timestamp: number;
  url_private: string;
  url_private_download: string;
  permalink: string;
  is_external: boolean;
  external_type: string;
  is_public: boolean;
  public_url_shared: boolean;
  display_as_bot: boolean;
  editable: boolean;
  deleted: boolean;
  channels: string[];
  groups: string[];
  ims: string[];
  shares: {
    public?: Record<string, SlackFileShare[]>;
    private?: Record<string, SlackFileShare[]>;
  };
  initial_comment?: string;
  thread_ts?: string;
  alt_txt?: string;
  snippet_type?: string;
  content_base64?: string;
}

export interface SlackFileUploadSession extends Entity {
  file_id: string;
  team_id: string;
  user: string;
  filename: string;
  title: string;
  length: number;
  upload_url: string;
  alt_txt?: string;
  snippet_type?: string;
  uploaded: boolean;
  uploaded_size?: number;
  content_base64?: string;
  completed: boolean;
}

export interface SlackPin extends Entity {
  pin_id: string;
  team_id: string;
  channel_id: string;
  message_ts: string;
  created: number;
  created_by: string;
}

export interface SlackBookmark extends Entity {
  bookmark_id: string;
  team_id: string;
  channel_id: string;
  title: string;
  type: "link";
  link: string;
  emoji: string;
  icon_url: string;
  entity_id: string | null;
  date_created: number;
  date_updated: number;
  rank: string;
  last_updated_by_user_id: string;
  last_updated_by_team_id: string;
  shortcut_id: string | null;
  app_id: string | null;
  access_level?: "read" | "write";
  parent_id?: string;
}

export type SlackViewType = "home" | "modal";

export interface SlackView extends Entity {
  view_id: string;
  team_id: string;
  user_id: string;
  type: SlackViewType;
  blocks: SlackJsonObject[];
  private_metadata: string;
  callback_id: string;
  external_id: string;
  title: SlackJsonObject | null;
  submit: SlackJsonObject | null;
  close: SlackJsonObject | null;
  state: SlackJsonObject;
  hash: string;
  clear_on_close: boolean;
  notify_on_close: boolean;
  root_view_id: string;
  previous_view_id?: string;
  app_id: string;
  bot_id: string;
  created: number;
  updated: number;
}

export interface SlackViewTrigger extends Entity {
  trigger_id: string;
  team_id: string;
  user_id: string;
  expires_at: number;
  used: boolean;
  view_id?: string;
}
