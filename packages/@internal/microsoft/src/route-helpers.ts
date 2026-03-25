import type { Context } from "hono";
import { microsoftGraphError, requireMicrosoftAuth } from "./helpers.js";

export function requireGraphUser(c: Context): string | Response {
  const authEmail = requireMicrosoftAuth(c);
  if (authEmail instanceof Response) return authEmail;

  const userId = c.req.param("userId");
  if (userId && userId !== "me" && userId !== authEmail) {
    return microsoftGraphError(c, 404, "Request_ResourceNotFound", "User not found.");
  }

  return authEmail;
}

export async function parseJsonBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await c.req.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function getGraphBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/v1.0`;
}

export function getNumberQuery(c: Context, name: string, fallback = 0): number {
  const raw = c.req.query(name);
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
}
