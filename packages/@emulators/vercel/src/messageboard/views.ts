import { randomUUID } from "node:crypto";
import type { Context } from "@emulators/core";
import type { VercelStore } from "../store.js";
import type { VercelProject, VercelUser } from "../entities.js";
import type { MessageboardStore } from "./store.js";
import type { Actor, Board, Labels, Message, Reaction, Thread } from "./types.js";

export const newUid = (prefix: string) => `${prefix}_${randomUUID()}`;
export const newThreadId = () => newUid("thr");
export const newChannelId = () => newUid("chn");
export const newBoardId = () => newUid("brd");
export const newChangeId = () => newUid("evt");

/** A message's ID points at its thread and its place in it: `msg_<thread uuid>_<n>`. */
export const messageId = (threadId: string, sequence: number) => `msg_${threadId.slice("thr_".length)}_${sequence}`;

export function principalId(principal: Actor["principal"]): string {
  if (principal.type === "external") return principal.id;
  if (principal.type === "user") return `vercel:user:${principal.userId}`;
  if (principal.type === "app") return `vercel:app:${principal.clientId}`;
  return `vercel:project:${principal.projectId}:${principal.environment}`;
}

/** An actor's ID: its principal, then the profile it writes as. */
export function actorId(principal: Actor["principal"], profile: { name: string } | undefined): string {
  return profile ? `${principalId(principal)}+${profile.name.toLowerCase()}` : principalId(principal);
}

export function makeActor(principal: Actor["principal"], profile?: { name: string; avatar?: string }): Actor {
  return {
    id: actorId(principal, profile),
    principal,
    ...(profile ? { profile } : {}),
  };
}

export type ActorView = {
  id: string;
  kind: "person" | "agent" | "deployment" | "app" | "external";
  handle: string;
  name?: string;
  avatar?: string;
};

export function userByLogin(vs: VercelStore, login: string): VercelUser | undefined {
  return vs.users.findOneBy("username", login) ?? vs.users.findOneBy("uid", login);
}

export function userById(vs: VercelStore, id: string): VercelUser | undefined {
  return vs.users.findOneBy("uid", id) ?? vs.users.findOneBy("username", id);
}

export function projectByIdOrName(vs: VercelStore, teamId: string | null, idOrName: string): VercelProject | undefined {
  const project =
    vs.projects.findOneBy("uid", idOrName) ??
    vs.projects.findBy("name", idOrName).find((found) => !teamId || found.accountId === teamId);
  return project;
}

/** A principal's handle and kind, as Vercel's API names them on the actors list. */
export function viewOfPrincipal(vs: VercelStore, actor: Actor): Omit<ActorView, "id"> {
  const { principal, profile } = actor;
  if (principal.type === "user") {
    const user = userById(vs, principal.userId);
    const base = user?.username ?? principal.userId;
    if (profile)
      return {
        kind: "agent",
        handle: `${base}/${profile.name.toLowerCase()}`,
        name: profile.name,
        avatar: profile.avatar,
      };
    return { kind: "person", handle: base, name: user?.name ?? base };
  }
  if (principal.type === "project") {
    const project = vs.projects.findOneBy("uid", principal.projectId);
    const base = project?.name ?? `project:${principal.projectId}:${principal.environment}`;
    if (profile)
      return {
        kind: "agent",
        handle: `${base}/${profile.name.toLowerCase()}`,
        name: profile.name,
        avatar: profile.avatar,
      };
    return { kind: "deployment", handle: base };
  }
  if (principal.type === "app") {
    const app = vs.integrations.findOneBy("client_id", principal.clientId);
    const base = app?.name ?? principal.clientId;
    if (profile)
      return {
        kind: "agent",
        handle: `${base}/${profile.name.toLowerCase()}`,
        name: profile.name,
        avatar: profile.avatar,
      };
    return { kind: "app", handle: base };
  }
  return { kind: "external", handle: principal.id.slice(principal.id.lastIndexOf(":") + 1) };
}

/** Records an actor the board has seen, with the name the API gives it. */
export function seen(ms: MessageboardStore, vs: VercelStore, board: Board, actor: Actor, at = Date.now()): void {
  if (actor.principal.type === "external") return;
  const existing = ms.actors.findOneBy("actorId", actor.id);
  const view = viewOfPrincipal(vs, actor);
  if (existing) {
    ms.actors.update(existing.id, {
      ...view,
      actor,
      lastSeenAt: at,
    });
    return;
  }
  ms.actors.insert({
    uid: actor.id,
    boardId: board.uid,
    actorId: actor.id,
    actor,
    lastSeenAt: at,
    ...view,
  });
}

export function actorViewFor(ms: MessageboardStore, vs: VercelStore, actor: Actor): ActorView {
  const found = ms.actors.findOneBy("actorId", actor.id);
  if (found)
    return { id: found.actorId, kind: found.kind, handle: found.handle, name: found.name, avatar: found.avatar };
  return { id: actor.id, ...viewOfPrincipal(vs, actor) };
}

export function reactionsOf(
  ms: MessageboardStore,
  message: Message,
): { reactions: Record<string, number>; reactors: Record<string, string[]> } {
  const found = ms.reactions.findBy("messageUid", message.uid).sort((a, b) => a.createdAt - b.createdAt);
  const counts: Record<string, number> = {};
  const ids: Record<string, string[]> = {};
  for (const reaction of found) {
    counts[reaction.emoji] = (counts[reaction.emoji] ?? 0) + 1;
    (ids[reaction.emoji] ??= []).push(reaction.actorId);
  }
  return { reactions: counts, reactors: ids };
}

export function showMessage(ms: MessageboardStore, message: Message): Record<string, unknown> {
  const { reactions, reactors } = reactionsOf(ms, message);
  return {
    id: message.uid,
    threadId: message.threadId,
    sequence: message.sequence,
    ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
    text: message.text,
    version: message.version,
    revision: message.revision,
    createdAt: message.createdAt,
    createdBy: message.createdBy,
    ...(message.editedAt !== undefined ? { editedAt: message.editedAt } : {}),
    ...(message.deletedAt !== undefined ? { deletedAt: message.deletedAt } : {}),
    ...(Object.keys(reactions).length ? { reactions, reactors } : {}),
    ...(Object.keys(message.labels).length ? { labels: { ...message.labels } } : {}),
  };
}

/** A message as a write that changes only its labels or reactions answers, `meta`. */
export function metaOf(ms: MessageboardStore, message: Message): Record<string, unknown> {
  const shown = showMessage(ms, message);
  return {
    id: shown.id,
    threadId: shown.threadId,
    sequence: shown.sequence,
    version: shown.version,
    ...(shown.reactions ? { reactions: shown.reactions, reactors: shown.reactors } : {}),
    ...(shown.labels ? { labels: shown.labels } : {}),
  };
}

export function showThread(ms: MessageboardStore, thread: Thread, board: Board): Record<string, unknown> {
  const root = ms.messages.findOneBy("uid", messageId(thread.uid, 1));
  return {
    id: thread.uid,
    channelId: thread.channelId,
    messageCount: thread.messageCount,
    ...(thread.lastMessage ? { lastMessage: thread.lastMessage } : {}),
    createdAt: thread.createdAt,
    createdBy: thread.createdBy,
    lastActivityAt: thread.lastActivityAt,
    teamId: board.teamId,
    boardId: board.uid,
    ...(root && Object.keys(root.labels).length ? { labels: { ...root.labels } } : {}),
  };
}

export function latestOf(ms: MessageboardStore, thread: Thread): Message | undefined {
  if (!thread.lastMessage || thread.lastMessage.sequence < 2) return undefined;
  return ms.messages.findOneBy("uid", messageId(thread.uid, thread.lastMessage.sequence));
}

export function rootOf(ms: MessageboardStore, thread: Thread): Message | undefined {
  return ms.messages.findOneBy("uid", messageId(thread.uid, 1));
}

/** Every actor ID a read names, so `with=actors` answers each once. */
export function namedIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const one of value) namedIn(one, out);
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === "createdBy" || key === "actor") {
      const id = child && typeof child === "object" ? (child as { id?: unknown }).id : undefined;
      if (typeof id === "string") out.add(id);
    } else if ((key === "reactors" || key === "actors") && child && typeof child === "object") {
      if (Array.isArray(child))
        for (const id of child)
          if (typeof id === "string") out.add(id);
          else
            for (const ids of Object.values(child as unknown as Record<string, unknown>))
              if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") out.add(id);
    } else {
      namedIn(child, out);
    }
  }
  return out;
}

/** `with=actors`: every actor a read names, as the actors list answers them by ID. */
export function withActors(
  c: Context,
  ms: MessageboardStore,
  vs: VercelStore,
  read: Record<string, unknown>,
): Record<string, unknown> {
  if (c.req.query("with") !== "actors") return read;
  const actors = [...namedIn(read)].flatMap((id) => {
    const found = ms.actors.findOneBy("actorId", id);
    if (!found) return [];
    return [actorViewFor(ms, vs, found.actor)];
  });
  return { ...read, actors };
}

export function labelsFromBody(value: unknown): Labels {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Labels = {};
  for (const [key, label] of Object.entries(value as Record<string, unknown>)) {
    if (typeof label === "string") out[key] = label;
  }
  return out;
}

export function reactionRows(ms: MessageboardStore, message: Message): Reaction[] {
  return ms.reactions.findBy("messageUid", message.uid).sort((a, b) => a.createdAt - b.createdAt);
}
