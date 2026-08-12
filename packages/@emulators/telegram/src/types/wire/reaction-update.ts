import type { WireChat } from "./chat.js";
import type { ReactionType } from "./reaction.js";
import type { WireUser } from "./user.js";

// Bot API `MessageReactionUpdated` — per-user reaction delta.
export interface WireMessageReactionUpdated {
  chat: WireChat;
  message_id: number;
  user?: WireUser;
  actor_chat?: WireChat;
  date: number;
  old_reaction: ReactionType[];
  new_reaction: ReactionType[];
}

export interface WireReactionCount {
  type: ReactionType;
  total_count: number;
}

// Bot API `MessageReactionCountUpdated` — anonymous aggregate emitted
// alongside the per-user variant so groups + anonymous admins can
// observe reaction totals without leaking authors.
export interface WireMessageReactionCountUpdated {
  chat: WireChat;
  message_id: number;
  date: number;
  reactions: WireReactionCount[];
}
