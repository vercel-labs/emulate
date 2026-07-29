import type { Entity } from "@emulators/core";
import type { ReactionType } from "../wire/reaction.js";

export type ChatType = "private" | "group" | "supergroup" | "channel";

export interface ChatPermissions {
  can_send_messages?: boolean;
  can_send_audios?: boolean;
  can_send_documents?: boolean;
  can_send_photos?: boolean;
  can_send_videos?: boolean;
  can_send_video_notes?: boolean;
  can_send_voice_notes?: boolean;
  can_send_polls?: boolean;
  can_send_other_messages?: boolean;
  can_add_web_page_previews?: boolean;
  can_change_info?: boolean;
  can_invite_users?: boolean;
  can_pin_messages?: boolean;
  can_manage_topics?: boolean;
}

export interface TelegramChat extends Entity {
  chat_id: number;
  type: ChatType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  member_user_ids: number[];
  member_bot_ids: number[];
  creator_user_id?: number;
  admin_user_ids?: number[];
  admin_bot_ids?: number[];
  next_message_id: number;
  // ChatFullInfo extras — defaulted, mutable via control plane.
  bio?: string;
  description?: string;
  invite_link?: string;
  pinned_message_id?: number;
  permissions?: ChatPermissions;
  slow_mode_delay?: number;
  message_auto_delete_time?: number;
  has_protected_content?: boolean;
  linked_chat_id?: number;
  available_reactions?: ReactionType[];
  accent_color_id?: number;
  max_reaction_count?: number;
  is_forum?: boolean;
}
