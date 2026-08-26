import { buildSchema, graphql, type ExecutionResult, type GraphQLError } from "graphql";
import { ApiError, type Context, type RouteContext, type AppEnv } from "@emulators/core";
import {
  createGitHubGraphQLContext,
  findVisibleRepository,
  requireGitHubGraphQLAuth,
  resolveVisibleNode,
} from "../graphql/context.js";
import { addIssueDependency, addSubIssue } from "../issue-relationships.js";
import { assertAuthenticatedActor, assertRepoPermission, ownerLoginOf } from "../route-helpers.js";
import type { GitHubIssue, GitHubIssueEvent, GitHubRepo, GitHubUser } from "../entities.js";
import { formatIssue, formatRepo, formatUser, generateNodeId } from "../helpers.js";
import { consumeGitHubGraphQLRateLimit, getGitHubGraphQLRateLimit } from "../graphql/rate-limit.js";
import { githubGraphQLSchema } from "../graphql/schema.js";
import { issueView, repositoryView, resolvedNodeView } from "../graphql/views.js";

const schema = buildSchema(githubGraphQLSchema);

function relationshipIssue(
  context: ReturnType<typeof createGitHubGraphQLContext>,
  nodeId: string,
): { issue: GitHubIssue; repo: GitHubRepo } {
  const node = resolveVisibleNode(context, nodeId);
  if (!node || node.kind !== "Issue") throw new ApiError(404, "Issue not found");
  return { issue: node.issue, repo: node.repo };
}

function insertRelationshipEvent(
  context: ReturnType<typeof createGitHubGraphQLContext>,
  repo: GitHubRepo,
  issue: GitHubIssue,
  actor: GitHubUser,
  event: string,
  extra: Partial<Pick<GitHubIssueEvent, "parent_issue_id" | "sub_issue_id" | "blocked_issue_id" | "blocking_issue_id">>,
): void {
  const row = context.gh.issueEvents.insert({
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
  context.gh.issueEvents.update(row.id, { node_id: generateNodeId("IssueEvent", row.id) });
}

function dispatchRelationshipWebhook(
  context: ReturnType<typeof createGitHubGraphQLContext>,
  webhooks: RouteContext["webhooks"],
  repo: GitHubRepo,
  action: string,
  payload: unknown,
): void {
  void webhooks.dispatch("sub_issues", action, payload, ownerLoginOf(context.gh, repo), repo.name);
}

function dispatchDependencyWebhook(
  context: ReturnType<typeof createGitHubGraphQLContext>,
  webhooks: RouteContext["webhooks"],
  repo: GitHubRepo,
  actor: GitHubUser,
  action: string,
  blocked: GitHubIssue,
  blocking: GitHubIssue,
): void {
  void webhooks.dispatch(
    "issue_dependencies",
    action,
    {
      action,
      blocked_issue_id: blocked.id,
      blocked_issue: formatIssue(blocked, context.gh, context.baseUrl),
      blocking_issue_id: blocking.id,
      blocking_issue: formatIssue(blocking, context.gh, context.baseUrl),
      repository: formatRepo(repo, context.gh, context.baseUrl),
      sender: formatUser(actor, context.baseUrl),
    },
    ownerLoginOf(context.gh, repo),
    repo.name,
  );
}

interface GraphQLRequestBody {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readGraphQLBody(c: Context<AppEnv>): Promise<GraphQLRequestBody | { error: string }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { error: "Problems parsing JSON" };
  }

  if (!isRecord(raw)) return { error: "GraphQL request body must be a JSON object" };

  const variables = raw.variables === undefined || raw.variables === null ? undefined : raw.variables;
  if (variables !== undefined && !isRecord(variables)) {
    return { error: "GraphQL variables must be a JSON object" };
  }

  return {
    query: typeof raw.query === "string" ? raw.query : "",
    variables,
    operationName:
      typeof raw.operationName === "string" && raw.operationName.length > 0 ? raw.operationName : undefined,
  };
}

function createRoot(context: ReturnType<typeof createGitHubGraphQLContext>, webhooks: RouteContext["webhooks"]) {
  return {
    repository: ({ owner, name }: { owner: string; name: string }) => {
      requireGitHubGraphQLAuth(context);
      const repo = findVisibleRepository(context, owner, name);
      return repo ? repositoryView(context, repo) : null;
    },
    node: ({ id }: { id: string }) => {
      requireGitHubGraphQLAuth(context);
      const node = resolveVisibleNode(context, id);
      return node ? resolvedNodeView(context, node) : null;
    },
    rateLimit: () => {
      requireGitHubGraphQLAuth(context);
      const rateLimit = getGitHubGraphQLRateLimit(context.store);
      return {
        limit: rateLimit.limit,
        remaining: rateLimit.remaining,
        used: rateLimit.used,
        resetAt: new Date(rateLimit.resetAt * 1000).toISOString(),
        cost: rateLimit.cost,
      };
    },
    addSubIssue: ({
      input,
    }: {
      input: { parentIssueId: string; childIssueId: string; replaceParent?: boolean; clientMutationId?: string | null };
    }) => {
      const parent = relationshipIssue(context, input.parentIssueId);
      const child = relationshipIssue(context, input.childIssueId);
      assertRepoPermission(context.gh, context.authUser, parent.repo, "issues", "write");
      assertRepoPermission(context.gh, context.authUser, child.repo, "issues", "read");
      const actor = assertAuthenticatedActor(context.gh, context.authUser);
      const result = addSubIssue(context.gh, parent.issue.id, child.issue.id, { replaceParent: input.replaceParent });
      const action = "sub_issue_added";
      const childAction = "parent_issue_added";
      if (result.replacedParentId !== null) {
        const replacedParent = relationshipIssue(
          context,
          context.gh.issues.get(result.replacedParentId)?.node_id ?? "",
        );
        const removedAction = "sub_issue_removed";
        const removedChildAction = "parent_issue_removed";
        insertRelationshipEvent(context, replacedParent.repo, replacedParent.issue, actor, removedAction, {
          parent_issue_id: replacedParent.issue.id,
          sub_issue_id: child.issue.id,
        });
        insertRelationshipEvent(context, child.repo, child.issue, actor, removedChildAction, {
          parent_issue_id: replacedParent.issue.id,
          sub_issue_id: child.issue.id,
        });
        dispatchRelationshipWebhook(context, webhooks, replacedParent.repo, removedAction, {
          action: removedAction,
          parent_issue_id: replacedParent.issue.id,
          parent_issue: formatIssue(replacedParent.issue, context.gh, context.baseUrl),
          sub_issue_id: child.issue.id,
          sub_issue: formatIssue(child.issue, context.gh, context.baseUrl),
          repository: formatRepo(replacedParent.repo, context.gh, context.baseUrl),
          sender: formatUser(actor, context.baseUrl),
        });
        dispatchRelationshipWebhook(context, webhooks, child.repo, removedChildAction, {
          action: removedChildAction,
          parent_issue_id: replacedParent.issue.id,
          parent_issue: formatIssue(replacedParent.issue, context.gh, context.baseUrl),
          sub_issue_id: child.issue.id,
          sub_issue: formatIssue(child.issue, context.gh, context.baseUrl),
          repository: formatRepo(child.repo, context.gh, context.baseUrl),
          sender: formatUser(actor, context.baseUrl),
        });
      }
      insertRelationshipEvent(context, parent.repo, parent.issue, actor, action, {
        parent_issue_id: parent.issue.id,
        sub_issue_id: child.issue.id,
      });
      insertRelationshipEvent(context, child.repo, child.issue, actor, childAction, {
        parent_issue_id: parent.issue.id,
        sub_issue_id: child.issue.id,
      });
      dispatchRelationshipWebhook(context, webhooks, parent.repo, action, {
        action,
        parent_issue_id: parent.issue.id,
        parent_issue: formatIssue(parent.issue, context.gh, context.baseUrl),
        sub_issue_id: child.issue.id,
        sub_issue: formatIssue(child.issue, context.gh, context.baseUrl),
        repository: formatRepo(parent.repo, context.gh, context.baseUrl),
        sender: formatUser(actor, context.baseUrl),
      });
      dispatchRelationshipWebhook(context, webhooks, child.repo, childAction, {
        action: childAction,
        parent_issue_id: parent.issue.id,
        parent_issue: formatIssue(parent.issue, context.gh, context.baseUrl),
        sub_issue_id: child.issue.id,
        sub_issue: formatIssue(child.issue, context.gh, context.baseUrl),
        repository: formatRepo(child.repo, context.gh, context.baseUrl),
        sender: formatUser(actor, context.baseUrl),
      });
      return {
        parentIssue: issueView(context, parent.issue, parent.repo),
        subIssue: issueView(context, child.issue, child.repo),
        childIssue: issueView(context, child.issue, child.repo),
        clientMutationId: input.clientMutationId ?? null,
      };
    },
    addBlockedBy: ({
      input,
    }: {
      input: {
        issueId?: string | null;
        blockedIssueId?: string | null;
        blockingIssueId: string;
        clientMutationId?: string | null;
      };
    }) => {
      const blockedId = input.issueId ?? input.blockedIssueId;
      if (!blockedId) throw new ApiError(400, "issueId is required");
      const blocked = relationshipIssue(context, blockedId);
      const blocking = relationshipIssue(context, input.blockingIssueId);
      assertRepoPermission(context.gh, context.authUser, blocked.repo, "issues", "write");
      assertRepoPermission(context.gh, context.authUser, blocking.repo, "issues", "read");
      const actor = assertAuthenticatedActor(context.gh, context.authUser);
      addIssueDependency(context.gh, blocked.issue.id, blocking.issue.id);
      const action = "blocked_by_added";
      const blockingAction = "blocking_added";
      insertRelationshipEvent(context, blocked.repo, blocked.issue, actor, action, {
        blocked_issue_id: blocked.issue.id,
        blocking_issue_id: blocking.issue.id,
      });
      insertRelationshipEvent(context, blocking.repo, blocking.issue, actor, blockingAction, {
        blocked_issue_id: blocked.issue.id,
        blocking_issue_id: blocking.issue.id,
      });
      dispatchDependencyWebhook(context, webhooks, blocked.repo, actor, action, blocked.issue, blocking.issue);
      dispatchDependencyWebhook(context, webhooks, blocking.repo, actor, blockingAction, blocked.issue, blocking.issue);
      return {
        issue: issueView(context, blocked.issue, blocked.repo),
        blockedIssue: issueView(context, blocked.issue, blocked.repo),
        blockedBy: issueView(context, blocking.issue, blocking.repo),
        blockingIssue: issueView(context, blocking.issue, blocking.repo),
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  };
}

async function runGraphQL(
  query: string,
  opts: {
    variables?: Record<string, unknown>;
    operationName?: string;
    context: ReturnType<typeof createGitHubGraphQLContext>;
    webhooks: RouteContext["webhooks"];
  },
): Promise<ExecutionResult> {
  if (!query.trim()) return { errors: [{ message: "GraphQL query is required" } as GraphQLError] };

  return graphql({
    schema,
    source: query,
    rootValue: createRoot(opts.context, opts.webhooks),
    contextValue: opts.context,
    variableValues: opts.variables,
    operationName: opts.operationName,
  });
}

function statusFromGraphQLResult(result: ExecutionResult): number {
  for (const error of result.errors ?? []) {
    const originalError = error.originalError as { status?: unknown } | undefined;
    if (originalError?.status === 401 || originalError?.status === 403) return originalError.status;
  }

  // Parse, validation, and variable-coercion errors have no response path.
  // Resolver failures retain HTTP 200 with a GraphQL error envelope.
  if ((result.errors ?? []).some((error) => error.path === undefined)) return 400;
  return 200;
}

function graphQLRequestError(message: string): ResponseBody {
  return { errors: [{ message }] };
}

type ResponseBody = { errors: Array<{ message: string }> };

export function graphqlRoutes({ app, store, baseUrl, webhooks }: RouteContext): void {
  app.post("/graphql", async (c) => {
    const context = createGitHubGraphQLContext(store, c.get("authUser"), baseUrl);
    if (!context.authUser) {
      return c.json(graphQLRequestError("Requires authentication"), 401);
    }

    const body = await readGraphQLBody(c);
    if ("error" in body) return c.json(graphQLRequestError(body.error), 400);

    // Keep the GraphQL bucket independent from the core REST bucket while
    // consuming exactly one cost unit for every accepted GraphQL request.
    consumeGitHubGraphQLRateLimit(store);

    const result = await runGraphQL(body.query, {
      variables: body.variables,
      operationName: body.operationName,
      context,
      webhooks,
    });
    return c.json(result, statusFromGraphQLResult(result));
  });
}
