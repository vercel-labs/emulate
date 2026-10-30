import type { AppEnv, AuthUser, Hono } from "@emulators/core";
import type { GitHubStore } from "../store.js";
import type { GitHubRepo, GitHubUser } from "../entities.js";
import { canAccessRepo, getActorUser } from "../route-helpers.js";

export type GitHubErrorType = "NOT_FOUND" | "FORBIDDEN" | "UNPROCESSABLE" | "INTERNAL";

export class GitHubGraphQLError extends Error {
  constructor(
    readonly type: GitHubErrorType,
    message: string,
  ) {
    super(message);
  }
}

export interface GraphQLContext {
  gh: GitHubStore;
  baseUrl: string;
  authUser: AuthUser;
  viewer: GitHubUser | undefined;
  rest: (method: string, path: string, body?: unknown) => Promise<any>;
}

export function createContext(opts: {
  app: Hono<AppEnv>;
  gh: GitHubStore;
  baseUrl: string;
  authUser: AuthUser;
  authorization: string;
}): GraphQLContext {
  const { app, gh, baseUrl, authUser, authorization } = opts;
  return {
    gh,
    baseUrl,
    authUser,
    viewer: getActorUser(gh, authUser),
    rest: async (method, path, body) => {
      const res = await app.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: { Authorization: authorization, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (res.ok) return json;
      const message = typeof json?.message === "string" ? json.message : `Request failed with status ${res.status}`;
      throw new GitHubGraphQLError(errorTypeForStatus(res.status), message);
    },
  };
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
