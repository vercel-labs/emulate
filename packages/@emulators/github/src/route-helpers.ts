import type { AuthUser } from "@emulators/core";
import { ApiError, notFound, unauthorized, forbidden } from "@emulators/core";
import type { GitHubStore } from "./store.js";
import type { GitHubOrg, GitHubRepo, GitHubTeam, GitHubUser } from "./entities.js";
import { generateNodeId } from "./helpers.js";

export { notFound as notFoundResponse };

const MEMBERS_TEAM_SLUG = "members";

/** Effective repository role, in GitHub's `role_name` vocabulary. */
export type RepoRole = "admin" | "maintain" | "write" | "triage" | "read" | "none";

const ROLE_RANK: Record<RepoRole, number> = { none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };

/** Map the permission spellings GitHub uses (collaborator, team, org base) onto a role. */
export function roleFromPermission(permission: string | null | undefined): RepoRole {
  switch (permission) {
    case "admin":
      return "admin";
    case "maintain":
      return "maintain";
    case "push":
    case "write":
      return "write";
    case "triage":
      return "triage";
    case "pull":
    case "read":
      return "read";
    default:
      return "none";
  }
}

/** The legacy `permission` field: admin, write, read or none. */
export function legacyPermission(role: RepoRole): "admin" | "write" | "read" | "none" {
  if (role === "admin") return "admin";
  if (role === "maintain" || role === "write") return "write";
  if (role === "triage" || role === "read") return "read";
  return "none";
}

function higherRole(a: RepoRole, b: RepoRole): RepoRole {
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

export function ownerLoginOf(gh: GitHubStore, repo: GitHubRepo): string {
  if (repo.owner_type === "User") {
    return gh.users.get(repo.owner_id)?.login ?? "unknown";
  }
  return gh.orgs.get(repo.owner_id)?.login ?? "unknown";
}

export function isOrgMember(gh: GitHubStore, userId: number, orgId: number): boolean {
  for (const team of gh.teams.all()) {
    if (team.org_id !== orgId) continue;
    const m = gh.teamMembers.findBy("team_id", team.id).find((x) => x.user_id === userId);
    if (m) return true;
  }
  return false;
}

/**
 * Organization role of a user: `admin` when they maintain any of the org's
 * teams (the emulator represents owners as maintainers), `member` when they
 * belong to one, null when they are not a member. The same reading orgs.ts
 * gives `GET /orgs/:org/memberships/:username`.
 */
export function orgRoleFor(gh: GitHubStore, orgId: number, userId: number): "admin" | "member" | null {
  let role: "admin" | "member" | null = null;
  for (const team of gh.teams.findBy("org_id", orgId)) {
    const membership = gh.teamMembers.findBy("team_id", team.id).find((m) => m.user_id === userId);
    if (!membership) continue;
    if (membership.role === "maintainer") return "admin";
    role = "member";
  }
  return role;
}

/** The implicit `members` team every org membership is recorded in. */
export function ensureMembersTeam(gh: GitHubStore, org: GitHubOrg): GitHubTeam {
  const existing = gh.teams.findBy("org_id", org.id).find((t) => t.slug === MEMBERS_TEAM_SLUG);
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
  return gh.teams.update(team.id, { node_id: generateNodeId("Team", team.id) }) ?? team;
}

/** Make `user` an org member, or an owner as maintainer of the members team. Idempotent. */
export function ensureOrgMembership(gh: GitHubStore, org: GitHubOrg, user: GitHubUser, role: "admin" | "member"): void {
  const team = ensureMembersTeam(gh, org);
  const teamRole: "member" | "maintainer" = role === "admin" ? "maintainer" : "member";
  const existing = gh.teamMembers.findBy("team_id", team.id).find((m) => m.user_id === user.id);
  if (existing) {
    if (existing.role !== teamRole) gh.teamMembers.update(existing.id, { role: teamRole });
  } else {
    gh.teamMembers.insert({ team_id: team.id, user_id: user.id, role: teamRole });
  }
  gh.teams.update(team.id, { members_count: gh.teamMembers.findBy("team_id", team.id).length });
}

/**
 * What `user` may do on `repo`, resolved the way GitHub does: the owner of a
 * user repo and the owners of an organization hold admin; an organization
 * member starts from the org's base permission (`default_repository_permission`,
 * which may be `none`); direct collaborator and team grants raise it; anyone
 * else has no access to a private repo and read on a public one.
 */
export function repoRoleFor(gh: GitHubStore, user: GitHubUser, repo: GitHubRepo): RepoRole {
  if (repo.owner_type === "User") {
    if (repo.owner_id === user.id) return "admin";
    const collab = gh.collaborators.findBy("repo_id", repo.id).find((c) => c.user_id === user.id);
    if (collab) return roleFromPermission(collab.permission);
    return repo.private ? "none" : "read";
  }

  const orgRole = orgRoleFor(gh, repo.owner_id, user.id);
  if (orgRole === "admin") return "admin";

  let role: RepoRole = "none";
  if (orgRole === "member") {
    role = roleFromPermission(gh.orgs.get(repo.owner_id)?.default_repository_permission);
  }
  const collab = gh.collaborators.findBy("repo_id", repo.id).find((c) => c.user_id === user.id);
  if (collab) role = higherRole(role, roleFromPermission(collab.permission));
  for (const membership of gh.teamMembers.findBy("user_id", user.id)) {
    const team = gh.teams.get(membership.team_id);
    if (!team || team.org_id !== repo.owner_id || team.slug === MEMBERS_TEAM_SLUG) continue;
    if (gh.teamRepos.findBy("team_id", team.id).some((link) => link.repo_id === repo.id)) {
      role = higherRole(role, roleFromPermission(team.permission));
    }
  }
  if (role === "none" && !repo.private) return "read";
  return role;
}

export function getActorUser(gh: GitHubStore, authUser: AuthUser): GitHubUser | undefined {
  return gh.users.findOneBy("login", authUser.login);
}

export function installationCanAccessRepo(authUser: AuthUser, repo: GitHubRepo): boolean {
  const installation = authUser.installation;
  if (!installation) return false;
  if (repo.owner_id !== installation.accountId || repo.owner_type !== installation.accountType) return false;
  return installation.repositorySelection === "all" || installation.repositoryIds.includes(repo.id);
}

/**
 * Whether an installation token acts for `owner` with `permission` granted at
 * write. A GitHub App manages the account it is installed on through its
 * permission set, not through membership: `administration: write` creates
 * repositories and manages collaborators there, `members: write` manages
 * organization membership.
 */
export function installationAdministers(
  authUser: AuthUser | undefined,
  ownerId: number,
  ownerType: "User" | "Organization",
  permission = "administration",
): boolean {
  const installation = authUser?.installation;
  if (!installation) return false;
  return (
    installation.accountId === ownerId &&
    installation.accountType === ownerType &&
    installation.permissions[permission] === "write"
  );
}

function installationActor(gh: GitHubStore, authUser: AuthUser): GitHubUser {
  const installation = authUser.installation!;
  const app = gh.apps.findOneBy("app_id", installation.appId);
  const login = `${app?.slug ?? `app-${installation.appId}`}[bot]`;
  const existing = gh.users.findOneBy("login", login);
  if (existing) return existing;

  const actor = gh.users.insert({
    login,
    node_id: "",
    avatar_url: "",
    gravatar_id: "",
    type: "Bot",
    site_admin: false,
    name: app?.name ?? "GitHub App",
    company: null,
    blog: "",
    location: null,
    email: `${installation.appId}+${login}@users.noreply.github.com`,
    hireable: null,
    bio: null,
    twitter_username: null,
    public_repos: 0,
    public_gists: 0,
    followers: 0,
    following: 0,
  });
  gh.users.update(actor.id, { node_id: generateNodeId("Bot", actor.id) });
  return gh.users.get(actor.id)!;
}

export function canAccessRepo(gh: GitHubStore, authUser: AuthUser | undefined, repo: GitHubRepo): boolean {
  if (!repo.private) return true;
  if (!authUser) return false;
  if (authUser.installation) return installationCanAccessRepo(authUser, repo);
  const user = getActorUser(gh, authUser);
  if (!user) return false;
  return repoRoleFor(gh, user, repo) !== "none";
}

export function assertRepoRead(gh: GitHubStore, authUser: AuthUser | undefined, repo: GitHubRepo): void {
  if (canAccessRepo(gh, authUser, repo)) return;
  if (!authUser) throw unauthorized();
  throw forbidden();
}

function hasInstallationPermission(authUser: AuthUser, permissions: string[], required: "read" | "write"): boolean {
  const requiredRank = required === "write" ? 2 : 1;
  return permissions.some((name) => {
    const granted = authUser.installation?.permissions[name];
    const grantedRank = granted === "write" ? 2 : granted === "read" ? 1 : 0;
    return grantedRank >= requiredRank;
  });
}

function canAccessRepoWithPermission(
  gh: GitHubStore,
  authUser: AuthUser | undefined,
  repo: GitHubRepo,
  permissions: string[],
  required: "read" | "write",
): boolean {
  if (required === "write" && authUser?.installation && !installationCanAccessRepo(authUser, repo)) return false;
  if (!canAccessRepo(gh, authUser, repo)) return false;
  if (required === "write" && !authUser) return false;
  if (!authUser?.installation || (!repo.private && required === "read")) return true;
  return hasInstallationPermission(authUser, permissions, required);
}

export function assertRepoPermission(
  gh: GitHubStore,
  authUser: AuthUser | undefined,
  repo: GitHubRepo,
  permissions: string | string[],
  required: "read" | "write" = "read",
): void {
  const accepted = Array.isArray(permissions) ? permissions : [permissions];
  if (!canAccessRepoWithPermission(gh, authUser, repo, accepted, required)) {
    if (!authUser) throw unauthorized();
    throw forbidden();
  }
}

export function canReadRepoContents(gh: GitHubStore, authUser: AuthUser | undefined, repo: GitHubRepo): boolean {
  return canAccessRepoWithPermission(gh, authUser, repo, ["contents"], "read");
}

export function assertRepoContentsRead(gh: GitHubStore, authUser: AuthUser | undefined, repo: GitHubRepo): void {
  assertRepoPermission(gh, authUser, repo, "contents");
}

export function assertAuthenticatedUser(gh: GitHubStore, authUser: AuthUser | undefined): GitHubUser {
  if (!authUser) throw unauthorized();
  const user = getActorUser(gh, authUser);
  if (!user) throw unauthorized();
  return user;
}

export function assertAuthenticatedActor(gh: GitHubStore, authUser: AuthUser | undefined): GitHubUser {
  if (!authUser) throw unauthorized();
  if (authUser.installation) return installationActor(gh, authUser);
  return assertAuthenticatedUser(gh, authUser);
}

/** Admin or maintain on the repo: organization owners, not every member. */
export function hasRepoAdmin(gh: GitHubStore, user: GitHubUser, repo: GitHubRepo): boolean {
  const role = repoRoleFor(gh, user, repo);
  return role === "admin" || role === "maintain";
}

function grantsRepoWrite(permission: string): boolean {
  return permission === "push" || permission === "write" || permission === "maintain" || permission === "admin";
}

export function hasRepoContentsWrite(gh: GitHubStore, user: GitHubUser, repo: GitHubRepo): boolean {
  if (repo.owner_type === "User" && repo.owner_id === user.id) return true;

  const collaborator = gh.collaborators.findBy("repo_id", repo.id).find((c) => c.user_id === user.id);
  if (collaborator && grantsRepoWrite(collaborator.permission)) return true;

  if (repo.owner_type !== "Organization") return false;
  const memberships = gh.teamMembers.findBy("user_id", user.id).filter((membership) => {
    return gh.teams.get(membership.team_id)?.org_id === repo.owner_id;
  });
  if (!memberships.length) return false;

  // Organization administrators are represented as maintainers of the members team by the emulator.
  const isOrgAdmin = memberships.some((membership) => {
    const team = gh.teams.get(membership.team_id);
    return team?.slug === "members" && membership.role === "maintainer";
  });
  if (isOrgAdmin) return true;

  const org = gh.orgs.get(repo.owner_id);
  if (org && grantsRepoWrite(org.default_repository_permission)) return true;

  return memberships.some((membership) => {
    const team = gh.teams.get(membership.team_id);
    if (!team || !grantsRepoWrite(team.permission)) return false;
    return gh.teamRepos.findBy("team_id", team.id).some((link) => link.repo_id === repo.id);
  });
}

export function assertRepoContentsWrite(gh: GitHubStore, authUser: AuthUser | undefined, repo: GitHubRepo): GitHubUser {
  if (authUser?.installation) {
    if (!installationCanAccessRepo(authUser, repo)) throw forbidden();
    if (authUser.installation.permissions.contents !== "write") throw forbidden();
    if (repo.archived) throw new ApiError(403, "Repository was archived so is read-only.");
    return installationActor(gh, authUser);
  }
  const user = assertAuthenticatedUser(gh, authUser);
  if (!hasRepoContentsWrite(gh, user, repo)) throw forbidden();
  if (repo.archived) throw new ApiError(403, "Repository was archived so is read-only.");
  return user;
}

function hasBranchProtectionBypass(gh: GitHubStore, user: GitHubUser, repo: GitHubRepo): boolean {
  if (user.site_admin) return true;
  if (repo.owner_type === "User") return repo.owner_id === user.id;

  const isOrgAdmin = gh.teamMembers.findBy("user_id", user.id).some((membership) => {
    const team = gh.teams.get(membership.team_id);
    return team?.org_id === repo.owner_id && team.slug === "members" && membership.role === "maintainer";
  });
  if (isOrgAdmin) return true;

  return gh.collaborators
    .findBy("repo_id", repo.id)
    .some((collaborator) => collaborator.user_id === user.id && collaborator.permission === "admin");
}

function branchRestrictionsAllow(
  gh: GitHubStore,
  user: GitHubUser,
  repo: GitHubRepo,
  users: string[],
  teams: string[],
) {
  const login = user.login.toLowerCase();
  if (users.some((allowed) => allowed.toLowerCase() === login)) return true;
  if (repo.owner_type !== "Organization") return false;

  const allowedTeams = new Set(teams.map((team) => team.toLowerCase()));
  return gh.teamMembers.findBy("user_id", user.id).some((membership) => {
    const team = gh.teams.get(membership.team_id);
    return team?.org_id === repo.owner_id && allowedTeams.has(team.slug.toLowerCase());
  });
}

function introducedRangeContainsMerge(gh: GitHubStore, repoId: number, currentSha: string, targetSha: string): boolean {
  const commits = new Map(gh.commits.findBy("repo_id", repoId).map((commit) => [commit.sha, commit]));
  const currentReachable = new Set<string>();
  const currentStack = [currentSha];
  while (currentStack.length) {
    const sha = currentStack.pop()!;
    if (currentReachable.has(sha)) continue;
    currentReachable.add(sha);
    const commit = commits.get(sha);
    if (commit) currentStack.push(...commit.parent_shas);
  }

  const visited = new Set<string>();
  const targetStack = [targetSha];
  while (targetStack.length) {
    const sha = targetStack.pop()!;
    if (visited.has(sha) || currentReachable.has(sha)) continue;
    visited.add(sha);
    const commit = commits.get(sha);
    if (!commit) continue;
    if (commit.parent_shas.length > 1) return true;
    targetStack.push(...commit.parent_shas);
  }
  return false;
}

export function assertBranchUpdateAllowed(
  gh: GitHubStore,
  user: GitHubUser,
  repo: GitHubRepo,
  branchName: string,
  options: { force?: boolean; parentCount?: number; deletion?: boolean; currentSha?: string; targetSha?: string } = {},
): void {
  const protection = gh.branchProtections
    .findBy("repo_id", repo.id)
    .find((candidate) => candidate.branch_name === branchName);
  if (!protection) return;
  if (hasBranchProtectionBypass(gh, user, repo) && !protection.enforce_admins) return;

  const restricted =
    protection.restrictions &&
    !branchRestrictionsAllow(gh, user, repo, protection.restrictions.users, protection.restrictions.teams);
  const blockedDeletion = options.deletion === true && !protection.allow_deletions;
  const requiredContexts = protection.required_status_checks?.contexts ?? [];
  const successfulConclusions = new Set(["success", "neutral", "skipped"]);
  const requiredChecksPassed = requiredContexts.every((context) => {
    if (!options.targetSha) return false;
    const latest = gh.checkRuns
      .findBy("repo_id", repo.id)
      .filter((run) => run.head_sha === options.targetSha && run.name === context)
      .sort((left, right) => {
        if (left.updated_at !== right.updated_at) return right.updated_at.localeCompare(left.updated_at);
        return right.id - left.id;
      })[0];
    return latest?.status === "completed" && latest.conclusion !== null && successfulConclusions.has(latest.conclusion);
  });
  const requirementsBlockDirectUpdate =
    options.deletion !== true &&
    (protection.required_pull_request_reviews !== null ||
      (requiredContexts.length > 0 && !requiredChecksPassed) ||
      protection.required_signatures);
  const invalidHistory =
    options.deletion !== true &&
    protection.required_linear_history &&
    (options.currentSha && options.targetSha
      ? introducedRangeContainsMerge(gh, repo.id, options.currentSha, options.targetSha)
      : (options.parentCount ?? 1) > 1);
  const blockedForcePush = options.deletion !== true && options.force === true && !protection.allow_force_pushes;

  if (restricted || blockedDeletion || requirementsBlockDirectUpdate || invalidHistory || blockedForcePush) {
    throw new ApiError(409, `Protected branch update failed for refs/heads/${branchName}.`);
  }
}

/**
 * Resolve the actor allowed to administer `repo` (collaborators, protection,
 * settings): an installation on the owner with `administration: write` and
 * access to the repo, or a user holding admin or maintain on it.
 */
export function assertRepoAdmin(gh: GitHubStore, authUser: AuthUser | undefined, repo: GitHubRepo): GitHubUser {
  if (!authUser) throw unauthorized();
  if (authUser.installation) {
    if (!installationCanAccessRepo(authUser, repo)) throw forbidden();
    if (!installationAdministers(authUser, repo.owner_id, repo.owner_type)) throw forbidden();
    return installationActor(gh, authUser);
  }
  const user = getActorUser(gh, authUser);
  if (!user) throw unauthorized();
  if (hasRepoAdmin(gh, user, repo)) return user;
  throw forbidden();
}

/**
 * Resolve the actor allowed to create a repository owned by `owner`: an
 * installation on that account with `administration: write`, the user for
 * their own account, or an organization member for the org.
 */
export function assertCanCreateRepoIn(
  gh: GitHubStore,
  authUser: AuthUser | undefined,
  owner: { type: "User" | "Organization"; id: number },
): GitHubUser {
  if (!authUser) throw unauthorized();
  if (authUser.installation) {
    if (!installationAdministers(authUser, owner.id, owner.type)) throw forbidden();
    return installationActor(gh, authUser);
  }
  const user = assertAuthenticatedUser(gh, authUser);
  if (owner.type === "User") {
    if (owner.id !== user.id) throw forbidden();
    return user;
  }
  if (!isOrgMember(gh, user.id, owner.id)) throw forbidden();
  return user;
}

export function assertRepoWrite(gh: GitHubStore, authUser: AuthUser | undefined, repo: GitHubRepo): GitHubUser {
  const user = assertAuthenticatedUser(gh, authUser);
  if (!repo.private) return user;
  if (!canAccessRepo(gh, authUser, repo)) throw forbidden();
  return user;
}

export function assertIssueWrite(gh: GitHubStore, authUser: AuthUser | undefined, repo: GitHubRepo): GitHubUser {
  const user = assertAuthenticatedUser(gh, authUser);
  if (!repo.private) return user;
  if (!canAccessRepo(gh, authUser, repo)) throw forbidden();
  return user;
}
