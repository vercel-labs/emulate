import type { RouteContext, AuthUser } from "@emulators/core";
import {
  ApiError,
  parseJsonBody,
  parsePagination,
  setLinkHeader,
  unauthorized,
  forbidden,
} from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type {
  GitHubOrg,
  GitHubRepo,
  GitHubTeam,
  GitHubUser,
} from "../entities.js";
import {
  formatOrgBrief,
  formatOrgFull,
  formatRepo,
  formatTeamBrief,
  formatUser,
  generateNodeId,
  lookupOwner,
  lookupRepo,
} from "../helpers.js";

const MEMBERS_TEAM_SLUG = "members";

function notFound() {
  return new ApiError(404, "Not Found");
}

function requireAuthUser(c: { get: (k: "authUser") => AuthUser | undefined }): AuthUser {
  const u = c.get("authUser");
  if (!u) throw unauthorized();
  return u;
}

function requireOrgAdmin(gh: GitHubStore, org: GitHubOrg, auth: AuthUser): void {
  const user = gh.users.findOneBy("login", auth.login);
  if (!user) throw forbidden();
  const role = orgRoleForUser(gh, org.id, user.id);
  if (role !== "admin") throw forbidden();
}

function getOrgByLogin(gh: GitHubStore, login: string): GitHubOrg | undefined {
  return gh.orgs.findOneBy("login", login);
}

function teamsForOrg(gh: GitHubStore, orgId: number): GitHubTeam[] {
  return gh.teams.findBy("org_id", orgId);
}

function getTeamByOrgSlug(
  gh: GitHubStore,
  org: GitHubOrg,
  slug: string
): GitHubTeam | undefined {
  return teamsForOrg(gh, org.id).find((t) => t.slug === slug);
}

function slugifyFromName(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "team";
}

function uniqueTeamSlug(gh: GitHubStore, orgId: number, base: string): string {
  let slug = base;
  let n = 2;
  const taken = (s: string) =>
    teamsForOrg(gh, orgId).some((t) => t.slug === s);
  while (taken(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function orgsForAuthenticatedUser(gh: GitHubStore, userId: number): GitHubOrg[] {
  const memberships = gh.teamMembers.findBy("user_id", userId);
  const orgIds = new Set<number>();
  for (const m of memberships) {
    const team = gh.teams.get(m.team_id);
    if (team) orgIds.add(team.org_id);
  }
  const orgs = [...orgIds]
    .map((id) => gh.orgs.get(id))
    .filter((o): o is GitHubOrg => Boolean(o));
  orgs.sort((a, b) => a.login.localeCompare(b.login));
  return orgs;
}

type OrgMemberRow = { user: GitHubUser; orgRole: "admin" | "member" };

function listOrgMembersDeduped(gh: GitHubStore, orgId: number): OrgMemberRow[] {
  const byUser = new Map<number, { user: GitHubUser; isAdmin: boolean }>();
  for (const team of teamsForOrg(gh, orgId)) {
    for (const m of gh.teamMembers.findBy("team_id", team.id)) {
      const user = gh.users.get(m.user_id);
      if (!user) continue;
      const isAdmin = m.role === "maintainer";
      const prev = byUser.get(user.id);
      if (!prev) {
        byUser.set(user.id, { user, isAdmin });
      } else {
        byUser.set(user.id, { user, isAdmin: prev.isAdmin || isAdmin });
      }
    }
  }
  return [...byUser.values()]
    .map(({ user, isAdmin }) => ({
      user,
      orgRole: isAdmin ? ("admin" as const) : ("member" as const),
    }))
    .sort((a, b) => a.user.id - b.user.id);
}

function orgRoleForUser(gh: GitHubStore, orgId: number, userId: number): "admin" | "member" | null {
  const row = listOrgMembersDeduped(gh, orgId).find((r) => r.user.id === userId);
  return row?.orgRole ?? null;
}

function syncTeamMemberCount(gh: GitHubStore, teamId: number) {
  const n = gh.teamMembers.findBy("team_id", teamId).length;
  gh.teams.update(teamId, { members_count: n });
}

function syncTeamRepoCount(gh: GitHubStore, teamId: number) {
  const n = gh.teamRepos.findBy("team_id", teamId).length;
  gh.teams.update(teamId, { repos_count: n });
}

function findTeamRepo(gh: GitHubStore, teamId: number, repoId: number) {
  return gh.teamRepos.findBy("team_id", teamId).find((r) => r.repo_id === repoId);
}

function getOrCreateMembersTeam(gh: GitHubStore, org: GitHubOrg): GitHubTeam {
  const existing = teamsForOrg(gh, org.id).find((t) => t.slug === MEMBERS_TEAM_SLUG);
  if (existing) return existing;
  const team = gh.teams.insert({
    node_id: "pending",
    name: "Members",
    slug: MEMBERS_TEAM_SLUG,
    description: null,
    privacy: "closed",
    permission: "pull",
    org_id: org.id,
    parent_id: null,
    members_count: 0,
    repos_count: 0,
  });
  const fixed = gh.teams.update(team.id, { node_id: generateNodeId("Team", team.id) });
  return fixed ?? team;
}

function deleteTeamCascade(gh: GitHubStore, team: GitHubTeam) {
  for (const child of teamsForOrg(gh, team.org_id).filter((t) => t.parent_id === team.id)) {
    gh.teams.update(child.id, { parent_id: null });
  }
  for (const m of gh.teamMembers.findBy("team_id", team.id)) {
    gh.teamMembers.delete(m.id);
  }
  for (const tr of gh.teamRepos.findBy("team_id", team.id)) {
    gh.teamRepos.delete(tr.id);
  }
  gh.teams.delete(team.id);
}

function removeUserFromAllOrgTeams(gh: GitHubStore, orgId: number, userId: number) {
  for (const team of teamsForOrg(gh, orgId)) {
    const memberships = gh.teamMembers
      .findBy("team_id", team.id)
      .filter((m) => m.user_id === userId);
    for (const m of memberships) {
      gh.teamMembers.delete(m.id);
    }
    syncTeamMemberCount(gh, team.id);
  }
}

function membershipUrl(baseUrl: string, orgLogin: string, teamSlug: string, userLogin: string) {
  return `${baseUrl}/orgs/${orgLogin}/teams/${teamSlug}/memberships/${userLogin}`;
}

function orgMembershipUrl(baseUrl: string, orgLogin: string, userLogin: string) {
  return `${baseUrl}/orgs/${orgLogin}/memberships/${userLogin}`;
}

function formatTeamMembership(
  baseUrl: string,
  orgLogin: string,
  teamSlug: string,
  user: GitHubUser,
  role: "member" | "maintainer"
) {
  return {
    url: membershipUrl(baseUrl, orgLogin, teamSlug, user.login),
    role,
    state: "active" as const,
    user: formatUser(user, baseUrl),
  };
}

export function orgsAndTeamsRoutes({ app, store, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/organizations", (c) => {
    const since = Math.max(0, parseInt(c.req.query("since") ?? "0", 10) || 0);
    const perPage = Math.min(
      100,
      Math.max(1, parseInt(c.req.query("per_page") ?? "30", 10) || 30)
    );

    const ordered = gh.orgs
      .all()
      .filter((o) => o.id > since)
      .sort((a, b) => a.id - b.id);
    const page = ordered.slice(0, perPage);

    if (page.length === perPage && ordered.length > perPage) {
      const lastId = page[page.length - 1]!.id;
      const nextUrl = new URL(c.req.url);
      nextUrl.searchParams.set("since", String(lastId));
      nextUrl.searchParams.set("per_page", String(perPage));
      c.header("Link", `<${nextUrl.toString()}>; rel="next"`);
    }

    return c.json(page.map((o) => formatOrgBrief(o, baseUrl)));
  });

  app.get("/user/orgs", (c) => {
    const auth = requireAuthUser(c);
    const user = gh.users.findOneBy("login", auth.login);
    if (!user) throw notFound();
    const orgs = orgsForAuthenticatedUser(gh, user.id);
    return c.json(orgs.map((o) => formatOrgBrief(o, baseUrl)));
  });

  app.get("/orgs/:org", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    return c.json(formatOrgFull(org, baseUrl));
  });

  app.patch("/orgs/:org", async (c) => {
    const auth = requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    requireOrgAdmin(gh, org, auth);

    const body = await parseJsonBody(c);
    const patch: Partial<GitHubOrg> = {};

    if ("billing_email" in body) {
      if (body.billing_email === null) patch.billing_email = null;
      else if (typeof body.billing_email === "string") patch.billing_email = body.billing_email;
    }
    if ("company" in body) {
      if (body.company === null) patch.company = null;
      else if (typeof body.company === "string") patch.company = body.company;
    }
    if ("email" in body) {
      if (body.email === null) patch.email = null;
      else if (typeof body.email === "string") patch.email = body.email;
    }
    if ("twitter_username" in body) {
      if (body.twitter_username === null) patch.twitter_username = null;
      else if (typeof body.twitter_username === "string") {
        patch.twitter_username = body.twitter_username;
      }
    }
    if ("location" in body) {
      if (body.location === null) patch.location = null;
      else if (typeof body.location === "string") patch.location = body.location;
    }
    if ("name" in body) {
      if (body.name === null) patch.name = null;
      else if (typeof body.name === "string") patch.name = body.name;
    }
    if ("description" in body) {
      if (body.description === null) patch.description = null;
      else if (typeof body.description === "string") patch.description = body.description;
    }
    if ("default_repository_permission" in body && typeof body.default_repository_permission === "string") {
      patch.default_repository_permission = body.default_repository_permission;
    }
    if ("members_can_create_repositories" in body && typeof body.members_can_create_repositories === "boolean") {
      patch.members_can_create_repositories = body.members_can_create_repositories;
    }

    const updated = gh.orgs.update(org.id, patch);
    if (!updated) throw notFound();
    return c.json(formatOrgFull(updated, baseUrl));
  });

  app.get("/orgs/:org/members", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();

    const roleQ = (c.req.query("role") ?? "all").toLowerCase();
    if (roleQ !== "all" && roleQ !== "admin" && roleQ !== "member") {
      throw new ApiError(422, "Invalid role parameter");
    }

    let rows = listOrgMembersDeduped(gh, org.id);
    if (roleQ === "admin") rows = rows.filter((r) => r.orgRole === "admin");
    else if (roleQ === "member") rows = rows.filter((r) => r.orgRole === "member");

    const { page, per_page } = parsePagination(c);
    const total = rows.length;
    const start = (page - 1) * per_page;
    const slice = rows.slice(start, start + per_page);

    setLinkHeader(c, total, page, per_page);
    return c.json(slice.map((r) => formatUser(r.user, baseUrl)));
  });

  app.get("/orgs/:org/members/:username", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const user = gh.users.findOneBy("login", c.req.param("username")!);
    if (!user) throw notFound();
    if (!orgRoleForUser(gh, org.id, user.id)) throw notFound();
    return c.body(null, 204);
  });

  app.delete("/orgs/:org/members/:username", (c) => {
    const auth = requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    requireOrgAdmin(gh, org, auth);
    const user = gh.users.findOneBy("login", c.req.param("username")!);
    if (!user) throw notFound();
    removeUserFromAllOrgTeams(gh, org.id, user.id);
    return c.body(null, 204);
  });

  app.get("/orgs/:org/memberships/:username", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const user = gh.users.findOneBy("login", c.req.param("username")!);
    if (!user) throw notFound();
    const role = orgRoleForUser(gh, org.id, user.id);
    if (!role) throw notFound();
    return c.json({
      url: orgMembershipUrl(baseUrl, org.login, user.login),
      state: "active",
      role,
      organization_url: `${baseUrl}/orgs/${org.login}`,
      user: formatUser(user, baseUrl),
      organization: formatOrgBrief(org, baseUrl),
    });
  });

  app.put("/orgs/:org/memberships/:username", async (c) => {
    const auth = requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    requireOrgAdmin(gh, org, auth);
    const user = gh.users.findOneBy("login", c.req.param("username")!);
    if (!user) throw notFound();

    const body = await parseJsonBody(c);
    const roleRaw = body.role;
    if (roleRaw !== "admin" && roleRaw !== "member") {
      throw new ApiError(422, "role must be admin or member");
    }
    const teamRole: "member" | "maintainer" = roleRaw === "admin" ? "maintainer" : "member";

    const membersTeam = getOrCreateMembersTeam(gh, org);
    const existing = gh.teamMembers
      .findBy("team_id", membersTeam.id)
      .find((m) => m.user_id === user.id);
    if (existing) {
      gh.teamMembers.update(existing.id, { role: teamRole });
    } else {
      gh.teamMembers.insert({ team_id: membersTeam.id, user_id: user.id, role: teamRole });
    }
    syncTeamMemberCount(gh, membersTeam.id);

    const orgRole = orgRoleForUser(gh, org.id, user.id)!;
    return c.json({
      url: orgMembershipUrl(baseUrl, org.login, user.login),
      state: "active",
      role: orgRole,
      organization_url: `${baseUrl}/orgs/${org.login}`,
      user: formatUser(user, baseUrl),
      organization: formatOrgBrief(org, baseUrl),
    });
  });

  app.get("/orgs/:org/teams", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();

    const all = teamsForOrg(gh, org.id).sort((a, b) => a.id - b.id);
    const { page, per_page } = parsePagination(c);
    const total = all.length;
    const start = (page - 1) * per_page;
    const slice = all.slice(start, start + per_page);

    setLinkHeader(c, total, page, per_page);
    return c.json(slice.map((t) => formatTeamBrief(t, gh, baseUrl)));
  });

  app.post("/orgs/:org/teams", async (c) => {
    requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();

    const body = await parseJsonBody(c);
    const name = body.name;
    if (typeof name !== "string" || !name.trim()) {
      throw new ApiError(422, "name is required");
    }

    let parentId: number | null = null;
    if (body.parent_team_id != null) {
      const pid = Number(body.parent_team_id);
      const parent = gh.teams.get(pid);
      if (!parent || parent.org_id !== org.id) {
        throw new ApiError(422, "Invalid parent_team_id");
      }
      parentId = parent.id;
    }

    const baseSlug = uniqueTeamSlug(gh, org.id, slugifyFromName(name));
    const privacy =
      body.privacy === "secret" || body.privacy === "closed" ? body.privacy : "closed";
    const permission = typeof body.permission === "string" ? body.permission : "pull";
    const description =
      body.description === null ? null : typeof body.description === "string" ? body.description : null;

    const team = gh.teams.insert({
      node_id: "pending",
      name: name.trim(),
      slug: baseSlug,
      description,
      privacy,
      permission,
      org_id: org.id,
      parent_id: parentId,
      members_count: 0,
      repos_count: 0,
    });
    const fixed = gh.teams.update(team.id, { node_id: generateNodeId("Team", team.id) });
    return c.json(formatTeamBrief(fixed ?? team, gh, baseUrl), 201);
  });

  app.get("/orgs/:org/teams/:team_slug", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const team = getTeamByOrgSlug(gh, org, c.req.param("team_slug")!);
    if (!team) throw notFound();
    return c.json(formatTeamBrief(team, gh, baseUrl));
  });

  app.patch("/orgs/:org/teams/:team_slug", async (c) => {
    requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const team = getTeamByOrgSlug(gh, org, c.req.param("team_slug")!);
    if (!team) throw notFound();

    const body = await parseJsonBody(c);
    const patch: Partial<GitHubTeam> = {};

    if ("name" in body && typeof body.name === "string" && body.name.trim()) {
      patch.name = body.name.trim();
    }
    if ("description" in body) {
      if (body.description === null) patch.description = null;
      else if (typeof body.description === "string") patch.description = body.description;
    }
    if (body.privacy === "secret" || body.privacy === "closed") {
      patch.privacy = body.privacy;
    }
    if ("permission" in body && typeof body.permission === "string") {
      patch.permission = body.permission;
    }
    if ("parent_team_id" in body) {
      if (body.parent_team_id === null) {
        patch.parent_id = null;
      } else {
        const pid = Number(body.parent_team_id);
        const parent = gh.teams.get(pid);
        if (!parent || parent.org_id !== org.id) {
          throw new ApiError(422, "Invalid parent_team_id");
        }
        if (parent.id === team.id) throw new ApiError(422, "Invalid parent_team_id");
        patch.parent_id = parent.id;
      }
    }

    const updated = gh.teams.update(team.id, patch);
    if (!updated) throw notFound();
    return c.json(formatTeamBrief(updated, gh, baseUrl));
  });

  app.delete("/orgs/:org/teams/:team_slug", (c) => {
    requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const team = getTeamByOrgSlug(gh, org, c.req.param("team_slug")!);
    if (!team) throw notFound();
    deleteTeamCascade(gh, team);
    return c.body(null, 204);
  });

  app.get("/orgs/:org/teams/:team_slug/members", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const team = getTeamByOrgSlug(gh, org, c.req.param("team_slug")!);
    if (!team) throw notFound();

    const roleQ = (c.req.query("role") ?? "all").toLowerCase();
    if (roleQ !== "all" && roleQ !== "member" && roleQ !== "maintainer") {
      throw new ApiError(422, "Invalid role parameter");
    }

    let members = gh.teamMembers
      .findBy("team_id", team.id)
      .map((m) => {
        const user = gh.users.get(m.user_id);
        return user ? { user, role: m.role } : null;
      })
      .filter((x): x is { user: GitHubUser; role: "member" | "maintainer" } => Boolean(x));

    if (roleQ === "member") members = members.filter((m) => m.role === "member");
    else if (roleQ === "maintainer") members = members.filter((m) => m.role === "maintainer");

    members.sort((a, b) => a.user.id - b.user.id);

    const { page, per_page } = parsePagination(c);
    const total = members.length;
    const start = (page - 1) * per_page;
    const slice = members.slice(start, start + per_page);

    setLinkHeader(c, total, page, per_page);
    return c.json(slice.map((m) => formatUser(m.user, baseUrl)));
  });

  app.put("/orgs/:org/teams/:team_slug/memberships/:username", async (c) => {
    requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const team = getTeamByOrgSlug(gh, org, c.req.param("team_slug")!);
    if (!team) throw notFound();
    const user = gh.users.findOneBy("login", c.req.param("username")!);
    if (!user) throw notFound();

    const body = await parseJsonBody(c);
    const role: "member" | "maintainer" =
      body.role === "maintainer" ? "maintainer" : "member";

    const existing = gh.teamMembers
      .findBy("team_id", team.id)
      .find((m) => m.user_id === user.id);
    if (existing) {
      gh.teamMembers.update(existing.id, { role });
    } else {
      gh.teamMembers.insert({ team_id: team.id, user_id: user.id, role });
    }
    syncTeamMemberCount(gh, team.id);

    return c.json(formatTeamMembership(baseUrl, org.login, team.slug, user, role));
  });

  app.delete("/orgs/:org/teams/:team_slug/memberships/:username", (c) => {
    requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const team = getTeamByOrgSlug(gh, org, c.req.param("team_slug")!);
    if (!team) throw notFound();
    const user = gh.users.findOneBy("login", c.req.param("username")!);
    if (!user) throw notFound();

    const existing = gh.teamMembers
      .findBy("team_id", team.id)
      .find((m) => m.user_id === user.id);
    if (existing) {
      gh.teamMembers.delete(existing.id);
      syncTeamMemberCount(gh, team.id);
    }
    return c.body(null, 204);
  });

  app.get("/orgs/:org/teams/:team_slug/memberships/:username", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const team = getTeamByOrgSlug(gh, org, c.req.param("team_slug")!);
    if (!team) throw notFound();
    const user = gh.users.findOneBy("login", c.req.param("username")!);
    if (!user) throw notFound();

    const m = gh.teamMembers
      .findBy("team_id", team.id)
      .find((x) => x.user_id === user.id);
    if (!m) throw notFound();

    return c.json(formatTeamMembership(baseUrl, org.login, team.slug, user, m.role));
  });

  app.get("/orgs/:org/teams/:team_slug/repos", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const team = getTeamByOrgSlug(gh, org, c.req.param("team_slug")!);
    if (!team) throw notFound();

    const links = gh.teamRepos.findBy("team_id", team.id);
    const repos = links
      .map((l) => gh.repos.get(l.repo_id))
      .filter((r): r is GitHubRepo => Boolean(r))
      .sort((a, b) => a.id - b.id);

    const { page, per_page } = parsePagination(c);
    const total = repos.length;
    const start = (page - 1) * per_page;
    const slice = repos.slice(start, start + per_page);

    setLinkHeader(c, total, page, per_page);
    return c.json(slice.map((r) => formatRepo(r, gh, baseUrl)));
  });

  app.put("/orgs/:org/teams/:team_slug/repos/:owner/:repo", (c) => {
    requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const team = getTeamByOrgSlug(gh, org, c.req.param("team_slug")!);
    if (!team) throw notFound();

    const ownerLogin = c.req.param("owner")!;
    const ownerInfo = lookupOwner(gh, ownerLogin);
    if (!ownerInfo || ownerInfo.type !== "Organization" || ownerInfo.id !== org.id) {
      throw new ApiError(422, "Repository must belong to this organization");
    }
    const repo = lookupRepo(gh, ownerLogin, c.req.param("repo")!);
    if (!repo) throw notFound();

    if (!findTeamRepo(gh, team.id, repo.id)) {
      gh.teamRepos.insert({ team_id: team.id, repo_id: repo.id });
      syncTeamRepoCount(gh, team.id);
    }
    return c.body(null, 204);
  });

  app.delete("/orgs/:org/teams/:team_slug/repos/:owner/:repo", (c) => {
    requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const team = getTeamByOrgSlug(gh, org, c.req.param("team_slug")!);
    if (!team) throw notFound();

    const ownerLogin = c.req.param("owner")!;
    const ownerInfo = lookupOwner(gh, ownerLogin);
    if (!ownerInfo || ownerInfo.type !== "Organization" || ownerInfo.id !== org.id) {
      throw new ApiError(422, "Repository must belong to this organization");
    }
    const repo = lookupRepo(gh, ownerLogin, c.req.param("repo")!);
    if (!repo) throw notFound();

    const tr = findTeamRepo(gh, team.id, repo.id);
    if (tr) {
      gh.teamRepos.delete(tr.id);
      syncTeamRepoCount(gh, team.id);
    }
    return c.body(null, 204);
  });

  app.get("/teams/:team_id", (c) => {
    const tid = parseInt(c.req.param("team_id") ?? "", 10);
    if (Number.isNaN(tid)) throw notFound();
    const team = gh.teams.get(tid);
    if (!team) throw notFound();
    return c.json(formatTeamBrief(team, gh, baseUrl));
  });

  app.get("/teams/:team_id/members", (c) => {
    const tid = parseInt(c.req.param("team_id") ?? "", 10);
    if (Number.isNaN(tid)) throw notFound();
    const team = gh.teams.get(tid);
    if (!team) throw notFound();

    const roleQ = (c.req.query("role") ?? "all").toLowerCase();
    if (roleQ !== "all" && roleQ !== "member" && roleQ !== "maintainer") {
      throw new ApiError(422, "Invalid role parameter");
    }

    let members = gh.teamMembers
      .findBy("team_id", team.id)
      .map((m) => {
        const user = gh.users.get(m.user_id);
        return user ? { user, role: m.role } : null;
      })
      .filter((x): x is { user: GitHubUser; role: "member" | "maintainer" } => Boolean(x));

    if (roleQ === "member") members = members.filter((m) => m.role === "member");
    else if (roleQ === "maintainer") members = members.filter((m) => m.role === "maintainer");

    members.sort((a, b) => a.user.id - b.user.id);

    const { page, per_page } = parsePagination(c);
    const total = members.length;
    const start = (page - 1) * per_page;
    const slice = members.slice(start, start + per_page);

    setLinkHeader(c, total, page, per_page);
    return c.json(slice.map((m) => formatUser(m.user, baseUrl)));
  });
}
