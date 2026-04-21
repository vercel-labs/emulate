import { z } from "zod";
import { zChatId } from "./primitives.js";

export const zCreateForumTopicBody = z.object({
  chat_id: zChatId,
  name: z.string().min(1),
  icon_color: z.number().int().optional(),
  icon_custom_emoji_id: z.string().optional(),
});
export type CreateForumTopicBody = z.infer<typeof zCreateForumTopicBody>;

export const zEditForumTopicBody = z.object({
  chat_id: zChatId,
  message_thread_id: z.number().int(),
  name: z.string().optional(),
  icon_custom_emoji_id: z.string().optional(),
});
export type EditForumTopicBody = z.infer<typeof zEditForumTopicBody>;

export const zCloseForumTopicBody = z.object({
  chat_id: zChatId,
  message_thread_id: z.number().int(),
});
export type CloseForumTopicBody = z.infer<typeof zCloseForumTopicBody>;

export const zDeleteForumTopicBody = zCloseForumTopicBody;
export type DeleteForumTopicBody = z.infer<typeof zDeleteForumTopicBody>;
