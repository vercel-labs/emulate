import { randomBytes, randomUUID } from "crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Entity } from "@internal/core";

export function generateEmailId(): string {
  return randomUUID();
}

export function generateDomainId(): string {
  return randomUUID();
}

export function generateApiKeyToken(): string {
  return "re_" + randomBytes(24).toString("base64url");
}

export function generateWebhookSecret(): string {
  return "whsec_" + randomBytes(24).toString("base64url");
}

export function resendError(
  c: Context,
  statusCode: number,
  name: string,
  message: string,
) {
  return c.json(
    { statusCode, name, message },
    statusCode as ContentfulStatusCode,
  );
}

export interface ResendPagination {
  limit: number;
  after: string | null;
  before: string | null;
}

export function parseResendPagination(c: Context): ResendPagination {
  const limitRaw = parseInt(c.req.query("limit") ?? "20", 10);
  const limit = Math.min(100, Math.max(1, isNaN(limitRaw) ? 20 : limitRaw));
  const after = c.req.query("after") ?? null;
  const before = c.req.query("before") ?? null;
  return { limit, after, before };
}

export function applyResendPagination<T extends Entity>(
  items: T[],
  pagination: ResendPagination,
): { data: T[]; has_more: boolean } {
  let filtered = items;

  if (pagination.after) {
    const afterId = parseInt(pagination.after, 10);
    const idx = filtered.findIndex((item) => item.id === afterId);
    if (idx >= 0) {
      filtered = filtered.slice(idx + 1);
    }
  } else if (pagination.before) {
    const beforeId = parseInt(pagination.before, 10);
    const idx = filtered.findIndex((item) => item.id === beforeId);
    if (idx >= 0) {
      filtered = filtered.slice(0, idx);
    }
  }

  const limited = filtered.slice(0, pagination.limit);
  const has_more = filtered.length > pagination.limit;

  return { data: limited, has_more };
}
