import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { AppEnv, Context, ContentfulStatusCode, Handler, Hono } from "@emulators/core";
import type { GToken } from "./entities.js";
import { applyOData, ODataError, parseODataOptions, type ODataOptions, type Row } from "./odata.js";
import type { GStore } from "./store.js";

export type Body = Record<string, unknown>;
export type Json = Record<string, unknown>;

export const GRAPH_AUDIENCE = "https://graph.microsoft.com";
export const API_VERSIONS = ["v1.0", "beta"];
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 999;
export const ALL_PERMISSIONS = [
  "User.Read.All",
  "User.ReadWrite.All",
  "User.Invite.All",
  "Group.Read.All",
  "Group.ReadWrite.All",
  "Directory.Read.All",
  "Directory.ReadWrite.All",
  "RoleManagement.Read.Directory",
  "RoleManagement.ReadWrite.Directory",
  "Organization.Read.All",
];

export function guid(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function shortToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export class GraphApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function badRequest(message: string, code = "Request_BadRequest"): GraphApiError {
  return new GraphApiError(400, code, message);
}

export function notFound(
  message = "Resource does not exist or one of its queried reference-property objects are not present.",
  code = "Request_ResourceNotFound",
): GraphApiError {
  return new GraphApiError(404, code, message);
}

export function forbidden(
  message = "Insufficient privileges to complete the operation.",
  code = "Authorization_RequestDenied",
): GraphApiError {
  return new GraphApiError(403, code, message);
}

export function conflict(
  message = "A conflicting object with one or more of the specified property values is present in the directory.",
  code = "Request_BadRequest",
): GraphApiError {
  return new GraphApiError(400, code, message);
}

export function errorBody(c: Context, code: string, message: string): Json {
  return {
    error: {
      code,
      message,
      innerError: {
        date: new Date().toISOString(),
        "request-id": c.req.header("client-request-id") ?? guid(),
        "client-request-id": c.req.header("client-request-id") ?? guid(),
      },
    },
  };
}

export function sendApiError(c: Context, error: GraphApiError): Response {
  return c.json(errorBody(c, error.code, error.message), error.status as ContentfulStatusCode);
}

export function unauthorized(c: Context, message = "Access token is empty."): Response {
  c.header(
    "WWW-Authenticate",
    `Bearer realm="", authorization_uri="https://login.microsoftonline.com/common/oauth2/authorize", client_id="00000003-0000-0000-c000-000000000000"`,
  );
  return c.json(errorBody(c, "InvalidAuthenticationToken", message), 401);
}

const JWT_SECRET = "emulate-graph-jwt-secret";

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

export function issueJwt(claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ typ: "JWT", alg: "HS256", kid: "emulate-graph" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export interface AuthContext {
  token: GToken;
  tenantId: string;
}

export function authenticate(c: Context, gs: GStore): AuthContext | Response {
  const header = c.req.header("Authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return unauthorized(c);
  const raw = header.slice(7).trim();
  if (!raw) return unauthorized(c);
  const token = gs.tokens.findOneBy("token", raw);
  if (!token)
    return unauthorized(
      c,
      "Access token validation failure. Invalid audience or the token is unknown to the emulator.",
    );
  if (Date.parse(token.expires_at) < Date.now())
    return unauthorized(c, "Lifetime validation failed, the token is expired.");
  return { token, tenantId: token.tenant_id };
}

export function requirePermission(auth: AuthContext, ...anyOf: string[]): void {
  if (auth.token.roles.some((role) => anyOf.includes(role))) return;
  throw forbidden();
}

export type ApiHandler = (c: Context<AppEnv>, auth: AuthContext) => Promise<Response> | Response;

export function api(gs: GStore, handler: ApiHandler): Handler<AppEnv> {
  return async (c) => {
    const auth = authenticate(c, gs);
    if (auth instanceof Response) return auth;
    try {
      return await handler(c, auth);
    } catch (error) {
      if (error instanceof GraphApiError) return sendApiError(c, error);
      if (error instanceof ODataError) return sendApiError(c, badRequest(error.message, "Request_UnsupportedQuery"));
      throw error;
    }
  };
}

export function route(
  app: Hono<AppEnv>,
  method: "get" | "post" | "put" | "patch" | "delete",
  path: string,
  handler: Handler<AppEnv>,
): void {
  for (const version of API_VERSIONS) app[method](`/${version}${path}`, handler);
}

export async function parseJsonBody(c: Context): Promise<Body> {
  const text = await c.req.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw badRequest(
      "Unable to read JSON request payload. Please ensure Content-Type header is set and payload is of valid JSON format.",
    );
  }
}

export function str(value: unknown): string | undefined {
  if (value === undefined || value === null || typeof value === "object") return undefined;
  return String(value);
}

export function strOrNull(value: unknown): string | null {
  const text = str(value);
  return text === undefined || text === "" ? null : text;
}

export function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = str(value);
  if (text === undefined) return undefined;
  return text.toLowerCase() === "true";
}

export function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = str(value);
  return text ? [text] : [];
}

export function emailValid(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function odataOptions(c: Context): ODataOptions {
  const url = new URL(c.req.url);
  const options = parseODataOptions(url, MAX_PAGE_SIZE);
  const top = url.searchParams.get("$top") ?? url.searchParams.get("top");
  if (top === null) options.top = DEFAULT_PAGE_SIZE;
  const skiptoken = url.searchParams.get("$skiptoken") ?? url.searchParams.get("skiptoken");
  if (skiptoken) {
    const decoded = Number.parseInt(
      Buffer.from(skiptoken, "base64url")
        .toString("utf8")
        .replace(/^skip:/, ""),
      10,
    );
    if (!Number.isFinite(decoded) || decoded < 0) throw badRequest("Invalid $skiptoken", "Request_UnsupportedQuery");
    options.skip = decoded;
  }
  return options;
}

export function collection<T extends Row>(
  c: Context,
  baseUrl: string,
  version: string,
  entitySet: string,
  rows: T[],
  options: ODataOptions,
): Response {
  const search = new URL(c.req.url).searchParams.get("$search");
  let filtered = rows;
  if (search) {
    const match = search.match(/^"?([A-Za-z]+):(.+?)"?$/);
    const needle = (match ? match[2] : search).replace(/"/g, "").toLowerCase();
    const field = match ? match[1] : null;
    filtered = rows.filter((row) =>
      field
        ? String(row[field] ?? "")
            .toLowerCase()
            .includes(needle)
        : Object.values(row).some((value) =>
            String(value ?? "")
              .toLowerCase()
              .includes(needle),
          ),
    );
  }
  const page = applyOData(filtered, options);
  const body: Json = { "@odata.context": `${baseUrl}/${version}/$metadata#${entitySet}` };
  if (options.count) body["@odata.count"] = page.total;
  body.value = page.rows;
  if (page.hasMore) {
    const next = new URL(c.req.url);
    next.searchParams.delete("$skip");
    next.searchParams.set(
      "$skiptoken",
      Buffer.from(`skip:${(options.skip ?? 0) + (options.top ?? 0)}`).toString("base64url"),
    );
    body["@odata.nextLink"] = `${baseUrl}${next.pathname}${next.search}`;
  }
  return c.json(body);
}

export function entity(
  c: Context,
  baseUrl: string,
  version: string,
  entitySet: string,
  row: Row,
  status: 200 | 201 = 200,
): Response {
  const url = new URL(c.req.url);
  const select = url.searchParams.get("$select");
  let body: Row = row;
  if (select) {
    const fields = select.split(",").map((field) => field.trim());
    body = Object.fromEntries(
      Object.entries(row).filter(([key]) => fields.some((field) => field.toLowerCase() === key.toLowerCase())),
    );
  }
  return c.json({ "@odata.context": `${baseUrl}/${version}/$metadata#${entitySet}/$entity`, ...body }, status);
}

export function versionOf(c: Context): string {
  const match = new URL(c.req.url).pathname.match(/^\/(v1\.0|beta)\//);
  return match?.[1] ?? "v1.0";
}
