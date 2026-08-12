import { z } from "zod";
import { zChatId } from "./primitives.js";
import { zMessageEntity } from "./message-entity.js";
import { zReplyMarkup } from "./reply-markup.js";

export const zParseMode = z.enum(["MarkdownV2", "HTML", "Markdown"]);

export const zSendMessageBody = z.object({
  chat_id: zChatId,
  text: z.string(),
  parse_mode: zParseMode.optional(),
  entities: z.array(zMessageEntity).optional(),
  reply_to_message_id: z.number().int().optional(),
  message_thread_id: z.number().int().optional(),
  reply_markup: zReplyMarkup.optional(),
});

export type SendMessageBody = z.infer<typeof zSendMessageBody>;

export const zEditMessageTextBody = z.object({
  chat_id: zChatId,
  message_id: z.number().int(),
  text: z.string(),
  parse_mode: zParseMode.optional(),
  entities: z.array(zMessageEntity).optional(),
});

export type EditMessageTextBody = z.infer<typeof zEditMessageTextBody>;

export const zDeleteMessageBody = z.object({
  chat_id: zChatId,
  message_id: z.number().int(),
});

export type DeleteMessageBody = z.infer<typeof zDeleteMessageBody>;

export const zEditMessageReplyMarkupBody = z.object({
  chat_id: zChatId,
  message_id: z.number().int(),
  reply_markup: zReplyMarkup.optional(),
});

export type EditMessageReplyMarkupBody = z.infer<typeof zEditMessageReplyMarkupBody>;
