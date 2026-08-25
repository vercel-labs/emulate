import type { Context, RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import type { GitHubIssue, GitHubIssueEvent, GitHubRepo, GitHubUser } from "../entities.js";
import {
  addIssueDependency,
  addSubIssue,
  getIssueById,
  getIssueByNumber,
  getParentRelation,
  listBlockedByRelations,
  listBlockingRelations,
  listSubIssueRelations,
  removeIssueDependency,
  removeSubIssue,
  reprioritizeSubIssue,
} from "../issue-relationships.js";
import { getGitHubStore } from "../store.js";
import { assertAuthenticatedActor, assertRepoPermission, notFoundResponse, ownerLoginOf } from "../route-helpers.js";
import { formatIssue, formatRepo, formatUser, generateNodeId, lookupRepo } from "../helpers.js";

function issueId(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ApiError(422, `${field} must be a positive integer`);
  }
  return value;
}

function pathIssueNumber(c: Context, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw notFoundResponse("Issue");
  return parsed;
}

function routeRepo(c: Context, gh: ReturnType<typeof getGitHubStore>) {
  const owner = c.req.param("owner");
  const name = c.req.param("repo");
  const repo = lookupRepo(gh, owner, name);
  if (!repo) throw notFoundResponse("Repository");
  return repo;
}

function routeIssue(c: Context, gh: ReturnType<typeof getGitHubStore>, repo: GitHubRepo): GitHubIssue {
  return getIssueByNumber(gh, repo.id, pathIssueNumber(c, c.req.param("issue_number")));
}

function issueJson(issue: GitHubIssue, gh: ReturnType<typeof getGitHubStore>, baseUrl: string) {
  const json = formatIssue(issue, gh, baseUrl);
  if (!json) throw notFoundResponse("Issue");
  return json;
}

function assertIssueRead(
  gh: ReturnType<typeof getGitHubStore>,
  authUser: Parameters<typeof assertRepoPermission>[1],
  issue: GitHubIssue,
): GitHubRepo {
  const repo = gh.repos.get(issue.repo_id);
  if (!repo) throw notFoundResponse("Repository");
  assertRepoPermission(gh, authUser, repo, "issues", "read");
  return repo;
}

function relationshipEvent(
  gh: ReturnType<typeof getGitHubStore>,
  repo: GitHubRepo,
  issue: GitHubIssue,
  actor: GitHubUser,
  event: string,
  extra: Partial<Pick<GitHubIssueEvent, "parent_issue_id" | "sub_issue_id" | "blocked_issue_id" | "blocking_issue_id">>,
): void {
  const row = gh.issueEvents.insert({
    node_id: "",
    repo_id: repo.id,
    issue_number: issue.number,
    event,
    actor_id: actor.id,
    commit_id: null,
    commit_url: null,
    label_name: null,
    assignee_id: null,
    milestone_title: null,
    rename: null,
    ...extra,
  } as Omit<GitHubIssueEvent, "id" | "created_at" | "updated_at">);
  gh.issueEvents.update(row.id, { node_id: generateNodeId("IssueEvent", row.id) });
}

function relationshipPayload(
  gh: ReturnType<typeof getGitHubStore>,
  baseUrl: string,
  action: string,
  repository: GitHubRepo,
  actor: GitHubUser,
  values: {
    parent: GitHubIssue;
    child: GitHubIssue;
  },
) {
  return {
    action,
    parent_issue_id: values.parent.id,
    parent_issue: issueJson(values.parent, gh, baseUrl),
    sub_issue_id: values.child.id,
    sub_issue: issueJson(values.child, gh, baseUrl),
    repository: formatRepo(repository, gh, baseUrl),
    sender: formatUser(actor, baseUrl),
  };
}

function dispatchSubIssueEvents(
  gh: ReturnType<typeof getGitHubStore>,
  webhooks: RouteContext["webhooks"],
  baseUrl: string,
  actor: GitHubUser,
  parent: GitHubIssue,
  child: GitHubIssue,
  action: "added" | "removed",
): void {
  const parentRepo = gh.repos.get(parent.repo_id);
  const childRepo = gh.repos.get(child.repo_id);
  if (!parentRepo || !childRepo) return;

  const parentAction = `sub_issue_${action}`;
  const childAction = `parent_issue_${action}`;
  relationshipEvent(gh, parentRepo, parent, actor, parentAction, {
    parent_issue_id: parent.id,
    sub_issue_id: child.id,
  });
  relationshipEvent(gh, childRepo, child, actor, childAction, {
    parent_issue_id: parent.id,
    sub_issue_id: child.id,
  });

  void webhooks.dispatch(
    "sub_issues",
    parentAction,
    relationshipPayload(gh, baseUrl, parentAction, parentRepo, actor, { parent, child }),
    ownerLoginOf(gh, parentRepo),
    parentRepo.name,
  );
  void webhooks.dispatch(
    "sub_issues",
    childAction,
    relationshipPayload(gh, baseUrl, childAction, childRepo, actor, { parent, child }),
    ownerLoginOf(gh, childRepo),
    childRepo.name,
  );
}

function dependencyPayload(
  gh: ReturnType<typeof getGitHubStore>,
  baseUrl: string,
  action: string,
  repository: GitHubRepo,
  actor: GitHubUser,
  blocked: GitHubIssue,
  blocking: GitHubIssue,
) {
  const blockingRepo = gh.repos.get(blocking.repo_id);
  const blockedRepo = gh.repos.get(blocked.repo_id);
  return {
    action,
    blocked_issue_id: blocked.id,
    blocked_issue: issueJson(blocked, gh, baseUrl),
    blocking_issue_id: blocking.id,
    blocking_issue: issueJson(blocking, gh, baseUrl),
    blocking_repository: blockingRepo ? formatRepo(blockingRepo, gh, baseUrl) : null,
    repository: formatRepo(repository, gh, baseUrl),
    blocked_repository: blockedRepo ? formatRepo(blockedRepo, gh, baseUrl) : null,
    sender: formatUser(actor, baseUrl),
  };
}

function dispatchDependencyEvents(
  gh: ReturnType<typeof getGitHubStore>,
  webhooks: RouteContext["webhooks"],
  baseUrl: string,
  actor: GitHubUser,
  blocked: GitHubIssue,
  blocking: GitHubIssue,
  action: "added" | "removed",
): void {
  const blockedRepo = gh.repos.get(blocked.repo_id);
  const blockingRepo = gh.repos.get(blocking.repo_id);
  if (!blockedRepo || !blockingRepo) return;

  const blockedAction = `blocked_by_${action}`;
  const blockingAction = `blocking_${action}`;
  relationshipEvent(gh, blockedRepo, blocked, actor, blockedAction, {
    blocked_issue_id: blocked.id,
    blocking_issue_id: blocking.id,
  });
  relationshipEvent(gh, blockingRepo, blocking, actor, blockingAction, {
    blocked_issue_id: blocked.id,
    blocking_issue_id: blocking.id,
  });

  void webhooks.dispatch(
    "issue_dependencies",
    blockedAction,
    dependencyPayload(gh, baseUrl, blockedAction, blockedRepo, actor, blocked, blocking),
    ownerLoginOf(gh, blockedRepo),
    blockedRepo.name,
  );
  void webhooks.dispatch(
    "issue_dependencies",
    blockingAction,
    dependencyPayload(gh, baseUrl, blockingAction, blockingRepo, actor, blocked, blocking),
    ownerLoginOf(gh, blockingRepo),
    blockingRepo.name,
  );
}

function listIssueRelations(
  c: Context,
  gh: ReturnType<typeof getGitHubStore>,
  relations: Array<{ child_issue_id?: number; blocking_issue_id?: number; blocked_issue_id?: number }>,
  relationIssueId: (relation: (typeof relations)[number]) => number,
  baseUrl: string,
) {
  const { page, per_page } = parsePagination(c);
  const issues = relations.map((relation) => {
    const issue = getIssueById(gh, relationIssueId(relation));
    assertIssueRead(gh, c.get("authUser"), issue);
    return issue;
  });
  const total = issues.length;
  const start = (page - 1) * per_page;
  setLinkHeader(c, total, page, per_page);
  return issues.slice(start, start + per_page).map((issue) => issueJson(issue, gh, baseUrl));
}

export function issueRelationshipsRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const parentPath = "/repos/:owner/:repo/issues/:issue_number/parent";
  const subIssuesPath = "/repos/:owner/:repo/issues/:issue_number/sub_issues";
  const subIssuePath = "/repos/:owner/:repo/issues/:issue_number/sub_issue";
  const priorityPath = "/repos/:owner/:repo/issues/:issue_number/sub_issues/priority";
  const blockedByPath = "/repos/:owner/:repo/issues/:issue_number/dependencies/blocked_by";
  const blockingPath = "/repos/:owner/:repo/issues/:issue_number/dependencies/blocking";
  const dependencyPath = "/repos/:owner/:repo/issues/:issue_number/dependencies/blocked_by/:issue_id";

  app.get(parentPath, (c) => {
    const gh = getGitHubStore(store);
    const repo = routeRepo(c, gh);
    const child = routeIssue(c, gh, repo);
    assertRepoPermission(gh, c.get("authUser"), repo, "issues", "read");
    const relation = getParentRelation(gh, child.id);
    if (!relation) throw notFoundResponse("Parent issue");
    const parent = getIssueById(gh, relation.parent_issue_id);
    assertIssueRead(gh, c.get("authUser"), parent);
    return c.json(issueJson(parent, gh, baseUrl));
  });

  app.get(subIssuesPath, (c) => {
    const gh = getGitHubStore(store);
    const repo = routeRepo(c, gh);
    const parent = routeIssue(c, gh, repo);
    assertRepoPermission(gh, c.get("authUser"), repo, "issues", "read");
    return c.json(
      listIssueRelations(c, gh, listSubIssueRelations(gh, parent.id), (relation) => relation.child_issue_id!, baseUrl),
    );
  });

  app.post(subIssuesPath, async (c) => {
    const gh = getGitHubStore(store);
    const repo = routeRepo(c, gh);
    const parent = routeIssue(c, gh, repo);
    assertRepoPermission(gh, c.get("authUser"), repo, "issues", "write");
    const body = await parseJsonBody(c);
    const child = getIssueById(gh, issueId(body.sub_issue_id, "sub_issue_id"));
    assertIssueRead(gh, c.get("authUser"), child);
    const replaceParent = body.replace_parent;
    if (replaceParent !== undefined && typeof replaceParent !== "boolean") {
      throw new ApiError(422, "replace_parent must be a boolean");
    }
    const actor = assertAuthenticatedActor(gh, c.get("authUser"));
    const result = addSubIssue(gh, parent.id, child.id, { replaceParent });
    if (result.replacedParentId !== null) {
      const oldParent = getIssueById(gh, result.replacedParentId);
      dispatchSubIssueEvents(gh, webhooks, baseUrl, actor, oldParent, child, "removed");
    }
    dispatchSubIssueEvents(gh, webhooks, baseUrl, actor, parent, child, "added");
    return c.json(issueJson(child, gh, baseUrl), 201);
  });

  app.delete(subIssuePath, async (c) => {
    const gh = getGitHubStore(store);
    const repo = routeRepo(c, gh);
    const parent = routeIssue(c, gh, repo);
    assertRepoPermission(gh, c.get("authUser"), repo, "issues", "write");
    const body = await parseJsonBody(c);
    const child = getIssueById(gh, issueId(body.sub_issue_id, "sub_issue_id"));
    assertIssueRead(gh, c.get("authUser"), child);
    const actor = assertAuthenticatedActor(gh, c.get("authUser"));
    removeSubIssue(gh, parent.id, child.id);
    dispatchSubIssueEvents(gh, webhooks, baseUrl, actor, parent, child, "removed");
    return c.json(issueJson(child, gh, baseUrl));
  });

  app.patch(priorityPath, async (c) => {
    const gh = getGitHubStore(store);
    const repo = routeRepo(c, gh);
    const parent = routeIssue(c, gh, repo);
    assertRepoPermission(gh, c.get("authUser"), repo, "issues", "write");
    const body = await parseJsonBody(c);
    const child = getIssueById(gh, issueId(body.sub_issue_id, "sub_issue_id"));
    assertIssueRead(gh, c.get("authUser"), child);
    const afterId = body.after_id === undefined ? undefined : issueId(body.after_id, "after_id");
    const beforeId = body.before_id === undefined ? undefined : issueId(body.before_id, "before_id");
    reprioritizeSubIssue(gh, parent.id, child.id, { afterId, beforeId });
    return c.json(issueJson(child, gh, baseUrl));
  });

  app.get(blockedByPath, (c) => {
    const gh = getGitHubStore(store);
    const repo = routeRepo(c, gh);
    const blocked = routeIssue(c, gh, repo);
    assertRepoPermission(gh, c.get("authUser"), repo, "issues", "read");
    return c.json(
      listIssueRelations(
        c,
        gh,
        listBlockedByRelations(gh, blocked.id),
        (relation) => relation.blocking_issue_id!,
        baseUrl,
      ),
    );
  });

  app.get(blockingPath, (c) => {
    const gh = getGitHubStore(store);
    const repo = routeRepo(c, gh);
    const blocking = routeIssue(c, gh, repo);
    assertRepoPermission(gh, c.get("authUser"), repo, "issues", "read");
    return c.json(
      listIssueRelations(
        c,
        gh,
        listBlockingRelations(gh, blocking.id),
        (relation) => relation.blocked_issue_id!,
        baseUrl,
      ),
    );
  });

  app.post(blockedByPath, async (c) => {
    const gh = getGitHubStore(store);
    const repo = routeRepo(c, gh);
    const blocked = routeIssue(c, gh, repo);
    assertRepoPermission(gh, c.get("authUser"), repo, "issues", "write");
    const body = await parseJsonBody(c);
    const blocking = getIssueById(gh, issueId(body.issue_id, "issue_id"));
    assertIssueRead(gh, c.get("authUser"), blocking);
    const actor = assertAuthenticatedActor(gh, c.get("authUser"));
    addIssueDependency(gh, blocked.id, blocking.id);
    dispatchDependencyEvents(gh, webhooks, baseUrl, actor, blocked, blocking, "added");
    return c.json(issueJson(blocking, gh, baseUrl), 201);
  });

  app.delete(dependencyPath, (c) => {
    const gh = getGitHubStore(store);
    const repo = routeRepo(c, gh);
    const blocked = routeIssue(c, gh, repo);
    assertRepoPermission(gh, c.get("authUser"), repo, "issues", "write");
    const blocking = getIssueById(gh, issueId(Number(c.req.param("issue_id")), "issue_id"));
    assertIssueRead(gh, c.get("authUser"), blocking);
    const actor = assertAuthenticatedActor(gh, c.get("authUser"));
    removeIssueDependency(gh, blocked.id, blocking.id);
    dispatchDependencyEvents(gh, webhooks, baseUrl, actor, blocked, blocking, "removed");
    return c.body(null, 204);
  });
}
