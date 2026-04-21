import { z } from "zod";
import { zChatId } from "./primitives.js";
import { zMessageEntity } from "./message-entity.js";

export const zSendMessageDraftBody = z.object({
  chat_id: zChatId,
  draft_id: z.number().int(),
  text: z.string(),
  entities: z.array(zMessageEntity).optional(),
});

export type SendMessageDraftBody = z.infer<typeof zSendMessageDraftBody>;
