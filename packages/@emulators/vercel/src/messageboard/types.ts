import type { Entity } from "@emulators/core";

/** Who a request is, as Vercel's API verifies it: a person, an app, a project's deployment, or an imported platform user. */
export type Principal =
  | { type: "user"; userId: string }
  | { type: "app"; clientId: string }
  | { type: "project"; projectId: string; environment: string }
  | { type: "external"; id: string; syncKey: string };

/** An agent's name, or an avatar, that a principal writes as. */
export type Profile = { name: string; avatar?: string };

/** Who wrote something: a principal, and the profile it wrote as. */
export type Actor = {
  id: string;
  principal: Principal;
  profile?: Profile;
};

export type Labels = Record<string, string>;

/** A board's channel, addressed by ID and named by its path. */
export type Board = Entity & {
  uid: string;
  teamId: string;
  name: string;
  visibility: "team" | "private";
  members: string[] | null;
  isDefault: boolean;
};

export type Channel = Entity & {
  uid: string;
  boardId: string;
  name: string;
  createdAt: number;
};

/** A thread: its root message and the replies after it. */
export type Thread = Entity & {
  uid: string;
  boardId: string;
  channelId: string;
  messageCount: number;
  createdAt: number;
  createdBy: Actor;
  lastActivityAt: number;
  lastMessage: { id: string; sequence: number; createdAt: number; createdBy: Actor } | null;
};

/** A message, its place in its thread (`sequence`), and its place in its channel's feed (`feedSequence`). */
export type Message = Entity & {
  uid: string;
  boardId: string;
  threadId: string;
  sequence: number;
  replyTo?: number;
  text: string;
  revision: number;
  version: number;
  createdAt: number;
  createdBy: Actor;
  editedAt?: number;
  deletedAt?: number;
  labels: Labels;
  feedSequence: number;
  /** The client ID a caller posted it with, for a retry to find. */
  clientId?: string;
  /** Who posted it, by principal and client ID. */
  clientKey?: string;
};

export type Reaction = Entity & {
  uid: string;
  boardId: string;
  threadId: string;
  messageUid: string;
  emoji: string;
  actorId: string;
  actor: Actor;
  createdAt: number;
};

/** A change to a board, as its channel's feed publishes it. */
export type Change = Entity & {
  uid: string;
  boardId: string;
  channelId: string;
  type: string;
  actor: Actor;
  createdAt: number;
  threadId?: string;
  message?: number;
  messageId?: string;
  emoji?: string;
  labels?: Record<string, { from?: string; to?: string }>;
  /** Its place in its channel's feed. */
  feedSequence: number;
  /** Its place in the board's feed. */
  boardSequence: number;
};

/** A principal as a grant keeps it. */
export type StoredPrincipal =
  | { kind: "user"; userId: string }
  | { kind: "project"; projectId: string; environments: string[] }
  | { kind: "all-users" }
  | { kind: "all-projects"; environments: string[] }
  | { kind: "app"; clientId: string }
  | { kind: "all-apps" }
  | { kind: "everyone" };

export type Permission = "read" | "post" | "react" | "label" | "sync" | "manage";

/** A principal as a grant answers it: its IDs, with the names the board knows beside them. */
export type PrincipalView =
  | { kind: "user"; userId: string; email: string | null }
  | { kind: "project"; projectId: string; name: string | null; environments: string[]; teamId: string | null }
  | { kind: "app"; clientId: string; name: string | null }
  | { kind: "all-users" }
  | { kind: "all-projects"; environments: string[] }
  | { kind: "all-apps" }
  | { kind: "everyone" };
export type Can = Record<string, "all" | Permission[]>;
export type Grant = Entity & {
  uid: string;
  boardId: string;
  principals: StoredPrincipal[];
  can: Can;
  by: string | null;
  at: number | null;
};

/** An actor as the board's actors list reports it, with the view the API names it by. */
export type ActorRecord = Entity & {
  uid: string;
  boardId: string;
  actorId: string;
  actor: Actor;
  kind: "person" | "agent" | "deployment" | "app" | "external";
  handle: string;
  name?: string;
  avatar?: string;
  lastSeenAt: number;
};

/** A write's answer, kept so a retry with the same operation ID answers what the first did. */
export type Receipt = Entity & {
  uid: string;
  boardId: string;
  key: string;
  answer: string;
  at: number;
};

/** Who asks, as the board decides access: their principal, team role, and any `x-board-can` limit. */
export type Who =
  | { kind: "user"; userId: string; role?: string; limit?: Can }
  | { kind: "project"; projectId: string; environment: string; limit?: Can }
  | { kind: "app"; clientId: string; limit?: Can };

export type Decision = {
  pattern: string | null;
  over: string[];
  level: "principal" | "group" | "everyone" | null;
  grants: Grant[];
  can: Permission[];
  capped: string | null;
};
