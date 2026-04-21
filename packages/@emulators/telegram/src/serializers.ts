import type { Store } from "@emulators/core";
import { getTelegramStore } from "./store.js";
import type {
  TelegramBot,
  TelegramChat,
  TelegramMessage,
  TelegramUser,
} from "./entities.js";
import type {
  WireBotAsUser,
  WireChat,
  WireChatFullInfo,
  WireMessage,
  WireUser,
} from "./types/wire/index.js";
import type { ChatPermissions } from "./types/store/chat.js";

export function resolveBotFromToken(store: Store, token: string): TelegramBot | null {
  const ts = getTelegramStore(store);
  const direct = ts.bots.findOneBy("token", token);
  return direct ?? null;
}

export function serializeUser(u: TelegramUser): WireUser {
  const out: WireUser = {
    id: u.user_id,
    is_bot: u.is_bot,
    first_name: u.first_name,
  };
  if (u.last_name) out.last_name = u.last_name;
  if (u.username) out.username = u.username;
  if (u.language_code) out.language_code = u.language_code;
  return out;
}

export function serializeBotAsUser(b: TelegramBot): WireBotAsUser {
  return {
    id: b.bot_id,
    is_bot: true,
    first_name: b.first_name,
    username: b.username,
  };
}

export function serializeChat(ch: TelegramChat): WireChat {
  const out: WireChat = {
    id: ch.chat_id,
    type: ch.type,
  };
  if (ch.title) out.title = ch.title;
  if (ch.username) out.username = ch.username;
  if (ch.first_name) out.first_name = ch.first_name;
  if (ch.last_name) out.last_name = ch.last_name;
  if (ch.is_forum) out.is_forum = true;
  return out;
}

const DEFAULT_GROUP_PERMISSIONS: ChatPermissions = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: false,
  can_invite_users: true,
  can_pin_messages: false,
  can_manage_topics: false,
};

export function serializeChatFullInfo(
  ch: TelegramChat,
  ctx: { store: Store },
): WireChatFullInfo {
  const out: WireChatFullInfo = {
    ...serializeChat(ch),
    accent_color_id: ch.accent_color_id ?? 0,
    max_reaction_count: ch.max_reaction_count ?? 11,
  };
  if (ch.bio) out.bio = ch.bio;
  if (ch.description) out.description = ch.description;
  if (ch.invite_link) out.invite_link = ch.invite_link;
  if (ch.slow_mode_delay !== undefined) out.slow_mode_delay = ch.slow_mode_delay;
  if (ch.message_auto_delete_time !== undefined) out.message_auto_delete_time = ch.message_auto_delete_time;
  if (ch.has_protected_content) out.has_protected_content = true;
  if (ch.linked_chat_id !== undefined) out.linked_chat_id = ch.linked_chat_id;
  if (ch.available_reactions) out.available_reactions = ch.available_reactions;
  if (ch.type === "group" || ch.type === "supergroup") {
    out.permissions = ch.permissions ?? DEFAULT_GROUP_PERMISSIONS;
  }
  if (ch.pinned_message_id !== undefined) {
    const ts = getTelegramStore(ctx.store);
    const pinned = ts.messages
      .findBy("chat_id", ch.chat_id)
      .find((m) => m.message_id === ch.pinned_message_id && !m.deleted);
    if (pinned) out.pinned_message = serializeMessage(pinned, { store: ctx.store });
  }
  return out;
}

export function serializeMessage(
  msg: TelegramMessage,
  ctx: { store: Store; depth?: number },
): WireMessage {
  const ts = getTelegramStore(ctx.store);
  const chat = ts.chats.findOneBy("chat_id", msg.chat_id);
  const fromUser = msg.from_user_id !== null ? ts.users.findOneBy("user_id", msg.from_user_id) : undefined;
  const fromBot = msg.from_bot_id !== null ? ts.bots.findOneBy("bot_id", msg.from_bot_id) : undefined;
  const senderChat =
    msg.sender_chat_id !== null && msg.sender_chat_id !== undefined
      ? ts.chats.findOneBy("chat_id", msg.sender_chat_id)
      : undefined;

  const from: WireUser | WireBotAsUser | undefined = fromUser
    ? serializeUser(fromUser)
    : fromBot
      ? serializeBotAsUser(fromBot)
      : undefined;

  const out: WireMessage = {
    message_id: msg.message_id,
    date: msg.date,
    chat: chat ? serializeChat(chat) : { id: msg.chat_id, type: "private" },
  };
  if (from) out.from = from;
  if (senderChat) out.sender_chat = serializeChat(senderChat);
  if (msg.message_thread_id !== undefined) out.message_thread_id = msg.message_thread_id;
  if (msg.text !== undefined) out.text = msg.text;
  if (msg.entities && msg.entities.length > 0) out.entities = msg.entities;
  if (msg.photo && msg.photo.length > 0) out.photo = msg.photo;
  if (msg.document) out.document = msg.document;
  if (msg.audio) out.audio = msg.audio;
  if (msg.voice) out.voice = msg.voice;
  if (msg.video) out.video = msg.video;
  if (msg.animation) out.animation = msg.animation;
  if (msg.sticker) out.sticker = msg.sticker;
  if (msg.caption !== undefined) out.caption = msg.caption;
  if (msg.caption_entities && msg.caption_entities.length > 0) out.caption_entities = msg.caption_entities;
  if (msg.reply_to_message_id !== undefined) {
    out.reply_to_message_id = msg.reply_to_message_id;
    const depth = ctx.depth ?? 0;
    if (depth < 1) {
      const quoted = ts.messages
        .findBy("chat_id", msg.chat_id)
        .find((m) => m.message_id === msg.reply_to_message_id && !m.deleted);
      if (quoted) {
        out.reply_to_message = serializeMessage(quoted, { store: ctx.store, depth: depth + 1 });
      }
    }
  }
  if (msg.reply_markup) out.reply_markup = msg.reply_markup;
  if (msg.edited_date !== undefined) out.edit_date = msg.edited_date;
  return out;
}
