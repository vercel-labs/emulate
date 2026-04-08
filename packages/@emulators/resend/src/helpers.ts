import { randomUUID } from "crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function generateUuid(): string {
  return randomUUID();
}

export function resendError(c: Context, statusCode: number, name: string, message: string) {
  return c.json({ statusCode, name, message }, statusCode as ContentfulStatusCode);
}

export function resendList(data: unknown[]) {
  return { object: "list" as const, data };
}

export async function parseResendBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await c.req.text();
    const params = new URLSearchParams(text);
    const result: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) {
      result[key] = value;
    }
    return result;
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
