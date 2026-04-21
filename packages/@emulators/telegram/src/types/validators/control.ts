import { z } from "zod";
import { zMessageEntity } from "./message-entity.js";
import { zMultipartFile } from "./primitives.js";

// Bot commands input shape (small, reused in create-bot + setMyCommands).
const zCommandPair = z.object({
  command: z.string(),
  description: z.string(),
});

export const zCreateBotInput = z.object({
  username: z.string().min(1),
  name: z.string().optional(),
  first_name: z.string().optional(),
  can_join_groups: z.boolean().optional(),
  can_read_all_group_messages: z.boolean().optional(),
  commands: z.array(zCommandPair).optional(),
  token: z.string().optional(),
});
export type CreateBotInput = z.infer<typeof zCreateBotInput>;

export const zCreateUserInput = z.object({
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});
export type CreateUserInput = z.infer<typeof zCreateUserInput>;

export const zCreatePrivateChatInput = z.object({
  botId: z.number().int(),
  userId: z.number().int(),
});
export type CreatePrivateChatInput = z.infer<typeof zCreatePrivateChatInput>;

export const zCreateGroupChatInput = z.object({
  title: z.string(),
  type: z.enum(["group", "supergroup"]).optional(),
  memberIds: z.array(z.number().int()),
  botIds: z.array(z.number().int()),
  creatorUserId: z.number().int().optional(),
  adminUserIds: z.array(z.number().int()).optional(),
  adminBotIds: z.array(z.number().int()).optional(),
  isForum: z.boolean().optional(),
});
export type CreateGroupChatInput = z.infer<typeof zCreateGroupChatInput>;

// Supergroup is a group with type fixed to supergroup; the handler fills
// `type` in, so the input mirrors CreateGroupChatInput minus `type`.
export const zCreateSupergroupInput = zCreateGroupChatInput.omit({ type: true });
export type CreateSupergroupInput = z.infer<typeof zCreateSupergroupInput>;

export const zCreateChannelInput = z.object({
  title: z.string(),
  username: z.string().optional(),
  memberBotIds: z.array(z.number().int()),
  memberUserIds: z.array(z.number().int()).optional(),
});
export type CreateChannelInput = z.infer<typeof zCreateChannelInput>;

export const zPromoteChatMemberInput = z.object({
  userId: z.number().int().optional(),
  botId: z.number().int().optional(),
  demote: z.boolean().optional(),
});
export type PromoteChatMemberInput = z.infer<typeof zPromoteChatMemberInput>;

export const zSimulateUserMessageInput = z.object({
  userId: z.number().int(),
  text: z.string(),
  replyToMessageId: z.number().int().optional(),
  messageThreadId: z.number().int().optional(),
});
export type SimulateUserMessageInput = z.infer<typeof zSimulateUserMessageInput>;

// Photo upload body accepts either a base64 blob (wire-friendly) or a
// multipart reference (in-process test-client shortcut). The route
// handler extracts the bytes from whichever branch is populated.
export const zSimulateUserPhotoInput = z
  .object({
    userId: z.number().int(),
    mimeType: z.string().optional(),
    caption: z.string().optional(),
    photoBase64: z.string().optional(),
    photo: zMultipartFile.optional(),
  })
  .refine(
    (v) => v.photoBase64 !== undefined || v.photo !== undefined,
    { message: "photoBase64 or multipart photo required" },
  );
export type SimulateUserPhotoInput = z.infer<typeof zSimulateUserPhotoInput>;

export const zSimulateCallbackInput = z.object({
  userId: z.number().int(),
  messageId: z.number().int(),
  data: z.string().optional(),
  callbackData: z.string().optional(),
});
export type SimulateCallbackInput = z.infer<typeof zSimulateCallbackInput>;

export const zSimulateEditedUserMessageInput = z.object({
  userId: z.number().int(),
  messageId: z.number().int(),
  text: z.string(),
  messageThreadId: z.number().int().optional(),
});
export type SimulateEditedUserMessageInput = z.infer<typeof zSimulateEditedUserMessageInput>;

export const zChatMembershipInput = z.object({
  botId: z.number().int(),
  byUserId: z.number().int(),
});
export type ChatMembershipInput = z.infer<typeof zChatMembershipInput>;

export const zReactionEntry = z.union([
  z.object({ type: z.literal("emoji"), emoji: z.string() }),
  z.object({ type: z.literal("custom_emoji"), custom_emoji_id: z.string() }),
]);

export const zSimulateReactionInput = z.object({
  userId: z.number().int(),
  messageId: z.number().int(),
  reaction: z.array(zReactionEntry),
});
export type SimulateReactionInput = z.infer<typeof zSimulateReactionInput>;

export const zCreateForumTopicControlBody = z.object({
  name: z.string().min(1),
});
export type CreateForumTopicControlInput = z.infer<typeof zCreateForumTopicControlBody>;

export const zSimulateChannelPostInput = z.object({
  text: z.string().optional(),
  caption: z.string().optional(),
  entities: z.array(zMessageEntity).optional(),
  reply_to_message_id: z.number().int().optional(),
  message_thread_id: z.number().int().optional(),
  photo_bytes_base64: z.string().optional(),
});
export type SimulateChannelPostControlInput = z.infer<typeof zSimulateChannelPostInput>;

export const zEditChannelPostInput = z.object({
  messageId: z.number().int(),
  text: z.string().optional(),
  caption: z.string().optional(),
});
export type EditChannelPostInput = z.infer<typeof zEditChannelPostInput>;

export const zMediaKind = z.enum([
  "photo",
  "video",
  "audio",
  "voice",
  "animation",
  "sticker",
  "document",
]);

export const zSimulateUserMediaInput = z
  .object({
    userId: z.number().int(),
    kind: zMediaKind,
    mimeType: z.string().optional(),
    caption: z.string().optional(),
    duration: z.number().int().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    fileName: z.string().optional(),
    messageThreadId: z.number().int().optional(),
    bytesBase64: z.string().optional(),
    file: zMultipartFile.optional(),
  })
  .refine(
    (v) => v.bytesBase64 !== undefined || v.file !== undefined,
    { message: "bytesBase64 or file required" },
  );
export type SimulateUserMediaInput = z.infer<typeof zSimulateUserMediaInput>;

export const zInjectFaultInput = z
  .object({
    bot_id: z.number().int().optional(),
    botId: z.number().int().optional(),
    method: z.string().optional(),
    error_code: z.number().int().optional(),
    errorCode: z.number().int().optional(),
    description: z.string().optional(),
    retry_after: z.number().int().optional(),
    retryAfter: z.number().int().optional(),
    count: z.number().int().optional(),
  })
  .refine((v) => v.bot_id !== undefined || v.botId !== undefined, {
    message: "bot_id required",
  })
  .refine((v) => v.error_code !== undefined || v.errorCode !== undefined, {
    message: "error_code required",
  });
export type InjectFaultControlInput = z.infer<typeof zInjectFaultInput>;
