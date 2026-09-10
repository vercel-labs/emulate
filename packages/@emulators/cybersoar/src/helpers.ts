import { randomUUID } from "node:crypto";
import type { AppEnv, Context, ContentfulStatusCode, Handler } from "@emulators/core";
import type { CsApiKey } from "./entities.js";
import type { CsStore } from "./store.js";

export type Body = Record<string, unknown>;
export type Json = Record<string, unknown>;

export function guid(): string {
  return randomUUID();
}

export class CybersoarError extends Error {
  constructor(
    readonly status: number,
    readonly messages: string | string[],
    readonly error: string,
  ) {
    super(Array.isArray(messages) ? messages.join("; ") : messages);
  }
}

export function badRequest(messages: string | string[]): CybersoarError {
  return new CybersoarError(400, messages, "Bad Request");
}

export function notFound(message: string): CybersoarError {
  return new CybersoarError(404, message, "Not Found");
}

export function sendError(c: Context, error: CybersoarError): Response {
  return c.json(
    { statusCode: error.status, message: error.messages, error: error.error },
    error.status as ContentfulStatusCode,
  );
}

export function authenticate(c: Context, cs: CsStore): CsApiKey | Response {
  const header = c.req.header("Authorization") ?? "";
  const match = header.match(/^(ApiKey|Bearer)\s+(.+)$/i);
  const raw = match ? match[2].trim() : (c.req.header("X-API-Key") ?? "");
  const key = raw ? cs.apiKeys.findOneBy("api_key", raw) : undefined;
  if (!key) return c.json({ statusCode: 401, message: "Unauthorized", error: "Unauthorized" }, 401);
  return key;
}

export type ApiHandler = (c: Context<AppEnv>, key: CsApiKey) => Promise<Response> | Response;

export function api(cs: CsStore, handler: ApiHandler): Handler<AppEnv> {
  return async (c) => {
    const key = authenticate(c, cs);
    if (key instanceof Response) return key;
    try {
      return await handler(c, key);
    } catch (error) {
      if (error instanceof CybersoarError) return sendError(c, error);
      throw error;
    }
  };
}

export async function parseJsonBody(c: Context): Promise<Body> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw badRequest("Unexpected token in JSON body");
  }
}

export function str(value: unknown): string | undefined {
  if (value === undefined || value === null || typeof value === "object") return undefined;
  return String(value);
}

export function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

export function isoDate(value: unknown, field: string): string | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw badRequest(`${field} must be a valid ISO 8601 date`);
  return new Date(parsed).toISOString();
}

export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function queryOf(c: Context): Record<string, string | undefined> {
  return Object.fromEntries(new URL(c.req.url).searchParams.entries());
}

export function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    return trimmed.slice(1, -1);
  return trimmed;
}
