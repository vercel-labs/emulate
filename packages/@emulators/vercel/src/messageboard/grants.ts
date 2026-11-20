import type { Context, RouteContext } from "@emulators/core";
import type { Board, Can, Grant, Permission, PrincipalView, StoredPrincipal, Who } from "./types.js";
import type { Directory } from "./access.js";
import { decide, canGrant, canList, canManageAt, PERMISSIONS } from "./access.js";
import {
  boardOf,
  bodyOf,
  directoryOf,
  grantsOf,
  identityOf,
  fail,
  teamOf,
  type Identity,
  type Session,
} from "./context.js";

type Resolved = { principal: StoredPrincipal } | { error: { status: number; code: string; message: string } };

function viewOf(grant: Grant, session: Session, board: Board): Record<string, unknown> {
  const principals: PrincipalView[] = grant.principals.map((principal): PrincipalView => {
    if (principal.kind === "user") {
      const user = session.vs.users.findOneBy("uid", principal.userId);
      return { kind: "user", userId: principal.userId, email: user?.email ?? null };
    }
    if (principal.kind === "project") {
      const project = session.vs.projects.findOneBy("uid", principal.projectId);
      return {
        kind: "project",
        projectId: principal.projectId,
        name: project?.name ?? null,
        environments: principal.environments,
        teamId: board.teamId,
      };
    }
    if (principal.kind === "app") {
      const app = session.vs.integrations.findOneBy("client_id", principal.clientId);
      return { kind: "app", clientId: principal.clientId, name: app?.name ?? null };
    }
    return principal as PrincipalView;
  });
  return {
    id: grant.uid,
    principals,
    can: grant.can,
    capped: grant.principals.some((principal) => principal.kind === "user" || principal.kind === "all-users"),
    by: grant.by,
    at: grant.at,
  };
}

function resolvePrincipal(session: Session, board: Board, input: Record<string, any>, removal = false): Resolved {
  const invalid = (code: string, message: string) => ({ error: { status: 400, code, message } });
  switch (input.kind) {
    case "user": {
      const user =
        (typeof input.userId === "string" ? session.vs.users.findOneBy("uid", input.userId) : undefined) ??
        (typeof input.email === "string" ? session.vs.users.findBy("email", input.email)[0] : undefined) ??
        (typeof input.userId === "string" ? session.vs.users.findOneBy("username", input.userId) : undefined);
      if (!user) return invalid("user_not_found", `no one on the team is ${String(input.email ?? input.userId ?? "")}`);
      return { principal: { kind: "user", userId: user.uid } };
    }
    case "project": {
      const project =
        (typeof input.projectId === "string"
          ? (session.vs.projects.findOneBy("uid", input.projectId) ??
            session.vs.projects.findBy("name", input.projectId).find((found) => found.accountId === board.teamId))
          : undefined) ??
        (typeof input.project === "string"
          ? session.vs.projects.findBy("name", input.project).find((found) => found.accountId === board.teamId)
          : undefined);
      if (!project)
        return invalid("project_not_found", `no project ${String(input.projectId ?? input.project ?? "")} on the team`);
      if (!removal && !Array.isArray(input.environments))
        return invalid("invalid_grant", "a project names its environments");
      return {
        principal: {
          kind: "project",
          projectId: project.uid,
          environments: Array.isArray(input.environments) ? input.environments : ["production"],
        },
      };
    }
    case "app": {
      const app =
        (typeof input.clientId === "string"
          ? session.vs.integrations.findOneBy("client_id", input.clientId)
          : undefined) ??
        (typeof input.app === "string"
          ? (session.vs.integrations.findOneBy("client_id", input.app) ??
            session.vs.integrations.findBy("name", input.app)[0])
          : undefined);
      if (!app) return invalid("app_not_found", `no app ${String(input.clientId ?? input.app ?? "")} on the team`);
      return { principal: { kind: "app", clientId: app.client_id } };
    }
    case "all-users":
    case "all-apps":
    case "everyone":
      return { principal: { kind: input.kind } };
    case "all-projects":
      if (!removal && !Array.isArray(input.environments))
        return invalid("invalid_grant", "all-projects names its environments");
      return {
        principal: {
          kind: "all-projects",
          environments: Array.isArray(input.environments) ? input.environments : ["production"],
        },
      };
    case "github":
    case "oidc":
      return invalid(
        "unsupported_principal",
        "Grants name no GitHub or OIDC principals: grant the Vercel App an OIDC exchange policy issues tokens to.",
      );
    default:
      return invalid("invalid_grant", `no principal kind ${String(input.kind)}`);
  }
}

function checkCan(can: unknown): Can | { error: { status: number; code: string; message: string } } {
  const invalid = (message: string) => ({ error: { status: 400, code: "invalid_grant", message } });
  if (!can || typeof can !== "object" || Array.isArray(can) || Object.keys(can).length === 0)
    return invalid("can maps channel patterns to permissions");
  const out: Can = {};
  for (const [pattern, grant] of Object.entries(can as Record<string, unknown>)) {
    if (!/^(\*|[a-z0-9_-]+(\/[a-z0-9_-]+)*\/?)$/.test(pattern)) return invalid(`${pattern} isn't a channel pattern`);
    if (grant === "all") out[pattern] = "all";
    else if (
      Array.isArray(grant) &&
      grant.every((permission) => (PERMISSIONS as readonly string[]).includes(permission as string))
    )
      out[pattern] = grant as Permission[];
    else return invalid(`${pattern} takes 'all' or permissions`);
  }
  return out;
}

function isError(value: unknown): value is { error: { status: number; code: string; message: string } } {
  return typeof value === "object" && value !== null && "error" in value;
}

function patternsOf(can: Can): string[] {
  return Object.keys(can);
}

function nextGrantId(grants: Grant[]): string {
  const numbers = grants
    .map((grant) => Number.parseInt(grant.uid.replace(/^g/, ""), 10))
    .filter((number) => Number.isFinite(number));
  return `g${Math.max(0, ...numbers) + 1}`;
}

/** Whether `who` had manage at each pattern before, and has it after: a change that loses it is a lockout. */
function locksOut(grants: Grant[], before: Grant[], who: Who, directory: Directory, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (!canManageAt(before, who, directory, pattern)) continue;
    if (!canManageAt(grants, who, directory, pattern)) return pattern;
  }
  return null;
}

function auth(c: Context, session: Session): { identity: Identity; board: Board } | Response {
  const team = teamOf(c, session.vs);
  const identity = identityOf(c, session, team);
  if (identity instanceof Response) return identity;
  const board = boardOf(c, session, identity);
  if (board instanceof Response) return board;
  return { identity, board };
}

export function grantRoutes(context: RouteContext, session: Session): void {
  const app = context.app;

  app.get("/v1/messageboard/boards/:board/grants", (c) => {
    const found = auth(c, session);
    if (found instanceof Response) return found;
    const { identity, board } = found;
    const grants = grantsOf(session, board);
    const directory = directoryOf(session, board);
    if (!canList(grants, identity.who, directory))
      return fail(c, 403, "grant_forbidden", "listing grants takes manage at *");
    return c.json({ grants: grants.map((grant) => viewOf(grant, session, board)) });
  });

  app.post("/v1/messageboard/boards/:board/grants", async (c) => {
    const found = auth(c, session);
    if (found instanceof Response) return found;
    const { identity, board } = found;
    const body = await bodyOf(c);
    if (body === null) return fail(c, 400, "invalid_grant", "The request body isn't JSON.");
    if (!Array.isArray(body.principals) || body.principals.length === 0)
      return fail(c, 400, "invalid_grant", "a grant names its principals");
    const principals: StoredPrincipal[] = [];
    for (const input of body.principals as Record<string, any>[]) {
      const resolved = resolvePrincipal(session, board, input);
      if (isError(resolved)) return fail(c, resolved.error.status, resolved.error.code, resolved.error.message);
      principals.push(resolved.principal);
    }
    const can = checkCan(body.can);
    if (isError(can)) return fail(c, can.error.status, can.error.code, can.error.message);
    const grants = grantsOf(session, board);
    const directory = directoryOf(session, board);
    const after = [
      ...grants,
      {
        id: -1,
        uid: "",
        boardId: board.uid,
        principals,
        can,
        by: identity.actor.id,
        at: Date.now(),
        created_at: "",
        updated_at: "",
      } as Grant,
    ];
    if (!canGrant(grants, identity.who, directory, patternsOf(can), after))
      return fail(c, 403, "grant_forbidden", "granting takes manage wherever the grant reaches");
    const id = nextGrantId(grants);
    const grant = session.ms.grants.insert({
      uid: id,
      boardId: board.uid,
      principals,
      can,
      by: identity.actor.id,
      at: Date.now(),
    });
    if (body.lockMeOut !== true) {
      const lost = locksOut(grantsOf(session, board), grants, identity.who, directory, patternsOf(can));
      if (lost !== null) {
        session.ms.grants.delete(grant.id);
        return fail(c, 409, "grant_lockout", `this grant would leave you unable to manage grants in ${lost}`);
      }
    }
    return c.json({ grant: viewOf(session.ms.grants.get(grant.id)!, session, board) });
  });

  app.post("/v1/messageboard/boards/:board/grants/batch", async (c) => {
    const found = auth(c, session);
    if (found instanceof Response) return found;
    const { identity, board } = found;
    const body = await bodyOf(c);
    if (body === null) return fail(c, 400, "invalid_grant", "The request body isn't JSON.");
    if (!Array.isArray(body.grants) || body.grants.length === 0 || body.grants.length > 16)
      return fail(c, 400, "invalid_grant", "a batch makes 1 to 16 grants");
    const grants = grantsOf(session, board);
    const directory = directoryOf(session, board);
    const made: { principals: StoredPrincipal[]; can: Can }[] = [];
    for (const input of body.grants as Record<string, any>[]) {
      if (!Array.isArray(input.principals) || input.principals.length === 0)
        return fail(c, 400, "invalid_grant", "a grant names its principals");
      const principals: StoredPrincipal[] = [];
      for (const principalInput of input.principals as Record<string, any>[]) {
        const resolved = resolvePrincipal(session, board, principalInput);
        if (isError(resolved)) return fail(c, resolved.error.status, resolved.error.code, resolved.error.message);
        principals.push(resolved.principal);
      }
      const can = checkCan(input.can);
      if (isError(can)) return fail(c, can.error.status, can.error.code, can.error.message);
      made.push({ principals, can });
    }
    const after = [
      ...grants,
      ...made.map(
        (grant) =>
          ({
            id: -1,
            uid: "",
            boardId: board.uid,
            principals: grant.principals,
            can: grant.can,
            by: identity.actor.id,
            at: Date.now(),
            created_at: "",
            updated_at: "",
          }) as Grant,
      ),
    ];
    for (const grant of made) {
      if (!canGrant(grants, identity.who, directory, patternsOf(grant.can), after))
        return fail(c, 403, "grant_forbidden", "granting takes manage wherever the grant reaches");
    }
    const before = [...grants];
    const created: Grant[] = [];
    for (const grant of made) {
      const id = nextGrantId([...grants, ...created]);
      created.push(
        session.ms.grants.insert({
          uid: id,
          boardId: board.uid,
          principals: grant.principals,
          can: grant.can,
          by: identity.actor.id,
          at: Date.now(),
        }),
      );
    }
    if (body.lockMeOut !== true) {
      const lost = locksOut(
        grantsOf(session, board),
        before,
        identity.who,
        directory,
        made.flatMap((grant) => patternsOf(grant.can)),
      );
      if (lost !== null) {
        for (const grant of created) session.ms.grants.delete(grant.id);
        return fail(c, 409, "grant_lockout", `these grants would leave you unable to manage grants in ${lost}`);
      }
    }
    return c.json({ grants: created.map((grant) => viewOf(session.ms.grants.get(grant.id)!, session, board)) });
  });

  app.get("/v1/messageboard/boards/:board/grants/explain", (c) => {
    const found = auth(c, session);
    if (found instanceof Response) return found;
    const { identity, board } = found;
    const channel = c.req.query("channel");
    if (!channel) return fail(c, 400, "invalid_request", "explain takes a channel");
    const grants = grantsOf(session, board);
    const directory = directoryOf(session, board);
    const named = namedWho(c, session, board);
    if (isError(named)) return fail(c, named.error.status, named.error.code, named.error.message);
    const other = "who" in named ? named.who : null;
    const lists = canList(grants, identity.who, directory);
    if (other && !lists)
      return fail(c, 403, "grant_forbidden", "explaining what someone else may do takes manage at *");
    const decision = decide(grants, other ?? identity.who, channel, directory);
    return c.json({
      channel,
      pattern: decision.pattern,
      over: decision.over,
      level: decision.level,
      grants: lists ? decision.grants.map((grant) => viewOf(grant, session, board)) : [],
      rule: null,
      capped: decision.capped,
      can: decision.can,
    });
  });

  app.patch("/v1/messageboard/boards/:board/grants/:grant", async (c) => {
    const found = auth(c, session);
    if (found instanceof Response) return found;
    const { identity, board } = found;
    const grants = grantsOf(session, board);
    const directory = directoryOf(session, board);
    const grant = grants.find((candidate) => candidate.uid === c.req.param("grant"));
    if (!grant) return fail(c, 404, "grant_not_found");
    for (const pattern of patternsOf(grant.can))
      if (!canManageAt(grants, identity.who, directory, pattern))
        return fail(c, 403, "grant_forbidden", `updating ${grant.uid} takes manage wherever the grant applies`);
    const body = await bodyOf(c);
    if (body === null) return fail(c, 400, "invalid_grant", "The request body isn't JSON.");
    let principals = [...grant.principals];
    for (const input of (Array.isArray(body.remove) ? body.remove : []) as Record<string, any>[]) {
      const resolved = resolvePrincipal(session, board, input, true);
      if (isError(resolved)) return fail(c, resolved.error.status, resolved.error.code, resolved.error.message);
      const removal = resolved.principal;
      const kept = principals.filter((principal) => !removes(removal, principal));
      if (kept.length === principals.length)
        return fail(c, 400, "not_in_grant", `${grant.uid} doesn't name that ${removal.kind} principal`);
      principals = kept;
    }
    for (const input of (Array.isArray(body.add) ? body.add : []) as Record<string, any>[]) {
      const resolved = resolvePrincipal(session, board, input);
      if (isError(resolved)) return fail(c, resolved.error.status, resolved.error.code, resolved.error.message);
      const added = resolved.principal;
      const at = principals.findIndex((principal) => samePrincipal(principal, added));
      const existing = principals[at];
      if (!existing) principals.push(added);
      else if ("environments" in existing && "environments" in added)
        principals[at] = { ...existing, environments: [...new Set([...existing.environments, ...added.environments])] };
    }
    if (principals.length === 0) return fail(c, 400, "grant_empty", `that leaves ${grant.uid} naming no one`);
    const can = body.can === undefined ? grant.can : checkCan(body.can);
    if (isError(can)) return fail(c, can.error.status, can.error.code, can.error.message);
    if (body.add !== undefined || body.can !== undefined) {
      const after = [...grants.filter((other) => other.uid !== grant.uid), { ...grant, principals, can }];
      if (!canGrant(grants, identity.who, directory, patternsOf(can), after))
        return fail(c, 403, "grant_forbidden", `updating ${grant.uid} takes manage wherever the grant reaches`);
    }
    const before = [...grants];
    session.ms.grants.update(grant.id, { principals, can, by: identity.actor.id, at: Date.now() });
    const touched = [...new Set([...patternsOf(grant.can), ...patternsOf(can)])];
    if (body.lockMeOut !== true) {
      const lost = locksOut(grantsOf(session, board), before, identity.who, directory, touched);
      if (lost !== null) {
        session.ms.grants.update(grant.id, {
          principals: grant.principals,
          can: grant.can,
          by: grant.by,
          at: grant.at,
        });
        return fail(
          c,
          409,
          "grant_lockout",
          `updating ${grant.uid} would leave you unable to manage grants in ${lost}`,
        );
      }
    }
    return c.json({ grant: viewOf(session.ms.grants.get(grant.id)!, session, board) });
  });

  app.post("/v1/messageboard/boards/:board/grants/:grant/revoke", async (c) => {
    const found = auth(c, session);
    if (found instanceof Response) return found;
    const { identity, board } = found;
    const grants = grantsOf(session, board);
    const directory = directoryOf(session, board);
    const grant = grants.find((candidate) => candidate.uid === c.req.param("grant"));
    const body = await bodyOf(c);
    if (body === null) return fail(c, 400, "invalid_grant", "The request body isn't JSON.");
    if (!grant) {
      if (!canList(grants, identity.who, directory))
        return fail(c, 403, "grant_forbidden", "revoking grants takes manage at *");
      return c.json({ revoked: false });
    }
    for (const pattern of patternsOf(grant.can))
      if (!canManageAt(grants, identity.who, directory, pattern))
        return fail(c, 403, "grant_forbidden", `revoking ${grant.uid} takes manage wherever the grant applies`);
    session.ms.grants.delete(grant.id);
    if (body.lockMeOut !== true) {
      const lost = locksOut(grantsOf(session, board), grants, identity.who, directory, patternsOf(grant.can));
      if (lost !== null) {
        const restored = session.ms.grants.insert({
          uid: grant.uid,
          boardId: grant.boardId,
          principals: grant.principals,
          can: grant.can,
          by: grant.by,
          at: grant.at,
        });
        return fail(
          c,
          409,
          "grant_lockout",
          `revoking ${restored.uid} would leave you unable to manage grants in ${lost}`,
        );
      }
    }
    return c.json({ revoked: true });
  });
}

function samePrincipal(a: StoredPrincipal, b: StoredPrincipal): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "user") return a.userId === (b as typeof a).userId;
  if (a.kind === "project") return a.projectId === (b as typeof a).projectId;
  if (a.kind === "app") return a.clientId === (b as typeof a).clientId;
  return true;
}

function removes(removal: StoredPrincipal, principal: StoredPrincipal): boolean {
  if (removal.kind !== principal.kind) return false;
  if (removal.kind === "user") return removal.userId === (principal as typeof removal).userId;
  if (removal.kind === "project") return removal.projectId === (principal as typeof removal).projectId;
  if (removal.kind === "app") return removal.clientId === (principal as typeof removal).clientId;
  return true;
}

function namedWho(
  c: Context,
  session: Session,
  board: Board,
): { who: Who | null } | { error: { status: number; code: string; message: string } } {
  const invalid = (code: string, message: string) => ({ error: { status: 400, code, message } });
  const user = c.req.query("user");
  if (user !== undefined) {
    const found =
      session.vs.users.findOneBy("uid", user) ??
      session.vs.users.findOneBy("username", user) ??
      session.vs.users.findBy("email", user)[0];
    if (!found) return invalid("user_not_found", `no one on the team is ${user}`);
    return { who: { kind: "user", userId: found.uid, role: "member" } };
  }
  const project = c.req.query("project");
  if (project !== undefined) {
    const found =
      session.vs.projects.findOneBy("uid", project) ??
      session.vs.projects.findBy("name", project).find((candidate) => candidate.accountId === board.teamId);
    if (!found) return invalid("project_not_found", `no project ${project} on the team`);
    return { who: { kind: "project", projectId: found.uid, environment: c.req.query("environment") ?? "production" } };
  }
  const app = c.req.query("app");
  if (app !== undefined) {
    const found = session.vs.integrations.findOneBy("client_id", app) ?? session.vs.integrations.findBy("name", app)[0];
    if (!found) return invalid("app_not_found", `no app ${app} on the team`);
    return { who: { kind: "app", clientId: found.client_id } };
  }
  if (c.req.query("github") !== undefined || c.req.query("oidc") !== undefined)
    return invalid(
      "unsupported_principal",
      "Grants name no GitHub or OIDC principals: explain the Vercel App an OIDC exchange policy issues tokens to.",
    );
  return { who: null };
}
