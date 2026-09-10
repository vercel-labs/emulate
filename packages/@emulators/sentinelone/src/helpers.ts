import { randomBytes, randomUUID } from "node:crypto";
import type { AppEnv, Context, ContentfulStatusCode, Handler, Hono } from "@emulators/core";
import type { S1ApiToken } from "./entities.js";
import type { S1Store } from "./store.js";

export type Body = Record<string, unknown>;
export type Json = Record<string, unknown>;

export const API_PREFIXES = ["/web/api/v2.1", "/web/api/v2.0"];
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 1000;

export const ERROR_CODES = {
  VALIDATION: 4000010,
  ALREADY_EXISTS: 4000030,
  UNAUTHORIZED: 4010010,
  FORBIDDEN: 4030010,
  NOT_FOUND: 4040010,
} as const;

export function nowIso(): string {
  return new Date().toISOString();
}

export function guid(): string {
  return randomUUID();
}

export function token(length = 40): string {
  return randomBytes(Math.ceil((length * 3) / 4))
    .toString("base64url")
    .slice(0, length);
}

export function sha1Hex(): string {
  return randomBytes(20).toString("hex");
}

export interface S1ErrorItem {
  code: number;
  detail: string;
  title: string;
}

export class S1ApiError extends Error {
  constructor(
    readonly status: number,
    readonly errors: S1ErrorItem[],
  ) {
    super(errors[0]?.detail ?? "Request failed");
  }
}

export function validation(detail: string, code: number = ERROR_CODES.VALIDATION): S1ApiError {
  return new S1ApiError(400, [{ code, detail, title: "Validation Error" }]);
}

export function alreadyExists(detail: string): S1ApiError {
  return new S1ApiError(400, [{ code: ERROR_CODES.ALREADY_EXISTS, detail, title: "Already Exists" }]);
}

export function notFound(detail: string): S1ApiError {
  return new S1ApiError(404, [{ code: ERROR_CODES.NOT_FOUND, detail, title: "Resource not found" }]);
}

export function forbidden(detail: string): S1ApiError {
  return new S1ApiError(403, [{ code: ERROR_CODES.FORBIDDEN, detail, title: "Forbidden" }]);
}

export function sendApiError(c: Context, error: S1ApiError): Response {
  return c.json({ errors: error.errors }, error.status as ContentfulStatusCode);
}

export function unauthorized(c: Context, detail = "Authentication failed: missing or invalid API token."): Response {
  return c.json({ errors: [{ code: ERROR_CODES.UNAUTHORIZED, detail, title: "Unauthorized" }] }, 401);
}

export function authenticate(c: Context, ss: S1Store): S1ApiToken | Response {
  const header = c.req.header("Authorization") ?? "";
  const match = header.match(/^(ApiToken|Bearer|Token)\s+(.+)$/i);
  if (!match) return unauthorized(c);
  const found = ss.apiTokens.findOneBy("token", match[2].trim());
  if (!found) return unauthorized(c);
  if (found.expires_at && Date.parse(found.expires_at) < Date.now())
    return unauthorized(c, "Authentication failed: the API token has expired.");
  return found;
}

export type ApiHandler = (c: Context<AppEnv>, key: S1ApiToken) => Promise<Response> | Response;

export function api(ss: S1Store, handler: ApiHandler): Handler<AppEnv> {
  return async (c) => {
    const key = authenticate(c, ss);
    if (key instanceof Response) return key;
    try {
      return await handler(c, key);
    } catch (error) {
      if (error instanceof S1ApiError) return sendApiError(c, error);
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
  for (const prefix of API_PREFIXES) app[method](`${prefix}${path}`, handler);
}

export async function parseJsonBody(c: Context): Promise<Body> {
  const text = await c.req.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw validation("Request body is not valid JSON");
  }
}

export function dataOf(body: Body): Body {
  return obj(body.data) ?? {};
}

export function filterOf(body: Body): Body {
  return obj(body.filter) ?? {};
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

export function obj(value: unknown): Body | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Body) : undefined;
}

export function list(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value);
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  const match = allowed.find((candidate) => candidate.toLowerCase() === text.toLowerCase());
  if (!match) throw validation(`${name} must be one of: ${allowed.join(", ")}`);
  return match;
}

export function emailValid(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isoOrThrow(value: unknown, name: string): string | undefined {
  const text = str(value);
  if (text === undefined || text === "") return undefined;
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw validation(`${name} must be an ISO 8601 date`);
  return new Date(parsed).toISOString();
}

export interface QueryParams {
  get(name: string): string | undefined;
  list(name: string): string[] | undefined;
  bool(name: string): boolean | undefined;
  num(name: string): number | undefined;
  has(name: string): boolean;
  all(): Record<string, string>;
}

export function queryParams(c: Context): QueryParams {
  const url = new URL(c.req.url);
  const params = url.searchParams;
  const read = (name: string) => {
    const values = params.getAll(name).filter((value) => value !== "");
    if (values.length === 0) return undefined;
    return values.join(",");
  };
  return {
    get: (name) => read(name),
    list: (name) => list(read(name)),
    bool: (name) => bool(read(name)),
    num: (name) => num(read(name)),
    has: (name) => params.has(name),
    all: () => Object.fromEntries([...params.keys()].map((key) => [key, read(key) ?? ""])),
  };
}

export function matchesList(value: string | null | undefined, wanted: string[] | undefined): boolean {
  if (!wanted || wanted.length === 0) return true;
  if (value === null || value === undefined) return false;
  return wanted.some((candidate) => candidate.toLowerCase() === value.toLowerCase());
}

export function containsAny(value: string | null | undefined, wanted: string[] | undefined): boolean {
  if (!wanted || wanted.length === 0) return true;
  if (value === null || value === undefined) return false;
  const lowered = value.toLowerCase();
  return wanted.some((candidate) => lowered.includes(candidate.toLowerCase()));
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

export interface PageOptions {
  defaultSort?: string;
  sortable?: string[];
}

export function paginate<T extends Json>(c: Context, rows: T[], options: PageOptions = {}): Json {
  const params = queryParams(c);
  const countOnly = params.bool("countOnly") ?? false;
  const skipCount = params.bool("skipCount") ?? false;
  const limitRaw = params.num("limit");
  const limit = limitRaw !== undefined ? Math.min(Math.max(Math.floor(limitRaw), 1), MAX_LIMIT) : DEFAULT_LIMIT;
  if (limitRaw !== undefined && (limitRaw < 1 || limitRaw > MAX_LIMIT))
    throw validation(`limit must be between 1 and ${MAX_LIMIT}`);
  const sortBy = params.get("sortBy") ?? options.defaultSort;
  const sortOrder = (params.get("sortOrder") ?? "asc").toLowerCase() === "desc" ? -1 : 1;
  let sorted = rows;
  if (sortBy) {
    if (options.sortable && !options.sortable.includes(sortBy))
      throw validation(`sortBy must be one of: ${options.sortable.join(", ")}`);
    sorted = [...rows].sort((a, b) => compareValues(a[sortBy], b[sortBy]) * sortOrder);
  }
  const total = sorted.length;
  if (countOnly) return { data: [], pagination: { nextCursor: null, totalItems: total } };
  let offset = params.num("skip") ?? 0;
  const cursor = params.get("cursor");
  if (cursor) {
    const decoded = Number.parseInt(
      Buffer.from(cursor, "base64url")
        .toString("utf8")
        .replace(/^offset:/, ""),
      10,
    );
    if (!Number.isFinite(decoded) || decoded < 0) throw validation("cursor is invalid");
    offset = decoded;
  }
  const page = sorted.slice(offset, offset + limit);
  const hasMore = offset + limit < total;
  return {
    data: page,
    pagination: {
      nextCursor: hasMore ? Buffer.from(`offset:${offset + limit}`).toString("base64url") : null,
      totalItems: skipCount ? null : total,
    },
  };
}
