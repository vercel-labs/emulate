import type { Entity } from "@emulators/core";
import type { ReactionType } from "../wire/reaction.js";

export interface TelegramReaction extends Entity {
  chat_id: number;
  message_id: number;
  sender_user_id: number | null;
  sender_bot_id: number | null;
  reaction: ReactionType[];
}
