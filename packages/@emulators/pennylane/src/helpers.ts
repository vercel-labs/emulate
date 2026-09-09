import type { AppEnv, Context, ContentfulStatusCode, Handler, Hono } from "@emulators/core";
import type { PlAddress, PlApiKey } from "./entities.js";
import type { PlStore } from "./store.js";

export type Body = Record<string, unknown>;
export type Json = Record<string, unknown>;

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export function nowIso(): string {
  return new Date().toISOString();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function money(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface PlFieldError {
  field: string;
  message: string;
}

export class PlApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors: PlFieldError[] = [],
  ) {
    super(message);
  }
}

export function badRequest(message: string, errors: PlFieldError[] = []): PlApiError {
  return new PlApiError(400, message, errors);
}

export function unprocessable(message: string, errors: PlFieldError[] = []): PlApiError {
  return new PlApiError(422, message, errors);
}

export function notFound(message = "Record not found"): PlApiError {
  return new PlApiError(404, message);
}

export function sendApiError(c: Context, error: PlApiError): Response {
  return c.json(
    { message: error.message, ...(error.errors.length > 0 ? { errors: error.errors } : {}) },
    error.status as ContentfulStatusCode,
  );
}

export function unauthorized(c: Context): Response {
  return c.json({ message: "Unauthorized: invalid or missing API token" }, 401);
}

export function authenticate(c: Context, ps: PlStore): PlApiKey | Response {
  const header = c.req.header("Authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return unauthorized(c);
  const key = header.slice(7).trim();
  const found = key ? ps.apiKeys.findOneBy("key", key) : undefined;
  if (!found) return unauthorized(c);
  return found;
}

export type ApiHandler = (c: Context<AppEnv>, key: PlApiKey) => Promise<Response> | Response;

export function api(ps: PlStore, handler: ApiHandler): Handler<AppEnv> {
  return async (c) => {
    const key = authenticate(c, ps);
    if (key instanceof Response) return key;
    try {
      return await handler(c, key);
    } catch (error) {
      if (error instanceof PlApiError) return sendApiError(c, error);
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
  app[method](`/api/external/v2${path}`, handler);
  app[method](`/v2${path}`, handler);
  app[method](path, handler);
}

export async function parseJsonBody(c: Context): Promise<Body> {
  const text = await c.req.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw badRequest("Request body is not valid JSON");
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

export function obj(value: unknown): Body | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Body) : undefined;
}

export function dateOnly(value: unknown, field: string, required = false): string | undefined {
  const text = str(value);
  if (text === undefined || text === "") {
    if (required) throw unprocessable("Validation failed", [{ field, message: "can't be blank" }]);
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(text) || Number.isNaN(Date.parse(text)))
    throw unprocessable("Validation failed", [{ field, message: "must be a date formatted as YYYY-MM-DD" }]);
  return text.slice(0, 10);
}

export function address(value: unknown): PlAddress | null | undefined {
  if (value === undefined) return undefined;
  const record = obj(value);
  if (!record) return null;
  return {
    address: str(record.address) ?? "",
    postal_code: str(record.postal_code) ?? "",
    city: str(record.city) ?? "",
    country_alpha2: (str(record.country_alpha2) ?? "FR").toUpperCase(),
  };
}

export function emailValid(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export interface FilterClause {
  field: string;
  operator: string;
  value: unknown;
}

const OPERATORS = [
  "eq",
  "not_eq",
  "gt",
  "gteq",
  "lt",
  "lteq",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "is_null",
  "is_not_null",
];

export function parseFilters(c: Context): FilterClause[] {
  const raw = c.req.query("filter");
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest("The filter parameter must be a JSON array of {field, operator, value} objects");
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((entry) => {
    const record = obj(entry);
    const field = str(record?.field);
    const operator = (str(record?.operator) ?? "eq").toLowerCase();
    if (!field) throw badRequest("Each filter needs a field");
    if (!OPERATORS.includes(operator))
      throw badRequest(`Unsupported filter operator '${operator}'. Supported operators: ${OPERATORS.join(", ")}`);
    return { field, operator, value: record?.value };
  });
}

export interface FilterSpec {
  operators?: readonly string[];
  get?: (row: Json) => unknown;
}

export function applyFilters<T extends Json>(
  rows: T[],
  filters: FilterClause[],
  specs: Readonly<Record<string, FilterSpec | true>>,
): T[] {
  let result = rows;
  for (const clause of filters) {
    const spec = specs[clause.field];
    if (!spec)
      throw badRequest(
        `Filtering on '${clause.field}' is not supported. Filterable fields: ${Object.keys(specs).join(", ")}`,
      );
    const allowed = spec === true ? undefined : spec.operators;
    if (allowed && !allowed.includes(clause.operator))
      throw badRequest(
        `Operator '${clause.operator}' is not supported for '${clause.field}'. Supported operators: ${allowed.join(", ")}`,
      );
    const read = spec === true ? (row: Json) => row[clause.field] : (spec.get ?? ((row: Json) => row[clause.field]));
    result = result.filter((row) => matches(read(row), clause.operator, clause.value));
  }
  return result;
}

function normalize(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = String(value);
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text.toLowerCase();
}

function matches(actual: unknown, operator: string, expected: unknown): boolean {
  const left = normalize(actual);
  switch (operator) {
    case "is_null":
      return left === null;
    case "is_not_null":
      return left !== null;
    case "in":
    case "not_in": {
      const list = (Array.isArray(expected) ? expected : String(expected ?? "").split(",")).map(normalize);
      const found = list.some((item) => item === left);
      return operator === "in" ? found : !found;
    }
    case "contains":
      return left !== null && String(left).includes(String(normalize(expected) ?? ""));
    case "starts_with":
      return left !== null && String(left).startsWith(String(normalize(expected) ?? ""));
  }
  const right = normalize(expected);
  if (left === null || right === null)
    return operator === "not_eq" ? left !== right : operator === "eq" && left === right;
  switch (operator) {
    case "eq":
      return left === right;
    case "not_eq":
      return left !== right;
    case "gt":
      return left > right;
    case "gteq":
      return left >= right;
    case "lt":
      return left < right;
    case "lteq":
      return left <= right;
  }
  return false;
}

export function applySort<T extends Json>(rows: T[], sort: string | undefined, allowed: readonly string[]): T[] {
  if (!sort) return rows;
  const clauses = sort
    .split(",")
    .map((clause) => clause.trim())
    .filter(Boolean)
    .map((clause) => ({ field: clause.replace(/^[-+]/, ""), descending: clause.startsWith("-") }));
  for (const clause of clauses)
    if (!allowed.includes(clause.field))
      throw badRequest(`Sorting on '${clause.field}' is not supported. Sortable fields: ${allowed.join(", ")}`);
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const left = normalize(a[clause.field]);
      const right = normalize(b[clause.field]);
      if (left === right) continue;
      if (left === null) return clause.descending ? 1 : -1;
      if (right === null) return clause.descending ? -1 : 1;
      const order = left < right ? -1 : 1;
      return clause.descending ? -order : order;
    }
    return 0;
  });
}

export function paginate<T extends Json>(c: Context, rows: T[]): Json {
  const limitRaw = c.req.query("limit") ?? c.req.query("per_page");
  const limit =
    limitRaw !== undefined
      ? Math.min(Math.max(Number.parseInt(limitRaw, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;
  const cursorRaw = c.req.query("cursor");
  let offset = 0;
  if (cursorRaw) {
    const decoded = Number.parseInt(
      Buffer.from(cursorRaw, "base64url")
        .toString("utf8")
        .replace(/^offset:/, ""),
      10,
    );
    if (!Number.isFinite(decoded) || decoded < 0) throw badRequest("The cursor parameter is invalid");
    offset = decoded;
  }
  const page = rows.slice(offset, offset + limit);
  const hasMore = offset + limit < rows.length;
  return {
    items: page,
    has_more: hasMore,
    next_cursor: hasMore ? Buffer.from(`offset:${offset + limit}`).toString("base64url") : null,
  };
}

export function listResponse<T extends Json>(
  c: Context,
  rows: T[],
  options: { filters: Readonly<Record<string, FilterSpec | true>>; sortable: readonly string[]; defaultSort?: string },
): Response {
  const filtered = applyFilters(rows, parseFilters(c), options.filters);
  const sorted = applySort(filtered, c.req.query("sort") ?? options.defaultSort, options.sortable);
  return c.json(paginate(c, sorted));
}

export function requireInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw notFound(`${name} not found`);
  return parsed;
}
