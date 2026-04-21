import type { Entity } from "@emulators/core";

export interface TelegramForumTopic extends Entity {
  chat_id: number;
  message_thread_id: number;
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
  is_closed?: boolean;
  is_deleted?: boolean;
}
