// Chat-inspection Bot API methods: getChat, getChatMember,
// getChatAdministrators, getChatMemberCount, sendChatAction.
import type { Context } from "hono";
import type { Store } from "@emulators/core";
import { getTelegramStore } from "../store.js";
import { ok, okRaw, tgError } from "../http.js";
import { serializeBotAsUser, serializeChatFullInfo, serializeUser } from "../serializers.js";
import { parseWithSchema } from "../types/validators/body.js";
import {
  zGetChatAdministratorsBody,
  zGetChatBody,
  zGetChatMemberBody,
  zGetChatMemberCountBody,
} from "../types/validators/chats.js";
import type { TelegramChat } from "../entities.js";
import type {
  WireBotAsUser,
  WireChatMember,
  WireChatMemberAdministrator,
  WireChatMemberOwner,
  WireUser,
} from "../types/wire/index.js";

type MemberStatus = "creator" | "administrator" | "member" | "left";

function chatMemberStatus(chat: TelegramChat, subjectId: number, isBot: boolean): MemberStatus {
  if (isBot) {
    if (!chat.member_bot_ids.includes(subjectId)) return "left";
    if ((chat.admin_bot_ids ?? []).includes(subjectId)) return "administrator";
    // Bots in their own private chat effectively behave as admins.
    if (chat.type === "private") return "administrator";
    return "member";
  }
  if (!chat.member_user_ids.includes(subjectId)) return "left";
  if (chat.creator_user_id === subjectId) return "creator";
  if ((chat.admin_user_ids ?? []).includes(subjectId)) return "administrator";
  return "member";
}

function buildChatMember(
  status: MemberStatus,
  user: WireUser | WireBotAsUser,
  chat: TelegramChat,
): WireChatMember {
  if (status === "left") return { status: "left", user };
  if (status === "member") return { status: "member", user };

  const isForum = chat.type === "supergroup" && chat.is_forum === true;
  const base = {
    user,
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: true,
    can_manage_video_chats: true,
    can_restrict_members: status === "creator",
    can_promote_members: status === "creator",
    can_change_info: true,
    can_invite_users: true,
  };
  const channelRights = chat.type === "channel"
    ? { can_post_messages: true, can_edit_messages: true }
    : { can_pin_messages: true };
  const forumRights = isForum ? { can_manage_topics: true } : {};

  if (status === "creator") {
    const owner: WireChatMemberOwner = {
      ...base,
      ...channelRights,
      ...forumRights,
      status: "creator",
      can_be_edited: false,
    };
    return owner;
  }
  const admin: WireChatMemberAdministrator = {
    ...base,
    ...channelRights,
    ...forumRights,
    status: "administrator",
    can_be_edited: true,
  };
  return admin;
}

export function getChat(c: Context, raw: unknown, store: Store) {
  const r = parseWithSchema(c, zGetChatBody, raw);
  if (!r.ok) return r.response;

  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", r.data.chat_id);
  if (!chat) return tgError(c, "Bad Request: chat not found");
  return ok(c, serializeChatFullInfo(chat, { store }));
}

export function getChatMember(c: Context, raw: unknown, store: Store) {
  const r = parseWithSchema(c, zGetChatMemberBody, raw);
  if (!r.ok) return r.response;
  const { chat_id: chatId, user_id: userId } = r.data;

  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", chatId);
  if (!chat) return tgError(c, "Bad Request: chat not found");

  const user = ts.users.findOneBy("user_id", userId);
  const bot = ts.bots.findOneBy("bot_id", userId);
  const isBotSubject = !!bot && !user;
  const knownMember =
    (user && chat.member_user_ids.includes(userId)) || (bot && chat.member_bot_ids.includes(userId));

  if (!user && !bot) return tgError(c, "Bad Request: user not found");
  if (!knownMember) return tgError(c, "Bad Request: user not found in chat");

  const status = chatMemberStatus(chat, userId, isBotSubject);
  const subject: WireUser | WireBotAsUser = user ? serializeUser(user) : serializeBotAsUser(bot!);
  const member = buildChatMember(status, subject, chat);
  return ok(c, member);
}

export function getChatAdministrators(c: Context, raw: unknown, store: Store) {
  const r = parseWithSchema(c, zGetChatAdministratorsBody, raw);
  if (!r.ok) return r.response;

  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", r.data.chat_id);
  if (!chat) return tgError(c, "Bad Request: chat not found");

  const admins: WireChatMember[] = [];

  if (chat.creator_user_id !== undefined) {
    const u = ts.users.findOneBy("user_id", chat.creator_user_id);
    if (u) admins.push(buildChatMember("creator", serializeUser(u), chat));
  }
  for (const uid of chat.admin_user_ids ?? []) {
    if (uid === chat.creator_user_id) continue;
    const u = ts.users.findOneBy("user_id", uid);
    if (u) admins.push(buildChatMember("administrator", serializeUser(u), chat));
  }
  for (const bid of chat.admin_bot_ids ?? []) {
    const b = ts.bots.findOneBy("bot_id", bid);
    if (b) admins.push(buildChatMember("administrator", serializeBotAsUser(b), chat));
  }
  return okRaw(c, admins);
}

export function getChatMemberCount(c: Context, raw: unknown, store: Store) {
  const r = parseWithSchema(c, zGetChatMemberCountBody, raw);
  if (!r.ok) return r.response;

  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", r.data.chat_id);
  if (!chat) return tgError(c, "Bad Request: chat not found");
  const count = chat.member_user_ids.length + chat.member_bot_ids.length;
  return c.json({ ok: true, result: count });
}

export function sendChatAction(c: Context) {
  return c.json({ ok: true, result: true });
}
