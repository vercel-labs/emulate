import { z } from "zod";
import { zChatId, zMultipartFile } from "./primitives.js";
import { zMessageEntity } from "./message-entity.js";
import { zReplyMarkup } from "./reply-markup.js";
import { zParseMode } from "./send-message.js";

// Media input fields accept either a string file_id (for resends) or a
// multipart upload. Control-plane tests drive multipart via __file.
const zMediaFileInput = z.union([z.string(), zMultipartFile]);

// Shared send-* body fields. Each concrete method extends this with
// its own media-input key (video/audio/voice/animation/sticker/photo).
const zSendMediaCommon = z.object({
  chat_id: zChatId,
  caption: z.string().optional(),
  caption_entities: z.array(zMessageEntity).optional(),
  parse_mode: zParseMode.optional(),
  message_thread_id: z.number().int().optional(),
  reply_markup: zReplyMarkup.optional(),
  duration: z.number().int().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  is_animated: z.boolean().optional(),
  is_video: z.boolean().optional(),
});

export const zSendPhotoBody = zSendMediaCommon.extend({
  photo: zMediaFileInput,
});
export type SendPhotoBody = z.infer<typeof zSendPhotoBody>;

export const zSendVideoBody = zSendMediaCommon.extend({
  video: zMediaFileInput,
});
export type SendVideoBody = z.infer<typeof zSendVideoBody>;

export const zSendAudioBody = zSendMediaCommon.extend({
  audio: zMediaFileInput,
  performer: z.string().optional(),
  title: z.string().optional(),
});
export type SendAudioBody = z.infer<typeof zSendAudioBody>;

export const zSendVoiceBody = zSendMediaCommon.extend({
  voice: zMediaFileInput,
});
export type SendVoiceBody = z.infer<typeof zSendVoiceBody>;

export const zSendAnimationBody = zSendMediaCommon.extend({
  animation: zMediaFileInput,
});
export type SendAnimationBody = z.infer<typeof zSendAnimationBody>;

export const zSendStickerBody = zSendMediaCommon.extend({
  sticker: zMediaFileInput,
  emoji: z.string().optional(),
});
export type SendStickerBody = z.infer<typeof zSendStickerBody>;

export const zSendDocumentBody = zSendMediaCommon.extend({
  document: zMediaFileInput,
});
export type SendDocumentBody = z.infer<typeof zSendDocumentBody>;

export type MediaKind = "video" | "audio" | "voice" | "animation" | "sticker";

// Map method kind to the zod schema for its request body. Used by the
// sendMediaMessage dispatcher in routes/bot-api.ts.
export const BODY_FOR_MEDIA: {
  video: typeof zSendVideoBody;
  audio: typeof zSendAudioBody;
  voice: typeof zSendVoiceBody;
  animation: typeof zSendAnimationBody;
  sticker: typeof zSendStickerBody;
} = {
  video: zSendVideoBody,
  audio: zSendAudioBody,
  voice: zSendVoiceBody,
  animation: zSendAnimationBody,
  sticker: zSendStickerBody,
};
