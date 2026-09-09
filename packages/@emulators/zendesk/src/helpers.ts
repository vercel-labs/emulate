import type { AppEnv, Context, ContentfulStatusCode, Entity, Handler, Hono } from "@emulators/core";
import type { ZendeskUser } from "./entities.js";
import type { ZendeskStore } from "./store.js";

export type Body = Record<string, unknown>;

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function toIso(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number")
    return new Date(value * (value < 1e12 ? 1000 : 1)).toISOString().replace(/\.\d{3}Z$/, "Z");
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isoSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

export function trimIso(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, "Z");
}

export async function parseJsonBody(c: Context): Promise<Body> {
  const text = await c.req.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new ZendeskApiError(400, { error: "BadRequest", description: "Request body is not valid JSON" });
  }
}

export function obj(value: unknown): Body {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Body) : {};
}

export function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object") return undefined;
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
  if (text === undefined || text === "") return undefined;
  return text === "true" || text === "1";
}

export function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

export function idList(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  const text = str(value);
  if (!text) return [];
  return text
    .split(",")
    .map((item) => Number(item.trim()))
    .filter(Number.isFinite);
}

export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = str(value);
  if (!text) return [];
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/[\s,]+/) : [];
  const tags = raw.map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean);
  return [...new Set(tags)];
}

export interface ZendeskErrorBody {
  error: string;
  description?: string;
  details?: Record<string, Array<{ description: string; error?: string }>>;
}

export class ZendeskApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ZendeskErrorBody,
  ) {
    super(body.description ?? body.error);
  }
}

export function sendApiError(c: Context, error: ZendeskApiError): Response {
  return c.json(error.body, error.status as ContentfulStatusCode);
}

export function recordNotFound(): ZendeskApiError {
  return new ZendeskApiError(404, { error: "RecordNotFound", description: "Not found" });
}

export function recordInvalid(details: Record<string, string | string[]>): ZendeskApiError {
  const formatted: Record<string, Array<{ description: string; error?: string }>> = {};
  for (const [field, messages] of Object.entries(details)) {
    formatted[field] = (Array.isArray(messages) ? messages : [messages]).map((message) => ({
      description: message,
      error: message.toLowerCase().includes("blank")
        ? "BlankValue"
        : message.toLowerCase().includes("taken")
          ? "DuplicateValue"
          : "InvalidValue",
    }));
  }
  return new ZendeskApiError(422, {
    error: "RecordInvalid",
    description: "Record validation errors",
    details: formatted,
  });
}

export function invalidValue(description: string): ZendeskApiError {
  return new ZendeskApiError(400, { error: "InvalidValue", description });
}

export function forbidden(
  description = "You do not have access to this page. Please contact the account owner of this help desk for further help.",
): ZendeskApiError {
  return new ZendeskApiError(403, { error: "Forbidden", description });
}

export function unauthorized(c: Context): Response {
  return c.json({ error: "Couldn't authenticate you" }, 401);
}

export interface AuthContext {
  actor: ZendeskUser;
  user: ZendeskUser;
}

function decodeBasic(header: string): { username: string; password: string } | null {
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function findByEmail(zs: ZendeskStore, email: string | undefined): ZendeskUser | undefined {
  if (!email) return undefined;
  return zs.users.all().find((user) => !user.deleted && user.email?.toLowerCase() === email.toLowerCase());
}

function firstAdmin(zs: ZendeskStore): ZendeskUser | undefined {
  return (
    zs.users.all().find((user) => !user.deleted && user.role === "admin") ??
    zs.users.all().find((user) => user.role === "agent")
  );
}

export function authenticate(c: Context, zs: ZendeskStore): AuthContext | Response {
  const header = c.req.header("Authorization") ?? "";
  let actor: ZendeskUser | undefined;

  if (header.toLowerCase().startsWith("basic ")) {
    const basic = decodeBasic(header);
    if (!basic) return unauthorized(c);
    if (basic.username.endsWith("/token")) {
      const email = basic.username.slice(0, -"/token".length);
      const token = zs.apiTokens.findOneBy("token", basic.password);
      if (!token) return unauthorized(c);
      actor = findByEmail(zs, token.email ?? email) ?? findByEmail(zs, email) ?? firstAdmin(zs);
    } else {
      const user = findByEmail(zs, basic.username);
      if (!user || user.password === null || user.password !== basic.password) return unauthorized(c);
      actor = user;
    }
  } else if (header.toLowerCase().startsWith("bearer ")) {
    const token = zs.oauthTokens.findOneBy("token", header.slice(7).trim());
    if (!token) return unauthorized(c);
    actor = zs.users.findOneBy("zd_id", token.user_id) ?? firstAdmin(zs);
  } else {
    return unauthorized(c);
  }

  if (!actor) return unauthorized(c);

  const onBehalfOf = c.req.header("X-On-Behalf-Of");
  let user = actor;
  if (onBehalfOf && (actor.role === "admin" || actor.role === "agent")) {
    const impersonated = findByEmail(zs, onBehalfOf) ?? zs.users.findOneBy("zd_id", Number(onBehalfOf));
    if (impersonated) user = impersonated;
  }
  return { actor, user };
}

export type ApiHandler = (c: Context<AppEnv>, auth: AuthContext) => Promise<Response> | Response;

export function api(zs: ZendeskStore, handler: ApiHandler): Handler<AppEnv> {
  return async (c) => {
    const auth = authenticate(c, zs);
    if (auth instanceof Response) return auth;
    c.header("X-Rate-Limit", "700");
    c.header("X-Rate-Limit-Remaining", "699");
    try {
      return await handler(c, auth);
    } catch (error) {
      if (error instanceof ZendeskApiError) return sendApiError(c, error);
      throw error;
    }
  };
}

export function requireAgent(auth: AuthContext): void {
  if (auth.user.role === "end-user") throw forbidden();
}

export function route(
  app: Hono<AppEnv>,
  method: "get" | "post" | "put" | "patch" | "delete",
  path: string,
  handler: Handler<AppEnv>,
): void {
  app[method](path, handler);
  app[method](`${path}.json`, handler);
}

export function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl}/api/v2/${path}.json`;
}

const MAX_PAGE_SIZE = 100;

export interface ListOptions<T extends Entity> {
  sortable?: Record<string, (entity: T) => unknown>;
  defaultSort?: string;
  extra?: Record<string, unknown>;
  cursorOnly?: boolean;
  countKey?: boolean;
}

function readSortValue<T extends Entity>(
  entity: T,
  formatted: Record<string, unknown>,
  field: string,
  sortable?: Record<string, (entity: T) => unknown>,
): unknown {
  if (sortable?.[field]) return sortable[field](entity);
  return formatted[field];
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function withParams(url: URL, updates: Record<string, string | null>): string {
  const next = new URL(url.toString());
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) next.searchParams.delete(key);
    else next.searchParams.set(key, value);
  }
  return next.toString();
}

function encodeCursor(index: number): string {
  return Buffer.from(`idx:${index}`).toString("base64url");
}

function decodeCursor(value: string | null): number | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (!decoded.startsWith("idx:")) return null;
    const parsed = Number(decoded.slice(4));
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function zendeskList<T extends Entity>(
  c: Context,
  entities: T[],
  key: string,
  format: (entity: T) => Record<string, unknown>,
  options: ListOptions<T> = {},
): Response {
  const url = new URL(c.req.url);
  const rows = entities.map((entity) => ({ entity, row: format(entity) }));
  const cursorMode =
    options.cursorOnly ||
    url.searchParams.has("page[size]") ||
    url.searchParams.has("page[after]") ||
    url.searchParams.has("page[before]");

  let sortField = options.defaultSort ?? null;
  let sortDesc = false;
  if (cursorMode) {
    const sort = url.searchParams.get("sort");
    if (sort) {
      sortDesc = sort.startsWith("-");
      sortField = sortDesc ? sort.slice(1) : sort;
    }
  } else {
    const sortBy = url.searchParams.get("sort_by");
    if (sortBy) sortField = sortBy;
    sortDesc = url.searchParams.get("sort_order") === "desc";
  }
  if (sortField) {
    const field = sortField;
    rows.sort((a, b) => {
      const result = compareValues(
        readSortValue(a.entity, a.row, field, options.sortable),
        readSortValue(b.entity, b.row, field, options.sortable),
      );
      return (result === 0 ? a.entity.id - b.entity.id : result) * (sortDesc ? -1 : 1);
    });
  } else {
    rows.sort((a, b) => a.entity.id - b.entity.id);
  }

  if (cursorMode) {
    const requested = Number(url.searchParams.get("page[size]") ?? MAX_PAGE_SIZE);
    const size = Number.isFinite(requested) ? Math.min(Math.max(1, requested), MAX_PAGE_SIZE) : MAX_PAGE_SIZE;
    const after = decodeCursor(url.searchParams.get("page[after]"));
    const before = decodeCursor(url.searchParams.get("page[before]"));
    let start = 0;
    if (after !== null) start = after;
    else if (before !== null) start = Math.max(0, before - size);
    const page = rows.slice(start, start + size);
    const hasMore = start + size < rows.length;
    const afterCursor = hasMore ? encodeCursor(start + size) : null;
    const beforeCursor = start > 0 ? encodeCursor(start) : null;
    return c.json({
      [key]: page.map(({ row }) => row),
      meta: {
        has_more: hasMore,
        after_cursor: afterCursor,
        before_cursor: beforeCursor,
      },
      links: {
        next: afterCursor
          ? withParams(url, { "page[after]": afterCursor, "page[before]": null, "page[size]": String(size) })
          : null,
        prev: beforeCursor
          ? withParams(url, { "page[before]": beforeCursor, "page[after]": null, "page[size]": String(size) })
          : null,
      },
      ...(options.extra ?? {}),
    });
  }

  const perPageRequested = Number(url.searchParams.get("per_page") ?? MAX_PAGE_SIZE);
  const perPage = Number.isFinite(perPageRequested)
    ? Math.min(Math.max(1, perPageRequested), MAX_PAGE_SIZE)
    : MAX_PAGE_SIZE;
  const pageRequested = Number(url.searchParams.get("page") ?? 1);
  const pageNumber = Number.isFinite(pageRequested) ? Math.max(1, pageRequested) : 1;
  const start = (pageNumber - 1) * perPage;
  const page = rows.slice(start, start + perPage);
  const hasNext = start + perPage < rows.length;
  return c.json({
    [key]: page.map(({ row }) => row),
    next_page: hasNext ? withParams(url, { page: String(pageNumber + 1), per_page: String(perPage) }) : null,
    previous_page: pageNumber > 1 ? withParams(url, { page: String(pageNumber - 1), per_page: String(perPage) }) : null,
    count: rows.length,
    ...(options.extra ?? {}),
  });
}

export function emailValid(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
