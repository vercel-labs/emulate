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
    const m = gh.teamMembers
      .findBy("team_id", team.id)
      .find((x) => x.user_id === userId);
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
  return Boolean(
    gh.collaborators.findBy("repo_id", repo.id).find((c) => c.user_id === user.id)
  );
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
  const collab = gh.collaborators
    .findBy("repo_id", repo.id)
    .find((c) => c.user_id === user.id);
  return collab?.permission === "admin" || collab?.permission === "maintain";
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
