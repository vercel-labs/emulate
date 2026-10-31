import type { Context, RouteContext, AuthUser } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader, unauthorized, forbidden } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import { enumValidationError, parseOptionalJsonBody } from "../request-body.js";
import type { GitHubStore } from "../store.js";
import type { GitHubOrg, GitHubOrgInvitation, GitHubRepo, GitHubTeam, GitHubUser } from "../entities.js";
import { canAccessRepo, getActorUser, hasRepoAdmin, isOrgMember } from "../route-helpers.js";
import {
  formatOrgBrief,
  formatOrgFull,
  formatRepo,
  formatTeamBrief,
  formatTeamFull,
  formatUser,
  generateNodeId,
  isOrgOwner,
  isRepoPermissionLevel,
  lookupRepo,
  repoPermissionFlags,
  ROLE_NAMES,
  teamRepoPermission,
} from "../helpers.js";

const MEMBERS_TEAM_SLUG = "members";
const ORG_ROLES = ["admin", "member"] as const;
const TEAM_ROLES = ["member", "maintainer"] as const;
const ADMIN_RIGHTS = "Must have admin rights to Repository.";

function isMemberOf(gh: GitHubStore, auth: AuthUser, org: GitHubOrg): boolean {
  const user = auth.installation ? undefined : getActorUser(gh, auth);
  return Boolean(user && isOrgMember(gh, user.id, org.id));
}

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

function getTeamByOrgSlug(gh: GitHubStore, org: GitHubOrg, slug: string): GitHubTeam | undefined {
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
  const taken = (s: string) => teamsForOrg(gh, orgId).some((t) => t.slug === s);
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
  const orgs = [...orgIds].map((id) => gh.orgs.get(id)).filter((o): o is GitHubOrg => Boolean(o));
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
      const isAdmin = team.slug === MEMBERS_TEAM_SLUG && m.role === "maintainer";
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

type TeamAccess = { user?: GitHubUser; visible: boolean; manage: boolean };

function teamAccess(gh: GitHubStore, auth: AuthUser, org: GitHubOrg, team: GitHubTeam): TeamAccess {
  if (auth.installation) {
    const installation = auth.installation;
    const level =
      installation.accountType === "Organization" && installation.accountId === org.id
        ? installation.permissions.members
        : undefined;
    return { visible: level === "read" || level === "write", manage: level === "write" };
  }
  const user = getActorUser(gh, auth);
  if (!user) return { visible: false, manage: false };
  const owner = isOrgOwner(gh, org.id, user.id);
  const membership = gh.teamMembers.findBy("team_id", team.id).find((m) => m.user_id === user.id);
  const visible = owner || (isOrgMember(gh, user.id, org.id) && (team.privacy === "closed" || Boolean(membership)));
  return { user, visible, manage: owner || membership?.role === "maintainer" };
}

/** GitHub answers 404 for a team the caller cannot see. */
function visibleTeam(
  c: { get: (k: "authUser") => AuthUser | undefined },
  gh: GitHubStore,
  orgLogin: string,
  slug: string,
) {
  const auth = requireAuthUser(c);
  const org = getOrgByLogin(gh, orgLogin);
  if (!org) throw notFound();
  const team = getTeamByOrgSlug(gh, org, slug);
  if (!team) throw notFound();
  const access = teamAccess(gh, auth, org, team);
  if (!access.visible) throw notFound();
  return { auth, org, team, access };
}

function hasTeamRepoAdmin(gh: GitHubStore, auth: AuthUser, access: TeamAccess, repo: GitHubRepo): boolean {
  if (auth.installation) return access.manage;
  return Boolean(access.user && hasRepoAdmin(gh, access.user, repo));
}

function findTeamRepo(gh: GitHubStore, teamId: number, repoId: number) {
  return gh.teamRepos.findBy("team_id", teamId).find((r) => r.repo_id === repoId);
}

export function getOrCreateTeam(gh: GitHubStore, org: GitHubOrg, name: string, permission: string): GitHubTeam {
  const slug = slugifyFromName(name);
  const existing = getTeamByOrgSlug(gh, org, slug);
  if (existing) return gh.teams.update(existing.id, { permission }) ?? existing;
  const team = gh.teams.insert({
    node_id: "pending",
    name,
    slug,
    description: null,
    privacy: "closed",
    permission,
    org_id: org.id,
    parent_id: null,
  });
  return gh.teams.update(team.id, { node_id: generateNodeId("Team", team.id) }) ?? team;
}

export function getOrCreateMembersTeam(gh: GitHubStore, org: GitHubOrg): GitHubTeam {
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
  for (const invitation of gh.orgInvitations.findBy("org_id", team.org_id)) {
    if (invitation.teams.some((t) => t.team_id === team.id)) {
      gh.orgInvitations.update(invitation.id, { teams: invitation.teams.filter((t) => t.team_id !== team.id) });
    }
  }
  gh.teams.delete(team.id);
}

function findInvitation(gh: GitHubStore, orgId: number, userId: number): GitHubOrgInvitation | undefined {
  return gh.orgInvitations.findBy("org_id", orgId).find((i) => i.invitee_id === userId);
}

function inviteToOrg(
  gh: GitHubStore,
  org: GitHubOrg,
  invitee: GitHubUser,
  inviter: GitHubUser | undefined,
  change: { role?: GitHubOrgInvitation["role"]; team?: GitHubOrgInvitation["teams"][number] },
): { invitation: GitHubOrgInvitation; created: boolean } {
  const existing = findInvitation(gh, org.id, invitee.id);
  const teams = (existing?.teams ?? []).filter((t) => t.team_id !== change.team?.team_id);
  if (change.team) teams.push(change.team);
  const role = change.role ?? existing?.role ?? "direct_member";
  if (existing)
    return { invitation: gh.orgInvitations.update(existing.id, { role, teams }) ?? existing, created: false };
  const row = gh.orgInvitations.insert({
    node_id: "",
    org_id: org.id,
    invitee_id: invitee.id,
    inviter_id: inviter?.id ?? null,
    role,
    teams,
  });
  const invitation =
    gh.orgInvitations.update(row.id, { node_id: generateNodeId("OrganizationInvitation", row.id) }) ?? row;
  return { invitation, created: true };
}

function acceptInvitation(gh: GitHubStore, org: GitHubOrg, invitation: GitHubOrgInvitation): GitHubTeam[] {
  const membersTeam = getOrCreateMembersTeam(gh, org);
  const joins = [
    { team_id: membersTeam.id, role: invitation.role === "admin" ? ("maintainer" as const) : ("member" as const) },
    ...invitation.teams,
  ];
  for (const join of joins) {
    const existing = gh.teamMembers.findBy("team_id", join.team_id).find((m) => m.user_id === invitation.invitee_id);
    if (existing) gh.teamMembers.update(existing.id, { role: join.role });
    else gh.teamMembers.insert({ team_id: join.team_id, user_id: invitation.invitee_id, role: join.role });
  }
  gh.orgInvitations.delete(invitation.id);
  return invitation.teams.flatMap(({ team_id }) => gh.teams.get(team_id) ?? []);
}

function removeUserFromAllOrgTeams(gh: GitHubStore, orgId: number, userId: number) {
  for (const team of teamsForOrg(gh, orgId)) {
    const memberships = gh.teamMembers.findBy("team_id", team.id).filter((m) => m.user_id === userId);
    for (const m of memberships) {
      gh.teamMembers.delete(m.id);
    }
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
  role: "member" | "maintainer",
  state: "active" | "pending" = "active",
) {
  return {
    url: membershipUrl(baseUrl, orgLogin, teamSlug, user.login),
    role,
    state,
    user: formatUser(user, baseUrl),
  };
}

function formatOrgMembership(
  baseUrl: string,
  org: GitHubOrg,
  user: GitHubUser,
  role: "admin" | "member",
  state: "active" | "pending",
) {
  return {
    url: orgMembershipUrl(baseUrl, org.login, user.login),
    state,
    role,
    organization_url: `${baseUrl}/orgs/${org.login}`,
    user: formatUser(user, baseUrl),
    organization: formatOrgBrief(org, baseUrl),
  };
}

function formatInvitation(gh: GitHubStore, baseUrl: string, org: GitHubOrg, invitation: GitHubOrgInvitation) {
  const invitee = gh.users.get(invitation.invitee_id);
  const inviter = invitation.inviter_id !== null ? gh.users.get(invitation.inviter_id) : undefined;
  return {
    id: invitation.id,
    node_id: invitation.node_id,
    login: invitee?.login ?? null,
    email: null,
    role: invitation.role,
    created_at: invitation.created_at,
    failed_at: null,
    failed_reason: null,
    inviter: inviter ? formatUser(inviter, baseUrl) : null,
    team_count: invitation.teams.length,
    invitation_teams_url: `${baseUrl}/organizations/${org.id}/invitations/${invitation.id}/teams`,
    invitation_source: "member",
  };
}

export function orgsAndTeamsRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  const orgEvent = (
    org: GitHubOrg,
    event: "organization" | "membership",
    action: string,
    sender: GitHubUser | undefined,
    payload: Record<string, unknown>,
  ) =>
    webhooks.dispatch(
      event,
      action,
      {
        action,
        ...payload,
        organization: formatOrgBrief(org, baseUrl),
        sender: sender ? formatUser(sender, baseUrl) : null,
      },
      org.login,
    );

  const teamMembershipEvent = (
    org: GitHubOrg,
    team: GitHubTeam,
    action: "added" | "removed",
    member: GitHubUser,
    sender: GitHubUser | undefined,
  ) => {
    if (team.slug === MEMBERS_TEAM_SLUG) return;
    const parent = team.parent_id !== null ? gh.teams.get(team.parent_id) : undefined;
    orgEvent(org, "membership", action, sender, {
      scope: "team",
      member: formatUser(member, baseUrl),
      team: { ...formatTeamBrief(team, gh, baseUrl), parent: parent ? formatTeamBrief(parent, gh, baseUrl) : null },
    });
  };

  const orgMembershipEvent = (
    org: GitHubOrg,
    action: "member_added" | "member_removed",
    user: GitHubUser,
    role: "admin" | "member",
    sender: GitHubUser | undefined,
  ) => {
    const { organization: _organization, ...membership } = formatOrgMembership(baseUrl, org, user, role, "active");
    orgEvent(org, "organization", action, sender, { membership });
  };

  const invitedEvent = (org: GitHubOrg, invitation: GitHubOrgInvitation, invitee: GitHubUser, sender?: GitHubUser) =>
    orgEvent(org, "organization", "member_invited", sender, {
      invitation: formatInvitation(gh, baseUrl, org, invitation),
      user: formatUser(invitee, baseUrl),
    });

  const removeFromOrg = (org: GitHubOrg, user: GitHubUser, sender: GitHubUser | undefined) => {
    const role = orgRoleForUser(gh, org.id, user.id);
    removeUserFromAllOrgTeams(gh, org.id, user.id);
    if (role) orgMembershipEvent(org, "member_removed", user, role, sender);
  };

  const paginatedInvitations = (c: Context, org: GitHubOrg, invitations: GitHubOrgInvitation[]) => {
    const { page, per_page } = parsePagination(c);
    const sorted = [...invitations].sort((a, b) => a.id - b.id);
    setLinkHeader(c, sorted.length, page, per_page);
    const slice = sorted.slice((page - 1) * per_page, page * per_page);
    return c.json(slice.map((invitation) => formatInvitation(gh, baseUrl, org, invitation)));
  };

  const visibleTeamById = (c: { get: (k: "authUser") => AuthUser | undefined }, id: string | undefined) => {
    const team = gh.teams.get(parseInt(id ?? "", 10));
    return visibleTeam(c, gh, (team && gh.orgs.get(team.org_id)?.login) ?? "", team?.slug ?? "").team;
  };

  app.get("/organizations", (c) => {
    const since = Math.max(0, parseInt(c.req.query("since") ?? "0", 10) || 0);
    const perPage = Math.min(100, Math.max(1, parseInt(c.req.query("per_page") ?? "30", 10) || 30));

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

    const body = await parseOptionalJsonBody(c);
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
    removeFromOrg(org, user, getActorUser(gh, auth));
    return c.body(null, 204);
  });

  app.get("/orgs/:org/memberships/:username", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const user = gh.users.findOneBy("login", c.req.param("username")!);
    if (!user) throw notFound();
    const role = orgRoleForUser(gh, org.id, user.id);
    if (role) return c.json(formatOrgMembership(baseUrl, org, user, role, "active"));
    const invitation = findInvitation(gh, org.id, user.id);
    if (!invitation) throw notFound();
    return c.json(formatOrgMembership(baseUrl, org, user, invitation.role === "admin" ? "admin" : "member", "pending"));
  });

  app.put("/orgs/:org/memberships/:username", async (c) => {
    const auth = requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    requireOrgAdmin(gh, org, auth);
    const user = gh.users.findOneBy("login", c.req.param("username")!);
    if (!user) throw notFound();

    const body = await parseOptionalJsonBody(c);
    const roleRaw = body.role ?? "member";
    if (roleRaw !== "admin" && roleRaw !== "member") throw enumValidationError(roleRaw, ORG_ROLES);

    if (!isOrgMember(gh, user.id, org.id)) {
      const inviter = getActorUser(gh, auth);
      const invite = inviteToOrg(gh, org, user, inviter, { role: roleRaw === "admin" ? "admin" : "direct_member" });
      if (invite.created) invitedEvent(org, invite.invitation, user, inviter);
      return c.json(formatOrgMembership(baseUrl, org, user, roleRaw, "pending"));
    }

    const membersTeam = getOrCreateMembersTeam(gh, org);
    const teamRole: "member" | "maintainer" = roleRaw === "admin" ? "maintainer" : "member";
    const existing = gh.teamMembers.findBy("team_id", membersTeam.id).find((m) => m.user_id === user.id);
    if (existing) {
      gh.teamMembers.update(existing.id, { role: teamRole });
    } else {
      gh.teamMembers.insert({ team_id: membersTeam.id, user_id: user.id, role: teamRole });
    }

    return c.json(formatOrgMembership(baseUrl, org, user, orgRoleForUser(gh, org.id, user.id)!, "active"));
  });

  app.delete("/orgs/:org/memberships/:username", (c) => {
    const auth = requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    requireOrgAdmin(gh, org, auth);
    const user = gh.users.findOneBy("login", c.req.param("username")!);
    if (!user) throw notFound();
    const invitation = findInvitation(gh, org.id, user.id);
    if (invitation) gh.orgInvitations.delete(invitation.id);
    else if (isOrgMember(gh, user.id, org.id)) removeFromOrg(org, user, getActorUser(gh, auth));
    else throw notFound();
    return c.body(null, 204);
  });

  app.get("/orgs/:org/invitations", (c) => {
    const auth = requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const caller = getActorUser(gh, auth);
    if (!caller || !isOrgOwner(gh, org.id, caller.id)) {
      throw new ApiError(403, "You must be an admin to view organization pending invitations.");
    }
    return paginatedInvitations(c, org, gh.orgInvitations.findBy("org_id", org.id));
  });

  app.delete("/orgs/:org/invitations/:invitation_id", (c) => {
    const auth = requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    requireOrgAdmin(gh, org, auth);
    const invitation = gh.orgInvitations.get(parseInt(c.req.param("invitation_id")!, 10));
    if (!invitation || invitation.org_id !== org.id) throw notFound();
    gh.orgInvitations.delete(invitation.id);
    return c.body(null, 204);
  });

  app.get("/orgs/:org/invitations/:invitation_id/teams", (c) => {
    const auth = requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    requireOrgAdmin(gh, org, auth);
    const invitation = gh.orgInvitations.get(parseInt(c.req.param("invitation_id")!, 10));
    if (!invitation || invitation.org_id !== org.id) throw notFound();
    const teams = invitation.teams.flatMap(({ team_id }) => gh.teams.get(team_id) ?? []);
    return c.json(teams.map((team) => formatTeamBrief(team, gh, baseUrl)));
  });

  app.get("/user/memberships/orgs/:org", (c) => {
    const auth = requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    const user = getActorUser(gh, auth);
    if (!org || !user) throw notFound();
    const role = orgRoleForUser(gh, org.id, user.id);
    if (role) return c.json(formatOrgMembership(baseUrl, org, user, role, "active"));
    const invitation = findInvitation(gh, org.id, user.id);
    if (!invitation) throw notFound();
    return c.json(formatOrgMembership(baseUrl, org, user, invitation.role === "admin" ? "admin" : "member", "pending"));
  });

  app.patch("/user/memberships/orgs/:org", async (c) => {
    const auth = requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    const user = getActorUser(gh, auth);
    if (!org || !user) throw notFound();
    const body = await parseJsonBody(c);
    if (body.state !== "active") throw enumValidationError(body.state, ["active"]);
    const invitation = findInvitation(gh, org.id, user.id);
    const joined = invitation ? acceptInvitation(gh, org, invitation) : [];
    const role = orgRoleForUser(gh, org.id, user.id);
    if (!role) throw notFound();
    if (invitation) {
      orgMembershipEvent(org, "member_added", user, role, user);
      for (const team of joined) teamMembershipEvent(org, team, "added", user, user);
    }
    return c.json(formatOrgMembership(baseUrl, org, user, role, "active"));
  });

  app.get("/orgs/:org/teams", (c) => {
    const auth = requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const all = teamsForOrg(gh, org.id)
      .filter((team) => teamAccess(gh, auth, org, team).visible)
      .sort((a, b) => a.id - b.id);
    if (!all.length && !isMemberOf(gh, auth, org)) throw new ApiError(403, ADMIN_RIGHTS);

    const { page, per_page } = parsePagination(c);
    const total = all.length;
    const start = (page - 1) * per_page;
    const slice = all.slice(start, start + per_page);

    setLinkHeader(c, total, page, per_page);
    return c.json(slice.map((t) => formatTeamBrief(t, gh, baseUrl)));
  });

  app.post("/orgs/:org/teams", async (c) => {
    const auth = requireAuthUser(c);
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFound();
    const creator = auth.installation ? undefined : getActorUser(gh, auth);
    const allowed = auth.installation
      ? auth.installation.accountType === "Organization" &&
        auth.installation.accountId === org.id &&
        auth.installation.permissions.members === "write"
      : Boolean(creator && isOrgMember(gh, creator.id, org.id));
    if (!allowed) throw new ApiError(403, ADMIN_RIGHTS);

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
    const privacy = body.privacy === "secret" || body.privacy === "closed" ? body.privacy : "closed";
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
    });
    const fixed = gh.teams.update(team.id, { node_id: generateNodeId("Team", team.id) });
    if (creator) gh.teamMembers.insert({ team_id: team.id, user_id: creator.id, role: "maintainer" });
    return c.json(formatTeamFull(fixed ?? team, gh, baseUrl), 201);
  });

  app.get("/orgs/:org/teams/:team_slug", (c) => {
    const { team } = visibleTeam(c, gh, c.req.param("org")!, c.req.param("team_slug")!);
    return c.json(formatTeamFull(team, gh, baseUrl));
  });

  app.patch("/orgs/:org/teams/:team_slug", async (c) => {
    const { org, team, access } = visibleTeam(c, gh, c.req.param("org")!, c.req.param("team_slug")!);
    if (!access.manage) throw notFound();

    const body = await parseOptionalJsonBody(c);
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
    return c.json(formatTeamFull(updated, gh, baseUrl));
  });

  app.delete("/orgs/:org/teams/:team_slug", (c) => {
    const { team, access } = visibleTeam(c, gh, c.req.param("org")!, c.req.param("team_slug")!);
    if (!access.manage) throw notFound();
    deleteTeamCascade(gh, team);
    return c.body(null, 204);
  });

  app.get("/orgs/:org/teams/:team_slug/members", (c) => {
    const { team } = visibleTeam(c, gh, c.req.param("org")!, c.req.param("team_slug")!);

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
    const { auth, org, team, access } = visibleTeam(c, gh, c.req.param("org")!, c.req.param("team_slug")!);
    if (!access.manage) {
      throw new ApiError(403, "You must be an organization owner or team maintainer to add a team membership.");
    }
    const user = gh.users.findOneBy("login", c.req.param("username")!);
    if (!user) throw notFound();

    const body = await parseOptionalJsonBody(c);
    const role = body.role ?? "member";
    if (role !== "member" && role !== "maintainer") throw enumValidationError(role, TEAM_ROLES);

    if (!isOrgMember(gh, user.id, org.id)) {
      const owner = auth.installation ? access.manage : Boolean(access.user && isOrgOwner(gh, org.id, access.user.id));
      if (!owner) {
        throw new ApiError(403, "You must be an organization owner or team maintainer to add a team membership.");
      }
      const invite = inviteToOrg(gh, org, user, access.user, { team: { team_id: team.id, role } });
      if (invite.created) invitedEvent(org, invite.invitation, user, access.user);
      return c.json(formatTeamMembership(baseUrl, org.login, team.slug, user, role, "pending"));
    }

    const existing = gh.teamMembers.findBy("team_id", team.id).find((m) => m.user_id === user.id);
    if (existing) {
      gh.teamMembers.update(existing.id, { role });
    } else {
      gh.teamMembers.insert({ team_id: team.id, user_id: user.id, role });
      teamMembershipEvent(org, team, "added", user, access.user);
    }

    return c.json(formatTeamMembership(baseUrl, org.login, team.slug, user, role));
  });

  app.get("/orgs/:org/teams/:team_slug/invitations", (c) => {
    const { org, team, access } = visibleTeam(c, gh, c.req.param("org")!, c.req.param("team_slug")!);
    if (!access.manage) {
      throw new ApiError(403, "You must be an organization owner or team maintainer to list team invitations.");
    }
    const invitations = gh.orgInvitations
      .findBy("org_id", org.id)
      .filter((i) => i.teams.some((t) => t.team_id === team.id));
    return paginatedInvitations(c, org, invitations);
  });

  app.delete("/orgs/:org/teams/:team_slug/memberships/:username", (c) => {
    const { org, team, access } = visibleTeam(c, gh, c.req.param("org")!, c.req.param("team_slug")!);
    const user = gh.users.findOneBy("login", c.req.param("username")!);
    if (!user) throw notFound();
    if (!access.manage) {
      throw new ApiError(403, "You must be an organization owner or team maintainer to remove a team membership.");
    }

    const existing = gh.teamMembers.findBy("team_id", team.id).find((m) => m.user_id === user.id);
    if (existing) {
      gh.teamMembers.delete(existing.id);
      teamMembershipEvent(org, team, "removed", user, access.user);
    }
    const invitation = findInvitation(gh, team.org_id, user.id);
    if (invitation?.teams.some((t) => t.team_id === team.id)) {
      gh.orgInvitations.update(invitation.id, { teams: invitation.teams.filter((t) => t.team_id !== team.id) });
    }
    return c.body(null, 204);
  });

  app.get("/orgs/:org/teams/:team_slug/memberships/:username", (c) => {
    const { org, team } = visibleTeam(c, gh, c.req.param("org")!, c.req.param("team_slug")!);
    const user = gh.users.findOneBy("login", c.req.param("username")!);
    if (!user) throw notFound();

    const m = gh.teamMembers.findBy("team_id", team.id).find((x) => x.user_id === user.id);
    if (m) return c.json(formatTeamMembership(baseUrl, org.login, team.slug, user, m.role));
    const invited = findInvitation(gh, org.id, user.id)?.teams.find((t) => t.team_id === team.id);
    if (!invited) throw notFound();
    return c.json(formatTeamMembership(baseUrl, org.login, team.slug, user, invited.role, "pending"));
  });

  app.get("/orgs/:org/teams/:team_slug/repos", (c) => {
    const { auth, team } = visibleTeam(c, gh, c.req.param("org")!, c.req.param("team_slug")!);

    const grants = gh.teamRepos
      .findBy("team_id", team.id)
      .flatMap((link) => {
        const repo = gh.repos.get(link.repo_id);
        return repo && canAccessRepo(gh, auth, repo) ? [{ repo, permission: teamRepoPermission(link, team) }] : [];
      })
      .sort((a, b) => a.repo.id - b.repo.id);

    const { page, per_page } = parsePagination(c);
    const total = grants.length;
    const start = (page - 1) * per_page;
    const slice = grants.slice(start, start + per_page);

    setLinkHeader(c, total, page, per_page);
    return c.json(
      slice.map(({ repo, permission }) => ({
        ...formatRepo(repo, gh, baseUrl, repoPermissionFlags(permission)),
        role_name: ROLE_NAMES[permission],
      })),
    );
  });

  app.put("/orgs/:org/teams/:team_slug/repos/:owner/:repo", async (c) => {
    const { auth, org, team, access } = visibleTeam(c, gh, c.req.param("org")!, c.req.param("team_slug")!);
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo || !canAccessRepo(gh, auth, repo)) throw notFound();
    if (!hasTeamRepoAdmin(gh, auth, access, repo)) {
      throw new ApiError(403, "You must have administrative rights on this repository.");
    }
    if (repo.owner_type !== "Organization" || repo.owner_id !== org.id) {
      throw new ApiError(422, "Repository must belong to this organization");
    }

    const body = await parseOptionalJsonBody(c);
    const permission = body.permission === undefined ? team.permission : body.permission;
    if (!isRepoPermissionLevel(permission)) throw new ApiError(422, "Validation Failed");

    const existing = findTeamRepo(gh, team.id, repo.id);
    if (existing) gh.teamRepos.update(existing.id, { permission });
    else gh.teamRepos.insert({ team_id: team.id, repo_id: repo.id, permission });
    return c.body(null, 204);
  });

  app.delete("/orgs/:org/teams/:team_slug/repos/:owner/:repo", (c) => {
    const { auth, team, access } = visibleTeam(c, gh, c.req.param("org")!, c.req.param("team_slug")!);
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo || !canAccessRepo(gh, auth, repo)) throw notFound();
    if (!access.manage && !hasTeamRepoAdmin(gh, auth, access, repo)) {
      throw new ApiError(
        403,
        "You must have administrative rights on a repository or team in order to remove the repository from that team",
      );
    }

    const tr = findTeamRepo(gh, team.id, repo.id);
    if (tr) {
      gh.teamRepos.delete(tr.id);
    }
    return c.body(null, 204);
  });

  app.get("/teams/:team_id", (c) => {
    const team = visibleTeamById(c, c.req.param("team_id"));
    return c.json(formatTeamFull(team, gh, baseUrl));
  });

  app.get("/teams/:team_id/members", (c) => {
    const team = visibleTeamById(c, c.req.param("team_id"));

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
