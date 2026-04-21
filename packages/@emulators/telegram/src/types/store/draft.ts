import type { Entity } from "@emulators/core";
import type { MessageEntity } from "../wire/message-entity.js";

export interface TelegramDraftSnapshot extends Entity {
  chat_id: number;
  draft_id: number;
  bot_id: number;
  seq: number;
  text: string;
  entities?: MessageEntity[];
}
