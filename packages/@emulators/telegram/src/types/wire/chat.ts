import type { ChatPermissions, ChatType } from "../store/chat.js";
import type { ReactionType } from "./reaction.js";
import type { WireMessage } from "./message.js";

// Bot API `Chat` object — what `sendMessage.chat` and friends look like
// on the wire. Emitted by serializeChat.
export interface WireChat {
  id: number;
  type: ChatType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: boolean;
}

// Bot API `ChatFullInfo` — the response body of getChat. Superset of
// WireChat with all the settings/metadata the bot is allowed to read.
export interface WireChatFullInfo extends WireChat {
  accent_color_id: number;
  max_reaction_count: number;
  bio?: string;
  description?: string;
  invite_link?: string;
  slow_mode_delay?: number;
  message_auto_delete_time?: number;
  has_protected_content?: boolean;
  linked_chat_id?: number;
  available_reactions?: ReactionType[];
  permissions?: ChatPermissions;
  // `pinned_message` is self-recursive through WireMessage — serializer
  // guards against cycles with a depth cap.
  pinned_message?: WireMessage;
}

