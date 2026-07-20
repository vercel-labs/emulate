import type { AuthUser } from "@emulators/core";
import { ApiError, notFound, unauthorized, forbidden } from "@emulators/core";
import type { GitHubStore } from "./store.js";
import type { GitHubRepo, GitHubUser } from "./entities.js";
import { generateNodeId } from "./helpers.js";

export { notFound as notFoundResponse };

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

export function getActorUser(gh: GitHubStore, authUser: AuthUser): GitHubUser | undefined {
  return gh.users.findOneBy("login", authUser.login);
}

function installationCanAccessRepo(authUser: AuthUser, repo: GitHubRepo): boolean {
  const installation = authUser.installation;
  if (!installation) return false;
  if (repo.owner_id !== installation.accountId || repo.owner_type !== installation.accountType) return false;
  return installation.repositorySelection === "all" || installation.repositoryIds.includes(repo.id);
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
  if (repo.owner_type === "User" && repo.owner_id === user.id) return true;
  if (repo.owner_type === "Organization" && isOrgMember(gh, user.id, repo.owner_id)) return true;
  return Boolean(gh.collaborators.findBy("repo_id", repo.id).find((c) => c.user_id === user.id));
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

export function hasRepoAdmin(gh: GitHubStore, user: GitHubUser, repo: GitHubRepo): boolean {
  if (repo.owner_type === "User" && repo.owner_id === user.id) return true;
  if (repo.owner_type === "Organization" && isOrgMember(gh, user.id, repo.owner_id)) return true;
  const collab = gh.collaborators.findBy("repo_id", repo.id).find((c) => c.user_id === user.id);
  return collab?.permission === "admin" || collab?.permission === "maintain";
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

export function assertRepoAdmin(gh: GitHubStore, authUser: AuthUser | undefined, repo: GitHubRepo): GitHubUser {
  if (!authUser) throw unauthorized();
  const user = getActorUser(gh, authUser);
  if (!user) throw unauthorized();
  if (hasRepoAdmin(gh, user, repo)) return user;
  throw forbidden();
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
