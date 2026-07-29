import { Store, type Collection } from "@emulators/core";
import type {
  TelegramBot,
  TelegramUser,
  TelegramChat,
  TelegramMessage,
  TelegramFile,
  TelegramCallbackQuery,
  TelegramUpdate,
  TelegramDraftSnapshot,
  TelegramReaction,
  TelegramFault,
  TelegramForumTopic,
} from "./entities.js";

export interface TelegramStore {
  bots: Collection<TelegramBot>;
  users: Collection<TelegramUser>;
  chats: Collection<TelegramChat>;
  messages: Collection<TelegramMessage>;
  files: Collection<TelegramFile>;
  callbackQueries: Collection<TelegramCallbackQuery>;
  updates: Collection<TelegramUpdate>;
  draftSnapshots: Collection<TelegramDraftSnapshot>;
  reactions: Collection<TelegramReaction>;
  faults: Collection<TelegramFault>;
  forumTopics: Collection<TelegramForumTopic>;
}

export function getTelegramStore(store: Store): TelegramStore {
  return {
    bots: store.collection<TelegramBot>("telegram.bots", ["bot_id", "token", "username"]),
    users: store.collection<TelegramUser>("telegram.users", ["user_id", "username"]),
    chats: store.collection<TelegramChat>("telegram.chats", ["chat_id", "type"]),
    messages: store.collection<TelegramMessage>("telegram.messages", ["chat_id", "message_id", "from_bot_id"]),
    files: store.collection<TelegramFile>("telegram.files", ["file_id", "file_unique_id"]),
    callbackQueries: store.collection<TelegramCallbackQuery>("telegram.callback_queries", ["callback_query_id"]),
    updates: store.collection<TelegramUpdate>("telegram.updates", ["for_bot_id", "update_id", "delivered"]),
    draftSnapshots: store.collection<TelegramDraftSnapshot>("telegram.draft_snapshots", [
      "chat_id",
      "draft_id",
      "bot_id",
    ]),
    reactions: store.collection<TelegramReaction>("telegram.reactions", ["chat_id", "message_id"]),
    faults: store.collection<TelegramFault>("telegram.faults", ["bot_id", "method"]),
    forumTopics: store.collection<TelegramForumTopic>("telegram.forum_topics", ["chat_id", "message_thread_id"]),
  };
}
