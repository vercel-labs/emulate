import type { Context } from "hono";
import { getAuthenticatedEmail, gmailError, matchesRequestedUser } from "./helpers.js";

export function requireGmailUser(c: Context): string | Response {
  const authEmail = getAuthenticatedEmail(c);
  if (!authEmail) {
    return gmailError(c, 401, "Request had invalid authentication credentials.", "authError", "UNAUTHENTICATED");
  }

  if (!matchesRequestedUser(c.req.param("userId"), authEmail)) {
    return gmailError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
  }

  return authEmail;
}

export async function parseGoogleBody(
  c: Context,
): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type") ?? "";
  const rawText = await c.req.text();

  if (!rawText) return {};

  let parsed: Record<string, unknown>;

  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(rawText);
      parsed = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    parsed = Object.fromEntries(new URLSearchParams(rawText));
  } else {
    parsed = {
      raw: Buffer.from(rawText, "utf8").toString("base64url"),
    };
  }

  const nestedBody = parsed.requestBody;
  if (nestedBody && typeof nestedBody === "object" && !Array.isArray(nestedBody)) {
    return nestedBody as Record<string, unknown>;
  }

  return parsed;
}

export function getStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }

  if (typeof value === "string" && value.length > 0) {
    return [value];
  }

  return [];
}

export function getString(body: Record<string, unknown>, ...fields: string[]): string | undefined {
  for (const field of fields) {
    const value = body[field];
    if (typeof value === "string") return value;
  }

  return undefined;
}
