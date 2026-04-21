import type { WireChat } from "./chat.js";
import type {
  PhotoSize,
  TelegramAnimation,
  TelegramAudio,
  TelegramDocument,
  TelegramSticker,
  TelegramVideo,
  TelegramVoice,
} from "./media.js";
import type { MessageEntity } from "./message-entity.js";
import type { ReplyMarkup } from "./reply-markup.js";
import type { WireBotAsUser, WireUser } from "./user.js";

// Bot API `Message` wire shape — exactly what serializeMessage emits.
// Only the fields the emulator actually produces are modelled; real
// Telegram ships many more (service messages, polls, contacts etc.)
// which are outside the emulator's scope.
export interface WireMessage {
  message_id: number;
  date: number;
  chat: WireChat;
  from?: WireUser | WireBotAsUser;
  sender_chat?: WireChat;
  message_thread_id?: number;
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
  reply_to_message?: WireMessage;
  reply_markup?: ReplyMarkup;
  edit_date?: number;
}
