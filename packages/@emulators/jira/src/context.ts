import type { AppEnv, Context, Store } from "@emulators/core";
import { getJiraStore, type JiraStore } from "./store.js";
import type { JiraUser } from "./entities.js";

export const GATEWAY_HEADER = "x-emulate-jira-cloud-id";

/** Route prefix for the platform REST API, matching both v2 and v3. */
export const API_V = "/rest/api/:v{[23]}";

export const READ = ["read:jira-work"];
export const WRITE = ["write:jira-work"];
export const MANAGE = ["manage:jira-project", "manage:jira-configuration"];

export class JiraError extends Error {
  constructor(
    public status: number,
    public errorMessages: string[] = [],
    public errors: Record<string, string> = {},
  ) {
    super(errorMessages[0] ?? Object.values(errors)[0] ?? "Jira error");
    this.name = "JiraError";
  }
}

export const issueNotFound = () =>
  new JiraError(404, ["Issue does not exist or you do not have permission to see it."]);

export const fieldError = (field: string, message: string) => new JiraError(400, [], { [field]: message });

export interface JiraRequest {
  c: Context<AppEnv>;
  store: Store;
  js: JiraStore;
  version: "2" | "3";
  /** Root used for `self` links: the base URL, or the api.atlassian.com style gateway prefix. */
  siteUrl: string;
  baseUrl: string;
  user: JiraUser;
  /** OAuth scopes granted to the token, or null for API tokens with the user's full permissions. */
  scopes: string[] | null;
  /** OAuth client that owns the access token, when the request used OAuth. */
  clientId: string | null;
}

/** Request for an endpoint that also serves anonymous callers, so there may be no user. */
export interface PublicJiraRequest extends Omit<JiraRequest, "user" | "scopes"> {
  user: JiraUser | null;
  scopes: string[] | null;
}

export interface HandlerOptions {
  /** Defaults to true. When false, anonymous requests are allowed and the handler gets a `PublicJiraRequest`. */
  auth?: boolean;
  /** OAuth scopes required when strict scope checking is enabled. Any one of them is enough. */
  scopes?: string[];
}

type JiraHandler = (r: JiraRequest) => Response | Promise<Response>;
type PublicJiraHandler = (r: PublicJiraRequest) => Response | Promise<Response>;
type RouteHandler = (c: Context<AppEnv>) => Promise<Response>;

export function jiraErrorResponse(c: Context<AppEnv>, err: JiraError): Response {
  return c.json({ errorMessages: err.errorMessages, errors: err.errors }, err.status);
}

export function makeHandler(store: Store, baseUrl: string) {
  function handle(fn: PublicJiraHandler, opts: HandlerOptions & { auth: false }): RouteHandler;
  function handle(fn: JiraHandler, opts?: HandlerOptions): RouteHandler;
  function handle(fn: JiraHandler | PublicJiraHandler, opts: HandlerOptions = {}) {
    return async (c: Context<AppEnv>): Promise<Response> => {
      try {
        const js = getJiraStore(store);
        const version = c.req.param("v") === "2" ? "2" : "3";
        const gatewayCloudId = c.req.header(GATEWAY_HEADER);
        const siteUrl = gatewayCloudId ? `${baseUrl}/ex/jira/${gatewayCloudId}` : baseUrl;
        let user: JiraUser | undefined;
        let scopes: string[] | null = null;
        let clientId: string | null = null;
        const auth = authenticate(c, js);
        if (auth) {
          user = auth.user;
          scopes = auth.scopes;
          clientId = auth.clientId;
        } else if (opts.auth !== false) {
          throw new JiraError(401, ["Client must be authenticated to access this resource."]);
        }
        if (opts.scopes && scopes && store.getData<boolean>("jira.strict_scopes")) {
          if (!opts.scopes.some((scope) => scopes!.includes(scope))) {
            throw new JiraError(401, [
              `Unauthorized; scope does not match. Required one of: ${opts.scopes.join(", ")}`,
            ]);
          }
        }
        const request = { c, store, js, version, siteUrl, baseUrl, scopes, clientId } as const;
        if (opts.auth === false) return await (fn as PublicJiraHandler)({ ...request, user: user ?? null });
        // Authenticated routes threw above when there was no user.
        return await (fn as JiraHandler)({ ...request, user: user! });
      } catch (err) {
        if (err instanceof JiraError) return jiraErrorResponse(c, err);
        throw err;
      }
    };
  }
  return handle;
}

interface AuthResult {
  user: JiraUser;
  scopes: string[] | null;
  clientId: string | null;
}

/** Returns the authenticated user, undefined when no credentials were sent, or throws 401 for bad credentials. */
export function authenticate(c: Context<AppEnv>, js: JiraStore): AuthResult | undefined {
  const header = c.req.header("Authorization");
  if (!header) return undefined;
  const unauthorized = () => new JiraError(401, ["Client must be authenticated to access this resource."]);

  const basic = /^Basic\s+(.+)$/i.exec(header);
  if (basic) {
    const decoded = Buffer.from(basic[1].trim(), "base64").toString("utf-8");
    const sep = decoded.indexOf(":");
    if (sep < 0) throw unauthorized();
    const email = decoded.slice(0, sep).toLowerCase();
    const secret = decoded.slice(sep + 1);
    const user = js.users.all().find((u) => u.email.toLowerCase() === email);
    if (!user || !user.active) throw unauthorized();
    const valid = js.apiTokens.findBy("account_id", user.account_id).some((t) => t.token === secret);
    if (!valid) throw unauthorized();
    return { user, scopes: null, clientId: null };
  }

  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer) {
    const value = bearer[1].trim();
    const apiToken = js.apiTokens.findOneBy("token", value);
    if (apiToken) {
      const user = js.users.findOneBy("account_id", apiToken.account_id);
      if (user?.active) return { user, scopes: null, clientId: null };
      throw unauthorized();
    }
    const oauth = js.oauthTokens.findOneBy("token", value);
    if (!oauth || oauth.type !== "access" || oauth.revoked) throw unauthorized();
    if (oauth.expires_at && new Date(oauth.expires_at).getTime() <= Date.now()) throw unauthorized();
    const user = js.users.findOneBy("account_id", oauth.account_id);
    if (!user?.active) throw unauthorized();
    return { user, scopes: oauth.scopes, clientId: oauth.client_id };
  }

  throw unauthorized();
}

export async function readJson(c: Context<AppEnv>): Promise<any> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Invalid JSON";
    throw new JiraError(400, [`Unexpected character in request body: ${detail}`]);
  }
}

export function intParam(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

export interface PageParams {
  startAt: number;
  maxResults: number;
}

/** Reads `startAt` and `maxResults` query params. `maxResults` defaults to `defaultMax` and is capped at `cap`. */
export function pageParams(c: Context<AppEnv>, defaultMax: number, cap?: number): PageParams {
  return {
    startAt: intParam(c.req.query("startAt"), 0),
    maxResults: intParam(c.req.query("maxResults"), defaultMax, cap),
  };
}

/** Splits `a,b` query values and repeated `?x=a&x=b` params into one list. */
export function listParam(c: Context<AppEnv>, name: string): string[] {
  return (c.req.queries(name) ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}
