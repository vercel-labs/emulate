import type { WireMessage } from "./message.js";
import type { WireBotAsUser, WireUser } from "./user.js";

// Bot API `CallbackQuery` wire shape. The emulator dispatches this as
// the body of a `callback_query` Update when a user clicks an inline
// button. The emulator skips the optional `message_instance` /
// `game_short_name` / `inline_message_id` fields it never emits.
export interface WireCallbackQuery {
  id: string;
  from: WireUser | WireBotAsUser;
  chat_instance: string;
  message?: WireMessage;
  data?: string;
}
