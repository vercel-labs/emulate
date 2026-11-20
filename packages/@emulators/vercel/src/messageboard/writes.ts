import { randomUUID } from "node:crypto";
import type { Actor, Board, Channel, Message, Thread } from "./types.js";
import { changesIn, channelNamed, emit, now, type Session } from "./context.js";
import { newChannelId, newThreadId, showMessage, showThread } from "./views.js";

export function principalKey(actor: Actor): string {
  const principal = actor.principal;
  if (principal.type === "user") return `vercel:user:${principal.userId}`;
  if (principal.type === "app") return `vercel:app:${principal.clientId}`;
  if (principal.type === "project") return `vercel:project:${principal.projectId}:${principal.environment}`;
  return principal.id;
}

/** Whether `actor` may change what `by` wrote: its principal did, and as its profile when it writes as one. */
export function owns(actor: Actor, by: Actor): boolean {
  return principalKey(actor) === principalKey(by) && (!actor.profile || actor.id === by.id);
}

export function makeChannel(session: Session, board: Board, name: string): Channel {
  const existing = channelNamed(session, board, name);
  if (existing) return existing;
  return session.ms.channels.insert({ uid: newChannelId(), boardId: board.uid, name, createdAt: now() });
}

/** Posts a reply in `thread`, as `actor`, in `channel`. */
export function reply(
  session: Session,
  board: Board,
  thread: Thread,
  channel: Channel,
  actor: Actor,
  text: string,
  replyTo: number | undefined,
  clientId: string | undefined,
  labels: Record<string, string> = {},
): Message {
  const sequence = thread.messageCount + 1;
  const createdAt = now();
  const feedSequence = changesIn(session, board, channel.uid).length + 1;
  const message = session.ms.messages.insert({
    uid: `msg_${thread.uid.slice("thr_".length)}_${sequence}`,
    boardId: board.uid,
    threadId: thread.uid,
    sequence,
    ...(replyTo !== undefined ? { replyTo } : {}),
    text,
    revision: 1,
    version: 1,
    createdAt,
    createdBy: actor,
    labels: { ...labels },
    feedSequence,
    ...(clientId !== undefined ? { clientId, clientKey: `${principalKey(actor)}|${clientId}` } : {}),
  });
  session.ms.threads.update(thread.id, {
    messageCount: sequence,
    lastActivityAt: createdAt,
    lastMessage: { id: message.uid, sequence, createdAt, createdBy: actor },
  });
  emit(session, board, channel, {
    type: "message.posted",
    actor,
    threadId: thread.uid,
    message: sequence,
    messageId: message.uid,
  });
  return message;
}

/** Starts a thread in `channel` with its first message, answering both as the API's post route does. */
export function startThread(
  session: Session,
  board: Board,
  channel: Channel,
  actor: Actor,
  text: string,
  labels: Record<string, string>,
  clientId: string | undefined,
): Record<string, unknown> {
  const createdAt = now();
  const thread = session.ms.threads.insert({
    uid: newThreadId(),
    boardId: board.uid,
    channelId: channel.uid,
    messageCount: 0,
    createdAt,
    createdBy: actor,
    lastActivityAt: createdAt,
    lastMessage: null,
  });
  const message = reply(session, board, thread, channel, actor, text, undefined, clientId, labels);
  return {
    thread: showThread(session.ms, session.ms.threads.get(thread.id)!, board),
    message: showMessage(session.ms, session.ms.messages.get(message.id)!),
  };
}

/** Adds, changes, or removes a message's labels, publishing the change as one `message.labeled`. */
export function applyLabels(
  session: Session,
  board: Board,
  thread: Thread,
  channel: Channel,
  message: Message,
  actor: Actor,
  set: Record<string, string>,
  unset: string[],
): "too_many" | void {
  const changes: Record<string, { from?: string; to?: string }> = {};
  const labels = { ...message.labels };
  for (const key of unset) {
    if (Object.hasOwn(labels, key)) {
      changes[key] = { from: labels[key]! };
      delete labels[key];
    }
  }
  for (const [key, value] of Object.entries(set)) {
    if (labels[key] !== value) {
      changes[key] = { ...(Object.hasOwn(labels, key) ? { from: labels[key]! } : {}), to: value };
      labels[key] = value;
    }
  }
  if (Object.keys(labels).length > 16) return "too_many";
  if (Object.keys(changes).length > 0) {
    session.ms.messages.update(message.id, { labels, version: message.version + 1 });
    emit(session, board, channel, {
      type: "message.labeled",
      actor,
      threadId: thread.uid,
      message: message.sequence,
      messageId: message.uid,
      labels: changes,
    });
  }
}

export function addReaction(
  session: Session,
  board: Board,
  thread: Thread,
  channel: Channel,
  message: Message,
  actor: Actor,
  emoji: string,
): void {
  const existing = session.ms.reactions
    .findBy("messageUid", message.uid)
    .find((reaction) => reaction.emoji === emoji && reaction.actorId === actor.id);
  if (existing) return;
  session.ms.reactions.insert({
    uid: `rct_${randomUUID()}`,
    boardId: board.uid,
    threadId: thread.uid,
    messageUid: message.uid,
    emoji,
    actorId: actor.id,
    actor,
    createdAt: now(),
  });
}
