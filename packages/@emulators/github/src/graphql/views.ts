import type { GraphQLConnectionArgs } from "./pagination.js";
import { connectionFromArray } from "./pagination.js";
import type { GitHubComment, GitHubIssue, GitHubLabel, GitHubRepo, GitHubUser } from "../entities.js";
import type { GitHubGraphQLContext, ResolvedGitHubGraphQLNode } from "./context.js";
import { findVisibleIssue, findVisibleIssueComment } from "./context.js";

type GraphQLActorView = {
  __typename: "User" | "Organization" | "Bot";
  id: string;
  login: string;
  name: string | null;
};

function actorView(user: GitHubUser | undefined): GraphQLActorView | null {
  if (!user) return null;
  const typename = user.type === "Organization" ? "Organization" : user.type === "Bot" ? "Bot" : "User";
  return {
    __typename: typename,
    id: user.node_id,
    login: user.login,
    name: user.name,
  };
}

function repositoryOwnerView(context: GitHubGraphQLContext, repo: GitHubRepo): GraphQLActorView | null {
  if (repo.owner_type === "Organization") {
    const org = context.gh.orgs.get(repo.owner_id);
    if (!org) return null;
    return {
      __typename: "Organization",
      id: org.node_id,
      login: org.login,
      name: org.name,
    };
  }
  return actorView(context.gh.users.get(repo.owner_id));
}

function stateReasonValue(
  issue: GitHubIssue,
  enableDuplicate: boolean,
): "COMPLETED" | "DUPLICATE" | "NOT_PLANNED" | "REOPENED" | null {
  const stateReason = issue.state_reason as string | null;
  if (stateReason === null) return null;
  if (stateReason === "duplicate") return enableDuplicate ? "DUPLICATE" : null;
  return stateReason === "completed"
    ? "COMPLETED"
    : stateReason === "not_planned"
      ? "NOT_PLANNED"
      : stateReason === "reopened"
        ? "REOPENED"
        : null;
}

function issueStateValue(issue: GitHubIssue): "OPEN" | "CLOSED" {
  return issue.state === "open" ? "OPEN" : "CLOSED";
}

export function repositoryView(context: GitHubGraphQLContext, repo: GitHubRepo) {
  return {
    __typename: "Repository" as const,
    id: repo.node_id,
    name: repo.name,
    nameWithOwner: repo.full_name,
    url: `${context.baseUrl}/${repo.full_name}`,
    isPrivate: repo.private,
    owner: repositoryOwnerView(context, repo),
    issue: ({ number }: { number: number }) => {
      const issue = findVisibleIssue(context, repo, number);
      return issue ? issueView(context, issue, repo) : null;
    },
    label: ({ name }: { name: string }) => {
      if (!name || !repo.has_issues) return null;
      const label = context.gh.labels.findBy("repo_id", repo.id).find((candidate) => candidate.name === name);
      return label ? labelView(context, label, repo) : null;
    },
  };
}

export function issueView(context: GitHubGraphQLContext, issue: GitHubIssue, repo?: GitHubRepo) {
  const issueRepo = repo ?? context.gh.repos.get(issue.repo_id);
  if (!issueRepo) return null;

  return {
    __typename: "Issue" as const,
    id: issue.node_id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issueStateValue(issue),
    stateReason: ({ enableDuplicate }: { enableDuplicate?: boolean } = {}) =>
      stateReasonValue(issue, enableDuplicate ?? false),
    repository: repositoryView(context, issueRepo),
    author: actorView(context.gh.users.get(issue.user_id)),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    url: `${context.baseUrl}/${issueRepo.full_name}/issues/${issue.number}`,
    comments: (args: GraphQLConnectionArgs = {}) => {
      const comments = context.gh.comments
        .findBy("repo_id", issueRepo.id)
        .filter((comment) => comment.comment_type === "issue" && comment.issue_number === issue.number)
        .sort((left, right) => {
          const byTime = left.created_at.localeCompare(right.created_at);
          return byTime !== 0 ? byTime : left.id - right.id;
        });
      const connection = connectionFromArray(
        comments.map((comment) => issueCommentView(context, comment, issue, issueRepo)),
        args,
        `issue-comments:${issue.node_id}`,
      );
      return connection;
    },
  };
}

export function labelView(context: GitHubGraphQLContext, label: GitHubLabel, repo?: GitHubRepo) {
  const labelRepo = repo ?? context.gh.repos.get(label.repo_id);
  if (!labelRepo) return null;
  return {
    __typename: "Label" as const,
    id: label.node_id,
    name: label.name,
    description: label.description,
    color: label.color,
    repository: repositoryView(context, labelRepo),
  };
}

export function issueCommentView(
  context: GitHubGraphQLContext,
  comment: GitHubComment,
  issue?: GitHubIssue,
  repo?: GitHubRepo,
) {
  const visible = issue && repo ? { comment, issue, repo } : findVisibleIssueComment(context, comment);
  if (!visible) return null;
  return {
    __typename: "IssueComment" as const,
    id: comment.node_id,
    body: comment.body,
    author: actorView(context.gh.users.get(comment.user_id)),
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    issue: issueView(context, visible.issue, visible.repo),
    repository: repositoryView(context, visible.repo),
  };
}

export function resolvedNodeView(
  context: GitHubGraphQLContext,
  node: ResolvedGitHubGraphQLNode,
):
  | ReturnType<typeof repositoryView>
  | ReturnType<typeof issueView>
  | ReturnType<typeof labelView>
  | ReturnType<typeof issueCommentView> {
  switch (node.kind) {
    case "Repository":
      return repositoryView(context, node.repo);
    case "Issue":
      return issueView(context, node.issue, node.repo);
    case "Label":
      return labelView(context, node.label, node.repo);
    case "IssueComment":
      return issueCommentView(context, node.comment, node.issue, node.repo);
  }
}
