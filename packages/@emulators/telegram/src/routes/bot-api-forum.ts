// Forum-topic Bot API methods: createForumTopic / editForumTopic /
// closeForumTopic / reopenForumTopic / deleteForumTopic. All four
// require a supergroup with is_forum=true.
import type { Context } from "hono";
import type { Store } from "@emulators/core";
import { getTelegramStore } from "../store.js";
import { ok, okRaw, tgError } from "../http.js";
import { parseWithSchema } from "../types/validators/body.js";
import {
  zCloseForumTopicBody,
  zCreateForumTopicBody,
  zDeleteForumTopicBody,
  zEditForumTopicBody,
} from "../types/validators/forum.js";
import type { TelegramForumTopic } from "../entities.js";

function requireForumChat(c: Context, chatId: number, store: Store) {
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", chatId);
  if (!chat) return { error: tgError(c, "Bad Request: chat not found") };
  if (chat.type !== "supergroup" || !chat.is_forum) {
    return { error: tgError(c, "Bad Request: CHAT_NOT_FORUM") };
  }
  return { chat };
}

function findForumTopic(store: Store, chatId: number, threadId: number): TelegramForumTopic | undefined {
  const ts = getTelegramStore(store);
  return ts.forumTopics
    .findBy("chat_id", chatId)
    .find((t) => t.message_thread_id === threadId && !t.is_deleted);
}

export function createForumTopicMethod(c: Context, raw: unknown, store: Store) {
  const r = parseWithSchema(c, zCreateForumTopicBody, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  const { chat, error } = requireForumChat(c, body.chat_id, store);
  if (error) return error;

  const ts = getTelegramStore(store);
  const existing = ts.forumTopics.findBy("chat_id", chat.chat_id);
  const maxId = existing.reduce((m, t) => Math.max(m, t.message_thread_id), 1);
  const message_thread_id = maxId + 1;
  const iconColor = body.icon_color ?? 0x6fb9f0;
  ts.forumTopics.insert({
    chat_id: chat.chat_id,
    message_thread_id,
    name: body.name,
    icon_color: iconColor,
    icon_custom_emoji_id: body.icon_custom_emoji_id,
  });
  const out: {
    message_thread_id: number;
    name: string;
    icon_color: number;
    icon_custom_emoji_id?: string;
  } = { message_thread_id, name: body.name, icon_color: iconColor };
  if (body.icon_custom_emoji_id) out.icon_custom_emoji_id = body.icon_custom_emoji_id;
  return ok(c, out);
}

export function editForumTopicMethod(c: Context, raw: unknown, store: Store) {
  const r = parseWithSchema(c, zEditForumTopicBody, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  const { chat, error } = requireForumChat(c, body.chat_id, store);
  if (error) return error;
  const topic = findForumTopic(store, chat.chat_id, body.message_thread_id);
  if (!topic) return tgError(c, "Bad Request: topic not found");

  const ts = getTelegramStore(store);
  const updates: Partial<TelegramForumTopic> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.icon_custom_emoji_id !== undefined) updates.icon_custom_emoji_id = body.icon_custom_emoji_id;
  ts.forumTopics.update(topic.id, updates);
  return okRaw(c, true);
}

export function closeForumTopicMethod(c: Context, raw: unknown, store: Store, close: boolean) {
  const r = parseWithSchema(c, zCloseForumTopicBody, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  const { chat, error } = requireForumChat(c, body.chat_id, store);
  if (error) return error;
  const topic = findForumTopic(store, chat.chat_id, body.message_thread_id);
  if (!topic) return tgError(c, "Bad Request: topic not found");

  const ts = getTelegramStore(store);
  ts.forumTopics.update(topic.id, { is_closed: close });
  return okRaw(c, true);
}

export function deleteForumTopicMethod(c: Context, raw: unknown, store: Store) {
  const r = parseWithSchema(c, zDeleteForumTopicBody, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  const { chat, error } = requireForumChat(c, body.chat_id, store);
  if (error) return error;
  const topic = findForumTopic(store, chat.chat_id, body.message_thread_id);
  if (!topic) return tgError(c, "Bad Request: topic not found");

  const ts = getTelegramStore(store);
  ts.forumTopics.update(topic.id, { is_deleted: true });
  return okRaw(c, true);
}
