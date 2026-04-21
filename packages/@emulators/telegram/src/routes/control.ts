import type { Context } from "hono";
import type { RouteContext, Store } from "@emulators/core";
import { getTelegramStore } from "../store.js";
import {
  generateBotToken,
  generateCallbackQueryId,
  nextBotId,
  nextChannelChatId,
  nextFileId,
  nextGroupChatId,
  nextSupergroupChatId,
  nextUserId,
} from "../ids.js";
import { parseJsonBody } from "../types/validators/body.js";
import {
  zChatMembershipInput,
  zCreateBotInput,
  zCreateChannelInput,
  zCreateForumTopicControlBody,
  zCreateGroupChatInput,
  zCreatePrivateChatInput,
  zCreateSupergroupInput,
  zCreateUserInput,
  zEditChannelPostInput,
  zInjectFaultInput,
  zPromoteChatMemberInput,
  zSimulateCallbackInput,
  zSimulateChannelPostInput,
  zSimulateEditedUserMessageInput,
  zSimulateReactionInput,
  zSimulateUserMediaInput,
  zSimulateUserMessageInput,
  zSimulateUserPhotoInput,
} from "../types/validators/control.js";
import {
  serializeBotAsUser,
  serializeChat,
  serializeMessage,
  serializeUser,
} from "../serializers.js";
import { parseEntities } from "../entity-parser.js";
import {
  allocateMessageId,
  buildMediaField as buildMediaFieldShared,
  buildPhotoSizes,
  defaultMimeForMediaKind as defaultMimeForMediaKindShared,
} from "../services/media.js";
import { getDispatcher } from "../dispatcher.js";
import { telegramPaths } from "../paths.js";
import type {
  InlineKeyboardMarkup,
  MessageEntity,
  TelegramBot,
  TelegramChat,
  TelegramMessage,
  TelegramUser,
} from "../entities.js";
import type {
  WireCallbackQuery,
  WireChatMemberUpdated,
  WireMessage,
  WireMessageReactionCountUpdated,
  WireMessageReactionUpdated,
  WireReactionCount,
} from "../types/wire/index.js";
import type { ReactionType } from "../types/wire/reaction.js";

// Chat ID conventions (match real Telegram):
//   private:    positive numbers equal to user_id
//   group:      negative numbers (allocator: nextGroupChatId)
//   supergroup: -100xxx range (allocator: nextSupergroupChatId)
//   channel:    -100xxx range, distinct allocator (nextChannelChatId)
function allocatePrivateChatId(userId: number): number {
  return userId;
}

export interface CreateBotInput {
  username: string;
  name?: string;
  first_name?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  commands?: Array<{ command: string; description: string }>;
  token?: string;
}

export interface CreateUserInput {
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface CreatePrivateChatInput {
  botId: number;
  userId: number;
}

export interface CreateGroupChatInput {
  title: string;
  type?: "group" | "supergroup";
  memberIds: number[];
  botIds: number[];
  creatorUserId?: number;
  adminUserIds?: number[];
  adminBotIds?: number[];
  isForum?: boolean;
}

export function createBot(store: Store, input: CreateBotInput): TelegramBot {
  const ts = getTelegramStore(store);
  const existingByUsername = ts.bots.findOneBy("username", input.username);
  if (existingByUsername) return existingByUsername;

  const bot_id = nextBotId(store);
  const token = input.token ?? generateBotToken(bot_id);
  return ts.bots.insert({
    bot_id,
    token,
    username: input.username,
    first_name: input.first_name ?? input.name ?? input.username,
    can_join_groups: input.can_join_groups ?? true,
    can_read_all_group_messages: input.can_read_all_group_messages ?? false,
    supports_inline_queries: false,
    webhook_url: null,
    webhook_secret: null,
    webhook_allowed_updates: null,
    commands: input.commands ?? [],
  });
}

export function createUser(store: Store, input: CreateUserInput): TelegramUser {
  const ts = getTelegramStore(store);
  if (input.username) {
    const existing = ts.users.findOneBy("username", input.username);
    if (existing) return existing;
  }
  const user_id = nextUserId(store);
  return ts.users.insert({
    user_id,
    is_bot: false,
    first_name: input.first_name,
    last_name: input.last_name,
    username: input.username,
    language_code: input.language_code,
  });
}

export function createPrivateChat(store: Store, input: CreatePrivateChatInput): TelegramChat {
  const ts = getTelegramStore(store);
  const chatId = allocatePrivateChatId(input.userId);
  const existing = ts.chats.findOneBy("chat_id", chatId);
  if (existing) {
    const updates: Partial<TelegramChat> = {};
    if (!existing.member_bot_ids.includes(input.botId)) {
      updates.member_bot_ids = [...existing.member_bot_ids, input.botId];
    }
    if (!existing.member_user_ids.includes(input.userId)) {
      updates.member_user_ids = [...existing.member_user_ids, input.userId];
    }
    if (Object.keys(updates).length > 0) {
      return ts.chats.update(existing.id, updates)!;
    }
    return existing;
  }
  const user = ts.users.findOneBy("user_id", input.userId);
  return ts.chats.insert({
    chat_id: chatId,
    type: "private",
    first_name: user?.first_name,
    last_name: user?.last_name,
    username: user?.username,
    member_user_ids: [input.userId],
    member_bot_ids: [input.botId],
    next_message_id: 1,
  });
}

export function createGroupChat(store: Store, input: CreateGroupChatInput): TelegramChat {
  const ts = getTelegramStore(store);
  const chatId = input.type === "supergroup" ? nextSupergroupChatId(store) : nextGroupChatId(store);
  // Creator defaults to the first member if not specified; real Telegram
  // always has a creator, so getChatAdministrators never returns empty.
  const creatorUserId = input.creatorUserId ?? input.memberIds[0];
  return ts.chats.insert({
    chat_id: chatId,
    type: input.type ?? "group",
    title: input.title,
    member_user_ids: [...input.memberIds],
    member_bot_ids: [...input.botIds],
    creator_user_id: creatorUserId,
    admin_user_ids: input.adminUserIds ? [...input.adminUserIds] : undefined,
    admin_bot_ids: input.adminBotIds ? [...input.adminBotIds] : undefined,
    next_message_id: 1,
    is_forum: input.type === "supergroup" ? input.isForum : undefined,
  });
}

export interface PromoteChatMemberInput {
  chatId: number;
  userId?: number;
  botId?: number;
  demote?: boolean;
}

export function promoteChatMember(store: Store, input: PromoteChatMemberInput): TelegramChat {
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", input.chatId);
  if (!chat) throw new Error(`chat ${input.chatId} not found`);
  const updates: Partial<TelegramChat> = {};
  if (input.userId !== undefined) {
    const admins = new Set(chat.admin_user_ids ?? []);
    if (input.demote) admins.delete(input.userId);
    else admins.add(input.userId);
    updates.admin_user_ids = Array.from(admins);
  }
  if (input.botId !== undefined) {
    const admins = new Set(chat.admin_bot_ids ?? []);
    if (input.demote) admins.delete(input.botId);
    else admins.add(input.botId);
    updates.admin_bot_ids = Array.from(admins);
  }
  return ts.chats.update(chat.id, updates) ?? chat;
}

export interface CreateSupergroupInput {
  title: string;
  memberIds: number[];
  botIds: number[];
  creatorUserId?: number;
  adminUserIds?: number[];
  adminBotIds?: number[];
  isForum?: boolean;
}

export function createSupergroup(store: Store, input: CreateSupergroupInput): TelegramChat {
  return createGroupChat(store, { ...input, type: "supergroup" });
}

export interface CreateChannelInput {
  title: string;
  username?: string;
  memberBotIds: number[];
  memberUserIds?: number[];
}

export function createChannel(store: Store, input: CreateChannelInput): TelegramChat {
  const ts = getTelegramStore(store);
  const chatId = nextChannelChatId(store);
  return ts.chats.insert({
    chat_id: chatId,
    type: "channel",
    title: input.title,
    username: input.username,
    member_user_ids: input.memberUserIds ?? [],
    member_bot_ids: [...input.memberBotIds],
    next_message_id: 1,
  });
}

export interface CreateForumTopicInput {
  chatId: number;
  name: string;
}

export function createForumTopic(
  store: Store,
  input: CreateForumTopicInput,
): { message_thread_id: number; name: string } {
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", input.chatId);
  if (!chat) throw new Error(`chat ${input.chatId} not found`);
  if (chat.type !== "supergroup") {
    throw new Error(`forum topics require a supergroup; chat ${input.chatId} is ${chat.type}`);
  }
  if (!chat.is_forum) {
    ts.chats.update(chat.id, { is_forum: true });
  }
  const existing = ts.forumTopics.findBy("chat_id", input.chatId);
  const maxId = existing.reduce((m, t) => Math.max(m, t.message_thread_id), 1);
  const message_thread_id = maxId + 1;
  ts.forumTopics.insert({
    chat_id: input.chatId,
    message_thread_id,
    name: input.name,
  });
  return { message_thread_id, name: input.name };
}

export interface SimulateChannelPostInput {
  chatId: number;
  text?: string;
  entities?: MessageEntity[];
  caption?: string;
  photoBytes?: Buffer;
  replyToMessageId?: number;
  messageThreadId?: number;
  edited?: boolean;
  existingMessageId?: number;
}

export function simulateChannelPost(
  store: Store,
  input: SimulateChannelPostInput,
): { message_id: number; update_id: number } {
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", input.chatId);
  if (!chat) throw new Error(`chat ${input.chatId} not found`);
  if (chat.type !== "channel") {
    throw new Error(`simulateChannelPost requires a channel; chat ${input.chatId} is ${chat.type}`);
  }

  let msg: TelegramMessage;
  if (input.edited) {
    if (input.existingMessageId === undefined) throw new Error("existingMessageId required for edited post");
    const existing = ts.messages
      .findBy("chat_id", input.chatId)
      .find((m) => m.message_id === input.existingMessageId);
    if (!existing) throw new Error(`message ${input.existingMessageId} not found`);
    ts.messages.update(existing.id, {
      text: input.text,
      entities: input.entities,
      caption: input.caption,
      edited_date: Math.floor(Date.now() / 1000),
    });
    msg = ts.messages.get(existing.id)!;
  } else {
    const messageId = allocateMessageId(store, chat);
    msg = ts.messages.insert({
      message_id: messageId,
      chat_id: chat.chat_id,
      from_user_id: null,
      from_bot_id: null,
      sender_chat_id: chat.chat_id,
      message_thread_id: input.messageThreadId,
      date: Math.floor(Date.now() / 1000),
      text: input.text,
      entities: input.entities,
      caption: input.caption,
      reply_to_message_id: input.replyToMessageId,
    });
  }

  const dispatcher = getDispatcher(store);
  let firstUpdateId = 0;
  for (const botId of chat.member_bot_ids) {
    const payload = serializeMessage(msg, { store });
    const type = input.edited ? ("edited_channel_post" as const) : ("channel_post" as const);
    const upd = dispatcher.enqueue(botId, type, payload);
    if (firstUpdateId === 0) firstUpdateId = upd.update_id;
  }

  return { message_id: msg.message_id, update_id: firstUpdateId };
}

import {
  clearFaults,
  getCallbackAnswer,
  injectFault,
  type InjectFaultInput,
} from "./control-diagnostics.js";
export { clearFaults, getCallbackAnswer, injectFault };
export type { InjectFaultInput };

export interface SimulateUserMediaInput {
  chatId: number;
  userId: number;
  kind: "photo" | "video" | "audio" | "voice" | "animation" | "sticker" | "document";
  bytes: Buffer;
  mimeType?: string;
  caption?: string;
  duration?: number;
  width?: number;
  height?: number;
  fileName?: string;
  messageThreadId?: number;
}

export function simulateUserMedia(
  store: Store,
  input: SimulateUserMediaInput,
): { message_id: number; update_id: number; file_id: string } {
  if (input.kind === "photo") {
    return simulateUserPhoto(store, {
      chatId: input.chatId,
      userId: input.userId,
      photoBytes: input.bytes,
      mimeType: input.mimeType,
      caption: input.caption,
    });
  }
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", input.chatId);
  if (!chat) throw new Error(`chat ${input.chatId} not found`);
  if (!chat.member_user_ids.includes(input.userId)) {
    throw new Error(`user ${input.userId} is not a member of chat ${input.chatId}`);
  }
  const firstBotId = chat.member_bot_ids[0];
  const ownerBot = firstBotId ?? 0;
  const { file_id, file_unique_id } = nextFileIdForKind(store, ownerBot, input.chatId, input.kind);
  ts.files.insert({
    file_id,
    file_unique_id,
    owner_bot_id: firstBotId ?? null,
    mime_type: input.mimeType ?? defaultMimeForMediaKindShared(input.kind),
    file_size: input.bytes.length,
    width: input.width ?? 0,
    height: input.height ?? 0,
    file_path: `${input.kind}s/${ownerBot}/${file_id}`,
    bytes_base64: input.bytes.toString("base64"),
    kind: input.kind,
    file_name: input.fileName,
    duration: input.duration,
  });

  const messageId = allocateMessageId(store, chat);

  const mediaField = buildMediaFieldShared({
    kind: input.kind,
    file_id,
    file_unique_id,
    file_size: input.bytes.length,
    width: input.width,
    height: input.height,
    duration: input.duration,
    mime_type: input.mimeType,
    file_name: input.fileName,
  });
  const msg = ts.messages.insert({
    message_id: messageId,
    chat_id: chat.chat_id,
    from_user_id: input.userId,
    from_bot_id: null,
    sender_chat_id: null,
    message_thread_id: input.messageThreadId,
    date: Math.floor(Date.now() / 1000),
    [input.kind]: mediaField,
    caption: input.caption,
  } as Parameters<typeof ts.messages.insert>[0]);

  const dispatcher = getDispatcher(store);
  let firstUpdateId = 0;
  for (const botId of chat.member_bot_ids) {
    const bot = ts.bots.findOneBy("bot_id", botId);
    if (!bot) continue;
    if (chat.type !== "private" && !bot.can_read_all_group_messages) continue;
    const upd = dispatcher.enqueue(botId, "message", serializeMessage(msg, { store }));
    if (firstUpdateId === 0) firstUpdateId = upd.update_id;
  }

  return { message_id: msg.message_id, update_id: firstUpdateId, file_id };
}

function nextFileIdForKind(
  store: Store,
  botId: number,
  chatId: number,
  kind: string,
): { file_id: string; file_unique_id: string } {
  return nextFileId(store, botId, chatId, kind[0]);
}

export interface SimulateUserMessageInput {
  chatId: number;
  userId: number;
  text: string;
  replyToMessageId?: number;
  messageThreadId?: number;
}

export function simulateUserMessage(store: Store, input: SimulateUserMessageInput): {
  message_id: number;
  update_id: number;
} {
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", input.chatId);
  if (!chat) throw new Error(`chat ${input.chatId} not found`);
  if (!chat.member_user_ids.includes(input.userId)) {
    throw new Error(`user ${input.userId} is not a member of chat ${input.chatId}`);
  }

  const entities = parseEntities(input.text);

  const messageId = allocateMessageId(store, chat);

  const msg = ts.messages.insert({
    message_id: messageId,
    chat_id: chat.chat_id,
    from_user_id: input.userId,
    from_bot_id: null,
    sender_chat_id: null,
    message_thread_id: input.messageThreadId,
    date: Math.floor(Date.now() / 1000),
    text: input.text,
    entities,
    reply_to_message_id: input.replyToMessageId,
  });

  // Dispatch an Update to every bot in the chat, subject to Telegram's
  // privacy rules for groups: bots only see messages that mention them or
  // start with a command addressed to them, unless can_read_all_group_messages.
  const dispatcher = getDispatcher(store);
  let firstUpdateId = 0;
  for (const botId of chat.member_bot_ids) {
    const bot = ts.bots.findOneBy("bot_id", botId);
    if (!bot) continue;
    if (chat.type !== "private" && !shouldBotSeeGroupMessage(input.text, entities, bot)) {
      continue;
    }
    const upd = dispatcher.enqueue(botId, "message", serializeMessage(msg, { store }));
    if (firstUpdateId === 0) firstUpdateId = upd.update_id;
  }

  return { message_id: msg.message_id, update_id: firstUpdateId };
}

function shouldBotSeeGroupMessage(text: string, entities: MessageEntity[], bot: TelegramBot): boolean {
  // Privacy mode (the default, can_read_all_group_messages = false):
  //   - @bot_username mention anywhere → delivered
  //   - /command@bot_username → delivered to that specific bot only
  //   - bare /command (no @) → NOT delivered (real Telegram drops it unless
  //     the bot has privacy off)
  //   - everything else → not delivered
  // Privacy off (can_read_all_group_messages = true): delivered unconditionally.
  if (bot.can_read_all_group_messages) return true;
  for (const e of entities) {
    const chunk = text.slice(e.offset, e.offset + e.length);
    if (e.type === "mention" && chunk.toLowerCase() === `@${bot.username.toLowerCase()}`) return true;
    if (e.type === "bot_command" && chunk.toLowerCase().endsWith(`@${bot.username.toLowerCase()}`)) return true;
  }
  return false;
}

export interface SimulateUserPhotoInput {
  chatId: number;
  userId: number;
  photoBytes: Buffer;
  mimeType?: string;
  caption?: string;
}

export function simulateUserPhoto(
  store: Store,
  input: SimulateUserPhotoInput,
): { message_id: number; update_id: number; file_id: string } {
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", input.chatId);
  if (!chat) throw new Error(`chat ${input.chatId} not found`);
  if (!chat.member_user_ids.includes(input.userId)) {
    throw new Error(`user ${input.userId} is not a member of chat ${input.chatId}`);
  }

  // Attribute uploaded photos to an "owner bot" scope for file_id — use the
  // first bot in the chat so getFile works for any bot that sees the message.
  const firstBotId = chat.member_bot_ids[0];
  if (firstBotId === undefined) {
    throw new Error(`chat ${input.chatId} has no bots to receive the photo`);
  }

  const { sizes } = buildPhotoSizes(store, input.photoBytes, firstBotId, input.chatId);
  const photoSizesJson = JSON.stringify(sizes);
  for (const size of sizes) {
    ts.files.insert({
      file_id: size.file_id,
      file_unique_id: size.file_unique_id,
      owner_bot_id: firstBotId,
      mime_type: input.mimeType ?? "image/jpeg",
      file_size: input.photoBytes.length,
      width: size.width,
      height: size.height,
      file_path: `photos/${firstBotId}/${size.file_id}`,
      bytes_base64: input.photoBytes.toString("base64"),
      kind: "photo" as const,
      photo_sizes_json: photoSizesJson,
    });
  }

  const messageId = allocateMessageId(store, chat);

  const msg = ts.messages.insert({
    message_id: messageId,
    chat_id: chat.chat_id,
    from_user_id: input.userId,
    from_bot_id: null,
    sender_chat_id: null,
    date: Math.floor(Date.now() / 1000),
    photo: sizes,
    caption: input.caption,
  });

  const dispatcher = getDispatcher(store);
  let firstUpdateId = 0;
  for (const botId of chat.member_bot_ids) {
    const bot = ts.bots.findOneBy("bot_id", botId);
    if (!bot) continue;
    if (chat.type !== "private" && !bot.can_read_all_group_messages) {
      // Per Telegram privacy rules, non-privileged bots do not see plain media in groups.
      continue;
    }
    const upd = dispatcher.enqueue(botId, "message", serializeMessage(msg, { store }));
    if (firstUpdateId === 0) firstUpdateId = upd.update_id;
  }

  return { message_id: msg.message_id, update_id: firstUpdateId, file_id: sizes[sizes.length - 1].file_id };
}

export interface SimulateCallbackInput {
  chatId: number;
  userId: number;
  messageId: number;
  callbackData: string;
}

export function simulateCallback(
  store: Store,
  input: SimulateCallbackInput,
): { callback_query_id: string; update_id: number } {
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", input.chatId);
  if (!chat) throw new Error(`chat ${input.chatId} not found`);
  const msg = ts.messages.findBy("chat_id", input.chatId).find((m) => m.message_id === input.messageId);
  if (!msg) throw new Error(`message ${input.messageId} in chat ${input.chatId} not found`);
  const botId = msg.from_bot_id;
  if (botId === null) throw new Error(`message ${input.messageId} was not sent by a bot`);

  const id = generateCallbackQueryId();
  ts.callbackQueries.insert({
    callback_query_id: id,
    from_user_id: input.userId,
    message_id: input.messageId,
    chat_id: input.chatId,
    data: input.callbackData,
    answered: false,
  });

  const user = ts.users.findOneBy("user_id", input.userId);
  if (!user) throw new Error(`user ${input.userId} not found`);

  const dispatcher = getDispatcher(store);
  const payload: WireCallbackQuery = {
    id,
    from: serializeUser(user),
    chat_instance: String(input.chatId),
    message: serializeMessage(msg, { store }),
    data: input.callbackData,
  };
  const upd = dispatcher.enqueue(botId, "callback_query", payload);
  return { callback_query_id: id, update_id: upd.update_id };
}

export function addBotToChat(
  store: Store,
  input: { chatId: number; botId: number; byUserId: number },
): { update_id: number } {
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", input.chatId);
  if (!chat) throw new Error(`chat ${input.chatId} not found`);
  const bot = ts.bots.findOneBy("bot_id", input.botId);
  if (!bot) throw new Error(`bot ${input.botId} not found`);
  const by = ts.users.findOneBy("user_id", input.byUserId);
  if (!by) throw new Error(`user ${input.byUserId} not found`);

  if (chat.member_bot_ids.includes(input.botId)) {
    return { update_id: 0 };
  }
  ts.chats.update(chat.id, { member_bot_ids: [...chat.member_bot_ids, input.botId] });

  const dispatcher = getDispatcher(store);
  const botUser = serializeBotAsUser(bot);
  const payload: WireChatMemberUpdated = {
    chat: serializeChat(chat),
    from: serializeUser(by),
    date: Math.floor(Date.now() / 1000),
    old_chat_member: { status: "left", user: botUser },
    new_chat_member: { status: "member", user: botUser },
  };
  const upd = dispatcher.enqueue(input.botId, "my_chat_member", payload);
  return { update_id: upd.update_id };
}

export function removeBotFromChat(
  store: Store,
  input: { chatId: number; botId: number; byUserId: number },
): { update_id: number } {
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", input.chatId);
  if (!chat) throw new Error(`chat ${input.chatId} not found`);
  const bot = ts.bots.findOneBy("bot_id", input.botId);
  if (!bot) throw new Error(`bot ${input.botId} not found`);
  const by = ts.users.findOneBy("user_id", input.byUserId);
  if (!by) throw new Error(`user ${input.byUserId} not found`);

  if (!chat.member_bot_ids.includes(input.botId)) {
    return { update_id: 0 };
  }
  ts.chats.update(chat.id, {
    member_bot_ids: chat.member_bot_ids.filter((id) => id !== input.botId),
  });

  const dispatcher = getDispatcher(store);
  const botUser = serializeBotAsUser(bot);
  const payload: WireChatMemberUpdated = {
    chat: serializeChat(chat),
    from: serializeUser(by),
    date: Math.floor(Date.now() / 1000),
    old_chat_member: { status: "member", user: botUser },
    new_chat_member: { status: "left", user: botUser },
  };
  const upd = dispatcher.enqueue(input.botId, "my_chat_member", payload);
  return { update_id: upd.update_id };
}

export interface SimulateReactionInput {
  chatId: number;
  messageId: number;
  userId: number;
  reaction: Array<{ type: "emoji"; emoji: string } | { type: "custom_emoji"; custom_emoji_id: string }>;
}

export function simulateReaction(
  store: Store,
  input: SimulateReactionInput,
): { update_id: number } {
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", input.chatId);
  if (!chat) throw new Error(`chat ${input.chatId} not found`);
  const msg = ts.messages.findBy("chat_id", input.chatId).find((m) => m.message_id === input.messageId);
  if (!msg) throw new Error(`message ${input.messageId} not found`);
  const user = ts.users.findOneBy("user_id", input.userId);
  if (!user) throw new Error(`user ${input.userId} not found`);

  // Upsert this user's reaction row
  const existing = ts.reactions
    .all()
    .find((r) => r.chat_id === input.chatId && r.message_id === input.messageId && r.sender_user_id === input.userId);
  const old_reaction = existing?.reaction ?? [];
  if (input.reaction.length === 0) {
    if (existing) ts.reactions.delete(existing.id);
  } else if (existing) {
    ts.reactions.update(existing.id, { reaction: input.reaction });
  } else {
    ts.reactions.insert({
      chat_id: input.chatId,
      message_id: input.messageId,
      sender_user_id: input.userId,
      sender_bot_id: null,
      reaction: input.reaction,
    });
  }

  // Aggregate current reactions across all users for the count variant.
  const aggregate = new Map<string, { total: number; reaction: ReactionType }>();
  for (const r of ts.reactions.findBy("chat_id", input.chatId)) {
    if (r.message_id !== input.messageId) continue;
    for (const rx of r.reaction) {
      const key = rx.type === "emoji" ? `e:${rx.emoji}` : `c:${rx.custom_emoji_id}`;
      const cur = aggregate.get(key);
      if (cur) cur.total += 1;
      else aggregate.set(key, { total: 1, reaction: rx });
    }
  }
  const reactions_count: WireReactionCount[] = Array.from(aggregate.values()).map((a) => ({
    type: a.reaction,
    total_count: a.total,
  }));

  // Dispatch message_reaction (per-user) and message_reaction_count
  // (anonymous aggregate) to all bots in the chat.
  const dispatcher = getDispatcher(store);
  let firstUpdateId = 0;
  const chatPayload = serializeChat(chat);
  const date = Math.floor(Date.now() / 1000);
  for (const botId of chat.member_bot_ids) {
    const bot = ts.bots.findOneBy("bot_id", botId);
    if (!bot) continue;
    const perUser: WireMessageReactionUpdated = {
      chat: chatPayload,
      message_id: input.messageId,
      user: serializeUser(user),
      date,
      old_reaction,
      new_reaction: input.reaction,
    };
    const upd = dispatcher.enqueue(botId, "message_reaction", perUser);
    if (firstUpdateId === 0) firstUpdateId = upd.update_id;
    const countPayload: WireMessageReactionCountUpdated = {
      chat: chatPayload,
      message_id: input.messageId,
      date,
      reactions: reactions_count,
    };
    dispatcher.enqueue(botId, "message_reaction_count", countPayload);
  }

  return { update_id: firstUpdateId };
}

export function getDraftHistory(
  store: Store,
  input: { chatId: number; draftId: number; botId?: number },
): Array<{ seq: number; text: string; entities?: unknown[]; bot_id: number }> {
  const ts = getTelegramStore(store);
  return ts.draftSnapshots
    .findBy("chat_id", input.chatId)
    .filter((s) => s.draft_id === input.draftId && (input.botId === undefined || s.bot_id === input.botId))
    .sort((a, b) => a.seq - b.seq)
    .map((s) => ({ seq: s.seq, text: s.text, entities: s.entities, bot_id: s.bot_id }));
}

export function simulateEditedUserMessage(
  store: Store,
  input: { chatId: number; messageId: number; userId: number; text: string; messageThreadId?: number },
): { update_id: number } {
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", input.chatId);
  if (!chat) throw new Error(`chat ${input.chatId} not found`);
  const msg = ts.messages.findBy("chat_id", input.chatId).find((m) => m.message_id === input.messageId);
  if (!msg) throw new Error(`message ${input.messageId} not found`);
  if (msg.from_user_id !== input.userId) throw new Error("cannot edit message from another user");
  const entities = parseEntities(input.text);
  ts.messages.update(msg.id, { text: input.text, entities, edited_date: Math.floor(Date.now() / 1000) });

  const dispatcher = getDispatcher(store);
  const updated = ts.messages.get(msg.id)!;
  let firstUpdateId = 0;
  for (const botId of chat.member_bot_ids) {
    const bot = ts.bots.findOneBy("bot_id", botId);
    if (!bot) continue;
    if (chat.type !== "private" && !shouldBotSeeGroupMessage(input.text, entities, bot)) continue;
    const upd = dispatcher.enqueue(botId, "edited_message", serializeMessage(updated, { store }));
    if (firstUpdateId === 0) firstUpdateId = upd.update_id;
  }
  return { update_id: firstUpdateId };
}

export function getSentMessages(store: Store, chatId: number): WireMessage[] {
  const ts = getTelegramStore(store);
  return ts.messages
    .findBy("chat_id", chatId)
    .filter((m) => m.from_bot_id !== null && !m.deleted)
    .sort((a, b) => a.message_id - b.message_id)
    .map((m) => serializeMessage(m, { store }));
}

export function getAllMessages(store: Store, chatId: number): WireMessage[] {
  const ts = getTelegramStore(store);
  return ts.messages
    .findBy("chat_id", chatId)
    .filter((m) => !m.deleted)
    .sort((a, b) => a.message_id - b.message_id)
    .map((m) => serializeMessage(m, { store }));
}

export function controlRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.post(telegramPaths.reset(), (c: Context) => {
    store.reset();
    return c.json({ ok: true });
  });

  app.post(telegramPaths.bots(), async (c) => {
    const r = await parseJsonBody(c, zCreateBotInput);
    if (!r.ok) return r.response;
    const bot = createBot(store, r.data);
    return c.json({ ok: true, bot: toBotDto(bot) });
  });

  app.get(telegramPaths.bots(), (c) => {
    const ts = getTelegramStore(store);
    return c.json({ ok: true, bots: ts.bots.all().map(toBotDto) });
  });

  app.post(telegramPaths.users(), async (c) => {
    const r = await parseJsonBody(c, zCreateUserInput);
    if (!r.ok) return r.response;
    const user = createUser(store, r.data);
    return c.json({ ok: true, user: serializeUser(user) });
  });

  app.post(telegramPaths.privateChat(), async (c) => {
    const r = await parseJsonBody(c, zCreatePrivateChatInput);
    if (!r.ok) return r.response;
    const chat = createPrivateChat(store, r.data);
    return c.json({ ok: true, chat: serializeChat(chat) });
  });

  app.post(telegramPaths.groupChat(), async (c) => {
    const r = await parseJsonBody(c, zCreateGroupChatInput);
    if (!r.ok) return r.response;
    const chat = createGroupChat(store, r.data);
    return c.json({ ok: true, chat: serializeChat(chat) });
  });

  app.post(telegramPaths.chatPromote(":chatId"), async (c) => {
    const r = await parseJsonBody(c, zPromoteChatMemberInput);
    if (!r.ok) return r.response;
    const chatId = Number(c.req.param("chatId"));
    const chat = promoteChatMember(store, {
      chatId,
      userId: r.data.userId,
      botId: r.data.botId,
      demote: r.data.demote === true,
    });
    return c.json({ ok: true, chat: serializeChat(chat) });
  });

  app.post(telegramPaths.chatMessages(":chatId"), async (c) => {
    const r = await parseJsonBody(c, zSimulateUserMessageInput);
    if (!r.ok) return r.response;
    const chatId = Number(c.req.param("chatId"));
    const result = simulateUserMessage(store, {
      chatId,
      userId: r.data.userId,
      text: r.data.text,
      replyToMessageId: r.data.replyToMessageId,
      messageThreadId: r.data.messageThreadId,
    });
    return c.json({ ok: true, ...result });
  });

  app.post(telegramPaths.chatPhotos(":chatId"), async (c) => {
    const r = await parseJsonBody(c, zSimulateUserPhotoInput);
    if (!r.ok) return r.response;
    const chatId = Number(c.req.param("chatId"));
    const photoBytes = r.data.photoBase64 !== undefined
      ? Buffer.from(r.data.photoBase64, "base64")
      : r.data.photo!.bytes;
    const result = simulateUserPhoto(store, {
      chatId,
      userId: r.data.userId,
      photoBytes,
      mimeType: r.data.mimeType,
      caption: r.data.caption,
    });
    return c.json({ ok: true, ...result });
  });

  app.post(telegramPaths.chatCallbacks(":chatId"), async (c) => {
    const r = await parseJsonBody(c, zSimulateCallbackInput);
    if (!r.ok) return r.response;
    const chatId = Number(c.req.param("chatId"));
    const result = simulateCallback(store, {
      chatId,
      userId: r.data.userId,
      messageId: r.data.messageId,
      callbackData: r.data.data ?? r.data.callbackData ?? "",
    });
    return c.json({ ok: true, ...result });
  });

  app.post(telegramPaths.chatEdits(":chatId"), async (c) => {
    const r = await parseJsonBody(c, zSimulateEditedUserMessageInput);
    if (!r.ok) return r.response;
    const chatId = Number(c.req.param("chatId"));
    const result = simulateEditedUserMessage(store, {
      chatId,
      messageId: r.data.messageId,
      userId: r.data.userId,
      text: r.data.text,
      messageThreadId: r.data.messageThreadId,
    });
    return c.json({ ok: true, ...result });
  });

  app.get(telegramPaths.chatMessages(":chatId"), (c) => {
    const chatId = Number(c.req.param("chatId"));
    const scope = c.req.query("scope") ?? "all";
    const items = scope === "bot" ? getSentMessages(store, chatId) : getAllMessages(store, chatId);
    return c.json({ ok: true, messages: items });
  });

  app.post(telegramPaths.chatAddBot(":chatId"), async (c) => {
    const r = await parseJsonBody(c, zChatMembershipInput);
    if (!r.ok) return r.response;
    const chatId = Number(c.req.param("chatId"));
    const result = addBotToChat(store, { chatId, botId: r.data.botId, byUserId: r.data.byUserId });
    return c.json({ ok: true, ...result });
  });

  app.post(telegramPaths.chatRemoveBot(":chatId"), async (c) => {
    const r = await parseJsonBody(c, zChatMembershipInput);
    if (!r.ok) return r.response;
    const chatId = Number(c.req.param("chatId"));
    const result = removeBotFromChat(store, { chatId, botId: r.data.botId, byUserId: r.data.byUserId });
    return c.json({ ok: true, ...result });
  });

  app.post(telegramPaths.chatReactions(":chatId"), async (c) => {
    const r = await parseJsonBody(c, zSimulateReactionInput);
    if (!r.ok) return r.response;
    const chatId = Number(c.req.param("chatId"));
    const result = simulateReaction(store, {
      chatId,
      messageId: r.data.messageId,
      userId: r.data.userId,
      reaction: r.data.reaction,
    });
    return c.json({ ok: true, ...result });
  });

  app.get(telegramPaths.chatDraft(":chatId", ":draftId"), (c) => {
    const chatId = Number(c.req.param("chatId"));
    const draftId = Number(c.req.param("draftId"));
    const snapshots = getDraftHistory(store, { chatId, draftId });
    return c.json({ ok: true, snapshots });
  });

  app.post(telegramPaths.channel(), async (c) => {
    const r = await parseJsonBody(c, zCreateChannelInput);
    if (!r.ok) return r.response;
    const chat = createChannel(store, r.data);
    return c.json({ ok: true, chat: serializeChat(chat) });
  });

  app.post(telegramPaths.supergroup(), async (c) => {
    const r = await parseJsonBody(c, zCreateSupergroupInput);
    if (!r.ok) return r.response;
    const chat = createSupergroup(store, r.data);
    return c.json({ ok: true, chat: serializeChat(chat) });
  });

  app.post(telegramPaths.chatTopics(":chatId"), async (c) => {
    const r = await parseJsonBody(c, zCreateForumTopicControlBody);
    if (!r.ok) return r.response;
    const chatId = Number(c.req.param("chatId"));
    const result = createForumTopic(store, { chatId, name: r.data.name });
    return c.json({ ok: true, ...result });
  });

  app.post(telegramPaths.channelPosts(":chatId"), async (c) => {
    const r = await parseJsonBody(c, zSimulateChannelPostInput);
    if (!r.ok) return r.response;
    const chatId = Number(c.req.param("chatId"));
    const photoBytes =
      r.data.photo_bytes_base64 !== undefined
        ? Buffer.from(r.data.photo_bytes_base64, "base64")
        : undefined;
    const result = simulateChannelPost(store, {
      chatId,
      text: r.data.text,
      entities: r.data.entities,
      caption: r.data.caption,
      photoBytes,
      replyToMessageId: r.data.reply_to_message_id,
      messageThreadId: r.data.message_thread_id,
    });
    return c.json({ ok: true, ...result });
  });

  app.post(telegramPaths.channelPostEdits(":chatId"), async (c) => {
    const r = await parseJsonBody(c, zEditChannelPostInput);
    if (!r.ok) return r.response;
    const chatId = Number(c.req.param("chatId"));
    const result = simulateChannelPost(store, {
      chatId,
      text: r.data.text,
      caption: r.data.caption,
      edited: true,
      existingMessageId: r.data.messageId,
    });
    return c.json({ ok: true, ...result });
  });

  app.post(telegramPaths.chatMedia(":chatId"), async (c) => {
    const r = await parseJsonBody(c, zSimulateUserMediaInput);
    if (!r.ok) return r.response;
    const chatId = Number(c.req.param("chatId"));
    const bytes = r.data.bytesBase64 !== undefined
      ? Buffer.from(r.data.bytesBase64, "base64")
      : r.data.file!.bytes;
    const result = simulateUserMedia(store, {
      chatId,
      userId: r.data.userId,
      kind: r.data.kind,
      bytes,
      mimeType: r.data.mimeType,
      caption: r.data.caption,
      duration: r.data.duration,
      width: r.data.width,
      height: r.data.height,
      fileName: r.data.fileName,
      messageThreadId: r.data.messageThreadId,
    });
    return c.json({ ok: true, ...result });
  });

  app.post(telegramPaths.faults(), async (c) => {
    const r = await parseJsonBody(c, zInjectFaultInput);
    if (!r.ok) return r.response;
    const result = injectFault(store, {
      botId: (r.data.bot_id ?? r.data.botId)!,
      method: r.data.method ?? "*",
      error_code: (r.data.error_code ?? r.data.errorCode)!,
      description: r.data.description,
      retry_after: r.data.retry_after ?? r.data.retryAfter,
      count: r.data.count,
    });
    return c.json({ ok: true, ...result });
  });

  app.delete(telegramPaths.faults(), (c) => {
    clearFaults(store);
    return c.json({ ok: true });
  });

  app.get(telegramPaths.callbackById(":id"), (c) => {
    const id = c.req.param("id") ?? "";
    const answer = getCallbackAnswer(store, id);
    if (!answer) return c.json({ ok: false, error: "callback_query not found" }, 404);
    return c.json({ ok: true, ...answer });
  });
}

function toBotDto(bot: TelegramBot) {
  return {
    bot_id: bot.bot_id,
    token: bot.token,
    username: bot.username,
    first_name: bot.first_name,
    webhook_url: bot.webhook_url,
    commands: bot.commands,
  };
}

// Re-export for tests
export function registerInlineKeyboardMarkup(
  markup: InlineKeyboardMarkup,
): InlineKeyboardMarkup {
  return markup;
}
