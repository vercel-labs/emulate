import { ApiError, type AppEnv, type AuthUser, type Hono, type WebhookDispatcher } from "@emulators/core";
import type { GitHubStore } from "../store.js";
import type { GitHubRepo, GitHubUser } from "../entities.js";
import {
  assertAuthenticatedActor,
  canAccessRepo,
  canAccessRepoWithPermission,
  getActorUser,
  hasRepoAdmin,
  hasRepoContentsWrite,
} from "../route-helpers.js";

export type GitHubErrorType =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "UNPROCESSABLE"
  | "INTERNAL"
  | "INVALID_CURSOR_ARGUMENTS"
  | "INVALID_PAGINATION"
  | "EXCESSIVE_PAGINATION"
  | "MISSING_PAGINATION_BOUNDARIES";

export class GitHubGraphQLError extends Error {
  constructor(
    readonly type: GitHubErrorType | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface GraphQLContext {
  gh: GitHubStore;
  webhooks: WebhookDispatcher;
  baseUrl: string;
  authUser: AuthUser;
  viewer: GitHubUser | undefined;
  rest: (method: string, path: string, body?: unknown) => Promise<any>;
}

export function createContext(opts: {
  app: Hono<AppEnv>;
  gh: GitHubStore;
  webhooks: WebhookDispatcher;
  baseUrl: string;
  authUser: AuthUser;
  authorization: string;
}): GraphQLContext {
  const { app, gh, webhooks, baseUrl, authUser, authorization } = opts;
  return {
    gh,
    webhooks,
    baseUrl,
    authUser,
    viewer: authUser.installation ? assertAuthenticatedActor(gh, authUser) : getActorUser(gh, authUser),
    rest: async (method, path, body) => {
      const res = await app.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: { Authorization: authorization, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      const text = await res.text();
      const json = parseJson(text);
      if (res.ok) return json;
      throw restError(res.status, json);
    },
  };
}

function parseJson(text: string): any {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** GitHub reports a REST validation failure's `errors[]` messages, joined, as the GraphQL error message. */
export function restError(status: number, body: { message?: unknown; errors?: unknown } | null): GitHubGraphQLError {
  const details = Array.isArray(body?.errors)
    ? body.errors.map((e: { message?: unknown }) => e?.message).filter((m): m is string => typeof m === "string")
    : [];
  const message =
    details.length > 0
      ? details.join(", ")
      : typeof body?.message === "string"
        ? body.message
        : `Request failed with status ${status}`;
  return new GitHubGraphQLError(errorTypeForStatus(status), message);
}

export function preflight<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof ApiError) throw restError(error.status, error);
    throw error;
  }
}

function errorTypeForStatus(status: number): GitHubErrorType {
  if (status === 404) return "NOT_FOUND";
  if (status === 401 || status === 403) return "FORBIDDEN";
  if (status === 422 || status === 409) return "UNPROCESSABLE";
  return "INTERNAL";
}

const NODE_ID = /^0:([A-Za-z]+?)(\d+)$/;

export function decodeNodeId(id: string): { type: string; id: number } | null {
  const match = NODE_ID.exec(Buffer.from(id, "base64").toString("utf8"));
  return match ? { type: match[1], id: Number(match[2]) } : null;
}

export function notFound(message: string): GitHubGraphQLError {
  return new GitHubGraphQLError("NOT_FOUND", message);
}

export function canSeeRepo(ctx: GraphQLContext, repo: GitHubRepo | undefined): repo is GitHubRepo {
  return repo !== undefined && canAccessRepo(ctx.gh, ctx.authUser, repo);
}

export type RepoPermission = "checks" | "contents" | "issues" | "pull_requests";

export function canRead(
  ctx: GraphQLContext,
  repo: GitHubRepo | undefined,
  permissions: RepoPermission[],
): repo is GitHubRepo {
  return repo !== undefined && canAccessRepoWithPermission(ctx.gh, ctx.authUser, repo, permissions, "read");
}

export function assertCanRead(ctx: GraphQLContext, repo: GitHubRepo, permissions: RepoPermission[]): void {
  if (!canRead(ctx, repo, permissions)) {
    throw new GitHubGraphQLError("FORBIDDEN", "Resource not accessible by integration");
  }
}

export function assertCanTriage(ctx: GraphQLContext, repo: GitHubRepo): void {
  const { gh, authUser, viewer } = ctx;
  const allowed = authUser.installation
    ? canAccessRepoWithPermission(gh, authUser, repo, ["issues", "pull_requests"], "write")
    : viewer !== undefined &&
      (hasRepoAdmin(gh, viewer, repo) ||
        hasRepoContentsWrite(gh, viewer, repo) ||
        gh.collaborators.findBy("repo_id", repo.id).some((c) => c.user_id === viewer.id && c.permission === "triage"));
  if (!allowed) {
    throw new GitHubGraphQLError(
      "FORBIDDEN",
      `${authUser.login} does not have permission to update metadata on ${repo.full_name}.`,
    );
  }
}
