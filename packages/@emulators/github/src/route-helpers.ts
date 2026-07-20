import type { AuthUser } from "@emulators/core";
import { notFound, unauthorized, forbidden } from "@emulators/core";
import type { GitHubStore } from "./store.js";
import type { GitHubRepo, GitHubUser } from "./entities.js";

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

export function canAccessRepo(gh: GitHubStore, authUser: AuthUser | undefined, repo: GitHubRepo): boolean {
  if (!repo.private) return true;
  if (!authUser) return false;
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

export function assertAuthenticatedUser(gh: GitHubStore, authUser: AuthUser | undefined): GitHubUser {
  if (!authUser) throw unauthorized();
  const user = getActorUser(gh, authUser);
  if (!user) throw unauthorized();
  return user;
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
  const user = assertAuthenticatedUser(gh, authUser);
  if (hasRepoContentsWrite(gh, user, repo)) return user;
  throw forbidden();
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
