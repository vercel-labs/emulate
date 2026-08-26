import { ApiError } from "@emulators/core";
import type { GitHubIssue, GitHubRepo, GitHubUser } from "../entities.js";
import { formatIssue, formatRepo, formatUser, generateNodeId, getNextIssueNumber, timestamp } from "../helpers.js";
import { ownerLoginOf } from "../route-helpers.js";
import { adjustRepoOpenIssues, dispatchGitHubWebhook, insertIssueEvent, type GitHubMutationContext } from "./common.js";
import { applyIssueLabelPlan, planIssueLabelReferences } from "./labels.js";
import { normalizeSubIssuePositions } from "../issue-relationships.js";

export interface CreateIssueInput {
  repo: GitHubRepo;
  actor: GitHubUser;
  title: unknown;
  body?: unknown;
  assigneeIds?: unknown;
  labels?: unknown;
  milestoneId?: unknown;
}

export function createIssue(context: GitHubMutationContext, input: CreateIssueInput): GitHubIssue {
  if (typeof input.title !== "string" || !input.title.trim()) {
    throw new ApiError(422, "Validation failed");
  }

  const issueBody =
    input.body === undefined
      ? null
      : typeof input.body === "string" || input.body === null
        ? (input.body as string | null)
        : null;

  const assigneeIds = input.assigneeIds === undefined ? [] : input.assigneeIds;
  if (!Array.isArray(assigneeIds) || assigneeIds.some((id) => typeof id !== "number" || !Number.isFinite(id))) {
    throw new ApiError(422, "Validation failed");
  }
  for (const id of assigneeIds) {
    if (!context.gh.users.get(id)) throw new ApiError(422, "Validation failed");
  }

  let milestoneId: number | null = null;
  if (input.milestoneId !== undefined && input.milestoneId !== null) {
    if (typeof input.milestoneId !== "number" || !Number.isFinite(input.milestoneId)) {
      throw new ApiError(422, "Validation failed");
    }
    const milestone = context.gh.milestones.get(input.milestoneId);
    if (!milestone || milestone.repo_id !== input.repo.id) throw new ApiError(422, "Validation failed");
    milestoneId = input.milestoneId;
  }

  const labelPlan = planIssueLabelReferences(context.gh, input.repo, input.labels);
  const issueNumber = getNextIssueNumber(context.gh, input.repo.id);
  const labelIds = applyIssueLabelPlan(context.gh, input.repo, labelPlan);

  const row = context.gh.issues.insert({
    node_id: "",
    number: issueNumber,
    repo_id: input.repo.id,
    title: input.title.trim(),
    body: issueBody,
    state: "open",
    state_reason: null,
    duplicate_issue_id: null,
    locked: false,
    active_lock_reason: null,
    user_id: input.actor.id,
    assignee_ids: [...assigneeIds],
    label_ids: labelIds,
    milestone_id: milestoneId,
    comments: 0,
    closed_at: null,
    closed_by_id: null,
    is_pull_request: false,
  } as Omit<GitHubIssue, "id" | "created_at" | "updated_at">);
  context.gh.issues.update(row.id, { node_id: generateNodeId("Issue", row.id) });
  const issue = context.gh.issues.get(row.id)!;

  adjustRepoOpenIssues(context.gh, input.repo.id, 1);
  insertIssueEvent(context.gh, input.repo, issue.number, "opened", input.actor.id);

  const ownerLogin = ownerLoginOf(context.gh, input.repo);
  dispatchGitHubWebhook(
    context,
    "issues",
    "opened",
    {
      action: "opened",
      issue: formatIssue(issue, context.gh, context.baseUrl),
      repository: formatRepo(input.repo, context.gh, context.baseUrl),
      sender: formatUser(input.actor, context.baseUrl),
    },
    ownerLogin,
    input.repo.name,
  );

  return issue;
}

export interface DeleteIssueInput {
  repo: GitHubRepo;
  issue: GitHubIssue;
}

/** Delete an issue and all records that are incident to its identity. */
export function deleteIssue(context: GitHubMutationContext, input: DeleteIssueInput): GitHubIssue {
  const current = context.gh.issues.get(input.issue.id);
  if (!current || current.repo_id !== input.repo.id || current.is_pull_request) {
    throw new ApiError(404, "Not Found");
  }

  const issueId = current.id;
  const issueNumber = current.number;
  for (const comment of context.gh.comments.findBy("repo_id", input.repo.id)) {
    if (comment.comment_type === "issue" && comment.issue_number === issueNumber) {
      context.gh.comments.delete(comment.id);
    }
  }
  for (const event of context.gh.issueEvents.findBy("repo_id", input.repo.id)) {
    if (event.issue_number === issueNumber) context.gh.issueEvents.delete(event.id);
  }
  const parentsToNormalize = new Set<number>();
  for (const relation of context.gh.issueSubIssues.all()) {
    if (relation.parent_issue_id === issueId || relation.child_issue_id === issueId) {
      if (relation.parent_issue_id !== issueId) parentsToNormalize.add(relation.parent_issue_id);
      context.gh.issueSubIssues.delete(relation.id);
    }
  }
  for (const parentId of parentsToNormalize) normalizeSubIssuePositions(context.gh, parentId);
  for (const relation of context.gh.issueDependencies.all()) {
    if (relation.blocked_issue_id === issueId || relation.blocking_issue_id === issueId) {
      context.gh.issueDependencies.delete(relation.id);
    }
  }
  for (const other of context.gh.issues.all()) {
    if (other.id !== issueId && other.duplicate_issue_id === issueId) {
      context.gh.issues.update(other.id, { duplicate_issue_id: null });
    }
  }
  if (current.state === "open") adjustRepoOpenIssues(context.gh, input.repo.id, -1);
  if (!context.gh.issues.delete(issueId)) throw new ApiError(404, "Not Found");
  return current;
}

export interface TransitionIssueLifecycleInput {
  repo: GitHubRepo;
  issue: GitHubIssue;
  actor: GitHubUser;
  state: "open" | "closed";
  stateReason?: GitHubIssue["state_reason"];
  duplicateIssue?: GitHubIssue | null;
  patch?: Partial<GitHubIssue>;
}

export interface TransitionIssueLifecycleResult {
  issue: GitHubIssue;
  changed: boolean;
}

export function transitionIssueLifecycle(
  context: GitHubMutationContext,
  input: TransitionIssueLifecycleInput,
): TransitionIssueLifecycleResult {
  const current = context.gh.issues.get(input.issue.id);
  if (!current || current.repo_id !== input.repo.id || current.is_pull_request) {
    throw new ApiError(404, "Not Found");
  }

  const patch: Partial<GitHubIssue> = { ...(input.patch ?? {}) };
  delete patch.state;
  delete patch.state_reason;
  delete patch.duplicate_issue_id;

  const duplicateReason = input.stateReason === "duplicate";
  if (duplicateReason && input.state !== "closed") {
    throw new ApiError(422, "Duplicate issues must be closed");
  }
  if (
    duplicateReason &&
    (!input.duplicateIssue ||
      input.duplicateIssue.id === current.id ||
      input.duplicateIssue.is_pull_request ||
      input.duplicateIssue.duplicate_issue_id != null)
  ) {
    throw new ApiError(422, "A valid canonical duplicate issue is required");
  }
  if (!duplicateReason && input.duplicateIssue) {
    throw new ApiError(422, "duplicate_issue_id requires state_reason duplicate");
  }

  const stateChanged = current.state !== input.state;
  const desiredStateReason =
    input.stateReason !== undefined
      ? input.stateReason
      : stateChanged
        ? input.state === "closed"
          ? "completed"
          : "reopened"
        : current.state_reason;
  const desiredDuplicateIssueId =
    input.stateReason !== undefined
      ? desiredStateReason === "duplicate"
        ? input.duplicateIssue!.id
        : null
      : stateChanged
        ? null
        : current.duplicate_issue_id;
  const reasonChanged = current.state_reason !== desiredStateReason;
  const duplicateChanged = current.duplicate_issue_id !== desiredDuplicateIssueId;
  const changed = stateChanged || reasonChanged || duplicateChanged;
  if (!changed && Object.keys(patch).length === 0) {
    return { issue: current, changed: false };
  }

  if (stateChanged) {
    patch.state = input.state;
    patch.state_reason = desiredStateReason;
    patch.duplicate_issue_id = desiredDuplicateIssueId;
    if (input.state === "closed") {
      patch.closed_at = timestamp();
      patch.closed_by_id = input.actor.id;
    } else {
      patch.closed_at = null;
      patch.closed_by_id = null;
    }
  } else if (reasonChanged || duplicateChanged) {
    patch.state_reason = desiredStateReason;
    patch.duplicate_issue_id = desiredDuplicateIssueId;
  }

  const updated = context.gh.issues.update(current.id, patch);
  if (!updated) throw new ApiError(404, "Not Found");
  if (!changed) return { issue: updated, changed: false };

  const ownerLogin = ownerLoginOf(context.gh, input.repo);
  const event =
    desiredStateReason === "duplicate" && current.state_reason !== "duplicate"
      ? "marked_as_duplicate"
      : current.state_reason === "duplicate" && desiredStateReason !== "duplicate"
        ? "unmarked_as_duplicate"
        : input.state === "closed"
          ? "closed"
          : "reopened";
  if (stateChanged) adjustRepoOpenIssues(context.gh, input.repo.id, input.state === "closed" ? -1 : 1);
  insertIssueEvent(context.gh, input.repo, updated.number, event, input.actor.id);
  dispatchGitHubWebhook(
    context,
    "issues",
    event,
    {
      action: event,
      issue: formatIssue(updated, context.gh, context.baseUrl),
      repository: formatRepo(input.repo, context.gh, context.baseUrl),
      sender: formatUser(input.actor, context.baseUrl),
    },
    ownerLogin,
    input.repo.name,
  );

  return { issue: updated, changed: true };
}
