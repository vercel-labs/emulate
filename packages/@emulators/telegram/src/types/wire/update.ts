import type { UpdateType } from "../store/update.js";
import type { WireMessage } from "./message.js";
import type { WireCallbackQuery } from "./callback-query.js";
import type { WireChatMemberUpdated } from "./chat-member-updated.js";
import type {
  WireMessageReactionCountUpdated,
  WireMessageReactionUpdated,
} from "./reaction-update.js";

// Discriminated wrapper emitted over the wire as a Bot API `Update`.
// Every variant carries `update_id` + exactly one named payload key
// matching one of the UpdateType values. Consumers discriminate by
// key presence (`"message" in update`, etc.).
export type WireUpdate =
  | { update_id: number; message: WireMessage }
  | { update_id: number; edited_message: WireMessage }
  | { update_id: number; channel_post: WireMessage }
  | { update_id: number; edited_channel_post: WireMessage }
  | { update_id: number; callback_query: WireCallbackQuery }
  | { update_id: number; my_chat_member: WireChatMemberUpdated }
  | { update_id: number; chat_member: WireChatMemberUpdated }
  | { update_id: number; message_reaction: WireMessageReactionUpdated }
  | { update_id: number; message_reaction_count: WireMessageReactionCountUpdated };

// Lookup: given an UpdateType, what payload does the dispatcher
// enqueue? Used to make Dispatcher.enqueue generic.
export type PayloadFor<T extends UpdateType> = T extends
  | "message"
  | "edited_message"
  | "channel_post"
  | "edited_channel_post"
  ? WireMessage
  : T extends "callback_query"
    ? WireCallbackQuery
    : T extends "my_chat_member" | "chat_member"
      ? WireChatMemberUpdated
      : T extends "message_reaction"
        ? WireMessageReactionUpdated
        : T extends "message_reaction_count"
          ? WireMessageReactionCountUpdated
          : never;

// Central wrapping: the runtime value `{ update_id, [type]: payload }`
// is a valid WireUpdate variant but TS cannot narrow the computed-key
// construction across the discriminated union. Per TYPING_SPEC §5.3
// this is the single sanctioned place for the cast — every caller
// remains fully typed via the generic signature.
export function wrapPayload<T extends UpdateType>(
  update_id: number,
  type: T,
  payload: PayloadFor<T>,
): WireUpdate {
  return { update_id, [type]: payload } as unknown as WireUpdate;
}
