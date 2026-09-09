import type { AppEnv, Context, ContentfulStatusCode, Entity, Handler, Hono } from "@emulators/core";
import type { MailgunApiKey } from "./entities.js";
import type { MailgunStore } from "./store.js";

export interface UploadedFile {
  name: string;
  type: string;
  content: Buffer;
}

export interface ParsedBody {
  fields: Record<string, string[]>;
  files: Record<string, UploadedFile[]>;
}

export async function parseBody(c: Context): Promise<ParsedBody> {
  const contentType = (c.req.header("Content-Type") ?? "").toLowerCase();
  const result: ParsedBody = { fields: {}, files: {} };
  const push = (key: string, value: string) => {
    (result.fields[key] ??= []).push(value);
  };
  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.raw.formData();
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") {
        push(key, value);
      } else {
        (result.files[key] ??= []).push({
          name: value.name || "file",
          type: value.type || "application/octet-stream",
          content: Buffer.from(await value.arrayBuffer()),
        });
      }
    }
    return result;
  }
  const text = await c.req.text();
  if (!text) return result;
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (Array.isArray(value))
            value.forEach((item) => push(key, typeof item === "string" ? item : JSON.stringify(item)));
          else if (value !== null && value !== undefined)
            push(key, typeof value === "string" ? value : JSON.stringify(value));
        }
      } else if (Array.isArray(parsed)) {
        push("__json_array__", text);
      }
    } catch {
      throw new MailgunApiError(400, "Request body is not valid JSON");
    }
    return result;
  }
  for (const [key, value] of new URLSearchParams(text)) push(key, value);
  return result;
}

export function first(body: ParsedBody, key: string): string | undefined {
  return body.fields[key]?.[0];
}

export function all(body: ParsedBody, key: string): string[] {
  return body.fields[key] ?? [];
}

export function yesNo(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const lowered = value.toLowerCase();
  if (["yes", "true", "1", "on"].includes(lowered)) return true;
  if (["no", "false", "0", "off"].includes(lowered)) return false;
  return fallback;
}

export function parseJson<T>(value: string | undefined): T | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export class MailgunApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function sendApiError(c: Context, error: MailgunApiError): Response {
  return c.json({ message: error.message, ...error.extra }, error.status as ContentfulStatusCode);
}

export function notFound(message = "Not found"): MailgunApiError {
  return new MailgunApiError(404, message);
}

export function badRequest(message: string, extra?: Record<string, unknown>): MailgunApiError {
  return new MailgunApiError(400, message, extra);
}

export function unauthorized(c: Context): Response {
  return c.json({ message: "Forbidden" }, 401);
}

export function authenticate(c: Context, ms: MailgunStore, domain?: string): MailgunApiKey | Response {
  const header = c.req.header("Authorization") ?? "";
  if (!header.toLowerCase().startsWith("basic ")) return unauthorized(c);
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return unauthorized(c);
  }
  const idx = decoded.indexOf(":");
  const secret = idx === -1 ? decoded : decoded.slice(idx + 1);
  const key = ms.apiKeys.findOneBy("key", secret);
  if (!key) return unauthorized(c);
  if (key.kind === "domain" && domain !== undefined && key.domain !== domain) return unauthorized(c);
  return key;
}

export type ApiHandler = (c: Context<AppEnv>, key: MailgunApiKey) => Promise<Response> | Response;

export function api(ms: MailgunStore, handler: ApiHandler, domainParam?: string): Handler<AppEnv> {
  return async (c) => {
    const domain = domainParam ? c.req.param(domainParam) : undefined;
    const key = authenticate(c, ms, domain);
    if (key instanceof Response) return key;
    try {
      return await handler(c, key);
    } catch (error) {
      if (error instanceof MailgunApiError) return sendApiError(c, error);
      throw error;
    }
  };
}

export function route(
  app: Hono<AppEnv>,
  method: "get" | "post" | "put" | "delete",
  path: string,
  handler: Handler<AppEnv>,
): void {
  app[method](path, handler);
}

export function rfc2822(date: Date | string | number): string {
  const value = typeof date === "number" ? new Date(date * 1000) : typeof date === "string" ? new Date(date) : date;
  return value.toUTCString();
}

export function epochSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

export function parseTime(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 1e12 ? numeric / 1000 : numeric;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return parsed / 1000;
}

export function parseDuration(value: string | undefined): number | undefined {
  const match = value?.match(/^(\d+)([smhdwM])$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, M: 30 * 86400 }[match[2]]!;
  return amount * unit;
}

export function splitAddresses(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;
  for (const char of value) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === "<") inAngle = true;
    if (char === ">") inAngle = false;
    if (char === "," && !inQuotes && !inAngle) {
      if (current.trim()) result.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

export function extractEmail(address: string): string {
  const match = address.match(/<([^>]+)>/);
  return (match ? match[1] : address).trim().toLowerCase();
}

export function displayName(address: string): string | null {
  const match = address.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  const name = match?.[1]?.trim();
  return name ? name : null;
}

export function emailValid(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

export function domainOf(address: string): string {
  return extractEmail(address).split("@")[1] ?? "";
}

export interface PagingOptions<T extends Entity> {
  anchorKey: string;
  anchor: (item: T) => string;
  defaultLimit?: number;
  maxLimit?: number;
}

export interface Paged<T> {
  items: T[];
  paging: { first: string; last: string; next: string; previous: string };
}

export function pagedItems<T extends Entity>(c: Context, sorted: T[], options: PagingOptions<T>): Paged<T> {
  const url = new URL(c.req.url);
  const requested = Number(url.searchParams.get("limit") ?? options.defaultLimit ?? 100);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(1, requested), options.maxLimit ?? 1000) : 100;
  const page = url.searchParams.get("page") ?? "first";
  const anchorValue = url.searchParams.get(options.anchorKey);
  const anchorIndex = anchorValue ? sorted.findIndex((item) => options.anchor(item) === anchorValue) : -1;

  let start = 0;
  if (page === "last") start = Math.max(0, sorted.length - limit);
  else if (page === "next" && anchorIndex !== -1) start = anchorIndex + 1;
  else if ((page === "prev" || page === "previous") && anchorIndex !== -1) start = Math.max(0, anchorIndex - limit);
  const items = sorted.slice(start, start + limit);

  const link = (pageName: string, anchor: string | null) => {
    const next = new URL(url.toString());
    next.searchParams.set("limit", String(limit));
    next.searchParams.set("page", pageName);
    if (anchor === null) next.searchParams.delete(options.anchorKey);
    else next.searchParams.set(options.anchorKey, anchor);
    return next.toString();
  };
  return {
    items,
    paging: {
      first: link("first", null),
      last: link("last", null),
      next: link("next", items.length > 0 ? options.anchor(items[items.length - 1]) : (anchorValue ?? "")),
      previous: link("prev", items.length > 0 ? options.anchor(items[0]) : (anchorValue ?? "")),
    },
  };
}

export function limitParam(c: Context, fallback: number, max = 1000): number {
  const requested = Number(new URL(c.req.url).searchParams.get("limit") ?? fallback);
  return Number.isFinite(requested) ? Math.min(Math.max(1, requested), max) : fallback;
}

export function skipParam(c: Context): number {
  const requested = Number(new URL(c.req.url).searchParams.get("skip") ?? 0);
  return Number.isFinite(requested) ? Math.max(0, requested) : 0;
}
