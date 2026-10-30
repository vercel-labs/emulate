import {
  RateLimiter,
  remaining,
  setRateLimitHeaders,
  type Context,
  type RateLimitBucket,
  type RouteContext,
} from "@emulators/core";
import {
  GraphQLError,
  Kind,
  buildSchema,
  defaultFieldResolver,
  execute,
  parse,
  getOperationAST,
  isLeafType,
  isObjectType,
  specifiedRules,
  validate,
  valueFromAST,
  type DocumentNode,
  type ExecutionResult,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
} from "graphql";
import { getGitHubStore } from "../store.js";
import { typeDefs } from "../graphql/schema.js";
import { GitHubGraphQLError, createContext, type RateLimitView } from "../graphql/context.js";
import { createMutationRoot, createQueryRoot } from "../graphql/resolvers.js";
import { isConnectionField, paginationError, queryCost, selectsPage } from "../graphql/limits.js";

const schema = buildSchema(typeDefs);

// GitHub checks `first`/`last` on every connection before resolving it.
for (const type of Object.values(schema.getTypeMap())) {
  if (!isObjectType(type) || type.name.startsWith("__")) continue;
  for (const field of Object.values(type.getFields())) {
    if (!isConnectionField(field.args)) continue;
    field.resolve = (source, args, context, info) => {
      const error = paginationError(info.fieldName, args, selectsPage(info.fieldNodes, info.fragments));
      if (error) throw error;
      return defaultFieldResolver(source, args, context, info);
    };
  }
}

export const GRAPHQL_PATHS = ["/graphql", "/api/graphql"];

const NULLABILITY_CONFLICT = /^Fields "\w+" conflict because they return conflicting types "(\w+)!?" and "(\w+)!?"\./;

// GitHub accepts `...on User{name} ...on Team{name}`, where the two leaf fields differ only in
// nullability, and gh sends it. graphql-js rejects it; every other overlap conflict stays an error.
function isNullabilityOnlyConflict(error: GraphQLError): boolean {
  const match = NULLABILITY_CONFLICT.exec(error.message);
  return match !== null && match[1] === match[2] && isLeafType(schema.getType(match[1]));
}

interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function parseVariables(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readBody(c: Context): Promise<GraphQLRequest> {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    query: typeof body.query === "string" ? body.query : "",
    variables:
      body.variables && typeof body.variables === "object" ? (body.variables as Record<string, unknown>) : undefined,
    operationName: typeof body.operationName === "string" ? body.operationName : undefined,
  };
}

const UNDEFINED_FIELD = /^Cannot query field "(\w+)" on type "(\w+)"\./;

function githubMessage(message: string): string {
  const match = UNDEFINED_FIELD.exec(message);
  return match ? `Field '${match[1]}' doesn't exist on type '${match[2]}'` : message;
}

function fragmentsOf(document: DocumentNode): Record<string, FragmentDefinitionNode> {
  const fragments: Record<string, FragmentDefinitionNode> = {};
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments[definition.name.value] = definition;
  }
  return fragments;
}

type RateLimitQuery = "none" | "only" | "dryRun";

// GitHub does not charge a query that only reads `rateLimit`, and `rateLimit(dryRun: true)` answers
// with the cost alone, without running the rest of the query.
function rateLimitQuery(operation: OperationDefinitionNode, variables: Record<string, unknown>): RateLimitQuery {
  if (operation.operation !== "query") return "none";
  const fields = operation.selectionSet.selections.filter((s) => s.kind === Kind.FIELD);
  const rateLimit = fields.filter((f) => f.name.value === "rateLimit");
  if (rateLimit.length === 0) return "none";
  const dryRunArg = schema
    .getQueryType()!
    .getFields()
    .rateLimit.args.find((a) => a.name === "dryRun")!;
  const dryRun = rateLimit.some((f) => {
    const node = f.arguments?.find((a) => a.name.value === "dryRun");
    return node !== undefined && valueFromAST(node.value, dryRunArg.type, variables) === true;
  });
  if (dryRun) return "dryRun";
  return fields.length === operation.selectionSet.selections.length && fields.length === rateLimit.length
    ? "only"
    : "none";
}

function onlyRateLimit(document: DocumentNode, operation: OperationDefinitionNode): DocumentNode {
  const selections = operation.selectionSet.selections.filter(
    (s) => s.kind === Kind.FIELD && s.name.value === "rateLimit",
  );
  return {
    ...document,
    definitions: document.definitions.map((d) =>
      d === operation ? { ...operation, selectionSet: { ...operation.selectionSet, selections } } : d,
    ),
  };
}

function rateLimitView(bucket: RateLimitBucket, cost: number, nodeCount: number): RateLimitView {
  return {
    cost,
    nodeCount,
    limit: bucket.limit,
    used: bucket.used,
    remaining: remaining(bucket),
    resetAt: new Date(bucket.resetAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

function formatResult(result: ExecutionResult) {
  if (!result.errors) return result;
  return {
    ...result,
    errors: result.errors.map((error: GraphQLError) => {
      const json = { ...error.toJSON(), message: githubMessage(error.message) };
      const original = error.originalError;
      return original instanceof GitHubGraphQLError && original.type ? { ...json, type: original.type } : json;
    }),
  };
}

export function graphqlRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  const fallbackLimiter = new RateLimiter();

  const run = async (c: Context, request: GraphQLRequest, method: "GET" | "POST") => {
    const authUser = c.get("authUser");
    const limiter = c.get("rateLimiter") ?? fallbackLimiter;
    const bucket = limiter.bucket(c.get("authToken") ?? "__anonymous__", "graphql");
    setRateLimitHeaders(c, bucket);
    if (!authUser) {
      return c.json(
        {
          message: "This endpoint requires you to be authenticated.",
          documentation_url:
            "https://docs.github.com/graphql/guides/forming-calls-with-graphql#authenticating-with-graphql",
        },
        401,
      );
    }
    if (!request.query) {
      return c.json({ errors: [{ message: "A query attribute must be specified and must be a string." }] }, 400);
    }

    const charge = (cost: number): Response | null => {
      const charged = limiter.charge(bucket, cost);
      setRateLimitHeaders(c, bucket);
      if (charged) return null;
      const subject = authUser.installation
        ? `installation ID ${authUser.installation.installationId}`
        : `user ID ${authUser.id}`;
      return c.json({
        errors: [{ type: "RATE_LIMITED", message: `API rate limit already exceeded for ${subject}.` }],
      });
    };

    let document: DocumentNode;
    try {
      document = parse(request.query);
    } catch (error) {
      return charge(1) ?? c.json(formatResult({ errors: [error as GraphQLError] }));
    }
    const validationErrors = validate(schema, document, specifiedRules).filter(
      (error) => !isNullabilityOnlyConflict(error),
    );
    if (validationErrors.length > 0) return charge(1) ?? c.json(formatResult({ errors: validationErrors }));
    const operation = getOperationAST(document, request.operationName);
    if (method === "GET" && operation?.operation === "mutation") {
      return c.json({ errors: [{ message: "Mutations are not allowed over GET. Use POST instead." }] }, 405);
    }

    const variables = request.variables ?? {};
    const { cost, nodeCount } = operation
      ? queryCost(schema, operation, fragmentsOf(document), variables)
      : { cost: 1, nodeCount: 0 };
    const kind = operation ? rateLimitQuery(operation, variables) : "none";
    if (kind === "none") {
      const limited = charge(cost);
      if (limited) return limited;
    }

    const context = createContext({
      app,
      gh,
      webhooks,
      baseUrl,
      authUser,
      authorization: c.req.header("Authorization") ?? "",
      rateLimit: () => rateLimitView(bucket, cost, nodeCount),
    });
    const result = await execute({
      schema,
      document: kind === "dryRun" && operation ? onlyRateLimit(document, operation) : document,
      rootValue: { ...createQueryRoot(context), ...createMutationRoot(context) },
      contextValue: context,
      variableValues: request.variables,
      operationName: request.operationName,
    });
    c.header("X-GitHub-Media-Type", "github.v4; format=json");
    return c.json(formatResult(result));
  };

  const get = (c: Context) =>
    run(
      c,
      {
        query: c.req.query("query") ?? "",
        variables: parseVariables(c.req.query("variables")),
        operationName: c.req.query("operationName") ?? undefined,
      },
      "GET",
    );
  const post = async (c: Context) => run(c, await readBody(c), "POST");

  for (const path of GRAPHQL_PATHS) {
    app.get(path, get);
    app.post(path, post);
  }
}
