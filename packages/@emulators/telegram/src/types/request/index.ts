// Inbound Bot API request body types. Each is derived from its zod
// schema in ../validators — the schema is the single source of truth.
// Re-exported here so callers don't have to know about zod.

export type {
  SendMessageBody,
  EditMessageTextBody,
  DeleteMessageBody,
  EditMessageReplyMarkupBody,
} from "../validators/send-message.js";

export type {
  SendPhotoBody,
  SendVideoBody,
  SendAudioBody,
  SendVoiceBody,
  SendAnimationBody,
  SendStickerBody,
  SendDocumentBody,
  MediaKind,
} from "../validators/send-media.js";

export type { AnswerCallbackQueryBody } from "../validators/callback-query.js";

export type {
  GetChatBody,
  GetChatMemberBody,
  GetChatAdministratorsBody,
  GetChatMemberCountBody,
  SendChatActionBody,
} from "../validators/chats.js";

export type {
  CreateForumTopicBody,
  EditForumTopicBody,
  CloseForumTopicBody,
  DeleteForumTopicBody,
} from "../validators/forum.js";

export type { GetUpdatesBody, SetWebhookBody, GetFileBody } from "../validators/delivery.js";

export type { SetMessageReactionBody } from "../validators/reaction.js";

export type { SetMyCommandsBody } from "../validators/commands.js";

export type { SendMessageDraftBody } from "../validators/draft.js";

export type { ChatIdInput, MultipartFileRef } from "../validators/primitives.js";
