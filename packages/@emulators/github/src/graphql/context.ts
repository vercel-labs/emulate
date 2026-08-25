import type { AuthUser, Context, Store, AppEnv } from "@emulators/core";
import { assertRepoPermission, canAccessRepo } from "../route-helpers.js";
import { getGitHubStore, type GitHubStore } from "../store.js";
import type { GitHubComment, GitHubIssue, GitHubLabel, GitHubRepo } from "../entities.js";
import { lookupRepo } from "../helpers.js";
import { unauthorized } from "@emulators/core";

export interface GitHubGraphQLContext {
  store: Store;
  gh: GitHubStore;
  c: Context<AppEnv>;
  baseUrl: string;
  authUser: AuthUser | undefined;
}

export function createGitHubGraphQLContext(store: Store, c: Context<AppEnv>, baseUrl: string): GitHubGraphQLContext {
  return {
    store,
    gh: getGitHubStore(store),
    c,
    baseUrl,
    authUser: c.get("authUser"),
  };
}

export function requireGitHubGraphQLAuth(context: GitHubGraphQLContext): AuthUser {
  if (!context.authUser) throw unauthorized();
  return context.authUser;
}

/** Repository visibility is intentionally shared with the existing REST API. */
export function canReadRepository(context: GitHubGraphQLContext, repo: GitHubRepo): boolean {
  requireGitHubGraphQLAuth(context);
  return canAccessRepo(context.gh, context.authUser, repo);
}

/**
 * Issue reads use the existing REST issue permission helper. Inaccessible
 * records are concealed as null by GraphQL rather than leaking a 403/404.
 */
export function canReadIssues(context: GitHubGraphQLContext, repo: GitHubRepo): boolean {
  if (!canReadRepository(context, repo) || !repo.has_issues) return false;
  try {
    assertRepoPermission(context.gh, context.authUser, repo, "issues");
    return true;
  } catch {
    return false;
  }
}

export function findVisibleRepository(
  context: GitHubGraphQLContext,
  owner: string,
  name: string,
): GitHubRepo | undefined {
  const repo = lookupRepo(context.gh, owner, name);
  return repo && canReadRepository(context, repo) ? repo : undefined;
}

export function findVisibleIssue(
  context: GitHubGraphQLContext,
  repo: GitHubRepo,
  issueNumber: number,
): GitHubIssue | undefined {
  if (!canReadIssues(context, repo)) return undefined;
  return context.gh.issues
    .findBy("repo_id", repo.id)
    .find((issue) => issue.number === issueNumber && !issue.is_pull_request);
}

export function findVisibleIssueComment(
  context: GitHubGraphQLContext,
  comment: GitHubComment,
): { comment: GitHubComment; issue: GitHubIssue; repo: GitHubRepo } | undefined {
  if (comment.comment_type !== "issue" || comment.issue_number === null) return undefined;
  const repo = context.gh.repos.get(comment.repo_id);
  if (!repo || !canReadIssues(context, repo)) return undefined;
  const issue = context.gh.issues
    .findBy("repo_id", repo.id)
    .find((candidate) => candidate.number === comment.issue_number && !candidate.is_pull_request);
  return issue ? { comment, issue, repo } : undefined;
}

export type ResolvedGitHubGraphQLNode =
  | { kind: "Repository"; repo: GitHubRepo }
  | { kind: "Issue"; issue: GitHubIssue; repo: GitHubRepo }
  | { kind: "Label"; label: GitHubLabel; repo: GitHubRepo }
  | { kind: "IssueComment"; comment: GitHubComment; issue: GitHubIssue; repo: GitHubRepo };

/** Resolve only the four node types promised by issue #2. */
export function resolveVisibleNode(
  context: GitHubGraphQLContext,
  nodeId: string,
): ResolvedGitHubGraphQLNode | undefined {
  requireGitHubGraphQLAuth(context);

  const repo = context.gh.repos.all().find((candidate) => candidate.node_id === nodeId);
  if (repo) return canReadRepository(context, repo) ? { kind: "Repository", repo } : undefined;

  const issue = context.gh.issues.all().find((candidate) => candidate.node_id === nodeId && !candidate.is_pull_request);
  if (issue) {
    const issueRepo = context.gh.repos.get(issue.repo_id);
    return issueRepo && canReadIssues(context, issueRepo) ? { kind: "Issue", issue, repo: issueRepo } : undefined;
  }

  const label = context.gh.labels.all().find((candidate) => candidate.node_id === nodeId);
  if (label) {
    const labelRepo = context.gh.repos.get(label.repo_id);
    return labelRepo && canReadIssues(context, labelRepo) ? { kind: "Label", label, repo: labelRepo } : undefined;
  }

  const comment = context.gh.comments.all().find((candidate) => candidate.node_id === nodeId);
  if (comment) {
    const visible = findVisibleIssueComment(context, comment);
    return visible ? { kind: "IssueComment", ...visible } : undefined;
  }

  return undefined;
}
