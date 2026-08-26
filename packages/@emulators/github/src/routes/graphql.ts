import { buildSchema, graphql, type ExecutionResult, type GraphQLError } from "graphql";
import { ApiError, type Context, type RouteContext, type AppEnv } from "@emulators/core";
import {
  createGitHubGraphQLContext,
  findVisibleRepository,
  requireGitHubGraphQLAuth,
  resolveVisibleNode,
} from "../graphql/context.js";
import { addIssueDependencyWithEvents, addSubIssueWithEvents } from "../issue-relationships.js";
import { assertAuthenticatedActor, assertIssueWrite, assertRepoPermission } from "../route-helpers.js";
import type { GitHubIssue, GitHubLabel, GitHubRepo } from "../entities.js";
import { consumeGitHubGraphQLRateLimit, getGitHubGraphQLRateLimit } from "../graphql/rate-limit.js";
import { githubGraphQLSchema } from "../graphql/schema.js";
import { issueCommentView, issueView, labelView, repositoryView, resolvedNodeView } from "../graphql/views.js";
import { createIssue, deleteIssue as deleteIssueOperation, transitionIssueLifecycle } from "../operations/issues.js";
import { createIssueComment } from "../operations/comments.js";
import { createRepositoryLabel, deleteRepositoryLabel } from "../operations/labels.js";

const schema = buildSchema(githubGraphQLSchema);

function relationshipIssue(
  context: ReturnType<typeof createGitHubGraphQLContext>,
  nodeId: string,
): { issue: GitHubIssue; repo: GitHubRepo } {
  const node = resolveVisibleNode(context, nodeId);
  if (!node || node.kind !== "Issue") throw new ApiError(404, "Issue not found");
  return { issue: node.issue, repo: node.repo };
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

function requireRepository(context: ReturnType<typeof createGitHubGraphQLContext>, id: string): GitHubRepo {
  const repo = context.gh.repos.all().find((candidate) => candidate.node_id === id);
  if (!repo) throw new ApiError(404, "Not Found");
  return repo;
}

function requireIssue(context: ReturnType<typeof createGitHubGraphQLContext>, id: string): GitHubIssue {
  const issue = context.gh.issues.all().find((candidate) => candidate.node_id === id);
  if (!issue || issue.is_pull_request) throw new ApiError(404, "Not Found");
  return issue;
}

function requireLabel(context: ReturnType<typeof createGitHubGraphQLContext>, id: string): GitHubLabel {
  const label = context.gh.labels.all().find((candidate) => candidate.node_id === id);
  if (!label) throw new ApiError(404, "Not Found");
  return label;
}

function mutationId(input: { clientMutationId?: string | null }): string | null {
  return input.clientMutationId ?? null;
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
      addSubIssueWithEvents(
        { gh: context.gh, webhooks, baseUrl: context.baseUrl, actor },
        parent.issue.id,
        child.issue.id,
        { replaceParent: input.replaceParent },
      );
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
      if (input.issueId && input.blockedIssueId && input.issueId !== input.blockedIssueId) {
        throw new ApiError(400, "issueId and blockedIssueId must refer to the same issue");
      }
      const blockedId = input.issueId ?? input.blockedIssueId;
      if (!blockedId) throw new ApiError(400, "issueId is required");
      const blocked = relationshipIssue(context, blockedId);
      const blocking = relationshipIssue(context, input.blockingIssueId);
      assertRepoPermission(context.gh, context.authUser, blocked.repo, "issues", "write");
      assertRepoPermission(context.gh, context.authUser, blocking.repo, "issues", "read");
      const actor = assertAuthenticatedActor(context.gh, context.authUser);
      addIssueDependencyWithEvents(
        { gh: context.gh, webhooks, baseUrl: context.baseUrl, actor },
        blocked.issue.id,
        blocking.issue.id,
      );
      return {
        issue: issueView(context, blocked.issue, blocked.repo),
        blockedIssue: issueView(context, blocked.issue, blocked.repo),
        blockedBy: issueView(context, blocking.issue, blocking.repo),
        blockingIssue: issueView(context, blocking.issue, blocking.repo),
        clientMutationId: input.clientMutationId ?? null,
      };
    },
    createIssue: ({
      input,
    }: {
      input: { repositoryId: string; title: string; body?: string | null; clientMutationId?: string | null };
    }) => {
      const repo = requireRepository(context, input.repositoryId);
      const actor = assertIssueWrite(context.gh, requireGitHubGraphQLAuth(context), repo);
      const issue = createIssue(
        { gh: context.gh, webhooks, baseUrl: context.baseUrl },
        { repo, actor, title: input.title, body: input.body },
      );
      return { clientMutationId: mutationId(input), issue: issueView(context, issue, repo) };
    },
    closeIssue: ({ input }: { input: { issueId: string; clientMutationId?: string | null } }) => {
      const issue = requireIssue(context, input.issueId);
      const repo = context.gh.repos.get(issue.repo_id);
      if (!repo) throw new ApiError(404, "Not Found");
      const actor = assertIssueWrite(context.gh, requireGitHubGraphQLAuth(context), repo);
      const result = transitionIssueLifecycle(
        { gh: context.gh, webhooks, baseUrl: context.baseUrl },
        { repo, issue, actor, state: "closed" },
      );
      return { clientMutationId: mutationId(input), issue: issueView(context, result.issue, repo) };
    },
    reopenIssue: ({ input }: { input: { issueId: string; clientMutationId?: string | null } }) => {
      const issue = requireIssue(context, input.issueId);
      const repo = context.gh.repos.get(issue.repo_id);
      if (!repo) throw new ApiError(404, "Not Found");
      const actor = assertIssueWrite(context.gh, requireGitHubGraphQLAuth(context), repo);
      const result = transitionIssueLifecycle(
        { gh: context.gh, webhooks, baseUrl: context.baseUrl },
        { repo, issue, actor, state: "open" },
      );
      return { clientMutationId: mutationId(input), issue: issueView(context, result.issue, repo) };
    },
    addComment: ({ input }: { input: { subjectId: string; body: string; clientMutationId?: string | null } }) => {
      const issue = requireIssue(context, input.subjectId);
      const repo = context.gh.repos.get(issue.repo_id);
      if (!repo) throw new ApiError(404, "Not Found");
      const actor = assertIssueWrite(context.gh, requireGitHubGraphQLAuth(context), repo);
      const result = createIssueComment(
        { gh: context.gh, webhooks, baseUrl: context.baseUrl },
        { repo, issue, actor, body: input.body },
      );
      return {
        clientMutationId: mutationId(input),
        comment: issueCommentView(context, result.comment, result.issue, repo),
      };
    },
    createLabel: ({
      input,
    }: {
      input: {
        repositoryId: string;
        name: string;
        color?: string | null;
        description?: string | null;
        clientMutationId?: string | null;
      };
    }) => {
      const repo = requireRepository(context, input.repositoryId);
      const actor = assertIssueWrite(context.gh, requireGitHubGraphQLAuth(context), repo);
      const label = createRepositoryLabel(
        { gh: context.gh, webhooks, baseUrl: context.baseUrl },
        { repo, actor, name: input.name, color: input.color, description: input.description },
      );
      return { clientMutationId: mutationId(input), label: labelView(context, label, repo) };
    },
    deleteLabel: ({ input }: { input: { id: string; clientMutationId?: string | null } }) => {
      const label = requireLabel(context, input.id);
      const repo = context.gh.repos.get(label.repo_id);
      if (!repo) throw new ApiError(404, "Not Found");
      const actor = assertIssueWrite(context.gh, requireGitHubGraphQLAuth(context), repo);
      const deleted = deleteRepositoryLabel(
        { gh: context.gh, webhooks, baseUrl: context.baseUrl },
        { repo, actor, name: label.name },
      );
      return { clientMutationId: mutationId(input), label: labelView(context, deleted, repo) };
    },
    deleteIssue: ({ input }: { input: { issueId: string; clientMutationId?: string | null } }) => {
      const issue = requireIssue(context, input.issueId);
      const repo = context.gh.repos.get(issue.repo_id);
      if (!repo) throw new ApiError(404, "Not Found");
      assertIssueWrite(context.gh, requireGitHubGraphQLAuth(context), repo);
      deleteIssueOperation({ gh: context.gh, webhooks, baseUrl: context.baseUrl }, { repo, issue });
      return { clientMutationId: mutationId(input), repository: repositoryView(context, repo) };
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
