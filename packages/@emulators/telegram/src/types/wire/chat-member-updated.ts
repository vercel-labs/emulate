import type { WireChat } from "./chat.js";
import type { WireChatMember } from "./chat-member.js";
import type { WireBotAsUser, WireUser } from "./user.js";

// Bot API `ChatMemberUpdated` object — the body of `chat_member` and
// `my_chat_member` Updates. The emulator emits abbreviated owner /
// member rows but keeps the full WireChatMember discriminator so
// consumers can narrow on `status`.
export interface WireChatMemberUpdated {
  chat: WireChat;
  from: WireUser | WireBotAsUser;
  date: number;
  old_chat_member: WireChatMember;
  new_chat_member: WireChatMember;
  invite_link?: { invite_link: string; creator: WireUser; is_primary: boolean; is_revoked: boolean };
}
