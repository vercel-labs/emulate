import { ApiError } from "@emulators/core";
import type { GitHubIssue, GitHubIssueEvent, GitHubRepo, GitHubUser } from "../entities.js";
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

function requireIssueForMutation(context: GitHubMutationContext, repo: GitHubRepo, issue: GitHubIssue): GitHubIssue {
  const current = context.gh.issues.get(issue.id);
  if (!current || current.repo_id !== repo.id || current.is_pull_request) {
    throw new ApiError(404, "Not Found");
  }
  return current;
}

function requireDeletableIssue(context: GitHubMutationContext, input: DeleteIssueInput): GitHubIssue {
  return requireIssueForMutation(context, input.repo, input.issue);
}

function deleteIssueComments(context: GitHubMutationContext, issue: GitHubIssue): void {
  for (const comment of context.gh.comments.findBy("repo_id", issue.repo_id)) {
    if (comment.comment_type === "issue" && comment.issue_number === issue.number) {
      context.gh.comments.delete(comment.id);
    }
  }
}

function isIssueEventIncidentTo(event: GitHubIssueEvent, issue: GitHubIssue): boolean {
  if (event.repo_id === issue.repo_id && event.issue_number === issue.number) return true;
  return [event.parent_issue_id, event.sub_issue_id, event.blocked_issue_id, event.blocking_issue_id].includes(
    issue.id,
  );
}

function deleteIncidentIssueEvents(context: GitHubMutationContext, issue: GitHubIssue): void {
  for (const event of context.gh.issueEvents.all()) {
    if (isIssueEventIncidentTo(event, issue)) context.gh.issueEvents.delete(event.id);
  }
}

function deleteIssueSubIssueRelations(context: GitHubMutationContext, issueId: number): void {
  const parentsToNormalize = new Set<number>();
  for (const relation of context.gh.issueSubIssues.all()) {
    if (relation.parent_issue_id !== issueId && relation.child_issue_id !== issueId) continue;
    if (relation.parent_issue_id !== issueId) parentsToNormalize.add(relation.parent_issue_id);
    context.gh.issueSubIssues.delete(relation.id);
  }
  for (const parentId of parentsToNormalize) normalizeSubIssuePositions(context.gh, parentId);
}

function deleteIssueDependencyRelations(context: GitHubMutationContext, issueId: number): void {
  for (const relation of context.gh.issueDependencies.all()) {
    if (relation.blocked_issue_id === issueId || relation.blocking_issue_id === issueId) {
      context.gh.issueDependencies.delete(relation.id);
    }
  }
}

function stateReasonAfterCanonicalDeletion(issue: GitHubIssue): GitHubIssue["state_reason"] {
  if (issue.state_reason !== "duplicate") return issue.state_reason;
  return issue.state === "closed" ? "completed" : "reopened";
}

function clearDuplicateIssueReferences(context: GitHubMutationContext, issueId: number): void {
  for (const issue of context.gh.issues.all()) {
    if (issue.id === issueId || issue.duplicate_issue_id !== issueId) continue;
    context.gh.issues.update(issue.id, {
      duplicate_issue_id: null,
      state_reason: stateReasonAfterCanonicalDeletion(issue),
    });
  }
}

/** Delete an issue and all records that are incident to its identity. */
export function deleteIssue(context: GitHubMutationContext, input: DeleteIssueInput): GitHubIssue {
  const current = requireDeletableIssue(context, input);
  deleteIssueComments(context, current);
  deleteIncidentIssueEvents(context, current);
  deleteIssueSubIssueRelations(context, current.id);
  deleteIssueDependencyRelations(context, current.id);
  clearDuplicateIssueReferences(context, current.id);
  if (current.state === "open") adjustRepoOpenIssues(context.gh, current.repo_id, -1);
  if (!context.gh.issues.delete(current.id)) throw new ApiError(404, "Not Found");
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

interface LifecycleResolution {
  desiredStateReason: GitHubIssue["state_reason"];
  desiredDuplicateIssueId: number | null;
  stateChanged: boolean;
  reasonChanged: boolean;
  duplicateChanged: boolean;
  changed: boolean;
}

function validateDuplicateClosure(input: TransitionIssueLifecycleInput): void {
  if (input.stateReason === "duplicate" && input.state !== "closed") {
    throw new ApiError(422, "Duplicate issues must be closed");
  }
}

function validateCanonicalDuplicate(current: GitHubIssue, input: TransitionIssueLifecycleInput): void {
  if (input.stateReason !== "duplicate") return;
  const duplicateIssue = input.duplicateIssue;
  if (!duplicateIssue) {
    throw new ApiError(422, "A valid canonical duplicate issue is required");
  }
  if (duplicateIssue.id === current.id) {
    throw new ApiError(422, "A valid canonical duplicate issue is required");
  }
  if (duplicateIssue.is_pull_request) {
    throw new ApiError(422, "A valid canonical duplicate issue is required");
  }
  if (duplicateIssue.duplicate_issue_id != null) {
    throw new ApiError(422, "A valid canonical duplicate issue is required");
  }
}

function rejectUnexpectedDuplicateReference(input: TransitionIssueLifecycleInput): void {
  if (input.stateReason !== "duplicate" && input.duplicateIssue) {
    throw new ApiError(422, "duplicate_issue_id requires state_reason duplicate");
  }
}

function desiredStateReason(current: GitHubIssue, input: TransitionIssueLifecycleInput, stateChanged: boolean) {
  if (input.stateReason !== undefined) return input.stateReason;
  if (!stateChanged) return current.state_reason;
  return input.state === "closed" ? "completed" : "reopened";
}

function desiredDuplicateIssueId(
  current: GitHubIssue,
  input: TransitionIssueLifecycleInput,
  stateReason: GitHubIssue["state_reason"],
  stateChanged: boolean,
): number | null {
  if (input.stateReason !== undefined) return stateReason === "duplicate" ? input.duplicateIssue!.id : null;
  if (!stateChanged) return current.duplicate_issue_id;
  return null;
}

function validateStateReasonCompatibility(state: GitHubIssue["state"], stateReason: GitHubIssue["state_reason"]): void {
  if (state === "open" && stateReason !== null && stateReason !== "reopened") {
    throw new ApiError(422, "Open issues must use state_reason reopened or null");
  }
  if (state === "closed" && stateReason === "reopened") {
    throw new ApiError(422, "Closed issues cannot use state_reason reopened");
  }
}

function resolveLifecycle(current: GitHubIssue, input: TransitionIssueLifecycleInput): LifecycleResolution {
  validateDuplicateClosure(input);
  validateCanonicalDuplicate(current, input);
  rejectUnexpectedDuplicateReference(input);
  const stateChanged = current.state !== input.state;
  const resolvedStateReason = desiredStateReason(current, input, stateChanged);
  validateStateReasonCompatibility(input.state, resolvedStateReason);
  const resolvedDuplicateIssueId = desiredDuplicateIssueId(current, input, resolvedStateReason, stateChanged);
  const reasonChanged = current.state_reason !== resolvedStateReason;
  const duplicateChanged = current.duplicate_issue_id !== resolvedDuplicateIssueId;
  return {
    desiredStateReason: resolvedStateReason,
    desiredDuplicateIssueId: resolvedDuplicateIssueId,
    stateChanged,
    reasonChanged,
    duplicateChanged,
    changed: stateChanged || reasonChanged || duplicateChanged,
  };
}

function lifecyclePatch(input: TransitionIssueLifecycleInput, resolution: LifecycleResolution): Partial<GitHubIssue> {
  const patch: Partial<GitHubIssue> = { ...(input.patch ?? {}) };
  delete patch.state;
  delete patch.state_reason;
  delete patch.duplicate_issue_id;
  if (resolution.stateChanged) {
    patch.state = input.state;
    patch.state_reason = resolution.desiredStateReason;
    patch.duplicate_issue_id = resolution.desiredDuplicateIssueId;
    if (input.state === "closed") {
      patch.closed_at = timestamp();
      patch.closed_by_id = input.actor.id;
    } else {
      patch.closed_at = null;
      patch.closed_by_id = null;
    }
  } else if (resolution.reasonChanged || resolution.duplicateChanged) {
    patch.state_reason = resolution.desiredStateReason;
    patch.duplicate_issue_id = resolution.desiredDuplicateIssueId;
  }
  return patch;
}

function lifecycleEvent(
  current: GitHubIssue,
  input: TransitionIssueLifecycleInput,
  resolution: LifecycleResolution,
): string | null {
  if (resolution.desiredStateReason === "duplicate" && current.state_reason !== "duplicate") {
    return "marked_as_duplicate";
  }
  if (current.state_reason === "duplicate" && resolution.desiredStateReason !== "duplicate") {
    return "unmarked_as_duplicate";
  }
  if (!resolution.stateChanged) return null;
  return input.state === "closed" ? "closed" : "reopened";
}

function dispatchLifecycleEvent(
  context: GitHubMutationContext,
  input: TransitionIssueLifecycleInput,
  issue: GitHubIssue,
  event: string,
  stateChanged: boolean,
): void {
  const ownerLogin = ownerLoginOf(context.gh, input.repo);
  if (stateChanged) adjustRepoOpenIssues(context.gh, input.repo.id, input.state === "closed" ? -1 : 1);
  insertIssueEvent(context.gh, input.repo, issue.number, event, input.actor.id);
  dispatchGitHubWebhook(
    context,
    "issues",
    event,
    {
      action: event,
      issue: formatIssue(issue, context.gh, context.baseUrl),
      repository: formatRepo(input.repo, context.gh, context.baseUrl),
      sender: formatUser(input.actor, context.baseUrl),
    },
    ownerLogin,
    input.repo.name,
  );
}

function persistLifecycleUpdate(
  context: GitHubMutationContext,
  current: GitHubIssue,
  patch: Partial<GitHubIssue>,
): GitHubIssue {
  const updated = context.gh.issues.update(current.id, patch);
  if (!updated) throw new ApiError(404, "Not Found");
  return updated;
}

export function transitionIssueLifecycle(
  context: GitHubMutationContext,
  input: TransitionIssueLifecycleInput,
): TransitionIssueLifecycleResult {
  const current = requireIssueForMutation(context, input.repo, input.issue);
  const resolution = resolveLifecycle(current, input);
  const patch = lifecyclePatch(input, resolution);
  if (!resolution.changed && Object.keys(patch).length === 0) {
    return { issue: current, changed: false };
  }

  const updated = persistLifecycleUpdate(context, current, patch);
  if (!resolution.changed) return { issue: updated, changed: false };

  const event = lifecycleEvent(current, input, resolution);
  if (event) dispatchLifecycleEvent(context, input, updated, event, resolution.stateChanged);
  return { issue: updated, changed: true };
}
