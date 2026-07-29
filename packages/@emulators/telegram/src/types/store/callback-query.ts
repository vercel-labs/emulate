import type { Entity } from "@emulators/core";

export interface TelegramCallbackQuery extends Entity {
  callback_query_id: string;
  from_user_id: number;
  message_id: number;
  chat_id: number;
  data: string;
  answered: boolean;
  answer_text?: string;
  answer_show_alert?: boolean;
  answer_url?: string;
  answer_cache_time?: number;
}
