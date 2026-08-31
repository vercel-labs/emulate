import { ApiError, notFound } from "@emulators/core";
import type { WebhookDispatcher } from "@emulators/core";
import type {
  GitHubIssue,
  GitHubIssueDependency,
  GitHubIssueEvent,
  GitHubIssueSubIssue,
  GitHubRepo,
  GitHubUser,
} from "./entities.js";
import type { GitHubStore } from "./store.js";
import { formatIssue, formatRepo, formatUser, generateNodeId } from "./helpers.js";
import { ownerLoginOf } from "./route-helpers.js";

export interface AddSubIssueOptions {
  replaceParent?: boolean;
}

export interface AddedSubIssue {
  relation: GitHubIssueSubIssue;
  replacedParentId: number | null;
}

export interface RelationshipMutationContext {
  gh: GitHubStore;
  webhooks: WebhookDispatcher;
  baseUrl: string;
  actor: GitHubUser;
}

function relationshipEvent(
  context: RelationshipMutationContext,
  repo: GitHubRepo,
  issue: GitHubIssue,
  event: string,
  extra: Partial<Pick<GitHubIssueEvent, "parent_issue_id" | "sub_issue_id" | "blocked_issue_id" | "blocking_issue_id">>,
): void {
  const row = context.gh.issueEvents.insert({
    node_id: "",
    repo_id: repo.id,
    issue_number: issue.number,
    event,
    actor_id: context.actor.id,
    commit_id: null,
    commit_url: null,
    label_name: null,
    assignee_id: null,
    milestone_title: null,
    rename: null,
    ...extra,
  } as Omit<GitHubIssueEvent, "id" | "created_at" | "updated_at">);
  context.gh.issueEvents.update(row.id, { node_id: generateNodeId("IssueEvent", row.id) });
}

function relationshipPayload(
  context: RelationshipMutationContext,
  action: string,
  repository: GitHubRepo,
  parent: GitHubIssue,
  child: GitHubIssue,
) {
  return {
    action,
    parent_issue_id: parent.id,
    parent_issue: formatIssue(parent, context.gh, context.baseUrl),
    sub_issue_id: child.id,
    sub_issue: formatIssue(child, context.gh, context.baseUrl),
    repository: formatRepo(repository, context.gh, context.baseUrl),
    sender: formatUser(context.actor, context.baseUrl),
  };
}

function dependencyPayload(
  context: RelationshipMutationContext,
  action: string,
  repository: GitHubRepo,
  blocked: GitHubIssue,
  blocking: GitHubIssue,
) {
  const blockedRepo = context.gh.repos.get(blocked.repo_id);
  const blockingRepo = context.gh.repos.get(blocking.repo_id);
  return {
    action,
    blocked_issue_id: blocked.id,
    blocked_issue: formatIssue(blocked, context.gh, context.baseUrl),
    blocking_issue_id: blocking.id,
    blocking_issue: formatIssue(blocking, context.gh, context.baseUrl),
    repository: formatRepo(repository, context.gh, context.baseUrl),
    blocked_repository: blockedRepo ? formatRepo(blockedRepo, context.gh, context.baseUrl) : null,
    blocking_repository: blockingRepo ? formatRepo(blockingRepo, context.gh, context.baseUrl) : null,
    sender: formatUser(context.actor, context.baseUrl),
  };
}

export function dispatchSubIssueRelationship(
  context: RelationshipMutationContext,
  parent: GitHubIssue,
  child: GitHubIssue,
  action: "added" | "removed",
): void {
  const parentRepo = context.gh.repos.get(parent.repo_id);
  const childRepo = context.gh.repos.get(child.repo_id);
  if (!parentRepo || !childRepo) return;
  const parentAction = `sub_issue_${action}`;
  const childAction = `parent_issue_${action}`;
  relationshipEvent(context, parentRepo, parent, parentAction, { parent_issue_id: parent.id, sub_issue_id: child.id });
  relationshipEvent(context, childRepo, child, childAction, { parent_issue_id: parent.id, sub_issue_id: child.id });
  void context.webhooks.dispatch(
    "sub_issues",
    parentAction,
    relationshipPayload(context, parentAction, parentRepo, parent, child),
    ownerLoginOf(context.gh, parentRepo),
    parentRepo.name,
  );
  void context.webhooks.dispatch(
    "sub_issues",
    childAction,
    relationshipPayload(context, childAction, childRepo, parent, child),
    ownerLoginOf(context.gh, childRepo),
    childRepo.name,
  );
}

export function dispatchIssueDependencyRelationship(
  context: RelationshipMutationContext,
  blocked: GitHubIssue,
  blocking: GitHubIssue,
  action: "added" | "removed",
): void {
  const blockedRepo = context.gh.repos.get(blocked.repo_id);
  const blockingRepo = context.gh.repos.get(blocking.repo_id);
  if (!blockedRepo || !blockingRepo) return;
  const blockedAction = `blocked_by_${action}`;
  const blockingAction = `blocking_${action}`;
  relationshipEvent(context, blockedRepo, blocked, blockedAction, {
    blocked_issue_id: blocked.id,
    blocking_issue_id: blocking.id,
  });
  relationshipEvent(context, blockingRepo, blocking, blockingAction, {
    blocked_issue_id: blocked.id,
    blocking_issue_id: blocking.id,
  });
  void context.webhooks.dispatch(
    "issue_dependencies",
    blockedAction,
    dependencyPayload(context, blockedAction, blockedRepo, blocked, blocking),
    ownerLoginOf(context.gh, blockedRepo),
    blockedRepo.name,
  );
  void context.webhooks.dispatch(
    "issue_dependencies",
    blockingAction,
    dependencyPayload(context, blockingAction, blockingRepo, blocked, blocking),
    ownerLoginOf(context.gh, blockingRepo),
    blockingRepo.name,
  );
}

export function addSubIssueWithEvents(
  context: RelationshipMutationContext,
  parentIssueId: number,
  childIssueId: number,
  options: AddSubIssueOptions = {},
): AddedSubIssue {
  const result = addSubIssue(context.gh, parentIssueId, childIssueId, options);
  if (result.replacedParentId !== null) {
    const oldParent = getIssueById(context.gh, result.replacedParentId);
    const child = getIssueById(context.gh, childIssueId);
    dispatchSubIssueRelationship(context, oldParent, child, "removed");
  }
  dispatchSubIssueRelationship(
    context,
    getIssueById(context.gh, parentIssueId),
    getIssueById(context.gh, childIssueId),
    "added",
  );
  return result;
}

export function addIssueDependencyWithEvents(
  context: RelationshipMutationContext,
  blockedIssueId: number,
  blockingIssueId: number,
): GitHubIssueDependency {
  const relation = addIssueDependency(context.gh, blockedIssueId, blockingIssueId);
  dispatchIssueDependencyRelationship(
    context,
    getIssueById(context.gh, blockedIssueId),
    getIssueById(context.gh, blockingIssueId),
    "added",
  );
  return relation;
}

function invalid(message: string): never {
  throw new ApiError(422, message);
}

/** Resolve an issue database ID while excluding pull requests from issue relationships. */
export function getIssueById(gh: GitHubStore, issueId: number): GitHubIssue {
  const issue = gh.issues.get(issueId);
  if (!issue || issue.is_pull_request) throw notFound("Issue");
  return issue;
}

/** Resolve an issue number within a repository while excluding pull requests. */
export function getIssueByNumber(gh: GitHubStore, repoId: number, issueNumber: number): GitHubIssue {
  const issue = gh.issues.findBy("repo_id", repoId).find((candidate) => {
    return candidate.number === issueNumber && !candidate.is_pull_request;
  });
  if (!issue) throw notFound("Issue");
  return issue;
}

function sameRepositoryOwner(gh: GitHubStore, left: GitHubIssue, right: GitHubIssue): boolean {
  const leftRepo = gh.repos.get(left.repo_id);
  const rightRepo = gh.repos.get(right.repo_id);
  return Boolean(
    leftRepo && rightRepo && leftRepo.owner_id === rightRepo.owner_id && leftRepo.owner_type === rightRepo.owner_type,
  );
}

function parentRelation(gh: GitHubStore, childIssueId: number): GitHubIssueSubIssue | undefined {
  return gh.issueSubIssues.findBy("child_issue_id", childIssueId)[0];
}

function orderedSubIssueRelations(gh: GitHubStore, parentIssueId: number): GitHubIssueSubIssue[] {
  return gh.issueSubIssues
    .findBy("parent_issue_id", parentIssueId)
    .sort((left, right) => left.position - right.position || left.id - right.id);
}

/** Normalize sibling positions after a relationship is removed outside this module. */
export function normalizeSubIssuePositions(gh: GitHubStore, parentIssueId: number): void {
  for (const [position, relation] of orderedSubIssueRelations(gh, parentIssueId).entries()) {
    if (relation.position !== position) {
      gh.issueSubIssues.update(relation.id, { position });
    }
  }
}

function wouldCreateParentCycle(gh: GitHubStore, parentIssueId: number, childIssueId: number): boolean {
  const visited = new Set<number>();
  let current: number | undefined = parentIssueId;
  while (current !== undefined && !visited.has(current)) {
    if (current === childIssueId) return true;
    visited.add(current);
    current = parentRelation(gh, current)?.parent_issue_id;
  }
  return false;
}

/** Return the current parent relationship for a child, if any. */
export function getParentRelation(gh: GitHubStore, childIssueId: number): GitHubIssueSubIssue | undefined {
  return parentRelation(gh, childIssueId);
}

/** Return ordered child relationships. The returned array is detached from the collection. */
export function listSubIssueRelations(gh: GitHubStore, parentIssueId: number): GitHubIssueSubIssue[] {
  return orderedSubIssueRelations(gh, parentIssueId);
}

/** Add an ordered parent to child relationship after validating the full graph transition. */
export function addSubIssue(
  gh: GitHubStore,
  parentIssueId: number,
  childIssueId: number,
  options: AddSubIssueOptions = {},
): AddedSubIssue {
  const parent = getIssueById(gh, parentIssueId);
  const child = getIssueById(gh, childIssueId);

  if (parent.id === child.id) invalid("An issue cannot be its own sub-issue");
  if (!sameRepositoryOwner(gh, parent, child)) {
    invalid("Sub-issues must belong to repositories owned by the same account");
  }
  if (wouldCreateParentCycle(gh, parent.id, child.id)) {
    invalid("Adding this sub-issue would create a cycle");
  }

  const existing = gh.issueSubIssues
    .findBy("parent_issue_id", parent.id)
    .find((relation) => relation.child_issue_id === child.id);
  if (existing) invalid("This issue is already a sub-issue");

  const currentParent = parentRelation(gh, child.id);
  if (currentParent && currentParent.parent_issue_id !== parent.id && !options.replaceParent) {
    invalid("The issue already has a parent; set replace_parent to move it");
  }

  if (currentParent && currentParent.parent_issue_id !== parent.id) {
    gh.issueSubIssues.delete(currentParent.id);
    normalizeSubIssuePositions(gh, currentParent.parent_issue_id);
  }

  const relation = gh.issueSubIssues.insert({
    parent_issue_id: parent.id,
    child_issue_id: child.id,
    position: orderedSubIssueRelations(gh, parent.id).length,
  });

  return {
    relation,
    replacedParentId: currentParent?.parent_issue_id ?? null,
  };
}

/** Remove a parent to child relationship and close the resulting ordering gap. */
export function removeSubIssue(gh: GitHubStore, parentIssueId: number, childIssueId: number): GitHubIssueSubIssue {
  getIssueById(gh, parentIssueId);
  getIssueById(gh, childIssueId);
  const relation = gh.issueSubIssues
    .findBy("parent_issue_id", parentIssueId)
    .find((candidate) => candidate.child_issue_id === childIssueId);
  if (!relation) throw notFound("Sub-issue relationship");
  gh.issueSubIssues.delete(relation.id);
  normalizeSubIssuePositions(gh, parentIssueId);
  return relation;
}

export interface ReprioritizeSubIssueOptions {
  afterId?: number;
  beforeId?: number;
}

/** Move a child relative to one sibling. Exactly one anchor is required. */
export function reprioritizeSubIssue(
  gh: GitHubStore,
  parentIssueId: number,
  childIssueId: number,
  options: ReprioritizeSubIssueOptions,
): GitHubIssueSubIssue {
  getIssueById(gh, parentIssueId);
  getIssueById(gh, childIssueId);
  const hasAfter = options.afterId !== undefined;
  const hasBefore = options.beforeId !== undefined;
  if (hasAfter === hasBefore) invalid("Exactly one of after_id or before_id is required");
  if (options.afterId === childIssueId || options.beforeId === childIssueId) {
    invalid("An issue cannot be reprioritized relative to itself");
  }

  const relations = orderedSubIssueRelations(gh, parentIssueId);
  const childIndex = relations.findIndex((relation) => relation.child_issue_id === childIssueId);
  if (childIndex === -1) throw notFound("Sub-issue relationship");
  const anchorId = options.afterId ?? options.beforeId!;
  const anchorIndex = relations.findIndex((relation) => relation.child_issue_id === anchorId);
  if (anchorIndex === -1) throw notFound("Sibling sub-issue");

  const [moving] = relations.splice(childIndex, 1);
  const adjustedAnchorIndex = relations.findIndex((relation) => relation.child_issue_id === anchorId);
  const insertionIndex = hasAfter ? adjustedAnchorIndex + 1 : adjustedAnchorIndex;
  relations.splice(insertionIndex, 0, moving);
  for (const [position, relation] of relations.entries()) {
    gh.issueSubIssues.update(relation.id, { position });
  }
  return gh.issueSubIssues.get(moving.id)!;
}

function wouldCreateDependencyCycle(gh: GitHubStore, blockedIssueId: number, blockingIssueId: number): boolean {
  const visited = new Set<number>();
  const stack = [blockingIssueId];
  while (stack.length) {
    const current = stack.pop()!;
    if (current === blockedIssueId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const relation of gh.issueDependencies.findBy("blocked_issue_id", current)) {
      stack.push(relation.blocking_issue_id);
    }
  }
  return false;
}

/** Return dependencies where the issue is blocked by another issue. */
export function listBlockedByRelations(gh: GitHubStore, blockedIssueId: number): GitHubIssueDependency[] {
  return gh.issueDependencies
    .findBy("blocked_issue_id", blockedIssueId)
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id - right.id);
}

/** Return dependencies where the issue blocks another issue. */
export function listBlockingRelations(gh: GitHubStore, blockingIssueId: number): GitHubIssueDependency[] {
  return gh.issueDependencies
    .findBy("blocking_issue_id", blockingIssueId)
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id - right.id);
}

/** Add a directed dependency: the blocked issue depends on the blocking issue. */
export function addIssueDependency(
  gh: GitHubStore,
  blockedIssueId: number,
  blockingIssueId: number,
): GitHubIssueDependency {
  const blocked = getIssueById(gh, blockedIssueId);
  const blocking = getIssueById(gh, blockingIssueId);
  if (blocked.id === blocking.id) invalid("An issue cannot depend on itself");
  if (
    gh.issueDependencies.findBy("blocked_issue_id", blocked.id).some((relation) => {
      return relation.blocking_issue_id === blocking.id;
    })
  ) {
    invalid("This dependency already exists");
  }
  if (wouldCreateDependencyCycle(gh, blocked.id, blocking.id)) {
    invalid("Adding this dependency would create a cycle");
  }
  return gh.issueDependencies.insert({
    blocked_issue_id: blocked.id,
    blocking_issue_id: blocking.id,
  });
}

/** Remove a directed dependency. */
export function removeIssueDependency(
  gh: GitHubStore,
  blockedIssueId: number,
  blockingIssueId: number,
): GitHubIssueDependency {
  getIssueById(gh, blockedIssueId);
  getIssueById(gh, blockingIssueId);
  const relation = gh.issueDependencies
    .findBy("blocked_issue_id", blockedIssueId)
    .find((candidate) => candidate.blocking_issue_id === blockingIssueId);
  if (!relation) throw notFound("Issue dependency");
  gh.issueDependencies.delete(relation.id);
  return relation;
}
