import type { WireBotAsUser, WireUser } from "./user.js";

// Bot API `ChatMember` — discriminated union on `status`. The emulator
// models only the subset required for getChatMember and
// getChatAdministrators. Restricted/left/kicked carry the full wire
// shape so future work can emit them without widening.

type AdminPermissions = {
  can_be_edited: boolean;
  is_anonymous: boolean;
  can_manage_chat: boolean;
  can_delete_messages: boolean;
  can_manage_video_chats: boolean;
  can_restrict_members: boolean;
  can_promote_members: boolean;
  can_change_info: boolean;
  can_invite_users: boolean;
  can_post_messages?: boolean;
  can_edit_messages?: boolean;
  can_pin_messages?: boolean;
  can_manage_topics?: boolean;
};

// The emulator emits full admin-permission fields on the creator row
// too, matching real Telegram's ChatMemberOwner practice of carrying
// the same permission fields for introspection convenience.
export interface WireChatMemberOwner extends AdminPermissions {
  status: "creator";
  user: WireUser | WireBotAsUser;
  custom_title?: string;
}

export interface WireChatMemberAdministrator extends AdminPermissions {
  status: "administrator";
  user: WireUser | WireBotAsUser;
  custom_title?: string;
}

export interface WireChatMemberMember {
  status: "member";
  user: WireUser | WireBotAsUser;
  until_date?: number;
}

export interface WireChatMemberRestricted {
  status: "restricted";
  user: WireUser | WireBotAsUser;
  is_member: boolean;
  can_send_messages: boolean;
  can_send_audios: boolean;
  can_send_documents: boolean;
  can_send_photos: boolean;
  can_send_videos: boolean;
  can_send_video_notes: boolean;
  can_send_voice_notes: boolean;
  can_send_polls: boolean;
  can_send_other_messages: boolean;
  can_add_web_page_previews: boolean;
  can_change_info: boolean;
  can_invite_users: boolean;
  can_pin_messages: boolean;
  can_manage_topics: boolean;
  until_date: number;
}

export interface WireChatMemberLeft {
  status: "left";
  user: WireUser | WireBotAsUser;
}

export interface WireChatMemberBanned {
  status: "kicked";
  user: WireUser | WireBotAsUser;
  until_date: number;
}

export type WireChatMember =
  | WireChatMemberOwner
  | WireChatMemberAdministrator
  | WireChatMemberMember
  | WireChatMemberRestricted
  | WireChatMemberLeft
  | WireChatMemberBanned;
