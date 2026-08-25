import { ApiError } from "@emulators/core";
import type { GitHubComment, GitHubIssue, GitHubRepo, GitHubUser } from "../entities.js";
import { formatComment, formatIssue, formatRepo, formatUser, generateNodeId } from "../helpers.js";
import { ownerLoginOf } from "../route-helpers.js";
import { dispatchGitHubWebhook, type GitHubMutationContext } from "./common.js";

export interface CreateIssueCommentInput {
  repo: GitHubRepo;
  issue: GitHubIssue;
  actor: GitHubUser;
  body: unknown;
}

export interface CreateIssueCommentResult {
  comment: GitHubComment;
  issue: GitHubIssue;
}

export function createIssueComment(
  context: GitHubMutationContext,
  input: CreateIssueCommentInput,
): CreateIssueCommentResult {
  if (input.issue.repo_id !== input.repo.id || input.issue.is_pull_request) {
    throw new ApiError(404, "Not Found");
  }
  if (typeof input.body !== "string" || !input.body.trim()) {
    throw new ApiError(422, "Validation failed");
  }

  const currentIssue = context.gh.issues.get(input.issue.id);
  if (!currentIssue || currentIssue.repo_id !== input.repo.id || currentIssue.is_pull_request) {
    throw new ApiError(404, "Not Found");
  }

  const row = context.gh.comments.insert({
    node_id: "",
    repo_id: input.repo.id,
    issue_number: currentIssue.number,
    pull_number: null,
    commit_sha: null,
    body: input.body,
    user_id: input.actor.id,
    in_reply_to_id: null,
    path: null,
    position: null,
    line: null,
    side: null,
    subject_type: null,
    comment_type: "issue",
    review_id: null,
  } as Omit<GitHubComment, "id" | "created_at" | "updated_at">);
  context.gh.comments.update(row.id, { node_id: generateNodeId("IssueComment", row.id) });
  const comment = context.gh.comments.get(row.id)!;
  const updatedIssue = context.gh.issues.update(currentIssue.id, { comments: currentIssue.comments + 1 })!;

  const ownerLogin = ownerLoginOf(context.gh, input.repo);
  dispatchGitHubWebhook(
    context,
    "issue_comment",
    "created",
    {
      action: "created",
      comment: formatComment(comment, context.gh, context.baseUrl),
      issue: formatIssue(updatedIssue, context.gh, context.baseUrl),
      repository: formatRepo(input.repo, context.gh, context.baseUrl),
      sender: formatUser(input.actor, context.baseUrl),
    },
    ownerLogin,
    input.repo.name,
  );

  return { comment, issue: updatedIssue };
}
