import { randomUUID } from "node:crypto";
import type { AppEnv, Context, ContentfulStatusCode, Handler, Hono } from "@emulators/core";
import type { D360ApiToken } from "./entities.js";
import type { D360Store } from "./store.js";

export type Body = Record<string, unknown>;

export function guid(): string {
  return randomUUID();
}

export function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  let slug = base;
  let counter = 1;
  while (taken(slug)) slug = `${base}-${counter++}`;
  return slug;
}

export interface D360Error {
  extension_data: null;
  stack_trace: null;
  description: string;
  error_code: string;
  custom_data: null;
  warning: boolean;
}

export function makeError(description: string, code = "invalid_request"): D360Error {
  return { extension_data: null, stack_trace: null, description, error_code: code, custom_data: null, warning: false };
}

export function envelope(
  result: unknown,
  extras: Partial<{ errors: D360Error[]; warnings: string[]; information: string[] }> = {},
) {
  return {
    result,
    extension_data: null,
    success: (extras.errors?.length ?? 0) === 0,
    errors: extras.errors ?? [],
    warnings: extras.warnings ?? [],
    information: extras.information ?? [],
  };
}

export class D360ApiError extends Error {
  constructor(
    readonly status: number,
    readonly errors: D360Error[],
  ) {
    super(errors[0]?.description ?? "Request failed");
  }
}

export function badRequest(description: string, code = "invalid_request"): D360ApiError {
  return new D360ApiError(400, [makeError(description, code)]);
}

export function notFound(description: string, code = "not_found"): D360ApiError {
  return new D360ApiError(404, [makeError(description, code)]);
}

export function sendApiError(c: Context, error: D360ApiError): Response {
  return c.json(envelope(null, { errors: error.errors }), error.status as ContentfulStatusCode);
}

export function unauthorized(c: Context): Response {
  return c.json(
    envelope(null, { errors: [makeError("The provided API token is invalid or missing.", "unauthorized")] }),
    401,
  );
}

export function authenticate(c: Context, ds: D360Store): D360ApiToken | Response {
  const header = c.req.header("api_token") ?? c.req.header("api-token") ?? c.req.header("x-api-token");
  const bearer = c.req.header("Authorization");
  const token = header ?? (bearer?.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : undefined);
  if (!token) return unauthorized(c);
  const found = ds.apiTokens.findOneBy("token", token);
  if (!found) return unauthorized(c);
  return found;
}

export type ApiHandler = (c: Context<AppEnv>, token: D360ApiToken) => Promise<Response> | Response;

export function api(ds: D360Store, handler: ApiHandler): Handler<AppEnv> {
  return async (c) => {
    const token = authenticate(c, ds);
    if (token instanceof Response) return token;
    try {
      return await handler(c, token);
    } catch (error) {
      if (error instanceof D360ApiError) return sendApiError(c, error);
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
  app[method](path.replace("/v2/", "/v1/"), handler);
}

export async function parseJsonBody(c: Context): Promise<Body> {
  const text = await c.req.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw badRequest("Request body is not valid JSON", "invalid_json");
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
  return text === "true" || text === "1";
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

export function obj(value: unknown): Body {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Body) : {};
}

export function emailValid(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function markdownToHtml(markdown: string): string {
  const escaped = markdown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = escaped.split(/\r?\n/);
  const html: string[] = [];
  let paragraph: string[] = [];
  let inList = false;
  const inline = (text: string) =>
    text
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, "<code>$1</code>")
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      closeList();
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  closeList();
  return html.join("");
}

export function skipTake(c: Context, defaultTake = 100): { skip: number; take: number } {
  const url = new URL(c.req.url);
  const skip = Number(url.searchParams.get("skip") ?? 0);
  const take = Number(url.searchParams.get("take") ?? defaultTake);
  return {
    skip: Number.isFinite(skip) && skip >= 0 ? skip : 0,
    take: Number.isFinite(take) && take > 0 ? Math.min(take, 1000) : defaultTake,
  };
}
