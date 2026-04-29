import { randomUUID } from "crypto";
import { gunzipSync } from "node:zlib";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function generateUuid(): string {
  return randomUUID();
}

export function posthogError(c: Context, statusCode: number, detail: string) {
  return c.json({ type: "validation_error", code: "invalid_request", detail }, statusCode as ContentfulStatusCode);
}

function tryJson(text: string): Record<string, unknown> {
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function parseUrlEncoded(text: string): Record<string, unknown> {
  const params = new URLSearchParams(text);
  const data = params.get("data");
  if (data) {
    return tryJson(data);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

function parseCaptureText(text: string, contentType: string): Record<string, unknown> {
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return parseUrlEncoded(text);
  }

  if (contentType.includes("text/plain") && text.startsWith("data=")) {
    return parseUrlEncoded(text);
  }

  return tryJson(text);
}

export async function parseCaptureBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";
  const contentEncoding = c.req.header("content-encoding") ?? "";
  const compressionParam = c.req.query("compression") ?? "";
  const isGzipped =
    contentEncoding.startsWith("gzip") ||
    contentEncoding === "x-gzip" ||
    compressionParam === "gzip-js" ||
    compressionParam === "gzip";

  if (isGzipped) {
    try {
      const buffer = Buffer.from(await c.req.arrayBuffer());
      return parseCaptureText(gunzipSync(buffer).toString("utf8"), contentType);
    } catch {
      return {};
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return parseUrlEncoded(await c.req.text());
  }

  if (contentType.includes("text/plain")) {
    const text = await c.req.text();
    if (text.startsWith("data=")) {
      return parseUrlEncoded(text);
    }
    return tryJson(text);
  }

  try {
    const body = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}
