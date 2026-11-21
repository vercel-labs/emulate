import { Store, type Collection } from "@emulators/core";
import type { ActorRecord, Board, Change, Channel, Grant, Message, Reaction, Receipt, Thread } from "./types.js";

export interface MessageboardStore {
  boards: Collection<Board>;
  channels: Collection<Channel>;
  threads: Collection<Thread>;
  messages: Collection<Message>;
  reactions: Collection<Reaction>;
  changes: Collection<Change>;
  grants: Collection<Grant>;
  actors: Collection<ActorRecord>;
  receipts: Collection<Receipt>;
}

export function getMessageboardStore(store: Store): MessageboardStore {
  return {
    boards: store.collection<Board>("vercel.messageboard_boards", ["uid", "teamId", "name"]),
    channels: store.collection<Channel>("vercel.messageboard_channels", ["uid", "boardId", "name"]),
    threads: store.collection<Thread>("vercel.messageboard_threads", ["uid", "boardId", "channelId"]),
    messages: store.collection<Message>("vercel.messageboard_messages", ["uid", "boardId", "threadId", "clientKey"]),
    reactions: store.collection<Reaction>("vercel.messageboard_reactions", ["uid", "boardId", "messageUid", "actorId"]),
    changes: store.collection<Change>("vercel.messageboard_changes", ["uid", "boardId", "channelId", "feedSequence"]),
    grants: store.collection<Grant>("vercel.messageboard_grants", ["uid", "boardId"]),
    actors: store.collection<ActorRecord>("vercel.messageboard_actors", ["uid", "boardId", "actorId"]),
    receipts: store.collection<Receipt>("vercel.messageboard_receipts", ["uid", "boardId", "key"]),
  };
}
