import { randomBytes, randomUUID } from "node:crypto";
import type { AppEnv, Context, ContentfulStatusCode, Handler, Hono } from "@emulators/core";
import type { EsApiKey } from "./entities.js";
import type { EsStore } from "./store.js";

export type Body = Record<string, unknown>;
export type Json = Record<string, unknown>;

export function guid(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function token(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export class KibanaError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly attributes?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class EsError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly reason: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(reason);
  }
}

export function kibanaBadRequest(message: string, attributes?: Record<string, unknown>): KibanaError {
  return new KibanaError(400, message, attributes);
}

export function kibanaNotFound(message: string): KibanaError {
  return new KibanaError(404, message);
}

export function kibanaConflict(message: string): KibanaError {
  return new KibanaError(409, message);
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
};

export function sendKibanaError(c: Context, error: KibanaError): Response {
  return c.json(
    {
      statusCode: error.status,
      error: STATUS_TEXT[error.status] ?? "Error",
      message: error.message,
      ...(error.attributes ? { attributes: error.attributes } : {}),
    },
    error.status as ContentfulStatusCode,
  );
}

export function sendEsError(c: Context, error: EsError): Response {
  c.header("X-Elastic-Product", "Elasticsearch");
  const detail = { type: error.type, reason: error.reason, ...error.extra };
  return c.json(
    { error: { root_cause: [detail], ...detail }, status: error.status },
    error.status as ContentfulStatusCode,
  );
}

export function esNotFound(index: string): EsError {
  return new EsError(404, "index_not_found_exception", `no such index [${index}]`, {
    "resource.type": "index_or_alias",
    "resource.id": index,
    index_uuid: "_na_",
    index,
  });
}

export function esBadRequest(reason: string, type = "parsing_exception"): EsError {
  return new EsError(400, type, reason);
}

export function authenticate(c: Context, es: EsStore): EsApiKey | Response {
  const header = c.req.header("Authorization") ?? "";
  const match = header.match(/^(ApiKey|Basic|Bearer)\s+(.+)$/i);
  if (!match) return unauthorized(c);
  const scheme = match[1].toLowerCase();
  const raw = match[2].trim();
  if (scheme === "basic") {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const [username, ...rest] = decoded.split(":");
    const password = rest.join(":");
    const found = es.apiKeys.all().find((key) => key.name === username && key.api_key === password);
    return found ?? unauthorized(c);
  }
  const direct = es.apiKeys.findOneBy("api_key", raw);
  if (direct) return direct;
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator > 0) {
    const keyId = decoded.slice(0, separator);
    const secret = decoded.slice(separator + 1);
    const found = es.apiKeys.findOneBy("key_id", keyId);
    if (found && found.api_key === secret) return found;
  }
  return unauthorized(c);
}

export function unauthorized(c: Context): Response {
  const isKibana = new URL(c.req.url).pathname.startsWith("/api/");
  if (isKibana) return c.json({ statusCode: 401, error: "Unauthorized", message: "Unauthorized" }, 401);
  c.header("X-Elastic-Product", "Elasticsearch");
  c.header("WWW-Authenticate", 'ApiKey, Basic realm="security", charset="UTF-8"');
  return c.json(
    {
      error: {
        root_cause: [
          {
            type: "security_exception",
            reason:
              "unable to authenticate with provided credentials and anonymous access is not allowed for this request",
          },
        ],
        type: "security_exception",
        reason: "unable to authenticate with provided credentials and anonymous access is not allowed for this request",
      },
      status: 401,
    },
    401,
  );
}

export type KibanaHandler = (c: Context<AppEnv>, key: EsApiKey) => Promise<Response> | Response;

export function kibana(es: EsStore, handler: KibanaHandler): Handler<AppEnv> {
  return async (c) => {
    const key = authenticate(c, es);
    if (key instanceof Response) return key;
    if (
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      !c.req.header("kbn-xsrf") &&
      !c.req.header("x-elastic-internal-origin")
    ) {
      return c.json({ statusCode: 400, error: "Bad Request", message: "Request must contain a kbn-xsrf header." }, 400);
    }
    try {
      return await handler(c, key);
    } catch (error) {
      if (error instanceof KibanaError) return sendKibanaError(c, error);
      throw error;
    }
  };
}

export function elasticsearch(es: EsStore, handler: KibanaHandler): Handler<AppEnv> {
  return async (c) => {
    const key = authenticate(c, es);
    if (key instanceof Response) return key;
    c.header("X-Elastic-Product", "Elasticsearch");
    try {
      return await handler(c, key);
    } catch (error) {
      if (error instanceof EsError) return sendEsError(c, error);
      throw error;
    }
  };
}

export function fleetRoute(
  app: Hono<AppEnv>,
  method: "get" | "post" | "put" | "delete",
  path: string,
  handler: Handler<AppEnv>,
): void {
  app[method](`/api${path}`, handler);
  app[method](`/kibana/api${path}`, handler);
}

export async function parseJsonBody(c: Context): Promise<Body> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new KibanaError(400, "Invalid request payload JSON format");
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

export function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = str(value);
  return text ? [text] : [];
}

export function obj(value: unknown): Body | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Body) : undefined;
}

export interface KueryClause {
  field: string;
  value: string;
}

export function parseKuery(kuery: string | undefined): KueryClause[] {
  if (!kuery) return [];
  const clauses: KueryClause[] = [];
  const pattern = /([A-Za-z0-9_.@-]+)\s*:\s*("([^"]*)"|'([^']*)'|([^\s()]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(kuery)) !== null)
    clauses.push({ field: match[1], value: (match[3] ?? match[4] ?? match[5] ?? "").trim() });
  if (clauses.length === 0 && kuery.trim()) clauses.push({ field: "", value: kuery.trim().replace(/^"|"$/g, "") });
  return clauses;
}

export function kueryMatches(row: Json, clauses: KueryClause[]): boolean {
  return clauses.every((clause) => {
    const wanted = clause.value.toLowerCase();
    if (!clause.field)
      return Object.values(row).some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(wanted),
      );
    const path = clause.field.replace(
      /^(fleet-agents|ingest-agent-policies|fleet-enrollment-api-keys|fleet-agent-policies)\./,
      "",
    );
    const actual = readPath(row, path);
    if (Array.isArray(actual)) return actual.some((item) => String(item).toLowerCase() === wanted);
    if (actual === undefined || actual === null) return false;
    const text = String(actual).toLowerCase();
    if (wanted.includes("*"))
      return new RegExp(
        `^${wanted
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      ).test(text);
    return text === wanted;
  });
}

export function readPath(row: unknown, path: string): unknown {
  if (row === null || row === undefined) return undefined;
  if (typeof row !== "object") return undefined;
  const record = row as Json;
  if (path in record) return record[path];
  const [head, ...rest] = path.split(".");
  if (!(head in record)) return undefined;
  if (rest.length === 0) return record[head];
  return readPath(record[head], rest.join("."));
}

export function paginate<T>(c: Context, rows: T[]): { items: T[]; total: number; page: number; perPage: number } {
  const url = new URL(c.req.url);
  const perPage = Math.min(Math.max(num(url.searchParams.get("perPage")) ?? 20, 1), 10000);
  const page = Math.max(num(url.searchParams.get("page")) ?? 1, 1);
  return { items: rows.slice((page - 1) * perPage, page * perPage), total: rows.length, page, perPage };
}
