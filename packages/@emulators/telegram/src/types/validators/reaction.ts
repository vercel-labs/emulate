import { z } from "zod";
import { zChatId } from "./primitives.js";

export const zReactionTypeInput = z.union([
  z.object({ type: z.literal("emoji"), emoji: z.string().optional() }),
  z.object({ type: z.literal("custom_emoji"), custom_emoji_id: z.string().optional() }),
]);

export const zSetMessageReactionBody = z.object({
  chat_id: zChatId,
  message_id: z.number().int(),
  reaction: z.array(zReactionTypeInput).optional(),
});

export type SetMessageReactionBody = z.infer<typeof zSetMessageReactionBody>;
