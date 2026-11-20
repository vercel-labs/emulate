import type { Store } from "@emulators/core";
import { getVercelStore, type VercelStore } from "../store.js";
import type { VercelTeam } from "../entities.js";
import { getMessageboardStore, type MessageboardStore } from "./store.js";
import type { Actor, Board, StoredPrincipal } from "./types.js";
import { defaultGrants } from "./context.js";
import { makeActor } from "./views.js";
import { stableBoardId } from "./ids.js";
import { addReaction, makeChannel, reply, startThread } from "./writes.js";

export type BoardReactionSeed = { emoji: string; by?: string };

export type BoardThreadSeed = {
  channel: string;
  text: string;
  by?: string;
  labels?: Record<string, string>;
  reactions?: BoardReactionSeed[];
  replies?: Array<{
    text: string;
    by?: string;
    labels?: Record<string, string>;
    reactions?: BoardReactionSeed[];
  }>;
};

export type BoardGrantSeed = {
  principals: Array<Record<string, unknown>>;
  can: Record<string, "all" | Array<"read" | "post" | "react" | "label" | "sync" | "manage">>;
};

export type BoardSeedConfig = {
  name: string;
  team?: string;
  default?: boolean;
  visibility?: "team" | "private";
  members?: string[];
  channels?: Array<string | { name: string }>;
  threads?: BoardThreadSeed[];
  grants?: BoardGrantSeed[];
};

export function seedBoards(store: Store, baseUrl: string, config: { boards?: BoardSeedConfig[] }): void {
  if (!config.boards?.length) return;
  const vs = getVercelStore(store);
  const ms = getMessageboardStore(store);
  const session = { vs, ms, baseUrl };

  for (const seed of config.boards) {
    const team = seed.team
      ? (vs.teams.findOneBy("slug", seed.team) ?? vs.teams.findOneBy("uid", seed.team) ?? vs.teams.all()[0])
      : vs.teams.all()[0];
    if (!team) continue;

    const uid = stableBoardId(team.uid, seed.name);
    let board = ms.boards.findOneBy("uid", uid);
    if (!board) {
      board = ms.boards.insert({
        uid,
        teamId: team.uid,
        name: seed.name,
        visibility: seed.visibility ?? "team",
        members: seed.visibility === "private" ? (seed.members ?? []) : null,
        isDefault: seed.default === true || ms.boards.findBy("teamId", team.uid).length === 0,
      });
    }
    defaultGrants(session, board);

    for (const channel of seed.channels ?? []) {
      makeChannel(session, board, typeof channel === "string" ? channel : channel.name);
    }

    for (const threadSeed of seed.threads ?? []) {
      const channel = makeChannel(session, board, threadSeed.channel);
      const actor = actorOf(vs, threadSeed.by) ?? firstUserActor(vs);
      if (!actor) continue;
      const made = startThread(session, board, channel, actor, threadSeed.text, threadSeed.labels ?? {}, undefined);
      const thread = ms.threads.findOneBy("uid", (made.thread as { id: string }).id);
      const root = thread
        ? ms.messages.findBy("threadId", thread.uid).find((message) => message.sequence === 1)
        : undefined;
      if (thread && root)
        for (const reaction of threadSeed.reactions ?? [])
          addReaction(session, board, thread, channel, root, actorOf(vs, reaction.by) ?? actor, reaction.emoji);
      for (const replySeed of threadSeed.replies ?? []) {
        const replyActor = actorOf(vs, replySeed.by) ?? actor;
        const message = reply(session, board, thread!, channel, replyActor, replySeed.text, 1, undefined);
        if (replySeed.labels && Object.keys(replySeed.labels).length)
          ms.messages.update(message.id, { labels: { ...replySeed.labels } });
        for (const reaction of replySeed.reactions ?? [])
          addReaction(
            session,
            board,
            thread!,
            channel,
            ms.messages.get(message.id)!,
            actorOf(vs, reaction.by) ?? replyActor,
            reaction.emoji,
          );
      }
    }

    for (const grant of seed.grants ?? []) {
      const principals = grant.principals.flatMap((input) => resolveSeedPrincipal(vs, team, input));
      if (principals.length === 0) continue;
      ms.grants.insert({
        uid: `g${ms.grants.findBy("boardId", board.uid).length + 1}`,
        boardId: board.uid,
        principals,
        can: grant.can,
        by: null,
        at: null,
      });
    }
  }
}

function actorOf(vs: VercelStore, name: string | undefined): Actor | undefined {
  if (!name) return undefined;
  const user =
    vs.users.findOneBy("username", name) ?? vs.users.findOneBy("uid", name) ?? vs.users.findBy("email", name)[0];
  return user ? makeActor({ type: "user", userId: user.uid }) : undefined;
}

function firstUserActor(vs: VercelStore): Actor | undefined {
  const user = vs.users.all()[0];
  return user ? makeActor({ type: "user", userId: user.uid }) : undefined;
}

function resolveSeedPrincipal(vs: VercelStore, team: VercelTeam, input: Record<string, unknown>): StoredPrincipal[] {
  if (input.kind === "user") {
    const user =
      (typeof input.userId === "string"
        ? (vs.users.findOneBy("uid", input.userId) ?? vs.users.findOneBy("username", input.userId))
        : undefined) ?? (typeof input.email === "string" ? vs.users.findBy("email", input.email)[0] : undefined);
    return user ? [{ kind: "user", userId: user.uid }] : [];
  }
  if (input.kind === "project") {
    const project =
      (typeof input.projectId === "string"
        ? (vs.projects.findOneBy("uid", input.projectId) ??
          vs.projects.findBy("name", input.projectId).find((found) => found.accountId === team.uid))
        : undefined) ??
      (typeof input.project === "string"
        ? vs.projects.findBy("name", input.project).find((found) => found.accountId === team.uid)
        : undefined);
    if (!project) return [];
    return [
      {
        kind: "project",
        projectId: project.uid,
        environments: Array.isArray(input.environments) ? (input.environments as string[]) : ["production"],
      },
    ];
  }
  if (input.kind === "app") {
    const app =
      (typeof input.clientId === "string" ? vs.integrations.findOneBy("client_id", input.clientId) : undefined) ??
      (typeof input.app === "string"
        ? (vs.integrations.findOneBy("client_id", input.app) ?? vs.integrations.findBy("name", input.app)[0])
        : undefined);
    return app ? [{ kind: "app", clientId: app.client_id }] : [];
  }
  if (input.kind === "all-users" || input.kind === "all-apps" || input.kind === "everyone")
    return [{ kind: input.kind }];
  if (input.kind === "all-projects")
    return [
      {
        kind: "all-projects",
        environments: Array.isArray(input.environments) ? (input.environments as string[]) : ["production"],
      },
    ];
  return [];
}

export function seededBoard(ms: MessageboardStore, team: VercelTeam, name: string): Board | undefined {
  return ms.boards.findOneBy("uid", stableBoardId(team.uid, name));
}
