import { createHash, randomBytes } from "node:crypto";
import type { Auth0User } from "./entities.js";

export const DEFAULT_CONNECTION = "Username-Password-Authentication";

export function generateAuth0UserId(): string {
  const id = randomBytes(8).toString("hex");
  return `auth0|${id}`;
}

export function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

export function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isStrongPassword(password: string): boolean {
  return password.length >= 8 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password);
}

export function generateToken(prefix: string): string {
  return `${prefix}_${randomBytes(20).toString("base64url")}`;
}

export function buildLogEvent(type: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    log_id: randomBytes(12).toString("hex"),
    date: new Date().toISOString(),
    type,
    ...fields,
  };
}

export function userResponse(user: Auth0User): Record<string, unknown> {
  return {
    user_id: user.user_id,
    email: user.email,
    email_verified: user.email_verified,
    name: user.name,
    given_name: user.given_name,
    family_name: user.family_name,
    nickname: user.nickname,
    picture: user.picture,
    blocked: user.blocked,
    app_metadata: user.app_metadata,
    user_metadata: user.user_metadata,
    created_at: user.created_at,
    updated_at: user.updated_at,
    identities: [
      {
        connection: user.connection,
        user_id: user.user_id.replace("auth0|", ""),
        provider: "auth0",
        isSocial: false,
      },
    ],
  };
}
