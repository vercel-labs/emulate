import type { Context, ContentfulStatusCode, Entity } from "@emulators/core";
import type { ChargebeeApiKey, CustomFields, PeriodUnit, TrialPeriodUnit } from "./entities.js";
import type { ChargebeeStore } from "./store.js";

export type Body = Record<string, unknown>;

export async function parseChargebeeBody(c: Context): Promise<Body> {
  const contentType = c.req.header("Content-Type") ?? "";
  const rawText = await c.req.text();
  if (!rawText) return {};

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(rawText);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return parseBracketParams(new URLSearchParams(rawText));
}

export function parseBracketParams(params: URLSearchParams): Body {
  const result: Body = {};
  for (const [key, value] of params) {
    const parts = key.replace(/]/g, "").split("[");
    let target: Record<string, unknown> | unknown[] = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const nextIsIndex = /^\d+$/.test(parts[i + 1]);
      const current = Array.isArray(target) ? target[Number(part)] : target[part];
      if (current === undefined || current === null || typeof current !== "object") {
        const created = nextIsIndex ? [] : {};
        if (Array.isArray(target)) target[Number(part)] = created;
        else target[part] = created;
      }
      target = (Array.isArray(target) ? target[Number(part)] : target[part]) as Record<string, unknown> | unknown[];
    }
    const last = parts[parts.length - 1];
    if (Array.isArray(target)) target[Number(last)] = value;
    else target[last] = value;
  }
  return result;
}

export function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return str(value[0]);
  if (typeof value === "object") return undefined;
  const text = String(value);
  return text;
}

export function strOrNull(value: unknown): string | null {
  const text = str(value);
  return text === undefined || text === "" ? null : text;
}

export function num(value: unknown): number | undefined {
  const text = str(value);
  if (text === undefined || text === "") return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = str(value);
  if (text === undefined || text === "") return undefined;
  return text === "true" || text === "1";
}

export function jsonValue(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function stringList(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.map(String).filter((item) => item !== "");
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map(String)
      .filter((item) => item !== "");
  }
  const text = String(value);
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return [text];
    }
  }
  return [text];
}

export function columnar(value: unknown): Array<Record<string, string>> {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value
      .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
      .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)])));
  }
  if (typeof value !== "object") return [];
  const columns = value as Record<string, unknown>;
  const rows: Array<Record<string, string>> = [];
  for (const [field, cells] of Object.entries(columns)) {
    const list = Array.isArray(cells) ? cells : typeof cells === "object" && cells ? Object.values(cells) : [cells];
    list.forEach((cell, index) => {
      if (cell === undefined || cell === null) return;
      rows[index] = rows[index] ?? {};
      rows[index][field] = String(cell);
    });
  }
  return rows.filter(Boolean);
}

export function pickCustomFields(body: Body): CustomFields {
  const out: CustomFields = {};
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith("cf_")) continue;
    const text = str(value);
    if (text !== undefined) out[key] = text;
  }
  return out;
}

export function pickAddress(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, cell] of Object.entries(value as Record<string, unknown>)) {
    const text = str(cell);
    if (text !== undefined && text !== "") out[key] = text;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function decodeBasicAuth(c: Context): { username: string; password: string } | null {
  const header = c.req.header("Authorization") ?? "";
  if (!header.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx === -1) return { username: decoded, password: "" };
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

export interface ChargebeeErrorBody {
  message: string;
  type: string;
  api_error_code: string;
  error_code?: string;
  error_msg?: string;
  param?: string;
  error_param?: string;
}

export class ChargebeeApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ChargebeeErrorBody,
  ) {
    super(body.message);
  }
}

export function chargebeeError(c: Context, status: number, body: ChargebeeErrorBody): Response {
  return c.json(
    {
      message: body.message,
      type: body.type,
      api_error_code: body.api_error_code,
      error_code: body.error_code ?? body.api_error_code,
      error_msg: body.error_msg ?? body.message,
      ...(body.param ? { param: body.param, error_param: body.param } : {}),
      http_status_code: status,
    },
    status as ContentfulStatusCode,
  );
}

export function sendApiError(c: Context, error: ChargebeeApiError): Response {
  return chargebeeError(c, error.status, error.body);
}

export function notFoundError(): ChargebeeApiError {
  return new ChargebeeApiError(404, {
    message: "Sorry, we couldn't find that resource",
    type: "invalid_request",
    api_error_code: "resource_not_found",
  });
}

export function paramError(param: string, message: string, code = "param_wrong_value"): ChargebeeApiError {
  return new ChargebeeApiError(400, {
    message: `${param} : ${message}`,
    type: "invalid_request",
    api_error_code: code,
    error_code: code,
    error_msg: message,
    param,
  });
}

export function blankParamError(param: string): ChargebeeApiError {
  return paramError(param, "cannot be blank", "param_wrong_value");
}

export function duplicateError(param: string, value: string): ChargebeeApiError {
  return new ChargebeeApiError(400, {
    message: `${param} : ${value} already exists. Please enter a different value.`,
    type: "invalid_request",
    api_error_code: "duplicate_entry",
    error_code: "duplicate_entry",
    error_msg: `${value} already exists. Please enter a different value.`,
    param,
  });
}

export function invalidStateError(message: string): ChargebeeApiError {
  return new ChargebeeApiError(400, {
    message,
    type: "invalid_request",
    api_error_code: "invalid_state_for_request",
  });
}

export function operationNotAllowedError(message: string): ChargebeeApiError {
  return new ChargebeeApiError(400, {
    message,
    type: "operation_failed",
    api_error_code: "operation_not_allowed",
  });
}

export function paymentError(message: string, code: string): ChargebeeApiError {
  return new ChargebeeApiError(400, {
    message,
    type: "payment",
    api_error_code: code,
  });
}

export function authError(c: Context): Response {
  return chargebeeError(c, 401, {
    message: "Sorry, authentication failed. Invalid api key",
    type: "api_authentication_failed",
    api_error_code: "api_authentication_failed",
  });
}

export function notFound(c: Context): Response {
  return sendApiError(c, notFoundError());
}

export function authenticate(c: Context, cs: ChargebeeStore): ChargebeeApiKey | Response {
  const auth = decodeBasicAuth(c);
  if (!auth || !auth.username) return authError(c);
  const key = cs.apiKeys.findOneBy("key", auth.username);
  if (!key) return authError(c);
  return key;
}

export function roundMoney(value: number): number {
  return Math.round(value);
}

export function addPeriod(start: number, count: number, unit: PeriodUnit | TrialPeriodUnit): number {
  const date = new Date(start * 1000);
  switch (unit) {
    case "day":
      date.setUTCDate(date.getUTCDate() + count);
      break;
    case "week":
      date.setUTCDate(date.getUTCDate() + count * 7);
      break;
    case "month": {
      const day = date.getUTCDate();
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() + count);
      const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(day, lastDay));
      break;
    }
    case "year": {
      const day = date.getUTCDate();
      date.setUTCDate(1);
      date.setUTCFullYear(date.getUTCFullYear() + count);
      const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(day, lastDay));
      break;
    }
  }
  return Math.floor(date.getTime() / 1000);
}

export function monthsInPeriod(count: number, unit: PeriodUnit): number {
  switch (unit) {
    case "day":
      return count / 30;
    case "week":
      return (count * 7) / 30;
    case "month":
      return count;
    case "year":
      return count * 12;
  }
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

type FilterOperator =
  | "is"
  | "is_not"
  | "in"
  | "not_in"
  | "starts_with"
  | "is_present"
  | "after"
  | "before"
  | "on"
  | "between"
  | "gt"
  | "lt"
  | "gte"
  | "lte";

interface ParsedFilter {
  path: string[];
  operator: FilterOperator;
  value: string;
}

const FILTER_OPERATORS = new Set<string>([
  "is",
  "is_not",
  "in",
  "not_in",
  "starts_with",
  "is_present",
  "after",
  "before",
  "on",
  "between",
  "gt",
  "lt",
  "gte",
  "lte",
]);

const RESERVED_QUERY_KEYS = new Set(["limit", "offset", "include_deleted", "sort_by"]);

function parseFilters(url: URL): {
  filters: ParsedFilter[];
  sort: { field: string; direction: "asc" | "desc" } | null;
} {
  const filters: ParsedFilter[] = [];
  let sort: { field: string; direction: "asc" | "desc" } | null = null;
  for (const [key, value] of url.searchParams) {
    const parts = key.replace(/]/g, "").split("[");
    const root = parts[0];
    if (root === "sort_by" && parts.length === 2 && (parts[1] === "asc" || parts[1] === "desc")) {
      sort = { field: value, direction: parts[1] };
      continue;
    }
    if (RESERVED_QUERY_KEYS.has(root)) continue;
    const last = parts[parts.length - 1];
    if (parts.length >= 2 && FILTER_OPERATORS.has(last)) {
      filters.push({ path: parts.slice(0, -1), operator: last as FilterOperator, value });
      continue;
    }
    if (parts.length === 1 && value !== "") {
      filters.push({ path: [root], operator: "is", value });
    }
  }
  return { filters, sort };
}

function readPath(obj: unknown, path: string[]): unknown {
  let current: unknown = obj;
  for (const segment of path) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function parseList(value: string): string[] {
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return value.split(",");
    }
  }
  return value.split(",").map((item) => item.trim());
}

function matchesFilter(actual: unknown, filter: ParsedFilter): boolean {
  const candidates = Array.isArray(actual) ? actual : [actual];
  switch (filter.operator) {
    case "is":
      return candidates.some((item) => item !== undefined && item !== null && String(item) === filter.value);
    case "is_not":
      return !candidates.some((item) => item !== undefined && item !== null && String(item) === filter.value);
    case "in": {
      const list = parseList(filter.value);
      return candidates.some((item) => item !== undefined && item !== null && list.includes(String(item)));
    }
    case "not_in": {
      const list = parseList(filter.value);
      return !candidates.some((item) => item !== undefined && item !== null && list.includes(String(item)));
    }
    case "starts_with":
      return candidates.some(
        (item) => typeof item === "string" && item.toLowerCase().startsWith(filter.value.toLowerCase()),
      );
    case "is_present": {
      const present = candidates.some((item) => item !== undefined && item !== null);
      return filter.value === "false" ? !present : present;
    }
    case "after":
    case "gt":
      return candidates.some((item) => typeof item === "number" && item > Number(filter.value));
    case "before":
    case "lt":
      return candidates.some((item) => typeof item === "number" && item < Number(filter.value));
    case "gte":
      return candidates.some((item) => typeof item === "number" && item >= Number(filter.value));
    case "lte":
      return candidates.some((item) => typeof item === "number" && item <= Number(filter.value));
    case "on": {
      const target = Number(filter.value);
      return candidates.some(
        (item) => typeof item === "number" && Math.floor(item / 86400) === Math.floor(target / 86400),
      );
    }
    case "between": {
      const [low, high] = parseList(filter.value).map(Number);
      return candidates.some((item) => typeof item === "number" && item >= low && item <= high);
    }
  }
}

export interface ListOptions<T extends Entity> {
  virtual?: (entity: T) => Record<string, unknown>;
  defaultLimit?: number;
}

export function chargebeeList<T extends Entity>(
  c: Context,
  entities: T[],
  primary: string,
  formatRow: (entity: T) => Record<string, unknown>,
  options: ListOptions<T> = {},
): Response {
  const url = new URL(c.req.url);
  const { filters, sort } = parseFilters(url);
  const requestedLimit = Number(url.searchParams.get("limit") ?? options.defaultLimit ?? 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(1, requestedLimit), 100) : 10;
  const offsetParam = url.searchParams.get("offset");
  let offset = 0;
  if (offsetParam) {
    const list = parseList(offsetParam);
    const parsed = Number(list[0]);
    offset = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  const rows = entities.map((entity) => ({ entity, row: formatRow(entity) }));
  const filtered = rows.filter(({ entity, row }) => {
    const primaryObject = row[primary] as Record<string, unknown>;
    const virtual = options.virtual?.(entity) ?? {};
    return filters.every((filter) => {
      let actual = readPath(primaryObject, filter.path);
      if (actual === undefined && filter.path.length === 1 && filter.path[0] in virtual) {
        actual = virtual[filter.path[0]];
      }
      return matchesFilter(actual, filter);
    });
  });

  if (sort) {
    const direction = sort.direction === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      const av = readPath(a.row[primary], [sort.field]);
      const bv = readPath(b.row[primary], [sort.field]);
      if (av === bv) return (a.entity.id - b.entity.id) * direction;
      if (av === undefined || av === null) return 1;
      if (bv === undefined || bv === null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * direction;
      return String(av).localeCompare(String(bv)) * direction;
    });
  } else {
    filtered.sort((a, b) => b.entity.id - a.entity.id);
  }

  const page = filtered.slice(offset, offset + limit);
  const hasMore = offset + limit < filtered.length;
  return c.json({
    list: page.map(({ row }) => row),
    ...(hasMore ? { next_offset: JSON.stringify([String(offset + limit)]) } : {}),
  });
}
