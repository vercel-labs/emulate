import type { Entity } from "@emulators/core";
import type { MessageEntity } from "../wire/message-entity.js";
import type {
  PhotoSize,
  TelegramAnimation,
  TelegramAudio,
  TelegramDocument,
  TelegramSticker,
  TelegramVideo,
  TelegramVoice,
} from "../wire/media.js";
import type { ReplyMarkup } from "../wire/reply-markup.js";

export interface TelegramMessage extends Entity {
  message_id: number;
  chat_id: number;
  from_user_id: number | null;
  from_bot_id: number | null;
  sender_chat_id: number | null;
  message_thread_id?: number;
  date: number;
  text?: string;
  entities?: MessageEntity[];
  photo?: PhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  video?: TelegramVideo;
  animation?: TelegramAnimation;
  sticker?: TelegramSticker;
  caption?: string;
  caption_entities?: MessageEntity[];
  reply_to_message_id?: number;
  reply_markup?: ReplyMarkup;
  edited_date?: number;
  deleted?: boolean;
}
