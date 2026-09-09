import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { AppEnv, Context, ContentfulStatusCode, Handler, Hono } from "@emulators/core";
import type { DefToken } from "./entities.js";
import { applyOData, ODataError, parseODataOptions, type ODataOptions, type Row } from "./odata.js";
import type { DefStore } from "./store.js";

export type Body = Record<string, unknown>;

export const API_AUDIENCE = "https://api.securitycenter.microsoft.com";
export const DEFAULT_PAGE_SIZE = 10000;
export const ALL_ROLES = [
  "Machine.Read.All",
  "Machine.ReadWrite.All",
  "Alert.Read.All",
  "Alert.ReadWrite.All",
  "Vulnerability.Read.All",
  "Software.Read.All",
  "SecurityRecommendation.Read.All",
  "Ti.ReadWrite.All",
  "AdvancedQuery.Read.All",
  "User.Read.All",
  "Machine.Isolate",
  "Machine.Scan",
  "Machine.Offboard",
  "Machine.CollectForensics",
  "Machine.RestrictExecution",
  "Machine.StopAndQuarantine",
  "Machine.LiveResponse",
  "Score.Read.All",
  "RemediationTasks.Read.All",
];

export function guid(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function machineId(): string {
  return randomBytes(20).toString("hex");
}

export function alertId(): string {
  return `da${randomBytes(9).toString("hex")}_${Math.floor(Math.random() * 1e9)}`;
}

export function shortHex(length = 16): string {
  return randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
}

export interface DefErrorBody {
  error: { code: string; message: string; target: string };
}

export class DefApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function badRequest(message: string, code = "BadRequest"): DefApiError {
  return new DefApiError(400, code, message);
}

export function notFound(message: string, code = "NotFound"): DefApiError {
  return new DefApiError(404, code, message);
}

export function forbidden(message: string, code = "Forbidden"): DefApiError {
  return new DefApiError(403, code, message);
}

export function conflict(message: string, code = "ActiveRequestAlreadyExists"): DefApiError {
  return new DefApiError(400, code, message);
}

export function errorBody(c: Context, code: string, message: string): DefErrorBody {
  return { error: { code, message, target: c.req.header("x-ms-request-id") ?? guid() } };
}

export function sendApiError(c: Context, error: DefApiError): Response {
  return c.json(errorBody(c, error.code, error.message), error.status as ContentfulStatusCode);
}

export function unauthorized(c: Context, message = "Authorization has been denied for this request."): Response {
  c.header("WWW-Authenticate", `Bearer realm="${API_AUDIENCE}", error="invalid_token"`);
  return c.json(errorBody(c, "Unauthorized", message), 401);
}

const JWT_SECRET = "emulate-defender-jwt-secret";

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function issueJwt(claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ typ: "JWT", alg: "HS256", kid: "emulate-defender" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export interface AuthContext {
  token: DefToken;
  tenantId: string;
}

export function authenticate(c: Context, ds: DefStore): AuthContext | Response {
  const header = c.req.header("Authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return unauthorized(c);
  const raw = header.slice(7).trim();
  if (!raw) return unauthorized(c);
  const token = ds.tokens.findOneBy("token", raw);
  if (!token) return unauthorized(c, "IDX10214: Audience validation failed. The token is unknown to the emulator.");
  if (Date.parse(token.expires_at) < Date.now())
    return unauthorized(c, "IDX10223: Lifetime validation failed. The token is expired.");
  return { token, tenantId: token.tenant_id };
}

export type ApiHandler = (c: Context<AppEnv>, auth: AuthContext) => Promise<Response> | Response;

export function api(ds: DefStore, handler: ApiHandler): Handler<AppEnv> {
  return async (c) => {
    const auth = authenticate(c, ds);
    if (auth instanceof Response) return auth;
    try {
      return await handler(c, auth);
    } catch (error) {
      if (error instanceof DefApiError) return sendApiError(c, error);
      if (error instanceof ODataError) return sendApiError(c, badRequest(error.message, "InvalidQuery"));
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
  app[method](path, handler);
  if (path.startsWith("/api/")) app[method](path.slice(4), handler);
}

export async function parseJsonBody(c: Context): Promise<Body> {
  const text = await c.req.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw badRequest("Request body is not valid JSON", "InvalidRequestBody");
  }
}

export async function parseFormOrJson(c: Context): Promise<Body> {
  const contentType = c.req.header("content-type") ?? "";
  const text = await c.req.text();
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text || "{}");
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export function field(body: Body, ...names: string[]): unknown {
  for (const name of names) {
    const key = Object.keys(body).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (key !== undefined && body[key] !== undefined) return body[key];
  }
  return undefined;
}

export function str(value: unknown): string | undefined {
  if (value === undefined || value === null || typeof value === "object") return undefined;
  return String(value);
}

export function strOrNull(value: unknown): string | null {
  const text = str(value);
  return text === undefined || text === "" ? null : text;
}

export function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = str(value);
  if (text === undefined) return undefined;
  return text.toLowerCase() === "true" || text === "1";
}

export function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = str(value);
  return text
    ? text
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  const match = allowed.find((candidate) => candidate.toLowerCase() === text.toLowerCase());
  if (!match) throw badRequest(`${name} must be one of ${allowed.join(", ")}`, "InvalidParameter");
  return match;
}

export function odataOptions(c: Context, defaultTop = DEFAULT_PAGE_SIZE): ODataOptions {
  return parseODataOptions(new URL(c.req.url), defaultTop);
}

export function odataCollection<T extends Row>(
  c: Context,
  baseUrl: string,
  entitySet: string,
  rows: T[],
  options: ODataOptions,
): Response {
  const page = applyOData(rows, options);
  const body: Row = { "@odata.context": `${baseUrl}/api/$metadata#${entitySet}` };
  if (options.count) body["@odata.count"] = page.total;
  body.value = page.rows;
  if (page.hasMore) {
    const next = new URL(c.req.url);
    next.searchParams.set("$skip", String((options.skip ?? 0) + (options.top ?? 0)));
    body["@odata.nextLink"] = `${baseUrl}${next.pathname}${next.search}`;
  }
  return c.json(body);
}

export function odataEntity(c: Context, baseUrl: string, entitySet: string, entity: Row): Response {
  return c.json({ "@odata.context": `${baseUrl}/api/$metadata#${entitySet}/$entity`, ...entity });
}
