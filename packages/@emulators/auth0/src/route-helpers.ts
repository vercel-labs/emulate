import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AuthUser, TokenMap, AppEnv } from "@emulators/core";
import type { Auth0Store } from "./store.js";
import type { Auth0User } from "./entities.js";

// Centralized error messages matching Auth0's actual API responses.
// These exact strings are critical for SDK error handling compatibility.
export const AUTH0_ERRORS = {
  USER_EXISTS: "The user already exists.",
  USER_NOT_FOUND: "The user does not exist.",
  INVALID_EMAIL: "Object didn't pass validation for format email: ",
  WEAK_PASSWORD: "PasswordStrengthError: Password is too weak",
  WRONG_CREDENTIALS: "Wrong email or password.",
  USER_BLOCKED: "user is blocked",
  INVALID_REFRESH_TOKEN: "Unknown or invalid refresh token.",
} as const;

// Management API error format: { statusCode, error, message, errorCode }
export function managementApiError(c: Context<AppEnv>, status: number, message: string, errorCode?: string): Response {
  return c.json(
    {
      statusCode: status,
      error: httpStatusText(status),
      message,
      errorCode: errorCode ?? httpStatusText(status),
    },
    status as ContentfulStatusCode,
  );
}

// Authentication API error format: { error, error_description }
// Standard OAuth2 error format used by /oauth/token, /oauth/revoke, /userinfo
export function authenticationApiError(
  c: Context<AppEnv>,
  status: number,
  error: string,
  errorDescription: string,
): Response {
  return c.json(
    {
      error,
      error_description: errorDescription,
    },
    status as ContentfulStatusCode,
  );
}

function httpStatusText(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 409:
      return "Conflict";
    case 429:
      return "Too Many Requests";
    default:
      return "Error";
  }
}

export async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object") {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function requireManagementToken(c: Context<AppEnv>, tokenMap?: TokenMap): AuthUser | Response {
  const existing = c.get("authUser");
  if (existing) return existing;

  const authHeader = c.req.header("Authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    const mapped = tokenMap?.get(token);
    if (mapped) {
      c.set("authUser", mapped);
      c.set("authToken", token);
      c.set("authScopes", mapped.scopes);
      return mapped;
    }
  }

  return managementApiError(c, 401, "Invalid token", "invalid_token");
}

export function findUserById(store: Auth0Store, userId: string): Auth0User | undefined {
  const decoded = decodeURIComponent(userId);
  return store.users.findOneBy("user_id", decoded);
}
