import { expect } from "vitest";
import { Hono } from "@emulators/core";
import { Store, WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";

export const base = "http://localhost:4000";
export const DEFAULT_GRAPHQL_TOKEN = "octocat-token";

export function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("octocat-token", { login: "octocat", id: 1, scopes: ["repo", "user"] });
  tokenMap.set("outsider-token", { login: "outsider", id: 2, scopes: ["repo", "user"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "outsider" }],
    repos: [
      { owner: "octocat", name: "hello-world" },
      { owner: "octocat", name: "public-canonical" },
      { owner: "octocat", name: "private-repo", private: true },
    ],
  });

  return { app, store, tokenMap, webhooks };
}

export function headers(token = "octocat-token"): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export function addInstallationToken(
  store: Store,
  tokenMap: TokenMap,
  token: string,
  options: { permissions: Record<string, string>; repositorySelection: "all" | "selected"; repositoryIds: number[] },
) {
  const gh = getGitHubStore(store);
  const owner = gh.users.findOneBy("login", "octocat")!;
  tokenMap.set(token, {
    login: owner.login,
    id: owner.id,
    scopes: Object.entries(options.permissions).map(([name, level]) => `${name}:${level}`),
    installation: {
      installationId: 42,
      appId: 9,
      accountId: owner.id,
      accountType: "User",
      permissions: options.permissions,
      repositoryIds: options.repositoryIds,
      repositorySelection: options.repositorySelection,
    },
  });
}

export async function graphql(
  app: Hono,
  query: string,
  variables?: Record<string, unknown>,
  operationName?: string,
  token = DEFAULT_GRAPHQL_TOKEN,
) {
  return app.request(`${base}/graphql`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ query, variables, operationName }),
  });
}

export interface GraphQLResponse {
  data?: {
    repository?: unknown;
    node?: unknown;
    rateLimit?: { limit: number; remaining: number; used: number; cost: number };
  };
  errors?: Array<{ message: string }>;
}

export async function responseBody(response: Response): Promise<GraphQLResponse> {
  return (await response.json()) as GraphQLResponse;
}

export async function createFixture(app: Hono) {
  const issueResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ title: "GraphQL issue", body: "Issue body" }),
  });
  expect(issueResponse.status).toBe(201);
  const issue = (await issueResponse.json()) as { node_id: string; number: number };

  const commentResponse = await app.request(`${base}/repos/octocat/hello-world/issues/${issue.number}/comments`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ body: "GraphQL comment" }),
  });
  expect(commentResponse.status).toBe(201);
  const comment = (await commentResponse.json()) as { node_id: string };

  const labelResponse = await app.request(`${base}/repos/octocat/hello-world/labels`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name: "graphql", color: "5319E7" }),
  });
  expect(labelResponse.status).toBe(201);
  const label = (await labelResponse.json()) as { node_id: string };

  const repoResponse = await app.request(`${base}/repos/octocat/hello-world`, {
    headers: headers(),
  });
  expect(repoResponse.status).toBe(200);
  const repo = (await repoResponse.json()) as { node_id: string };

  return { issue, comment, label, repo };
}

export async function createIssue(app: Hono, title: string) {
  const response = await app.request(`${base}/repos/octocat/hello-world/issues`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ title }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: number; node_id: string; number: number };
}
