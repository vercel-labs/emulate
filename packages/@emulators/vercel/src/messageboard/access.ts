import type { Board, Can, Decision, Grant, Permission, StoredPrincipal, Who } from "./types.js";

export const PERMISSIONS: readonly Permission[] = ["read", "post", "react", "label", "sync", "manage"];

/** What each permission implies: reacting, labelling, and syncing read, and managing does everything. */
const IMPLIES: Record<Permission, Permission[]> = {
  read: [],
  post: [],
  react: ["read"],
  label: ["read"],
  sync: ["read"],
  manage: ["read", "post", "react", "label", "sync"],
};

export const ROLE_ALL: Can = { "*": "all" };

/** The permissions a principal's credential carries without the board's grants: a person may do everything, a deployment or an app what it needs. */
export function baseline(who: Who): Permission[] {
  if (who.kind === "user") return who.role === "viewer" ? ["read", "react"] : [...PERMISSIONS];
  if (who.kind === "project") return ["read", "post", "react", "label", "sync"];
  return ["read", "post", "react", "label"];
}

export function expand(grant: "all" | Permission[]): Set<Permission> {
  const out = new Set<Permission>();
  const add = (permission: Permission) => {
    if (out.has(permission)) return;
    out.add(permission);
    for (const implied of IMPLIES[permission]) add(implied);
  };
  for (const permission of grant === "all" ? PERMISSIONS : grant) add(permission);
  return out;
}

/** Whether grant pattern `pattern` covers `target`, a channel or a pattern of its own. */
export function covers(pattern: string, target: string): boolean {
  if (pattern === "*" || pattern === target) return true;
  if (!pattern.endsWith("/")) return false;
  return target === pattern.slice(0, -1) || target.startsWith(pattern);
}

/** The longest exact or subtree pattern wins, then `*`, the same as the board's own access rules. */
export function specificity(pattern: string): number {
  if (pattern === "*") return 0;
  return pattern.endsWith("/") ? pattern.length : Number.MAX_SAFE_INTEGER;
}

export type Directory = {
  members: Set<string>;
  projects: Set<string>;
  apps: Set<string>;
};

const LEVEL = { principal: 0, group: 1, everyone: 2 } as const;

function levelOf(principal: StoredPrincipal): keyof typeof LEVEL {
  if (principal.kind === "everyone") return "everyone";
  if (principal.kind === "all-users" || principal.kind === "all-projects" || principal.kind === "all-apps")
    return "group";
  return "principal";
}

function names(principal: StoredPrincipal, who: Who, directory: Directory, admitted: boolean): boolean {
  switch (principal.kind) {
    case "user":
      return who.kind === "user" && who.userId === principal.userId;
    case "all-users":
      return who.kind === "user" && directory.members.has(who.userId);
    case "project":
      return (
        who.kind === "project" &&
        who.projectId === principal.projectId &&
        principal.environments.includes(who.environment)
      );
    case "all-projects":
      return (
        who.kind === "project" &&
        directory.projects.has(who.projectId) &&
        principal.environments.includes(who.environment)
      );
    case "app":
      return who.kind === "app" && who.clientId === principal.clientId;
    case "all-apps":
      return who.kind === "app" && directory.apps.has(who.clientId);
    case "everyone":
      return admitted;
  }
}

const EMPTY: Pick<Decision, "pattern" | "over" | "level" | "grants" | "can" | "capped"> = {
  pattern: null,
  over: [],
  level: null,
  grants: [],
  can: [],
  capped: null,
};

/**
 * What decides `target` for `who`, and what it gives: the most specific pattern its grants name,
 * the closest level there (its own principal, then a group, then everyone), and those grants'
 * permissions added up, within its `x-board-can` limit and its team role. `own` leaves everyone's
 * grants out, to ask what `who` itself gives there.
 */
export function decide(grants: Grant[], who: Who, target: string, directory: Directory, own = false): Decision {
  const admitted =
    (who.kind === "user" && directory.members.has(who.userId)) ||
    grants.some((grant) =>
      grant.principals.some((principal) => principal.kind !== "everyone" && names(principal, who, directory, false)),
    );
  if (!admitted) return { ...EMPTY };

  const candidates: { grant: Grant; level: keyof typeof LEVEL; pattern: string }[] = [];
  for (const grant of grants) {
    const levels = grant.principals
      .filter((principal) => !(own && principal.kind === "everyone") && names(principal, who, directory, true))
      .map(levelOf);
    if (levels.length === 0) continue;
    const level = levels.sort((a, b) => LEVEL[a] - LEVEL[b])[0]!;
    for (const pattern of Object.keys(grant.can))
      if (covers(pattern, target)) candidates.push({ grant, level, pattern });
  }
  if (candidates.length === 0) return { ...EMPTY };

  const [pattern, ...over] = [...new Set(candidates.map((candidate) => candidate.pattern))].sort(
    (a, b) => specificity(b) - specificity(a),
  ) as [string, ...string[]];
  const at = candidates.filter((candidate) => candidate.pattern === pattern);
  const level = at.map((candidate) => candidate.level).sort((a, b) => LEVEL[a] - LEVEL[b])[0]!;
  const deciding = at.filter((candidate) => candidate.level === level);
  const given = new Set<Permission>();
  for (const { grant } of deciding) for (const permission of expand(grant.can[pattern]!)) given.add(permission);

  const limited = who.limit
    ? Object.keys(who.limit)
        .filter((spot) => covers(spot, target))
        .sort((a, b) => specificity(b) - specificity(a))[0]
    : undefined;
  const limit = who.limit ? (limited === undefined ? new Set<Permission>() : expand(who.limit[limited]!)) : null;

  let can = PERMISSIONS.filter((permission) => given.has(permission) && (limit === null || limit.has(permission)));
  let capped: string | null = null;
  if (
    who.kind === "user" &&
    who.role === "viewer" &&
    can.some((permission) => permission !== "read" && permission !== "react")
  ) {
    can = can.filter((permission) => permission === "read" || permission === "react");
    capped = "viewer";
  }

  return { pattern, over, level, grants: deciding.map(({ grant }) => grant), can, capped };
}

/** What `who` may do in `channel` on `board`, as its grants, its limit, and its team role leave it. */
export function canIn(grants: Grant[], who: Who, directory: Directory, channel: string): Permission[] {
  return decide(grants, who, channel, directory).can;
}

/** What `GET /me` says a caller may do: each pattern the grants or the limit name, with what it gives there. */
export function canSummary(grants: Grant[], who: Who, directory: Directory): Can {
  const patterns = new Set<string>([
    "*",
    ...grants.flatMap((grant) => Object.keys(grant.can)),
    ...Object.keys(who.limit ?? {}),
  ]);
  const out: Can = {};
  for (const pattern of patterns) {
    const can = decide(grants, who, pattern, directory).can;
    if (can.length > 0) out[pattern] = [...can];
  }
  return out;
}

/** Whether `who` may manage grants at `pattern`: a team owner, or manage wherever the grants reach. */
export function canManageAt(grants: Grant[], who: Who, directory: Directory, pattern: string): boolean {
  if (who.kind === "user" && who.role === "owner" && who.limit === undefined) return true;
  return decide(grants, who, pattern, directory).can.includes("manage");
}

/** Whether `who` may manage at `pattern` on its own: without relying on an `everyone` grant. */
export function canManageOwnAt(grants: Grant[], who: Who, directory: Directory, pattern: string): boolean {
  return decide(grants, who, pattern, directory, true).can.includes("manage");
}

/** Whether `who` may list the board's grants or explain anyone: a team owner, or manage at `*`. */
export function canList(grants: Grant[], who: Who, directory: Directory): boolean {
  return canManageAt(grants, who, directory, "*");
}

/** Whether `who` may make a grant whose `can` names `patterns`, judged against the grants as they are after it. */
export function canGrant(
  grants: Grant[],
  who: Who,
  directory: Directory,
  patterns: readonly string[],
  _after: readonly Grant[],
): boolean {
  if (who.kind === "user" && who.role === "owner" && who.limit === undefined) return true;
  // Every path a new pattern covers has to be one the caller manages now: a parent pattern is not a way around
  // a subtree the caller is narrowed out of. Spots are the patterns grants name and the caller's own limits.
  const spots = new Set<string>([
    ...grants.flatMap((grant) => Object.keys(grant.can)),
    ...Object.keys(who.limit ?? {}),
  ]);
  for (const pattern of patterns) {
    if (!canManageAt(grants, who, directory, pattern)) return false;
    for (const spot of spots)
      if (spot !== pattern && covers(pattern, spot) && !canManageOwnAt(grants, who, directory, spot)) return false;
  }
  return true;
}

export function grantsOf(grants: Grant[], boardId: string): Grant[] {
  return grants.filter((grant) => grant.boardId === boardId);
}

export function parseCanHeader(value: string): Can {
  const can: Can = Object.create(null) as Can;
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf("=");
    if (at === -1) throw new Error(`can: ${trimmed} names no permissions`);
    const pattern = trimmed.slice(0, at).trim();
    const permissions = trimmed
      .slice(at + 1)
      .split(/[|+ ]/)
      .map((permission) => permission.trim())
      .filter(Boolean);
    if (!pattern) throw new Error("can: a pattern is empty");
    if (!/^(\*|[a-z0-9_-]+(\/[a-z0-9_-]+)*\/?)$/.test(pattern))
      throw new Error(`can: ${pattern} isn't a channel pattern`);
    if (!permissions.every((permission) => (PERMISSIONS as readonly string[]).includes(permission)))
      throw new Error(`can: ${trimmed} names a permission the board doesn't know`);
    can[pattern] = permissions as Permission[];
  }
  return can;
}

export function boardDirectory(options: {
  members: Iterable<string>;
  projects: Iterable<string>;
  apps: Iterable<string>;
}): Directory {
  return {
    members: new Set(options.members),
    projects: new Set(options.projects),
    apps: new Set(options.apps),
  };
}

export function isBoardOwner(board: Board, who: Who): boolean {
  return who.kind === "user" && who.role === "owner" && (board.members === null || board.members.includes(who.userId));
}
