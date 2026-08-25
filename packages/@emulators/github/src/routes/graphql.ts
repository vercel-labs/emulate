import { buildSchema, graphql, type ExecutionResult, type GraphQLError } from "graphql";
import type { Context, RouteContext, AppEnv } from "@emulators/core";
import {
  createGitHubGraphQLContext,
  findVisibleRepository,
  requireGitHubGraphQLAuth,
  resolveVisibleNode,
} from "../graphql/context.js";
import { consumeGitHubGraphQLRateLimit, getGitHubGraphQLRateLimit } from "../graphql/rate-limit.js";
import { githubGraphQLSchema } from "../graphql/schema.js";
import { repositoryView, resolvedNodeView } from "../graphql/views.js";

const schema = buildSchema(githubGraphQLSchema);

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

function createRoot(context: ReturnType<typeof createGitHubGraphQLContext>) {
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
  };
}

async function runGraphQL(
  query: string,
  opts: {
    variables?: Record<string, unknown>;
    operationName?: string;
    context: ReturnType<typeof createGitHubGraphQLContext>;
  },
): Promise<ExecutionResult> {
  if (!query.trim()) return { errors: [{ message: "GraphQL query is required" } as GraphQLError] };

  return graphql({
    schema,
    source: query,
    rootValue: createRoot(opts.context),
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

export function graphqlRoutes({ app, store, baseUrl }: RouteContext): void {
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
    });
    return c.json(result, statusFromGraphQLResult(result));
  });
}
