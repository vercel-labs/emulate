import type { Context, RouteContext } from "@emulators/core";
import { GraphQLError, buildSchema, graphql, type ExecutionResult } from "graphql";
import { getGitHubStore } from "../store.js";
import { typeDefs } from "../graphql/schema.js";
import { GitHubGraphQLError, createContext } from "../graphql/context.js";
import { createMutationRoot, createQueryRoot } from "../graphql/resolvers.js";

const schema = buildSchema(typeDefs);

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

function formatResult(result: ExecutionResult) {
  if (!result.errors) return result;
  return {
    ...result,
    errors: result.errors.map((error: GraphQLError) => {
      const json = error.toJSON();
      const original = error.originalError;
      return original instanceof GitHubGraphQLError ? { ...json, type: original.type } : json;
    }),
  };
}

export function graphqlRoutes({ app, store, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  const execute = async (c: Context, request: GraphQLRequest) => {
    const authUser = c.get("authUser");
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

    const context = createContext({
      app,
      gh,
      baseUrl,
      authUser,
      authorization: c.req.header("Authorization") ?? "",
    });
    const result = await graphql({
      schema,
      source: request.query,
      rootValue: { ...createQueryRoot(context), ...createMutationRoot(context) },
      contextValue: context,
      variableValues: request.variables,
      operationName: request.operationName,
    });
    c.header("X-GitHub-Media-Type", "github.v4; format=json");
    return c.json(formatResult(result));
  };

  const get = (c: Context) =>
    execute(c, {
      query: c.req.query("query") ?? "",
      variables: parseVariables(c.req.query("variables")),
      operationName: c.req.query("operationName") ?? undefined,
    });
  const post = async (c: Context) => execute(c, await readBody(c));

  for (const path of ["/graphql", "/api/graphql"]) {
    app.get(path, get);
    app.post(path, post);
  }

  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    app.on(method, "/api/v3/:path{.*}", (c) => {
      const url = new URL(c.req.url);
      url.pathname = url.pathname.slice("/api/v3".length) || "/";
      return app.fetch(new Request(url, c.req.raw));
    });
  }
}
