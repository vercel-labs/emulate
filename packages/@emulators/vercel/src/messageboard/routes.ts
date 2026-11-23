import { randomUUID } from "node:crypto";
import type { Context, RouteContext } from "@emulators/core";
import type { VercelTeam } from "../entities.js";
import type { Board, Channel } from "./types.js";
import {
  boardOf,
  boardView,
  bodyOf,
  canOf,
  canWrite,
  changeView,
  changesIn,
  channelNamed,
  channelOf,
  cursorAt,
  defaultGrants,
  emit,
  fail,
  identityOf,
  mayRead,
  mayUse,
  messageOf,
  now,
  parseCursor,
  sessionOf,
  summaryOf,
  tagged,
  teamOf,
  threadOf,
  tokenMay,
  type Identity,
  type Session,
} from "./context.js";
import {
  latestOf,
  metaOf,
  newBoardId,
  newChannelId,
  reactionRows,
  rootOf,
  showMessage,
  showThread,
  withActors,
  actorViewFor,
} from "./views.js";
import { grantRoutes } from "./grants.js";
import { applyLabels, makeChannel, owns, principalKey, reply, startThread } from "./writes.js";

const BOARD_NAME = /^[^/]{1,64}$/;
const CHANNEL_NAME = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;
const CLIENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const LABEL = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const EMOJI = /^[a-z0-9_+-]{1,64}$/;
const THREAD_PAGE_MAX = 100;
const MAIN_CHANNEL = "general";

function isFailure(value: unknown): value is Response {
  return value instanceof Response;
}

function identified(c: Context, session: Session): { identity: Identity; team: VercelTeam | null } | Response {
  const team = teamOf(c, session.vs);
  const identity = identityOf(c, session, team);
  if (isFailure(identity)) return identity;
  return { identity, team };
}

function boardFor(c: Context, session: Session, identity: Identity): Board | Response {
  return boardOf(c, session, identity);
}

function makeBoard(
  session: Session,
  teamId: string,
  name: string,
  options: { default?: boolean; visibility?: "team" | "private"; members?: string[] | null } = {},
): Board {
  const board = session.ms.boards.insert({
    uid: newBoardId(),
    teamId,
    name,
    visibility: options.visibility ?? "team",
    members: options.members ?? null,
    isDefault: options.default === true,
  });
  defaultGrants(session, board);
  return board;
}

function labelsValid(value: Record<string, unknown>): boolean {
  const entries = Object.entries(value);
  return (
    entries.length <= 16 &&
    entries.every(([key, label]) => LABEL.test(key) && typeof label === "string" && label.length <= 200)
  );
}

function validateText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length > 10_000) return null;
  return value;
}

function reservedLabels(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => key.startsWith("board."));
}

const BODY_MAX = 1_000_000;

function threadPageCursor(scope: string, value: number): string {
  return Buffer.from(JSON.stringify({ scope, value: String(value) })).toString("base64url");
}

function readThreadCursor(cursor: string, scope: string): number | null {
  if (cursor.length > 1024) return null;
  try {
    const found = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { scope?: unknown; value?: unknown };
    if (found.scope !== scope) return null;
    if (typeof found.value !== "string" || !/^\d+$/.test(found.value)) return null;
    return Number(found.value);
  } catch {
    return null;
  }
}

export function messageboardRoutes(context: RouteContext): void {
  const session = sessionOf(context);
  const app = context.app;

  // A body larger than any board write needs is refused before it is read.
  app.use("/v1/messageboard/*", async (c, next) => {
    const length = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(length) && length > BODY_MAX)
      return fail(c, 413, "entity_too_large", "The request body is too large.");
    await next();
  });

  // ---- Team-level routes -------------------------------------------------

  app.get("/v1/messageboard/me", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const { identity, team } = found;
    const baselineCan =
      identity.who.kind === "user" && identity.who.role === "viewer"
        ? ["read", "react"]
        : identity.who.kind === "user"
          ? ["read", "post", "react", "label", "sync", "manage"]
          : identity.who.kind === "project"
            ? ["read", "post", "react", "label", "sync"]
            : ["read", "post", "react", "label"];
    return c.json({
      teamId: team?.uid ?? "team_emulated",
      actor: identity.actor,
      view: actorViewFor(session.ms, session.vs, identity.actor),
      can: { "*": baselineCan },
      expiresAt: null,
    });
  });

  app.get("/v1/messageboard/boards", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const { identity, team } = found;
    const name = c.req.query("name")?.trim().normalize("NFC") ?? null;
    if (name !== null && !BOARD_NAME.test(name))
      return fail(c, 400, "invalid_request", "A board name is 1 to 64 characters with no /.");
    const scoped = c.req.query("teamId") !== undefined || c.req.query("slug") !== undefined;
    const usable = session.ms.boards
      .all()
      .filter((board) => mayUse(session, board, identity.actor.principal))
      .filter((board) => !scoped || board.teamId === team?.uid)
      .filter((board) => name === null || board.name.toLowerCase() === name.toLowerCase());
    const preferred = usable.find((board) => board.isDefault) ?? usable[0];
    return c.json({ boards: usable.map(boardView), defaultBoardId: preferred?.uid ?? null, cursor: null });
  });

  app.post("/v1/messageboard/boards/default", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const { identity, team } = found;
    if (!team) return fail(c, 404, "board_not_found", "No team for this board.");
    if (identity.actor.principal.type !== "user") return fail(c, 403, "forbidden");
    const existing = session.ms.boards.findBy("teamId", team.uid).find((board) => board.isDefault);
    if (existing) return c.json({ board: boardView(existing) });
    if (session.ms.boards.findBy("teamId", team.uid).some((board) => board.name.toLowerCase() === "general"))
      return fail(c, 409, "board_name_taken");
    const board = makeBoard(session, team.uid, "General", { default: true });
    makeChannel(session, board, MAIN_CHANNEL);
    return c.json({ board: boardView(board) });
  });

  app.post("/v1/messageboard/boards/ensure", async (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const { identity, team } = found;
    const account =
      identity.actor.principal.type === "project"
        ? session.vs.projects.findOneBy("uid", identity.actor.principal.projectId)?.accountId
        : undefined;
    const owner = account ? session.vs.teams.findOneBy("uid", account) : team;
    if (!owner) return fail(c, 404, "board_not_found", "No team for this board.");
    const body = await bodyOf(c);
    if (body === null) return fail(c, 400, "invalid_request", "The request body isn't JSON.");
    const name = typeof body.name === "string" ? body.name.trim().normalize("NFC") : null;
    if (name === null || !BOARD_NAME.test(name))
      return fail(c, 400, "invalid_request", "A board name is 1 to 64 characters with no /.");
    const some = session.ms.boards
      .findBy("teamId", owner.uid)
      .find((board) => board.name.toLowerCase() === name.toLowerCase());
    if (some) {
      if (!mayUse(session, some, identity.actor.principal))
        return fail(c, 409, "board_name_taken", "A board has that name.");
      return c.json({ board: boardView(some), created: false });
    }
    const board = makeBoard(session, owner.uid, name);
    return c.json({ board: boardView(board), created: true });
  });

  app.get("/v1/messageboard/boards/:board", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    return c.json({ board: boardView(board) });
  });

  app.get("/v1/messageboard/boards/:board/me", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const can = summaryOf(session, board, found.identity.who);
    return c.json({
      teamId: board.teamId,
      actor: found.identity.actor,
      view: actorViewFor(session.ms, session.vs, found.identity.actor),
      can,
      expiresAt: null,
    });
  });

  // ---- Channels ----------------------------------------------------------

  app.get("/v1/messageboard/boards/:board/channels", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const { who } = found.identity;
    const readable = session.ms.channels
      .findBy("boardId", board.uid)
      .filter((channel) => mayRead(session, board, who, channel));
    const name = c.req.query("name") ?? null;
    if (name !== null)
      return tagged(c, {
        channels: readable
          .filter((channel) => channel.name === name)
          .map((channel) => ({ id: channel.uid, name: channel.name })),
        cursor: null,
      });
    const prefix = c.req.query("prefix") ?? null;
    const limit = Number(c.req.query("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      return fail(c, 400, "invalid_request", "A page holds 1 to 500 channels.");
    const scope = prefix === null ? "all" : Buffer.from(JSON.stringify(prefix)).toString("base64url").slice(0, 8);
    const cursor = c.req.query("cursor") ?? null;
    let from = 0;
    if (cursor !== null) {
      const parsed = /^(.+)\.(\d+)$/.exec(cursor);
      if (!parsed || parsed[1] !== scope) return fail(c, 400, "invalid_cursor");
      from = Number(parsed[2]);
    }
    const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const listed = (prefix === null ? readable : readable.filter((channel) => channel.name.startsWith(prefix))).sort(
      byName,
    );
    const page = listed.slice(from, from + limit);
    return tagged(c, {
      channels: page.map((channel) => ({ id: channel.uid, name: channel.name })),
      cursor: from + page.length < listed.length ? `${scope}.${from + page.length}` : null,
    });
  });

  app.get("/v1/messageboard/boards/:board/channels/:channel", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const channel = channelOf(session, board, c.req.param("channel"));
    if (!channel || !mayRead(session, board, found.identity.who, channel)) return fail(c, 404, "channel_not_found");
    return tagged(c, { channel: { id: channel.uid, name: channel.name } });
  });

  app.post("/v1/messageboard/boards/:board/channels", async (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const body = await bodyOf(c);
    if (body === null) return fail(c, 400, "invalid_request", "The request body isn't JSON.");
    const name = typeof body.name === "string" ? body.name : "";
    if (!CHANNEL_NAME.test(name) || name.length > 80) return fail(c, 400, "invalid_channel_name");
    if (!canWrite(session, board, found.identity.who, "read", name)) return fail(c, 403, "forbidden");
    if (channelNamed(session, board, name)) return fail(c, 409, "channel_name_taken");
    const channel = session.ms.channels.insert({ uid: newChannelId(), boardId: board.uid, name, createdAt: now() });
    return c.json({ channel: { id: channel.uid, name: channel.name } });
  });

  // ---- Actors ------------------------------------------------------------

  app.get("/v1/messageboard/boards/:board/actors", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const ids = c.req.queries("id");
    const listed = session.ms.actors.findBy("boardId", board.uid);
    const actors = ids
      ? ids.flatMap((id) => {
          const record = listed.find((actor) => actor.actorId === id);
          return record ? [actorViewFor(session.ms, session.vs, record.actor)] : [];
        })
      : listed
          .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
          .map((record) => actorViewFor(session.ms, session.vs, record.actor));
    return tagged(c, { actors, cursor: null });
  });

  // ---- Threads -----------------------------------------------------------

  app.get("/v1/messageboard/boards/:board/threads", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const { who } = found.identity;
    const name = c.req.query("channel");
    const id = c.req.query("channelId");
    let channel: Channel | undefined;
    if (name !== undefined) channel = channelNamed(session, board, name);
    else if (id !== undefined) channel = channelOf(session, board, id);
    if (!channel) return fail(c, 404, "channel_not_found");
    if (!mayRead(session, board, who, channel)) return fail(c, 404, "channel_not_found");
    const label = c.req.query("label") ?? null;
    let listed = session.ms.threads.findBy("boardId", board.uid).filter((thread) => thread.channelId === channel!.uid);
    if (label !== null) {
      const [key, value] = label.split("=", 2) as [string, string | undefined];
      listed = listed.filter((thread) => {
        const root = rootOf(session.ms, thread);
        return (
          root !== undefined && Object.hasOwn(root.labels, key) && (value === undefined || root.labels[key] === value)
        );
      });
      listed.sort((a, b) => a.createdAt - b.createdAt);
    } else {
      listed.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    }
    const limit = Number(c.req.query("limit") ?? 25);
    if (!Number.isInteger(limit) || limit < 1 || limit > THREAD_PAGE_MAX)
      return fail(c, 400, "invalid_request", "A page holds 1 to 100 threads.");
    const scope = `${board.teamId}#${board.uid}#${channel.uid}#threads`;
    const cursor = c.req.query("cursor") ?? null;
    const from = cursor === null ? 0 : readThreadCursor(cursor, scope);
    if (from === null) return fail(c, 400, "invalid_cursor", "Invalid cursor.");
    const page = listed.slice(from, from + limit);
    const include = c.req.query("include") ?? null;
    if (include !== null && include !== "messages") return fail(c, 400, "invalid_request");
    const threads = page.map((thread) => {
      const shown = showThread(session.ms, thread, board);
      if (include !== "messages") return shown;
      const root = rootOf(session.ms, thread);
      const latest = latestOf(session.ms, thread);
      return {
        ...shown,
        ...(root ? { rootMessage: showMessage(session.ms, root) } : {}),
        ...(latest ? { latestMessage: showMessage(session.ms, latest) } : {}),
      };
    });
    const read: Record<string, unknown> = {
      threads,
      cursor: from + page.length < listed.length ? threadPageCursor(scope, from + page.length) : null,
    };
    return c.json(withActors(c, session.ms, session.vs, read));
  });

  app.post("/v1/messageboard/boards/:board/threads", async (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const body = await bodyOf(c);
    if (body === null) return fail(c, 400, "invalid_request", "The request body isn't JSON.");
    const { actor, who } = found.identity;
    const name = typeof body.channel === "string" ? body.channel : null;
    const channelId = typeof body.channelId === "string" ? body.channelId : null;
    if (name === null && channelId === null) return fail(c, 400, "invalid_request", "A post names a channel.");
    if (name !== null && channelId !== null) return fail(c, 400, "invalid_request");
    if (name !== null && (!CHANNEL_NAME.test(name) || name.length > 80)) return fail(c, 400, "invalid_channel_name");
    const known = name !== null ? channelNamed(session, board, name) : channelOf(session, board, channelId!);
    if (!known && name === null) return fail(c, 404, "channel_not_found");
    if (known && !canWrite(session, board, who, "post", known.name)) return fail(c, 403, "forbidden");
    if (!known && !tokenMay(who, "post", name!)) return fail(c, 403, "forbidden");
    if (!known && !canOf(session, board, who, name!).includes("post")) return fail(c, 403, "forbidden");
    const text = validateText(body.text);
    if (text === null || text.trim().length === 0)
      return fail(c, 400, "invalid_message", "A message is 1 to 10000 characters.");
    const labels = body.labels && typeof body.labels === "object" ? body.labels : {};
    if (!labelsValid(labels)) return fail(c, 400, "invalid_label");
    if (reservedLabels(labels)) return fail(c, 400, "reserved_label", "Labels under board. are the board's own.");
    if (body.task !== undefined) return fail(c, 400, "invalid_request", "A post takes no task.");
    const clientId = body.clientId;
    if (clientId !== undefined && (typeof clientId !== "string" || !CLIENT_ID.test(clientId)))
      return fail(c, 400, "invalid_client_id");
    if (typeof clientId === "string") {
      const again = session.ms.messages.findOneBy("clientKey", `${board.uid}|${principalKey(actor)}|${clientId}`);
      if (again) {
        const thread = session.ms.threads.findOneBy("uid", again.threadId)!;
        const read: Record<string, unknown> = {
          thread: showThread(session.ms, thread, board),
          message: showMessage(session.ms, again),
        };
        return c.json(withActors(c, session.ms, session.vs, read));
      }
    }
    const channel =
      known ?? session.ms.channels.insert({ uid: newChannelId(), boardId: board.uid, name: name!, createdAt: now() });
    const made = startThread(session, board, channel, actor, text, labels, clientId);
    return c.json(made);
  });

  app.get("/v1/messageboard/boards/:board/threads/:thread", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const thread = threadOf(session, board, c.req.param("thread"));
    if (!thread) return fail(c, 404, "thread_not_found");
    const channel = session.ms.channels.findOneBy("uid", thread.channelId)!;
    if (!mayRead(session, board, found.identity.who, channel)) return fail(c, 404, "channel_not_found");
    const read: Record<string, unknown> = { thread: showThread(session.ms, thread, board) };
    if (c.req.query("include") === "channel") read.channel = { id: channel.uid, name: channel.name };
    return c.json(withActors(c, session.ms, session.vs, read));
  });

  app.get("/v1/messageboard/boards/:board/threads/:thread/messages", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const thread = threadOf(session, board, c.req.param("thread"));
    if (!thread) return fail(c, 404, "thread_not_found");
    const channel = session.ms.channels.findOneBy("uid", thread.channelId)!;
    if (!mayRead(session, board, found.identity.who, channel)) return fail(c, 404, "channel_not_found");
    const after = Number(c.req.query("after") ?? 0);
    const limit = Number(c.req.query("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return fail(c, 400, "invalid_request", "A page holds 1 to 100 messages.");
    let listed = session.ms.messages
      .findBy("threadId", thread.uid)
      .filter((message) => message.sequence > after)
      .sort((a, b) => a.sequence - b.sequence);
    if (c.req.query("order") === "desc") listed = listed.reverse();
    const cursor = c.req.query("cursor") ?? null;
    let from = 0;
    if (cursor !== null) {
      if (!/^\d+$/.test(cursor)) return fail(c, 400, "invalid_cursor");
      from = Number(cursor);
    }
    const page = listed.slice(from, from + limit);
    const read: Record<string, unknown> = {
      messages: page.map((message) => showMessage(session.ms, message)),
      cursor: from + page.length < listed.length ? String(from + page.length) : null,
    };
    return c.json(withActors(c, session.ms, session.vs, read));
  });

  app.post("/v1/messageboard/boards/:board/threads/:thread/messages", async (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const thread = threadOf(session, board, c.req.param("thread"));
    if (!thread) return fail(c, 404, "thread_not_found");
    const channel = session.ms.channels.findOneBy("uid", thread.channelId)!;
    if (!canWrite(session, board, found.identity.who, "post", channel.name)) return fail(c, 403, "forbidden");
    const body = await bodyOf(c);
    if (body === null) return fail(c, 400, "invalid_request", "The request body isn't JSON.");
    const { actor } = found.identity;
    const text = validateText(body.text);
    if (text === null || text.trim().length === 0)
      return fail(c, 400, "invalid_message", "A message is 1 to 10000 characters.");
    const clientId = body.clientId;
    if (clientId !== undefined && (typeof clientId !== "string" || !CLIENT_ID.test(clientId)))
      return fail(c, 400, "invalid_client_id");
    if (typeof clientId === "string") {
      const again = session.ms.messages.findOneBy("clientKey", `${board.uid}|${principalKey(actor)}|${clientId}`);
      if (again) {
        const read: Record<string, unknown> = {
          thread: showThread(session.ms, thread, board),
          message: showMessage(session.ms, again),
        };
        return c.json(withActors(c, session.ms, session.vs, read));
      }
    }
    if (body.after !== undefined) {
      if (!Number.isInteger(body.after) || body.after < 1 || body.after > thread.messageCount)
        return fail(c, 400, "invalid_after");
      if (body.after !== thread.messageCount)
        return fail(c, 409, "newer_message", `message ${thread.messageCount} came after ${body.after}`);
    }
    const replyTo = body.replyTo !== undefined ? Number(body.replyTo) : undefined;
    if (replyTo !== undefined && (replyTo < 1 || replyTo > thread.messageCount)) return fail(c, 400, "invalid_reply");
    if (body.labels && typeof body.labels === "object" && Object.keys(body.labels).length > 0) {
      if (!labelsValid(body.labels)) return fail(c, 400, "invalid_label");
      if (reservedLabels(body.labels))
        return fail(c, 400, "reserved_label", "Labels under board. are the board's own.");
    }
    const message = reply(
      session,
      board,
      thread,
      channel,
      actor,
      text,
      replyTo,
      typeof clientId === "string" ? clientId : undefined,
    );
    if (body.labels && typeof body.labels === "object" && Object.keys(body.labels).length > 0)
      applyLabels(session, board, thread, channel, message, actor, body.labels as Record<string, string>, []);
    const read: Record<string, unknown> = {
      thread: showThread(session.ms, thread, board),
      message: showMessage(session.ms, message),
    };
    return c.json(withActors(c, session.ms, session.vs, read));
  });

  app.get("/v1/messageboard/boards/:board/threads/:thread/messages/:n", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const thread = threadOf(session, board, c.req.param("thread"));
    if (!thread) return fail(c, 404, "thread_not_found");
    const message = messageOf(session, thread, Number(c.req.param("n")));
    if (!message) return fail(c, 404, "message_not_found");
    const channel = session.ms.channels.findOneBy("uid", thread.channelId)!;
    if (!mayRead(session, board, found.identity.who, channel)) return fail(c, 404, "channel_not_found");
    return c.json({ message: showMessage(session.ms, message) });
  });

  app.patch("/v1/messageboard/boards/:board/threads/:thread/messages/:n", async (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const thread = threadOf(session, board, c.req.param("thread"));
    if (!thread) return fail(c, 404, "thread_not_found");
    const channel = session.ms.channels.findOneBy("uid", thread.channelId)!;
    if (!canWrite(session, board, found.identity.who, "post", channel.name)) return fail(c, 403, "forbidden");
    const message = messageOf(session, thread, Number(c.req.param("n")));
    if (!message) return fail(c, 404, "message_not_found");
    if (!owns(found.identity.actor, message.createdBy)) return fail(c, 403, "message_not_owned");
    const body = await bodyOf(c);
    if (body === null) return fail(c, 400, "invalid_request", "The request body isn't JSON.");
    const text = validateText(body.text);
    if (text === null || text.trim().length === 0)
      return fail(c, 400, "invalid_message", "A message is 1 to 10000 characters.");
    if (typeof body.revision === "number" && body.revision !== message.revision)
      return fail(
        c,
        409,
        "revision_conflict",
        `The message changed since revision ${body.revision}; it is at revision ${message.revision}.`,
      );
    if (message.deletedAt !== undefined) return fail(c, 409, "message_deleted");
    if (message.text !== text) {
      session.ms.messages.update(message.id, {
        text,
        editedAt: now(),
        revision: message.revision + 1,
        version: message.version + 1,
      });
      emit(session, board, channel, {
        type: "message.edited",
        actor: found.identity.actor,
        threadId: thread.uid,
        message: message.sequence,
        messageId: message.uid,
      });
    }
    const current = session.ms.messages.get(message.id)!;
    return c.json({ message: showMessage(session.ms, current) });
  });

  app.post("/v1/messageboard/boards/:board/threads/:thread/messages/:n/delete", async (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const thread = threadOf(session, board, c.req.param("thread"));
    if (!thread) return fail(c, 404, "thread_not_found");
    const channel = session.ms.channels.findOneBy("uid", thread.channelId)!;
    if (!canWrite(session, board, found.identity.who, "post", channel.name)) return fail(c, 403, "forbidden");
    const message = messageOf(session, thread, Number(c.req.param("n")));
    if (!message) return fail(c, 404, "message_not_found");
    if (!owns(found.identity.actor, message.createdBy)) return fail(c, 403, "message_not_owned");
    const body = await bodyOf(c);
    if (body === null) return fail(c, 400, "invalid_request", "The request body isn't JSON.");
    if (typeof body.revision === "number" && body.revision !== message.revision)
      return fail(
        c,
        409,
        "revision_conflict",
        `The message changed since revision ${body.revision}; it is at revision ${message.revision}.`,
      );
    if (message.deletedAt === undefined) {
      session.ms.messages.update(message.id, {
        text: "",
        deletedAt: now(),
        revision: message.revision + 1,
        version: message.version + 1,
      });
      const channel = session.ms.channels.findOneBy("uid", thread.channelId)!;
      emit(session, board, channel, {
        type: "message.deleted",
        actor: found.identity.actor,
        threadId: thread.uid,
        message: message.sequence,
        messageId: message.uid,
      });
    }
    return c.json({ message: showMessage(session.ms, session.ms.messages.get(message.id)!) });
  });

  app.get("/v1/messageboard/boards/:board/threads/:thread/messages/:n/reactions", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const thread = threadOf(session, board, c.req.param("thread"));
    if (!thread) return fail(c, 404, "thread_not_found");
    const channel = session.ms.channels.findOneBy("uid", thread.channelId)!;
    if (!mayRead(session, board, found.identity.who, channel)) return fail(c, 404, "channel_not_found");
    const message = messageOf(session, thread, Number(c.req.param("n")));
    if (!message) return fail(c, 404, "message_not_found");
    return c.json({
      reactions: reactionRows(session.ms, message).map((reaction) => ({
        emoji: reaction.emoji,
        actor: reaction.actor,
        createdAt: reaction.createdAt,
      })),
      cursor: null,
    });
  });

  app.post("/v1/messageboard/boards/:board/threads/:thread/messages/:n/reactions", async (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const thread = threadOf(session, board, c.req.param("thread"));
    if (!thread) return fail(c, 404, "thread_not_found");
    const channel = session.ms.channels.findOneBy("uid", thread.channelId)!;
    if (!canWrite(session, board, found.identity.who, "react", channel.name)) return fail(c, 403, "forbidden");
    const message = messageOf(session, thread, Number(c.req.param("n")));
    if (!message) return fail(c, 404, "message_not_found");
    const body = await bodyOf(c);
    if (body === null) return fail(c, 400, "invalid_request", "The request body isn't JSON.");
    if (typeof body.emoji !== "string" || !EMOJI.test(body.emoji) || Object.hasOwn(Object.prototype, body.emoji))
      return fail(c, 400, "invalid_emoji");
    if (message.deletedAt !== undefined) return fail(c, 409, "message_deleted");
    const { actor } = found.identity;
    const existing = session.ms.reactions
      .findBy("messageUid", message.uid)
      .find((reaction) => reaction.emoji === body.emoji && reaction.actorId === actor.id);
    if (body.remove === true) {
      if (existing) {
        session.ms.reactions.delete(existing.id);
        session.ms.messages.update(message.id, { version: message.version + 1 });
        emit(session, board, channel, {
          type: "message.reaction_removed",
          actor,
          threadId: thread.uid,
          message: message.sequence,
          messageId: message.uid,
          emoji: body.emoji,
        });
      }
    } else if (!existing) {
      session.ms.reactions.insert({
        uid: `rct_${randomUUID()}`,
        boardId: board.uid,
        threadId: thread.uid,
        messageUid: message.uid,
        emoji: body.emoji,
        actorId: actor.id,
        actor,
        createdAt: now(),
      });
      session.ms.messages.update(message.id, { version: message.version + 1 });
      emit(session, board, channel, {
        type: "message.reaction_added",
        actor,
        threadId: thread.uid,
        message: message.sequence,
        messageId: message.uid,
        emoji: body.emoji,
      });
    }
    return c.json({ meta: metaOf(session.ms, session.ms.messages.get(message.id)!) });
  });

  app.post("/v1/messageboard/boards/:board/threads/:thread/messages/:n/labels", async (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const thread = threadOf(session, board, c.req.param("thread"));
    if (!thread) return fail(c, 404, "thread_not_found");
    const channel = session.ms.channels.findOneBy("uid", thread.channelId)!;
    if (!canWrite(session, board, found.identity.who, "label", channel.name)) return fail(c, 403, "forbidden");
    const message = messageOf(session, thread, Number(c.req.param("n")));
    if (!message) return fail(c, 404, "message_not_found");
    const body = await bodyOf(c);
    if (body === null) return fail(c, 400, "invalid_request", "The request body isn't JSON.");
    const set = body.set && typeof body.set === "object" ? (body.set as Record<string, string>) : {};
    const unset = Array.isArray(body.unset) ? (body.unset as string[]) : [];
    if (unset.some((key) => Object.hasOwn(set, key))) return fail(c, 400, "invalid_label");
    if (!Object.keys(set).every((key) => LABEL.test(key)) || !unset.every((key) => LABEL.test(key)))
      return fail(c, 400, "invalid_label");
    if (!labelsValid(set)) return fail(c, 400, "invalid_label");
    if ([...Object.keys(set), ...unset].some((key) => key.startsWith("board.")))
      return fail(c, 400, "reserved_label", "Labels under board. are the board's own.");
    const expected = body.if && typeof body.if === "object" ? (body.if as Record<string, string | null>) : {};
    for (const [key, want] of Object.entries(expected).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const current = Object.hasOwn(message.labels, key) ? message.labels[key] : undefined;
      if (current !== (want ?? undefined))
        return fail(
          c,
          409,
          "label_conflict",
          want === null ? `${key} is set` : current === undefined ? `${key} isn't set` : `${key} isn't ${want}`,
        );
    }
    const apply = applyLabels(session, board, thread, channel, message, found.identity.actor, set, unset);
    if (apply === "too_many") return fail(c, 400, "too_many_labels");
    return c.json({ meta: metaOf(session.ms, session.ms.messages.get(message.id)!) });
  });

  // ---- Messages across a channel ----------------------------------------

  app.get("/v1/messageboard/boards/:board/messages", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const channel = readChannel(c, session, board);
    if (isFailure(channel)) return channel;
    if (!mayRead(session, board, found.identity.who, channel)) return fail(c, 404, "channel_not_found");
    const limit = Number(c.req.query("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(c, 400, "invalid_request");
    const head = changesIn(session, board, channel.uid).length;
    const listed = session.ms.messages
      .findBy("boardId", board.uid)
      .filter((message) => {
        const thread = session.ms.threads.findOneBy("uid", message.threadId);
        return thread?.channelId === channel.uid;
      })
      .sort((a, b) => a.feedSequence - b.feedSequence);
    const after = c.req.query("cursor") ?? c.req.query("after") ?? null;
    if (c.req.query("cursor") !== undefined && c.req.query("after") !== undefined)
      return fail(c, 400, "invalid_request", "Read on with after or with cursor, not both.");
    if (after === null)
      return c.json({
        messages: listed.slice(-limit).map((message) => showMessage(session.ms, message)),
        cursor: cursorAt(head, channel.uid),
        caughtUp: true,
      });
    const parsed = parseCursor(after);
    if (!parsed || parsed.scope !== channel.uid) return fail(c, 400, "invalid_cursor");
    const fresh = listed.filter((message) => message.feedSequence > parsed.position);
    const taken = fresh.slice(0, limit);
    const more = fresh.length > limit;
    return c.json({
      messages: taken.map((message) => showMessage(session.ms, message)),
      cursor: cursorAt(more ? taken[taken.length - 1]!.feedSequence : head, channel.uid),
      caughtUp: !more,
    });
  });

  app.get("/v1/messageboard/boards/:board/messages/:id", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const id = /^msg_([0-9a-f-]{36})_([1-9]\d*)$/.exec(c.req.param("id"));
    if (!id) return fail(c, 404, "message_not_found");
    const thread = session.ms.threads.findOneBy("uid", `thr_${id[1]}`);
    if (!thread || thread.boardId !== board.uid) return fail(c, 404, "message_not_found");
    const message = messageOf(session, thread, Number(id[2]));
    if (!message) return fail(c, 404, "message_not_found");
    const channel = session.ms.channels.findOneBy("uid", thread.channelId)!;
    if (!mayRead(session, board, found.identity.who, channel)) return fail(c, 404, "channel_not_found");
    const read: Record<string, unknown> = {
      thread: showThread(session.ms, thread, board),
      message: showMessage(session.ms, message),
    };
    if (c.req.query("include") === "channel") read.channel = { id: channel.uid, name: channel.name };
    return c.json(withActors(c, session.ms, session.vs, read));
  });

  app.get("/v1/messageboard/boards/:board/posts/:client", (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const message = session.ms.messages.findOneBy(
      "clientKey",
      `${board.uid}|${principalKey(found.identity.actor)}|${c.req.param("client")}`,
    );
    if (!message) return fail(c, 404, "post_not_found");
    const thread = session.ms.threads.findOneBy("uid", message.threadId);
    if (!thread) return fail(c, 404, "post_not_found");
    const read: Record<string, unknown> = {
      thread: showThread(session.ms, thread, board),
      message: showMessage(session.ms, message),
    };
    return c.json(withActors(c, session.ms, session.vs, read));
  });

  // ---- Feeds -------------------------------------------------------------

  app.get("/v1/messageboard/boards/:board/changes", async (c) => {
    const found = identified(c, session);
    if (isFailure(found)) return found;
    const board = boardFor(c, session, found.identity);
    if (isFailure(board)) return board;
    const { who } = found.identity;
    const name = c.req.query("channel");
    const id = c.req.query("channelId");
    const include = c.req.query("include") === "message";
    const last = c.req.query("last") !== undefined ? Number(c.req.query("last")) : null;
    const trees = name !== undefined && name.endsWith("/") ? name : null;
    let channel: Channel | null = null;
    if (id !== undefined) channel = channelOf(session, board, id) ?? null;
    else if (name !== undefined && trees === null) channel = channelNamed(session, board, name) ?? null;
    if ((name !== undefined || id !== undefined) && !channel && trees === null)
      return fail(c, 404, "channel_not_found");
    if (channel && !mayRead(session, board, who, channel)) return fail(c, 404, "channel_not_found");
    if (!channel) {
      const all = session.ms.channels.findBy("boardId", board.uid);
      const inScope =
        trees === null
          ? all
          : all.filter((candidate) => candidate.name === trees.slice(0, -1) || candidate.name.startsWith(trees));
      if (inScope.some((candidate) => !mayRead(session, board, who, candidate)))
        return fail(
          c,
          403,
          "feed_needs_every_channel",
          trees === null
            ? "You can't read every channel of this board, so you can't read its feed across channels: read a channel's."
            : `You can't read every channel under ${trees}, so you can't read its feed: read a channel's.`,
        );
    }

    const scope = channel
      ? channel.uid
      : trees
        ? `tree${Buffer.from(trees).toString("base64url").slice(0, 8)}`
        : "board";
    const listed = changesIn(session, board, channel?.uid).filter((change) => {
      if (!trees) return true;
      const inChannel = session.ms.channels.findOneBy("uid", change.channelId);
      return inChannel !== undefined && (inChannel.name === trees.slice(0, -1) || inChannel.name.startsWith(trees));
    });
    const head = listed.length;
    if (last !== null) {
      if (!Number.isInteger(last) || last < 1 || last > 100) return fail(c, 400, "invalid_request");
      const start = Math.max(0, head - last);
      return c.json({
        events: listed
          .slice(start)
          .map((change, i) => changeView(session, board, change, cursorAt(start + i + 1, scope), include)),
        cursor: cursorAt(head, scope),
        caughtUp: true,
      });
    }
    const cursor = c.req.query("cursor") ?? null;
    let from = c.req.query("from") === "latest" ? head : 0;
    if (cursor !== null) {
      const parsed = parseCursor(cursor);
      if (!parsed || parsed.scope !== scope || parsed.position > head) return fail(c, 400, "invalid_cursor");
      from = parsed.position;
    }
    const wait = Math.min(Number(c.req.query("wait") ?? 0), 25);
    if (wait > 0 && head <= from) {
      const until = Date.now() + wait * 1000;
      const signal = c.req.raw.signal;
      while (Date.now() < until && !signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const nowHead = changesIn(session, board, channel?.uid).filter((change) => {
          if (!trees) return true;
          const inChannel = session.ms.channels.findOneBy("uid", change.channelId);
          return inChannel !== undefined && (inChannel.name === trees.slice(0, -1) || inChannel.name.startsWith(trees));
        }).length;
        if (nowHead > from) break;
      }
    }
    const after = changesIn(session, board, channel?.uid).filter((change) => {
      if (!trees) return true;
      const inChannel = session.ms.channels.findOneBy("uid", change.channelId);
      return inChannel !== undefined && (inChannel.name === trees.slice(0, -1) || inChannel.name.startsWith(trees));
    });
    const taken = after.slice(from, from + 48);
    return c.json({
      events: taken.map((change, i) => changeView(session, board, change, cursorAt(from + i + 1, scope), include)),
      cursor: cursorAt(from + taken.length, scope),
      caughtUp: from + taken.length >= after.length,
    });
  });

  // Grants, schedules, sync's records and schemas: the surface the board's grants commands use.
  grantRoutes(context, session);

  for (const path of ["/v2/messageboard/boards/:board/tasks", "/v2/messageboard/boards/:board/tasks/:rest"]) {
    app.get(path, (c) => fail(c, 501, "no_tasks", "This board keeps no tasks."));
    app.post(path, (c) => fail(c, 501, "no_tasks", "This board keeps no tasks."));
  }
}

function readChannel(c: Context, session: Session, board: Board): Channel | Response {
  const name = c.req.query("channel");
  const id = c.req.query("channelId");
  if (name !== undefined) {
    const found = channelNamed(session, board, name);
    if (!found) return fail(c, 404, "channel_not_found");
    return found;
  }
  if (id !== undefined) {
    const found = channelOf(session, board, id);
    if (!found) return fail(c, 404, "channel_not_found");
    return found;
  }
  return fail(c, 400, "invalid_request", "A read names a channel.");
}
