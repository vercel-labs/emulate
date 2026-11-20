import { createHash } from "node:crypto";
import type { Context, RouteContext } from "@emulators/core";
import { getVercelStore, type VercelStore } from "../store.js";
import type { VercelProject, VercelTeam, VercelUser } from "../entities.js";
import { getMessageboardStore, type MessageboardStore } from "./store.js";
import type {
  Actor,
  Board,
  Can,
  Change,
  Channel,
  Grant,
  Message,
  Permission,
  Principal,
  Profile,
  Thread,
  Who,
} from "./types.js";
import { canIn, canSummary, parseCanHeader, type Directory } from "./access.js";
import { makeActor, newChangeId, reactionsOf, seen, userByLogin, userById, projectByIdOrName } from "./views.js";

export type Session = {
  vs: VercelStore;
  ms: MessageboardStore;
  baseUrl: string;
  /** The tokens the emulator was configured with: a board request from any other bearer token is refused. */
  tokens?: Map<string, unknown>;
};

export function sessionOf({ store, baseUrl, tokenMap }: RouteContext): Session {
  return {
    vs: getVercelStore(store),
    ms: getMessageboardStore(store),
    baseUrl,
    ...(tokenMap ? { tokens: tokenMap } : {}),
  };
}

/** Vercel's API's error body: a code and a message, as every board route answers. */
export function fail(c: Context, status: number, code: string, message = code): Response {
  return c.json({ error: { code, message } }, status);
}

export function bodyOf(c: Context): Promise<Record<string, any>> {
  return c.req
    .json()
    .then((body: unknown) =>
      body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, any>) : {},
    )
    .catch(() => null) as Promise<Record<string, any>>;
}

export function now(): number {
  return Date.now();
}

/** The team a request is for: `teamId` or `slug`, or the first team the emulator knows. */
export function teamOf(c: Context, vs: VercelStore): VercelTeam | null {
  const teamId = c.req.query("teamId");
  const slug = c.req.query("slug");
  if (teamId) return vs.teams.findOneBy("uid", teamId) ?? null;
  if (slug) return vs.teams.findOneBy("slug", slug) ?? null;
  return vs.teams.all()[0] ?? null;
}

export type Identity = {
  actor: Actor;
  who: Who;
  profile: Profile | undefined;
  limit: Can | undefined;
};

/** The principal a configured token's login names: `project:<project>:<environment>`, `app:<client-id-or-name>`, or a user. */
function principalOfLogin(session: Session, login: string, team: VercelTeam | null): Principal | null {
  const project = /^project:(.+):([A-Za-z0-9_-]+)$/.exec(login);
  if (project) {
    const found = projectByIdOrName(session.vs, team?.uid ?? null, project[1]!);
    if (found) return { type: "project", projectId: found.uid, environment: project[2]! };
  }
  const app = /^app:(.+)$/.exec(login);
  if (app) {
    const found =
      session.vs.integrations.findOneBy("client_id", app[1]!) ?? session.vs.integrations.findBy("name", app[1]!)[0];
    if (found) return { type: "app", clientId: found.client_id };
  }
  const user = /^user:(.+)$/.exec(login);
  if (user) {
    const found = userByLogin(session.vs, user[1]!);
    if (found) return { type: "user", userId: found.uid };
  }
  return null;
}

/** Who a request is: the bearer token's principal, or the emulator token's user. */
export function identityOf(c: Context, session: Session, team: VercelTeam | null): Identity | Response {
  // Who the emulator's token map verified, and only that: a bearer token nobody configured is not a principal,
  // and a token acts as a project or an app only when its configured login says so.
  const raw =
    c.req
      .header("authorization")
      ?.replace(/^(Bearer|token)\s+/i, "")
      .trim() ?? "";
  if (!raw || !session.tokens?.has(raw)) return fail(c, 401, "not_authenticated", "Authentication required");
  const auth = c.get("authUser") as { login: string } | undefined;
  if (!auth) return fail(c, 401, "not_authenticated", "Authentication required");
  let principal = principalOfLogin(session, auth.login, team);
  if (!principal) {
    const user = userByLogin(session.vs, auth.login);
    if (user) principal = { type: "user", userId: user.uid };
  }
  if (!principal || principal.type === "external")
    return fail(c, 403, "forbidden", "These credentials aren't a principal this board knows.");

  let profile: Profile | undefined;
  const header = c.req.header("x-board-profile");
  if (header) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(header))
      return fail(
        c,
        400,
        "invalid_profile",
        "Profiles start with a letter and use up to 32 letters, numbers, and hyphens.",
      );
    const avatar = c.req.header("x-board-avatar");
    profile = { name: header, ...(avatar ? { avatar } : {}) };
  }
  let limit: Can | undefined;
  const narrowed = c.req.header("x-board-can");
  if (narrowed !== undefined) {
    try {
      limit = parseCanHeader(narrowed);
    } catch (error) {
      return fail(c, 400, "invalid_scope", error instanceof Error ? error.message : "can isn't a scope");
    }
  }

  const actor = makeActor(principal, profile);
  const role = principal.type === "user" ? roleOf(session.vs, team, principal.userId) : undefined;
  const who: Who =
    principal.type === "user"
      ? { kind: "user", userId: principal.userId, ...(role ? { role } : {}), ...(limit ? { limit } : {}) }
      : principal.type === "project"
        ? {
            kind: "project",
            projectId: principal.projectId,
            environment: principal.environment,
            ...(limit ? { limit } : {}),
          }
        : { kind: "app", clientId: principal.clientId, ...(limit ? { limit } : {}) };
  return { actor, who, profile, limit };
}

export function roleOf(vs: VercelStore, team: VercelTeam | null, userId: string): string {
  if (!team) return "owner";
  const member = vs.teamMembers.findBy("teamId", team.uid).find((found) => found.userId === userId);
  return member?.role.toLowerCase() ?? "member";
}

/** Whether the caller may use the board: a person on its team, a project on it, or an app. */
export function mayUse(session: Session, board: Board, principal: Principal): boolean {
  if (board.members !== null && principal.type === "user" && !board.members.includes(principal.userId)) return false;
  if (principal.type === "user") {
    const member = session.vs.teamMembers
      .findBy("teamId", board.teamId)
      .find((found) => found.userId === principal.userId);
    return member !== undefined;
  }
  if (principal.type === "project") {
    const project = session.vs.projects.findOneBy("uid", principal.projectId);
    return project?.accountId === board.teamId;
  }
  return true;
}

export function boardOf(c: Context, session: Session, identity: Identity): Board | Response {
  const id = c.req.param("board");
  const found = id ? session.ms.boards.findOneBy("uid", id) : undefined;
  const named = c.req.query("teamId") !== undefined || c.req.query("slug") !== undefined;
  const team = named ? teamOf(c, session.vs) : null;
  if (
    !found ||
    (team && found.teamId !== team.uid) ||
    (named && !team) ||
    !mayUse(session, found, identity.actor.principal)
  )
    return fail(c, 404, "board_not_found", "No such board.");
  return found;
}

export function grantsOf(session: Session, board: Board): Grant[] {
  return session.ms.grants.findBy("boardId", board.uid);
}

export function directoryOf(session: Session, board: Board): Directory {
  const users = session.vs.teamMembers.findBy("teamId", board.teamId).map((member) => member.userId);
  const projects = session.vs.projects.findBy("accountId", board.teamId).map((project) => project.uid);
  const apps = session.vs.integrations.all().map((app) => app.client_id);
  return { members: new Set(users), projects: new Set(projects), apps: new Set(apps) };
}

export function canOf(session: Session, board: Board, who: Who, channel: string): Permission[] {
  return canIn(grantsOf(session, board), who, directoryOf(session, board), channel);
}

export function summaryOf(session: Session, board: Board, who: Who): Can {
  return canSummary(grantsOf(session, board), who, directoryOf(session, board));
}

/** What a narrowed caller (`x-board-can`) may do at a channel, at its closest pattern, if it named any. */
export function tokenMay(who: Who, permission: Permission, channel: string): boolean {
  if (!who.limit) return true;
  const patterns = [
    channel,
    ...channel.split("/").map((_, i, parts) => `${parts.slice(0, parts.length - i).join("/")}/`),
    "*",
  ];
  const pattern = patterns.find((candidate) => Object.hasOwn(who.limit!, candidate));
  if (pattern === undefined) return false;
  const grant = who.limit[pattern]!;
  return grant === "all" || grant.includes(permission);
}

export function mayRead(session: Session, board: Board, who: Who, channel: Channel | string): boolean {
  const name = typeof channel === "string" ? channel : channel.name;
  return tokenMay(who, "read", name) && canOf(session, board, who, name).includes("read");
}

export function canWrite(session: Session, board: Board, who: Who, permission: Permission, channel: string): boolean {
  return tokenMay(who, permission, channel) && canOf(session, board, who, channel).includes(permission);
}

export function channelOf(session: Session, board: Board, idOrName: string): Channel | undefined {
  const byId = session.ms.channels.findOneBy("uid", idOrName);
  if (byId) return byId.boardId === board.uid ? byId : undefined;
  return session.ms.channels.findBy("boardId", board.uid).find((channel) => channel.name === idOrName);
}

export function channelNamed(session: Session, board: Board, name: string): Channel | undefined {
  return session.ms.channels.findBy("boardId", board.uid).find((channel) => channel.name === name);
}

export function threadOf(session: Session, board: Board, id: string): Thread | undefined {
  const thread = session.ms.threads.findOneBy("uid", id);
  return thread && thread.boardId === board.uid ? thread : undefined;
}

export function messageOf(session: Session, thread: Thread, sequence: number): Message | undefined {
  return session.ms.messages.findBy("threadId", thread.uid).find((message) => message.sequence === sequence);
}

export function cursorAt(position: number, scope: string): string {
  return `c1.${position}.${scope}`;
}

export function parseCursor(cursor: string): { position: number; scope: string } | null {
  if (cursor.length > 128) return null;
  const found = /^c1\.(\d+)\.(.+)$/.exec(cursor);
  return found ? { position: Number(found[1]), scope: found[2]! } : null;
}

export function changesIn(session: Session, board: Board, channelId?: string): Change[] {
  const all = session.ms.changes.findBy("boardId", board.uid);
  return (channelId ? all.filter((change) => change.channelId === channelId) : all).sort((a, b) =>
    channelId ? a.feedSequence - b.feedSequence : a.boardSequence - b.boardSequence,
  );
}

export type ChangeInput = Omit<
  Change,
  "uid" | "boardId" | "channelId" | "feedSequence" | "boardSequence" | "createdAt" | "id" | "created_at" | "updated_at"
>;

export function emit(session: Session, board: Board, channel: Channel, change: ChangeInput): Change {
  const feed = changesIn(session, board, channel.uid).length + 1;
  const boardSequence = changesIn(session, board).length + 1;
  const made = session.ms.changes.insert({
    uid: newChangeId(),
    boardId: board.uid,
    channelId: channel.uid,
    createdAt: now(),
    feedSequence: feed,
    boardSequence,
    ...change,
  });
  seen(session.ms, session.vs, board, change.actor);
  return made;
}

/** A channel's feed as a read answers it, with its message as it is now when asked for. */
export function changeView(
  session: Session,
  board: Board,
  change: Change,
  cursor: string,
  includeMessage: boolean,
): Record<string, unknown> {
  const channel = session.ms.channels.findOneBy("uid", change.channelId);
  const message =
    includeMessage && change.messageId ? session.ms.messages.findOneBy("uid", change.messageId) : undefined;
  return {
    id: change.uid,
    type: change.type,
    channelId: change.channelId,
    channel: channel?.name ?? "",
    actor: change.actor,
    createdAt: change.createdAt,
    ...(change.threadId !== undefined ? { threadId: change.threadId } : {}),
    ...(change.message !== undefined ? { message: change.message } : {}),
    ...(change.messageId !== undefined ? { messageId: change.messageId } : {}),
    ...(change.emoji !== undefined ? { emoji: change.emoji } : {}),
    ...(change.labels !== undefined ? { labels: change.labels } : {}),
    cursor,
    ...(message && includeMessage ? { currentMessage: showMessageFor(session, message) } : {}),
  };
}

function showMessageFor(session: Session, message: Message) {
  // The feed embeds the message as the API shows it, reactions included.
  const { reactions, reactors } =
    message.deletedAt !== undefined ? { reactions: {}, reactors: {} } : reactionsOf(session.ms, message);
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

export function weakEtag(value: unknown): string {
  return `W/"${createHash("sha256").update(JSON.stringify(value)).digest("base64url")}"`;
}

export function tagged(c: Context, value: unknown): Response {
  const etag = weakEtag(value);
  if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
  return c.json(value, 200, { etag });
}

/** The default grants every board on Vercel's API starts with. */
export function defaultGrants(session: Session, board: Board): void {
  if (session.ms.grants.findBy("boardId", board.uid).length > 0) return;
  const add = (principals: Grant["principals"], can: Can) =>
    session.ms.grants.insert({
      uid: `g${session.ms.grants.findBy("boardId", board.uid).length + 1}`,
      boardId: board.uid,
      principals,
      can,
      by: null,
      at: null,
    });
  add([{ kind: "all-users" }], { "*": "all" });
  add([{ kind: "all-projects", environments: ["production", "preview", "development"] }], {
    "*": ["read", "post", "react", "label", "sync"],
  });
  add([{ kind: "all-apps" }], { "*": ["read", "post", "react", "label"] });
}

export function boardView(board: Board): Record<string, unknown> {
  return { id: board.uid, teamId: board.teamId, name: board.name, visibility: board.visibility };
}

export function actorOfUser(vs: VercelStore, userId: string, profile?: Profile): Actor {
  const user = userById(vs, userId);
  return makeActor({ type: "user", userId: user?.uid ?? userId }, profile);
}

export function userNamed(vs: VercelStore, name: string): VercelUser | undefined {
  return userByLogin(vs, name);
}

export function projectNamed(vs: VercelStore, team: VercelTeam | null, name: string): VercelProject | undefined {
  return projectByIdOrName(vs, team?.uid ?? null, name);
}
