import type { Context } from "hono";
import type { RouteContext, Store } from "@emulators/core";
import { getTelegramStore } from "../store.js";
import { nextFileId } from "../ids.js";
import { ok, okRaw, parseTelegramBody, tgError } from "../http.js";
import {
  resolveBotFromToken,
  serializeMessage,
} from "../serializers.js";
import { parseEntities } from "../entity-parser.js";
import { getDispatcher } from "../dispatcher.js";
import { MarkdownParseError, parseMarkdownV2 } from "../markdown.js";
import { HtmlParseError, parseHtml } from "../html.js";
import { allocateMessageId, buildMediaField, buildPhotoSizes } from "../services/media.js";
import {
  closeForumTopicMethod,
  createForumTopicMethod,
  deleteForumTopicMethod,
  editForumTopicMethod,
} from "./bot-api-forum.js";
import {
  getChat,
  getChatAdministrators,
  getChatMember,
  getChatMemberCount,
  sendChatAction,
} from "./bot-api-chats.js";
import {
  deleteWebhook,
  getMe,
  getUpdates,
  getWebhookInfo,
  setWebhook,
} from "./bot-api-delivery.js";
import type { z } from "zod";
import { parseWithSchema, type ParseResult } from "../types/validators/body.js";
import {
  zAnswerCallbackQueryBody,
  zDeleteMessageBody,
  zEditMessageReplyMarkupBody,
  zEditMessageTextBody,
  zGetFileBody,
  zSendMessageBody,
  zSendMessageDraftBody,
  zSendPhotoBody,
  zSendDocumentBody,
  zSetMessageReactionBody,
  zSetMyCommandsBody,
  BODY_FOR_MEDIA,
  type MediaKind,
  type SendAnimationBody,
  type SendAudioBody,
  type SendStickerBody,
  type SendVideoBody,
  type SendVoiceBody,
  type MultipartFileRef,
} from "../types/validators/index.js";
import type {
  InlineKeyboardMarkup,
  MessageEntity,
  PhotoSize,
  ReplyMarkup,
  TelegramBot,
  TelegramChat,
  TelegramDocument,
  TelegramFault,
  TelegramMessage,
} from "../entities.js";
import { isInlineKeyboardMarkup } from "../types/wire/reply-markup.js";

function isMultipartFile(v: unknown): v is MultipartFileRef {
  return typeof v === "object" && v !== null && (v as { __file?: boolean }).__file === true;
}

export function botApiRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ts = () => getTelegramStore(store);
  const dispatcher = () => getDispatcher(store);

  // All Bot API methods live under /bot<token>/<method>.
  // We accept both GET (query/form) and POST (json/form/multipart).
  // Hono's inline :param doesn't play well with tokens containing ":", so we
  // use a wildcard and parse the path ourselves.
  const methodHandler = async (c: Context) => {
    const path = new URL(c.req.url).pathname;
    const m = path.match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
    if (!m) return tgError(c, "Not Found", 404, 404);
    const token = m[1];
    const method = m[2];

    const bot = resolveBotFromToken(store, token);
    if (!bot) return tgError(c, "Unauthorized", 401, 401);

    // Check injected faults before dispatching the real handler.
    const fault = consumeFault(store, bot.bot_id, method);
    if (fault) {
      const status = faultHttpStatus(fault.error_code);
      const parameters = fault.retry_after !== null ? { retry_after: fault.retry_after } : undefined;
      return c.json(
        { ok: false, error_code: fault.error_code, description: fault.description, ...(parameters ? { parameters } : {}) },
        status,
      );
    }

    const body: unknown =
      c.req.method === "GET"
        ? queryToBody(c)
        : await parseTelegramBody(c);

    switch (method) {
      case "getMe":
        return getMe(c, bot);
      case "getUpdates":
        return await getUpdates(c, bot, body, dispatcher());
      case "setWebhook":
        return setWebhook(c, bot, body, store);
      case "deleteWebhook":
        return deleteWebhook(c, bot, store);
      case "getWebhookInfo":
        return getWebhookInfo(c, bot);
      case "sendMessage":
        return sendMessage(c, bot, body, store);
      case "sendPhoto":
        return sendPhoto(c, bot, body, store);
      case "getFile":
        return getFile(c, bot, body, store);
      case "answerCallbackQuery":
        return answerCallbackQuery(c, bot, body, store);
      case "getChat":
        return getChat(c, body, store);
      case "getChatMember":
        return getChatMember(c, body, store);
      case "getChatAdministrators":
        return getChatAdministrators(c, body, store);
      case "setMyCommands":
        return setMyCommands(c, bot, body, store);
      case "getMyCommands":
        return getMyCommands(c, bot);
      case "editMessageReplyMarkup":
        return editMessageReplyMarkup(c, bot, body, store);
      case "editMessageText":
        return editMessageText(c, bot, body, store);
      case "deleteMessage":
        return deleteMessage(c, bot, body, store);
      case "sendMessageDraft":
        return sendMessageDraft(c, bot, body, store);
      case "sendDocument":
        return sendDocument(c, bot, body, store);
      case "sendChatAction":
        return sendChatAction(c);
      case "getChatMemberCount":
        return getChatMemberCount(c, body, store);
      case "setMessageReaction":
        return setMessageReaction(c, bot, body, store);
      case "sendVideo":
        return sendMediaMessage(c, bot, body, store, "video");
      case "sendAudio":
        return sendMediaMessage(c, bot, body, store, "audio");
      case "sendVoice":
        return sendMediaMessage(c, bot, body, store, "voice");
      case "sendAnimation":
        return sendMediaMessage(c, bot, body, store, "animation");
      case "sendSticker":
        return sendMediaMessage(c, bot, body, store, "sticker");
      case "createForumTopic":
        return createForumTopicMethod(c, body, store);
      case "editForumTopic":
        return editForumTopicMethod(c, body, store);
      case "closeForumTopic":
        return closeForumTopicMethod(c, body, store, true);
      case "reopenForumTopic":
        return closeForumTopicMethod(c, body, store, false);
      case "deleteForumTopic":
        return deleteForumTopicMethod(c, body, store);
      default:
        return tgError(c, `Method ${method} is not implemented in the emulator`, 404, 404);
    }
  };

  // Hono's parametric and wildcard routes do not cooperate with path segments
  // containing ":" (used by Telegram bot tokens). We register a catchall that
  // dispatches based on path shape — specific routes registered by other
  // modules still win because Hono prioritises specific matches over "*".
  app.all("*", async (c) => {
    const path = new URL(c.req.url).pathname;

    const botMatch = path.match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
    if (botMatch) return methodHandler(c);

    const fileMatch = path.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (fileMatch) {
      const token = fileMatch[1];
      const bot = resolveBotFromToken(store, token);
      if (!bot) return c.text("Unauthorized", 401);
      const filePath = decodeURIComponent(fileMatch[2]);
      const file = ts()
        .files.all()
        .find((f) => f.file_path === filePath);
      if (!file) return c.text("File not found", 404);
      const bytes = Buffer.from(file.bytes_base64, "base64");
      return c.body(bytes, 200, {
        "Content-Type": file.mime_type,
        "Content-Length": String(bytes.length),
      });
    }

    return c.notFound();
  });
}

// GET-style requests embed body fields in the query string; preserve the
// transport at this layer — zod validators handle type-coercing the values.
function queryToBody(c: Context): unknown {
  const url = new URL(c.req.url);
  const result: { [key: string]: unknown } = {};
  for (const [key, value] of url.searchParams) {
    try {
      result[key] = JSON.parse(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function sendMessage(
  c: Context,
  bot: TelegramBot,
  raw: unknown,
  store: Store,
) {
  const r = parseWithSchema(c, zSendMessageBody, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  if (!body.text) return tgError(c, "Bad Request: text is required");

  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", body.chat_id);
  if (!chat) return tgError(c, "Bad Request: chat not found", 400);
  if (!chat.member_bot_ids.includes(bot.bot_id)) {
    return tgError(c, "Forbidden: bot is not a member of the chat", 403, 403);
  }

  const parsed = applyParseMode(body.text, body.parse_mode, body.entities);
  if (!parsed.ok) return tgError(c, parsed.description, 400);

  // Real Telegram rejects messages whose visible text exceeds 4096 chars.
  // Length is counted in UTF-16 code units on the parsed (stripped) text.
  if (parsed.text.length > TEXT_LIMIT) {
    return tgError(c, "Bad Request: message is too long", 400, 400);
  }

  const threadErr = validateMessageThreadId(body.message_thread_id, chat);
  if (threadErr) return tgError(c, threadErr, 400);

  if (body.reply_to_message_id !== undefined) {
    const target = ts.messages
      .findBy("chat_id", body.chat_id)
      .find((m) => m.message_id === body.reply_to_message_id && !m.deleted);
    if (!target) {
      return tgError(c, "Bad Request: message to be replied not found", 400, 400);
    }
  }

  const messageId = allocateMessageId(store, chat);

  const msg = ts.messages.insert({
    message_id: messageId,
    chat_id: chat.chat_id,
    from_user_id: null,
    from_bot_id: bot.bot_id,
    sender_chat_id: null,
    message_thread_id: body.message_thread_id,
    date: Math.floor(Date.now() / 1000),
    text: parsed.text,
    entities: parsed.entities,
    reply_to_message_id: body.reply_to_message_id,
    reply_markup: body.reply_markup,
  });

  return ok(c, serializeMessage(msg, { store }));
}

const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

function validateMessageThreadId(
  raw: number | undefined,
  chat: TelegramChat,
): string | null {
  if (raw === undefined) return null;
  if (chat.type !== "supergroup") return "Bad Request: message thread not found";
  return null;
}

/**
 * Interprets `parse_mode` against the raw text. Returns the stripped text
 * and the entities derived from markup. Caller-supplied `entities` are
 * preserved and appended to the parsed set (real Telegram behaviour: when
 * both are present, entities take precedence and parse_mode is ignored,
 * but we merge so tests can exercise either path without losing data).
 */
function applyParseMode(
  rawText: string,
  parseMode: "MarkdownV2" | "HTML" | "Markdown" | undefined,
  callerEntities: MessageEntity[] | undefined,
): { ok: true; text: string; entities: MessageEntity[] | undefined } | { ok: false; description: string } {
  if (!parseMode) {
    return { ok: true, text: rawText, entities: callerEntities };
  }
  try {
    if (parseMode === "MarkdownV2") {
      const { text, entities } = parseMarkdownV2(rawText);
      const merged = mergeEntities(entities, callerEntities);
      return { ok: true, text, entities: merged.length > 0 ? merged : undefined };
    }
    if (parseMode === "HTML") {
      const { text, entities } = parseHtml(rawText);
      const merged = mergeEntities(entities, callerEntities);
      return { ok: true, text, entities: merged.length > 0 ? merged : undefined };
    }
    // Legacy Markdown v1: simpler grammar than V2 (no spoiler/underline/
    // strikethrough, `_` and `*` only, no escape syntax). Real Telegram
    // still accepts it; many older SDKs default to it.
    const { text, entities } = parseLegacyMarkdown(rawText);
    const merged = mergeEntities(entities, callerEntities);
    return { ok: true, text, entities: merged.length > 0 ? merged : undefined };
  } catch (err) {
    if (err instanceof MarkdownParseError || err instanceof HtmlParseError) {
      return { ok: false, description: err.message };
    }
    throw err;
  }
}

function mergeEntities(
  parsed: MessageEntity[],
  caller: MessageEntity[] | undefined,
): MessageEntity[] {
  if (!caller || caller.length === 0) return parsed;
  // When caller supplies entities explicitly, real Telegram discards
  // parse_mode output — drop the parsed side.
  const all = [...caller];
  all.sort((a, b) => (a.offset !== b.offset ? a.offset - b.offset : b.length - a.length));
  return all;
}

// Minimal legacy Markdown (v1) parser: *bold*, _italic_, `code`,
// ```pre```, [text](url). No escape syntax; unmatched markers are
// emitted as literal text.
function parseLegacyMarkdown(input: string): { text: string; entities: MessageEntity[] } {
  const out: string[] = [];
  const entities: MessageEntity[] = [];
  let i = 0;
  const emit = (
    type: MessageEntity["type"],
    markerLen: number,
    closer: string,
    extras?: Partial<MessageEntity>,
  ): boolean => {
    const close = input.indexOf(closer, i + markerLen);
    if (close === -1) return false;
    const body = input.slice(i + markerLen, close);
    const start = out.join("").length;
    out.push(body);
    entities.push({ type, offset: start, length: body.length, ...extras });
    i = close + closer.length;
    return true;
  };
  while (i < input.length) {
    const ch = input[i];
    if (input.startsWith("```", i) && emit("pre", 3, "```")) continue;
    if (ch === "`" && emit("code", 1, "`")) continue;
    if (ch === "*" && emit("bold", 1, "*")) continue;
    if (ch === "_" && emit("italic", 1, "_")) continue;
    if (ch === "[") {
      const close = input.indexOf("]", i + 1);
      if (close !== -1 && input[close + 1] === "(") {
        const urlClose = input.indexOf(")", close + 2);
        if (urlClose !== -1) {
          const text = input.slice(i + 1, close);
          const url = input.slice(close + 2, urlClose);
          const start = out.join("").length;
          out.push(text);
          if (url.startsWith("tg://user?id=")) {
            const uid = Number(url.slice("tg://user?id=".length));
            if (Number.isFinite(uid)) {
              entities.push({
                type: "text_mention",
                offset: start,
                length: text.length,
                user: { id: uid, is_bot: false, first_name: "" },
              });
            }
          } else {
            entities.push({ type: "text_link", offset: start, length: text.length, url });
          }
          i = urlClose + 1;
          continue;
        }
      }
    }
    out.push(ch);
    i += 1;
  }
  entities.sort((a, b) => (a.offset !== b.offset ? a.offset - b.offset : b.length - a.length));
  return { text: out.join(""), entities };
}

async function sendPhoto(
  c: Context,
  bot: TelegramBot,
  raw: unknown,
  store: Store,
) {
  const r = parseWithSchema(c, zSendPhotoBody, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", body.chat_id);
  if (!chat) return tgError(c, "Bad Request: chat not found");
  if (!chat.member_bot_ids.includes(bot.bot_id)) {
    return tgError(c, "Forbidden: bot is not a member of the chat", 403, 403);
  }

  const captionResult = applyCaption(body.caption, body.parse_mode, body.caption_entities);
  if (!captionResult.ok) return tgError(c, captionResult.description, 400);
  const { caption, captionEntities } = captionResult;

  const threadErr = validateMessageThreadId(body.message_thread_id, chat);
  if (threadErr) return tgError(c, threadErr, 400);

  let photoSizes: PhotoSize[];

  if (typeof body.photo === "string") {
    // Re-send by file_id — real Telegram preserves the file_id exactly.
    const file = ts.files.findOneBy("file_id", body.photo);
    if (!file) return tgError(c, "Bad Request: file not found");
    if (file.photo_sizes_json) {
      photoSizes = JSON.parse(file.photo_sizes_json) as PhotoSize[];
    } else {
      // Legacy row without saved tiers — fall back to synthesising but
      // keep the same file_id for the primary tier.
      photoSizes = [
        {
          file_id: file.file_id,
          file_unique_id: file.file_unique_id,
          width: file.width,
          height: file.height,
          file_size: file.file_size,
        },
      ];
    }
  } else {
    const upload = body.photo;
    const bytes = upload.bytes;
    const { sizes } = buildPhotoSizes(store, bytes, bot.bot_id, body.chat_id);
    const photoSizesJson = JSON.stringify(sizes);
    for (const size of sizes) {
      ts.files.insert({
        file_id: size.file_id,
        file_unique_id: size.file_unique_id,
        owner_bot_id: bot.bot_id,
        mime_type: upload.type || "image/jpeg",
        file_size: bytes.length,
        width: size.width,
        height: size.height,
        file_path: `photos/${bot.bot_id}/${size.file_id}`,
        bytes_base64: bytes.toString("base64"),
        kind: "photo" as const,
        photo_sizes_json: photoSizesJson,
      });
    }
    photoSizes = sizes;
  }

  const messageId = allocateMessageId(store, chat);

  const msg = ts.messages.insert({
    message_id: messageId,
    chat_id: chat.chat_id,
    from_user_id: null,
    from_bot_id: bot.bot_id,
    sender_chat_id: null,
    message_thread_id: body.message_thread_id,
    date: Math.floor(Date.now() / 1000),
    photo: photoSizes,
    caption,
    caption_entities: captionEntities,
    reply_markup: body.reply_markup,
  });

  return ok(c, serializeMessage(msg, { store }));
}

function applyCaption(
  rawCaption: string | undefined,
  parseMode: "MarkdownV2" | "HTML" | "Markdown" | undefined,
  callerEntities: MessageEntity[] | undefined,
):
  | { ok: true; caption: string | undefined; captionEntities: MessageEntity[] | undefined }
  | { ok: false; description: string } {
  if (rawCaption === undefined) {
    return { ok: true, caption: undefined, captionEntities: callerEntities };
  }
  const parsed = applyParseMode(rawCaption, parseMode, callerEntities);
  if (!parsed.ok) return parsed;
  if (parsed.text.length > CAPTION_LIMIT) {
    return { ok: false, description: "Bad Request: message caption is too long" };
  }
  return { ok: true, caption: parsed.text, captionEntities: parsed.entities };
}

function setMessageReaction(
  c: Context,
  bot: TelegramBot,
  raw: unknown,
  store: Store,
) {
  const r = parseWithSchema(c, zSetMessageReactionBody, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", body.chat_id);
  if (!chat) return tgError(c, "Bad Request: chat not found");
  const msg = ts.messages
    .findBy("chat_id", body.chat_id)
    .find((m) => m.message_id === body.message_id);
  if (!msg) return tgError(c, "Bad Request: message not found");

  // Upsert the reaction row for this bot on this message.
  const existing = ts.reactions.all().find(
    (rr) => rr.chat_id === body.chat_id && rr.message_id === body.message_id && rr.sender_bot_id === bot.bot_id,
  );
  const typed = (body.reaction ?? []).map((rr) =>
    rr.type === "emoji"
      ? { type: "emoji" as const, emoji: rr.emoji ?? "" }
      : { type: "custom_emoji" as const, custom_emoji_id: rr.custom_emoji_id ?? "" },
  );

  if (existing) {
    if (typed.length === 0) {
      ts.reactions.delete(existing.id);
    } else {
      ts.reactions.update(existing.id, { reaction: typed });
    }
  } else if (typed.length > 0) {
    ts.reactions.insert({
      chat_id: body.chat_id,
      message_id: body.message_id,
      sender_user_id: null,
      sender_bot_id: bot.bot_id,
      reaction: typed,
    });
  }

  return c.json({ ok: true, result: true });
}

function getFile(
  c: Context,
  bot: TelegramBot,
  raw: unknown,
  store: Store,
) {
  const r = parseWithSchema(c, zGetFileBody, raw);
  if (!r.ok) return r.response;

  const ts = getTelegramStore(store);
  const file = ts.files.findOneBy("file_id", r.data.file_id);
  if (!file) return tgError(c, "Bad Request: file not found");

  void bot;
  return ok(c, {
    file_id: file.file_id,
    file_unique_id: file.file_unique_id,
    file_size: file.file_size,
    file_path: file.file_path,
  });
}

function answerCallbackQuery(
  c: Context,
  bot: TelegramBot,
  raw: unknown,
  store: Store,
) {
  const r = parseWithSchema(c, zAnswerCallbackQueryBody, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  const ts = getTelegramStore(store);
  const cq = ts.callbackQueries.findOneBy("callback_query_id", body.callback_query_id);
  if (!cq) return tgError(c, "Bad Request: callback_query not found");

  ts.callbackQueries.update(cq.id, {
    answered: true,
    answer_text: body.text,
    answer_show_alert: body.show_alert,
    answer_url: body.url,
    answer_cache_time: body.cache_time,
  });
  void bot;
  return c.json({ ok: true, result: true });
}

function setMyCommands(
  c: Context,
  bot: TelegramBot,
  raw: unknown,
  store: Store,
) {
  const r = parseWithSchema(c, zSetMyCommandsBody, raw);
  if (!r.ok) return r.response;

  const ts = getTelegramStore(store);
  ts.bots.update(bot.id, { commands: r.data.commands });
  return okRaw(c, true);
}

function getMyCommands(c: Context, bot: TelegramBot) {
  return c.json({ ok: true, result: bot.commands });
}

function editMessageReplyMarkup(
  c: Context,
  bot: TelegramBot,
  raw: unknown,
  store: Store,
) {
  const r = parseWithSchema(c, zEditMessageReplyMarkupBody, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  const ts = getTelegramStore(store);
  const msg = ts.messages
    .findBy("chat_id", body.chat_id)
    .find((m) => m.message_id === body.message_id);
  if (!msg) return tgError(c, "Bad Request: message not found");

  // editMessageReplyMarkup only accepts inline keyboards — the other
  // reply-markup kinds can't be attached to an existing message.
  let newMarkup: InlineKeyboardMarkup | undefined;
  if (body.reply_markup !== undefined) {
    if (!isInlineKeyboardMarkup(body.reply_markup)) {
      return tgError(c, "Bad Request: reply_markup must be an inline keyboard");
    }
    newMarkup = body.reply_markup;
  }
  ts.messages.update(msg.id, { reply_markup: newMarkup, edited_date: Math.floor(Date.now() / 1000) });

  void bot;
  const updated = ts.messages.get(msg.id)!;
  return ok(c, serializeMessage(updated, { store }));
}

export function parseInlineKeyboard(markup: unknown): InlineKeyboardMarkup | null {
  if (!markup || typeof markup !== "object") return null;
  const m = markup as ReplyMarkup;
  if (isInlineKeyboardMarkup(m)) return m;
  return null;
}

export { parseEntities };

// expose for control plane
export function simulateInsertMessage(
  store: Store,
  input: {
    chatId: number;
    fromUserId: number;
    text: string;
    entities?: MessageEntity[];
    replyTo?: number;
    messageThreadId?: number;
  },
): TelegramMessage {
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", input.chatId);
  if (!chat) throw new Error(`chat ${input.chatId} not found`);
  if (!chat.member_user_ids.includes(input.fromUserId)) {
    throw new Error(`user ${input.fromUserId} is not a member of chat ${input.chatId}`);
  }
  const messageId = allocateMessageId(store, chat);
  return ts.messages.insert({
    message_id: messageId,
    chat_id: chat.chat_id,
    from_user_id: input.fromUserId,
    from_bot_id: null,
    sender_chat_id: null,
    message_thread_id: input.messageThreadId,
    date: Math.floor(Date.now() / 1000),
    text: input.text,
    entities: input.entities,
    reply_to_message_id: input.replyTo,
  });
}

// ---- Full-parity additions: faults, rich media, length limits ----

function consumeFault(
  store: Store,
  botId: number,
  method: string,
): TelegramFault | null {
  const ts = getTelegramStore(store);
  const matches = ts.faults.all().filter(
    (f) => f.bot_id === botId && (f.method === "*" || f.method === method) && f.remaining > 0,
  );
  if (matches.length === 0) return null;
  // Prefer specific-method faults over wildcards.
  matches.sort((a, b) => (a.method === "*" ? 1 : 0) - (b.method === "*" ? 1 : 0));
  const fault = matches[0];
  const remaining = fault.remaining - 1;
  if (remaining <= 0) {
    ts.faults.delete(fault.id);
  } else {
    ts.faults.update(fault.id, { remaining });
  }
  return fault;
}

function faultHttpStatus(errorCode: number): 400 | 401 | 403 | 404 | 429 {
  if (errorCode === 401 || errorCode === 403 || errorCode === 404 || errorCode === 429) {
    return errorCode;
  }
  return 400;
}

// Narrow the per-kind zod body to (a) its media input field and
// (b) the extra per-kind fields the handler consumes. Keeps the
// dispatcher typed without a cast at the output site.
type AnyMediaBody =
  | SendVideoBody
  | SendAudioBody
  | SendVoiceBody
  | SendAnimationBody
  | SendStickerBody;

// Lift the media-input field out of the per-kind body. Each branch has
// exactly one such field whose key matches the method's kind. Using
// `in` guards keeps the access type-checked without a cast.
function pickMediaInput(body: AnyMediaBody, kind: MediaKind): string | MultipartFileRef {
  switch (kind) {
    case "video":
      return "video" in body ? body.video : unreachable(kind);
    case "audio":
      return "audio" in body ? body.audio : unreachable(kind);
    case "voice":
      return "voice" in body ? body.voice : unreachable(kind);
    case "animation":
      return "animation" in body ? body.animation : unreachable(kind);
    case "sticker":
      return "sticker" in body ? body.sticker : unreachable(kind);
  }
}

function unreachable(kind: MediaKind): never {
  // The zod schema guarantees the per-kind field is present. Reached
  // only if BODY_FOR_MEDIA routing drifts from pickMediaInput — the
  // assertion surfaces the bug loudly rather than silently.
  throw new Error(`sendMediaMessage: ${kind} body missing its media field`);
}

async function sendMediaMessage(
  c: Context,
  bot: TelegramBot,
  raw: unknown,
  store: Store,
  kind: MediaKind,
) {
  const schema = BODY_FOR_MEDIA[kind] as z.ZodType<AnyMediaBody>;
  const r: ParseResult<AnyMediaBody> = parseWithSchema(c, schema, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", body.chat_id);
  if (!chat) return tgError(c, "Bad Request: chat not found");
  if (!chat.member_bot_ids.includes(bot.bot_id)) {
    return tgError(c, "Forbidden: bot is not a member of the chat", 403, 403);
  }

  // Caption + parse_mode (sticker has no caption).
  let caption: string | undefined;
  let captionEntities: MessageEntity[] | undefined;
  if (kind === "sticker") {
    // Real Telegram silently ignores captions on stickers.
    caption = undefined;
    captionEntities = undefined;
  } else {
    const capResult = applyCaption(body.caption, body.parse_mode, body.caption_entities);
    if (!capResult.ok) return tgError(c, capResult.description, 400);
    caption = capResult.caption;
    captionEntities = capResult.captionEntities;
  }

  const threadErr = validateMessageThreadId(body.message_thread_id, chat);
  if (threadErr) return tgError(c, threadErr, 400);

  const input = pickMediaInput(body, kind);

  const duration = body.duration ?? 0;
  const width = body.width ?? 0;
  const height = body.height ?? 0;

  let file_id: string;
  let file_unique_id: string;
  let file_name: string | undefined;
  let mime_type: string | undefined;
  let file_size = 0;

  if (typeof input === "string") {
    // Re-send by file_id.
    const file = ts.files.findOneBy("file_id", input);
    if (!file) return tgError(c, "Bad Request: file not found");
    file_id = file.file_id;
    file_unique_id = file.file_unique_id;
    file_name = file.file_name;
    mime_type = file.mime_type;
    file_size = file.file_size;
  } else if (isMultipartFile(input)) {
    const bytes = input.bytes;
    const ids = nextFileId(store, bot.bot_id, body.chat_id, kind[0]);
    file_id = ids.file_id;
    file_unique_id = ids.file_unique_id;
    file_name = input.name;
    mime_type = input.type || defaultMimeForKind(kind);
    file_size = bytes.length;
    ts.files.insert({
      file_id,
      file_unique_id,
      owner_bot_id: bot.bot_id,
      mime_type,
      file_size,
      width,
      height,
      file_path: `${kind}s/${bot.bot_id}/${file_id}`,
      bytes_base64: bytes.toString("base64"),
      kind,
      file_name,
      duration,
    });
  } else {
    return tgError(c, `Bad Request: ${kind} must be a file_id string or multipart upload`);
  }

  const mediaField = buildMediaField({
    kind,
    file_id,
    file_unique_id,
    file_size,
    width,
    height,
    duration,
    mime_type,
    file_name,
    performer: "performer" in body ? body.performer : undefined,
    title: "title" in body ? body.title : undefined,
    emoji: "emoji" in body ? body.emoji : undefined,
    is_animated: body.is_animated === true,
    is_video: body.is_video === true,
  });

  const messageId = allocateMessageId(store, chat);

  const msg = ts.messages.insert({
    message_id: messageId,
    chat_id: chat.chat_id,
    from_user_id: null,
    from_bot_id: bot.bot_id,
    sender_chat_id: null,
    message_thread_id: body.message_thread_id,
    date: Math.floor(Date.now() / 1000),
    [kind]: mediaField,
    caption,
    caption_entities: captionEntities,
    reply_markup: body.reply_markup,
  });

  return ok(c, serializeMessage(msg, { store }));
}

function defaultMimeForKind(kind: MediaKind): string {
  switch (kind) {
    case "video":
      return "video/mp4";
    case "audio":
      return "audio/mpeg";
    case "voice":
      return "audio/ogg";
    case "animation":
      return "video/mp4";
    case "sticker":
      return "image/webp";
  }
}

// ---- editMessageText / deleteMessage / sendMessageDraft / sendDocument ----

function editMessageText(
  c: Context,
  bot: TelegramBot,
  raw: unknown,
  store: Store,
) {
  const r = parseWithSchema(c, zEditMessageTextBody, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  if (!body.text) return tgError(c, "Bad Request: text is required");

  const ts = getTelegramStore(store);
  const msg = ts.messages
    .findBy("chat_id", body.chat_id)
    .find((m) => m.message_id === body.message_id);
  if (!msg) return tgError(c, "Bad Request: message not found");
  if (msg.from_bot_id !== bot.bot_id) {
    return tgError(c, "Bad Request: message can't be edited by this bot", 403, 403);
  }
  const parsed = applyParseMode(body.text, body.parse_mode, body.entities);
  if (!parsed.ok) return tgError(c, parsed.description, 400);
  if (parsed.text.length > TEXT_LIMIT) {
    return tgError(c, "Bad Request: message is too long", 400, 400);
  }
  ts.messages.update(msg.id, {
    text: parsed.text,
    entities: parsed.entities,
    edited_date: Math.floor(Date.now() / 1000),
  });
  const updated = ts.messages.get(msg.id)!;
  const chat = ts.chats.findOneBy("chat_id", body.chat_id);
  if (chat) dispatchEditedMessage(store, chat, bot.bot_id, updated);
  return ok(c, serializeMessage(updated, { store }));
}

function dispatchEditedMessage(
  store: Store,
  chat: TelegramChat,
  editorBotId: number,
  updated: TelegramMessage,
): void {
  const ts = getTelegramStore(store);
  const dispatcher = getDispatcher(store);
  const payload = serializeMessage(updated, { store });
  for (const otherBotId of chat.member_bot_ids) {
    if (otherBotId === editorBotId) continue;
    const bot = ts.bots.findOneBy("bot_id", otherBotId);
    if (!bot) continue;
    const type = chat.type === "channel" ? "edited_channel_post" : "edited_message";
    dispatcher.enqueue(otherBotId, type, payload);
  }
}

function deleteMessage(
  c: Context,
  bot: TelegramBot,
  raw: unknown,
  store: Store,
) {
  const r = parseWithSchema(c, zDeleteMessageBody, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  const ts = getTelegramStore(store);
  const msg = ts.messages
    .findBy("chat_id", body.chat_id)
    .find((m) => m.message_id === body.message_id);
  if (!msg) return tgError(c, "Bad Request: message not found");
  // Telegram allows bots to delete their own messages unconditionally,
  // and messages from other senders only if the bot has sufficient rights
  // (which in our emulator we simplify to: always allowed for member bots).
  if (msg.from_bot_id !== null && msg.from_bot_id !== bot.bot_id) {
    return tgError(c, "Bad Request: message can't be deleted by this bot", 403, 403);
  }
  ts.messages.update(msg.id, { deleted: true });
  return c.json({ ok: true, result: true });
}

function sendMessageDraft(
  c: Context,
  bot: TelegramBot,
  raw: unknown,
  store: Store,
) {
  const r = parseWithSchema(c, zSendMessageDraftBody, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  if (body.draft_id === 0 || !body.text) {
    return tgError(c, "Bad Request: chat_id, draft_id (non-zero), text required");
  }
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", body.chat_id);
  if (!chat) return tgError(c, "Bad Request: chat not found");
  // Real Telegram restricts sendMessageDraft to private chats.
  if (chat.type !== "private") {
    return tgError(c, "Bad Request: message drafts are supported only in private chats");
  }
  if (!chat.member_bot_ids.includes(bot.bot_id)) {
    return tgError(c, "Forbidden: bot is not a member of the chat", 403, 403);
  }

  const existing = ts.draftSnapshots
    .findBy("chat_id", body.chat_id)
    .filter((s) => s.draft_id === body.draft_id && s.bot_id === bot.bot_id);
  const seq = existing.length > 0 ? Math.max(...existing.map((s) => s.seq)) + 1 : 1;

  ts.draftSnapshots.insert({
    chat_id: body.chat_id,
    draft_id: body.draft_id,
    bot_id: bot.bot_id,
    seq,
    text: body.text,
    entities: body.entities,
  });

  return c.json({ ok: true, result: true });
}

async function sendDocument(
  c: Context,
  bot: TelegramBot,
  raw: unknown,
  store: Store,
) {
  const r = parseWithSchema(c, zSendDocumentBody, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", body.chat_id);
  if (!chat) return tgError(c, "Bad Request: chat not found");
  if (!chat.member_bot_ids.includes(bot.bot_id)) {
    return tgError(c, "Forbidden: bot is not a member of the chat", 403, 403);
  }

  const capResult = applyCaption(body.caption, body.parse_mode, body.caption_entities);
  if (!capResult.ok) return tgError(c, capResult.description, 400);
  const { caption, captionEntities } = capResult;

  const threadErr = validateMessageThreadId(body.message_thread_id, chat);
  if (threadErr) return tgError(c, threadErr, 400);

  let document: TelegramDocument;

  if (typeof body.document === "string") {
    // Re-send by file_id — Telegram preserves the same ids on echo.
    const file = ts.files.findOneBy("file_id", body.document);
    if (!file) return tgError(c, "Bad Request: file not found");
    document = {
      file_id: file.file_id,
      file_unique_id: file.file_unique_id,
      file_name: file.file_name,
      mime_type: file.mime_type,
      file_size: file.file_size,
    };
  } else {
    const upload = body.document;
    const bytes = upload.bytes;
    const { file_id, file_unique_id } = nextFileId(store, bot.bot_id, body.chat_id, "d");
    ts.files.insert({
      file_id,
      file_unique_id,
      owner_bot_id: bot.bot_id,
      mime_type: upload.type || "application/octet-stream",
      file_size: bytes.length,
      width: 0,
      height: 0,
      file_path: `documents/${bot.bot_id}/${file_id}`,
      bytes_base64: bytes.toString("base64"),
      kind: "document" as const,
      file_name: upload.name,
    });
    document = {
      file_id,
      file_unique_id,
      file_name: upload.name,
      mime_type: upload.type || "application/octet-stream",
      file_size: bytes.length,
    };
  }

  const messageId = allocateMessageId(store, chat);

  const msg = ts.messages.insert({
    message_id: messageId,
    chat_id: chat.chat_id,
    from_user_id: null,
    from_bot_id: bot.bot_id,
    sender_chat_id: null,
    message_thread_id: body.message_thread_id,
    date: Math.floor(Date.now() / 1000),
    document,
    caption,
    caption_entities: captionEntities,
    reply_markup: body.reply_markup,
  });

  return ok(c, serializeMessage(msg, { store }));
}
