import { z } from "zod";
import { zChatId } from "./primitives.js";

export const zGetChatBody = z.object({
  chat_id: zChatId,
});
export type GetChatBody = z.infer<typeof zGetChatBody>;

export const zGetChatMemberBody = z.object({
  chat_id: zChatId,
  user_id: z.number().int(),
});
export type GetChatMemberBody = z.infer<typeof zGetChatMemberBody>;

export const zGetChatAdministratorsBody = zGetChatBody;
export type GetChatAdministratorsBody = z.infer<typeof zGetChatAdministratorsBody>;

export const zGetChatMemberCountBody = zGetChatBody;
export type GetChatMemberCountBody = z.infer<typeof zGetChatMemberCountBody>;

export const zSendChatActionBody = z.object({
  chat_id: zChatId,
  action: z.string().optional(),
  message_thread_id: z.number().int().optional(),
});
export type SendChatActionBody = z.infer<typeof zSendChatActionBody>;
