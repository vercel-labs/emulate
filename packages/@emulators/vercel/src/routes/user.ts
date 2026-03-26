import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody } from "@emulators/core";
export { ApiError };
import { getVercelStore } from "../store.js";
import type { VercelStore } from "../store.js";
import type { VercelTeam, VercelTeamMember, VercelUser } from "../entities.js";
import {
  applyCursorPagination,
  formatTeam,
  formatUser,
  generateUid,
  parseCursorPagination,
  resolveTeamScope,
} from "../helpers.js";

function vercelErr(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function resolveTeamByIdOrSlug(vs: VercelStore, teamIdOrSlug: string): VercelTeam | undefined {
  return (
    vs.teams.findOneBy("uid", teamIdOrSlug as VercelTeam["uid"]) ??
    vs.teams.findOneBy("slug", teamIdOrSlug as VercelTeam["slug"])
  );
}

function getTeamMember(vs: VercelStore, teamUid: string, userUid: string): VercelTeamMember | undefined {
  return vs.teamMembers.findBy("teamId", teamUid as VercelTeamMember["teamId"]).find((m) => m.userId === userUid);
}

function formatTeamForViewer(team: VercelTeam, member: VercelTeamMember | undefined) {
  return {
    ...formatTeam(team),
    membership: member
      ? { confirmed: member.confirmed, role: member.role }
      : { confirmed: false, role: "VIEWER" as const },
  };
}

function formatMemberRow(vs: VercelStore, m: VercelTeamMember) {
  const user = vs.users.findOneBy("uid", m.userId as VercelUser["uid"]);
  return {
    id: String(m.id),
    role: m.role,
    confirmed: m.confirmed,
    joinedFrom: m.joinedFrom,
    user: user ? formatUser(user) : null,
  };
}

const TEAM_ROLES: VercelTeamMember["role"][] = ["OWNER", "MEMBER", "DEVELOPER", "VIEWER"];

function parseRole(value: unknown, fallback: VercelTeamMember["role"]): VercelTeamMember["role"] | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") return null;
  return TEAM_ROLES.includes(value as VercelTeamMember["role"]) ? (value as VercelTeamMember["role"]) : null;
}

function defaultTeamBilling(): VercelTeam["billing"] {
  return { plan: "hobby", period: null, trial: null, cancelation: null, addons: null };
}

function defaultTeamResourceConfig(): VercelTeam["resourceConfig"] {
  return { nodeType: "standard", concurrentBuilds: 1 };
}

export function userRoutes({ app, store }: RouteContext): void {
  const vs = getVercelStore(store);

  app.get("/registration", (c) => c.json({ registration: false }));

  app.get("/v2/user", (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }
    const user = vs.users.findOneBy("username", auth.login as VercelUser["username"]);
    if (!user) {
      return vercelErr(c, 403, "forbidden", "User not found");
    }
    return c.json({ user: formatUser(user) });
  });

  app.patch("/v2/user", async (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }
    const existing = vs.users.findOneBy("username", auth.login as VercelUser["username"]);
    if (!existing) {
      return vercelErr(c, 403, "forbidden", "User not found");
    }

    const body = await parseJsonBody(c);
    const patch: Partial<Pick<VercelUser, "name" | "email">> = {};
    if ("name" in body) {
      if (body.name === null) patch.name = null;
      else if (typeof body.name === "string") patch.name = body.name;
    }
    if ("email" in body && typeof body.email === "string") {
      patch.email = body.email;
    }

    const updated = vs.users.update(existing.id, patch);
    if (!updated) {
      return vercelErr(c, 500, "internal_error", "Failed to update user");
    }
    return c.json({ user: formatUser(updated) });
  });

  app.get("/v2/teams", (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }
    const user = vs.users.findOneBy("username", auth.login as VercelUser["username"]);
    if (!user) {
      return vercelErr(c, 403, "forbidden", "User not found");
    }

    const pagination = parseCursorPagination(c);
    const memberships = vs.teamMembers.findBy("userId", user.uid as VercelTeamMember["userId"]);
    let teams = memberships
      .map((m) => vs.teams.findOneBy("uid", m.teamId as VercelTeam["uid"]))
      .filter((t): t is VercelTeam => Boolean(t));

    if (c.req.query("teamId") || c.req.query("slug")) {
      const scope = resolveTeamScope(c, vs);
      const scopedTeam = scope?.team;
      if (!scopedTeam) {
        return vercelErr(c, 404, "not_found", "Team not found");
      }
      teams = teams.filter((t) => t.uid === scopedTeam.uid);
    }

    const { items, pagination: pageMeta } = applyCursorPagination(teams, pagination);
    const formatted = items.map((team) => {
      const member = getTeamMember(vs, team.uid, user.uid);
      return formatTeamForViewer(team, member);
    });

    return c.json({
      teams: formatted,
      pagination: pageMeta,
    });
  });

  app.get("/v2/teams/:teamId", (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }
    const user = vs.users.findOneBy("username", auth.login as VercelUser["username"]);
    if (!user) {
      return vercelErr(c, 403, "forbidden", "User not found");
    }

    const team = resolveTeamByIdOrSlug(vs, c.req.param("teamId"));
    if (!team) {
      return vercelErr(c, 404, "not_found", "Team not found");
    }
    const member = getTeamMember(vs, team.uid, user.uid);
    return c.json({ team: formatTeamForViewer(team, member) });
  });

  app.post("/v2/teams", async (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }
    const creator = vs.users.findOneBy("username", auth.login as VercelUser["username"]);
    if (!creator) {
      return vercelErr(c, 403, "forbidden", "User not found");
    }

    const body = await parseJsonBody(c);
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    if (!slug) {
      return vercelErr(c, 400, "bad_request", "Missing required field: slug");
    }

    if (vs.teams.findOneBy("slug", slug as VercelTeam["slug"])) {
      return vercelErr(c, 409, "team_slug_already_exists", "A team with this slug already exists");
    }

    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : slug;

    const team = vs.teams.insert({
      uid: generateUid("team"),
      slug,
      name,
      avatar: null,
      description: null,
      creatorId: creator.uid,
      membership: { confirmed: true, role: "OWNER" },
      billing: defaultTeamBilling(),
      resourceConfig: defaultTeamResourceConfig(),
      stagingPrefix: "",
    });

    vs.teamMembers.insert({
      teamId: team.uid,
      userId: creator.uid,
      role: "OWNER",
      confirmed: true,
      joinedFrom: "cli",
    });

    const member = getTeamMember(vs, team.uid, creator.uid);
    return c.json({ team: formatTeamForViewer(team, member) });
  });

  app.patch("/v2/teams/:teamId", async (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }
    const user = vs.users.findOneBy("username", auth.login as VercelUser["username"]);
    if (!user) {
      return vercelErr(c, 403, "forbidden", "User not found");
    }

    const team = resolveTeamByIdOrSlug(vs, c.req.param("teamId"));
    if (!team) {
      return vercelErr(c, 404, "not_found", "Team not found");
    }

    const member = getTeamMember(vs, team.uid, user.uid);
    if (!member || member.role !== "OWNER") {
      return vercelErr(c, 403, "forbidden", "Insufficient permissions to update this team");
    }

    const body = await parseJsonBody(c);
    const patch: Partial<Pick<VercelTeam, "name" | "description" | "slug">> = {};

    if ("name" in body && typeof body.name === "string") patch.name = body.name;
    if ("description" in body) {
      if (body.description === null) patch.description = null;
      else if (typeof body.description === "string") patch.description = body.description;
    }
    if ("slug" in body && typeof body.slug === "string") {
      const nextSlug = body.slug.trim();
      if (nextSlug && nextSlug !== team.slug) {
        const taken = vs.teams.findOneBy("slug", nextSlug as VercelTeam["slug"]);
        if (taken && taken.id !== team.id) {
          return vercelErr(c, 409, "team_slug_already_exists", "A team with this slug already exists");
        }
        patch.slug = nextSlug;
      }
    }

    const updated = vs.teams.update(team.id, patch);
    if (!updated) {
      return vercelErr(c, 500, "internal_error", "Failed to update team");
    }
    const viewer = getTeamMember(vs, updated.uid, user.uid);
    return c.json({ team: formatTeamForViewer(updated, viewer) });
  });

  app.get("/v2/teams/:teamId/members", (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }
    const user = vs.users.findOneBy("username", auth.login as VercelUser["username"]);
    if (!user) {
      return vercelErr(c, 403, "forbidden", "User not found");
    }

    const team = resolveTeamByIdOrSlug(vs, c.req.param("teamId"));
    if (!team) {
      return vercelErr(c, 404, "not_found", "Team not found");
    }

    if (!getTeamMember(vs, team.uid, user.uid)) {
      return vercelErr(c, 403, "forbidden", "Not a member of this team");
    }

    const pagination = parseCursorPagination(c);
    const members = vs.teamMembers.findBy("teamId", team.uid as VercelTeamMember["teamId"]);
    const { items, pagination: pageMeta } = applyCursorPagination(members, pagination);
    return c.json({
      members: items.map((m) => formatMemberRow(vs, m)),
      pagination: pageMeta,
    });
  });

  app.post("/v2/teams/:teamId/members", async (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }
    const actor = vs.users.findOneBy("username", auth.login as VercelUser["username"]);
    if (!actor) {
      return vercelErr(c, 403, "forbidden", "User not found");
    }

    const team = resolveTeamByIdOrSlug(vs, c.req.param("teamId"));
    if (!team) {
      return vercelErr(c, 404, "not_found", "Team not found");
    }

    const actorMember = getTeamMember(vs, team.uid, actor.uid);
    if (!actorMember || actorMember.role !== "OWNER") {
      return vercelErr(c, 403, "forbidden", "Insufficient permissions to add members");
    }

    const body = await parseJsonBody(c);
    const email = typeof body.email === "string" ? body.email.trim() : undefined;
    const uid = typeof body.uid === "string" ? body.uid.trim() : undefined;

    let target: VercelUser | undefined;
    if (uid) {
      target = vs.users.findOneBy("uid", uid as VercelUser["uid"]);
    } else if (email) {
      target = vs.users.findOneBy("email", email as VercelUser["email"]);
    } else {
      return vercelErr(c, 400, "bad_request", "Provide uid or email");
    }

    if (!target) {
      return vercelErr(c, 404, "not_found", "User not found");
    }

    const role = parseRole(body.role, "MEMBER");
    if (role === null) {
      return vercelErr(c, 400, "bad_request", "Invalid role");
    }

    if (getTeamMember(vs, team.uid, target.uid)) {
      return vercelErr(c, 409, "member_already_exists", "User is already a member of this team");
    }

    const row = vs.teamMembers.insert({
      teamId: team.uid,
      userId: target.uid,
      role,
      confirmed: true,
      joinedFrom: email ? "email" : "invite",
    });

    return c.json({ member: formatMemberRow(vs, row) });
  });
}
