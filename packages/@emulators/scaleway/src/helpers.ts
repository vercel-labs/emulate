import { randomUUID } from "node:crypto";
import type { AppEnv, Context, ContentfulStatusCode, Handler, Hono } from "@emulators/core";
import { REGIONS, type Region, type ScwApiKey } from "./entities.js";
import type { ScwStore } from "./store.js";

export type Body = Record<string, unknown>;
export type Json = Record<string, unknown>;

export const API_PREFIX = "/transactional-email/v1alpha1/regions/:region";

export function guid(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export class ScalewayError extends Error {
  constructor(
    readonly status: number,
    readonly body: Json,
  ) {
    super(String(body.message ?? "error"));
  }
}

export interface ArgumentDetail {
  argument_name: string;
  help_message: string;
  reason: "unknown" | "required" | "invalid_format" | "constraint";
}

export function invalidArguments(details: ArgumentDetail[]): ScalewayError {
  return new ScalewayError(400, { message: "invalid argument(s)", type: "invalid_arguments", details });
}

export function notFound(resource: string, resourceId: string): ScalewayError {
  return new ScalewayError(404, {
    message: "resource is not found",
    type: "not_found",
    resource,
    resource_id: resourceId,
  });
}

export function permissionsDenied(): ScalewayError {
  return new ScalewayError(403, { message: "insufficient permissions", type: "permissions_denied" });
}

export function preconditionFailed(precondition: string, helpMessage: string): ScalewayError {
  return new ScalewayError(412, {
    message: "precondition failed",
    type: "precondition_failed",
    precondition,
    help_message: helpMessage,
  });
}

export function quotaExceeded(quota: string, current: number, limit: number): ScalewayError {
  return new ScalewayError(403, {
    message: "quota exceeded(s)",
    type: "quotas_exceeded",
    details: [{ quota, current, limit }],
  });
}

export function sendError(c: Context, error: ScalewayError): Response {
  return c.json(error.body, error.status as ContentfulStatusCode);
}

export function deniedAuthentication(
  c: Context,
  reason: "invalid_argument" | "not_found" | "expired" = "invalid_argument",
): Response {
  return c.json({ message: "authentication is denied", method: "api_key", reason, type: "denied_authentication" }, 401);
}

export function authenticate(c: Context, scw: ScwStore): ScwApiKey | Response {
  const token = c.req.header("X-Auth-Token")?.trim();
  if (!token) return deniedAuthentication(c);
  const key = scw.apiKeys.findOneBy("secret_key", token);
  if (!key) return deniedAuthentication(c, "not_found");
  return key;
}

export type ApiHandler = (c: Context<AppEnv>, key: ScwApiKey, region: Region) => Promise<Response> | Response;

export function api(scw: ScwStore, handler: ApiHandler): Handler<AppEnv> {
  return async (c) => {
    const key = authenticate(c, scw);
    if (key instanceof Response) return key;
    const region = c.req.param("region") ?? "fr-par";
    try {
      if (!REGIONS.includes(region as Region))
        throw invalidArguments([
          {
            argument_name: "region",
            help_message: `region must be one of ${REGIONS.join(", ")}`,
            reason: "constraint",
          },
        ]);
      return await handler(c, key, region as Region);
    } catch (error) {
      if (error instanceof ScalewayError) return sendError(c, error);
      throw error;
    }
  };
}

export function route(
  app: Hono<AppEnv>,
  method: "get" | "post" | "patch" | "delete",
  path: string,
  handler: Handler<AppEnv>,
): void {
  app[method](`${API_PREFIX}${path}`, handler);
}

export async function parseJsonBody(c: Context): Promise<Body> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new ScalewayError(400, { message: "invalid JSON body", type: "invalid_request_body" });
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

export function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = str(value);
  if (text === undefined) return undefined;
  return text.toLowerCase() === "true";
}

export function obj(value: unknown): Body | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Body) : undefined;
}

export function allQuery(c: Context, name: string): string[] {
  const url = new URL(c.req.url);
  return url.searchParams
    .getAll(name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isEmail(value: string): boolean {
  return /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/.test(value);
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

export function paginate<T>(c: Context, rows: T[]): { items: T[]; total: number } {
  const url = new URL(c.req.url);
  const pageSize = num(url.searchParams.get("page_size")) ?? 20;
  const page = num(url.searchParams.get("page")) ?? 1;
  if (pageSize < 1 || pageSize > 100)
    throw invalidArguments([
      { argument_name: "page_size", help_message: "page_size must be between 1 and 100", reason: "constraint" },
    ]);
  if (page < 1)
    throw invalidArguments([
      { argument_name: "page", help_message: "page must be greater than 0", reason: "constraint" },
    ]);
  return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length };
}

export function queryOf(c: Context): Record<string, string | undefined> {
  return Object.fromEntries(new URL(c.req.url).searchParams.entries());
}

export function parseDate(value: string | undefined, field: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed))
    throw invalidArguments([
      { argument_name: field, help_message: "must be an RFC 3339 timestamp", reason: "invalid_format" },
    ]);
  return parsed;
}
