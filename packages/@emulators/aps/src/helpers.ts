import { createHash, randomBytes } from "node:crypto";
import type { ApsClient, ApsUser, ApsClientType } from "./entities.js";

export const DEFAULT_CONFIDENTIAL_CLIENT_ID = "aps-test-client";
export const DEFAULT_CONFIDENTIAL_CLIENT_SECRET = "aps-test-secret";
export const DEFAULT_PUBLIC_CLIENT_ID = "aps-test-app";
export const DEFAULT_USER_EMAIL = "testuser@autodesk.local";

export const SUPPORTED_SCOPES = [
  "user-profile:read",
  "user:read",
  "user:write",
  "viewables:read",
  "data:read",
  "data:write",
  "data:create",
  "data:search",
  "bucket:create",
  "bucket:read",
  "bucket:update",
  "bucket:delete",
  "code:all",
  "account:read",
  "account:write",
  "openid",
];

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomString(alphabet: string, length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export function generateAuthorizationCode(): string {
  return randomBytes(30).toString("base64url");
}

export function generateRefreshToken(): string {
  return randomString(ALPHANUMERIC, 42);
}

export function generateJti(): string {
  return randomString(ALPHANUMERIC, 64);
}

export function generateUserId(): string {
  return randomString(UPPER_ALPHANUMERIC, 12);
}

export function analyticsIdFor(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 32);
}

export function parseScope(scope: string): string[] {
  return scope
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isSupportedScope(scope: string): boolean {
  if (SUPPORTED_SCOPES.includes(scope)) return true;
  return /^data:read:[^*\\"]+$/.test(scope);
}

export function splitName(name: string, email: string): { first_name: string; last_name: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    const local = email.split("@")[0] ?? "Test";
    return { first_name: local, last_name: "User" };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: "" };
  return { first_name: parts.slice(0, -1).join(" "), last_name: parts[parts.length - 1] };
}

export function userNameFor(user: Pick<ApsUser, "email">): string {
  return user.email.split("@")[0] ?? user.email;
}

export function normalizeClientType(type: string | undefined, fallback: ApsClientType): ApsClientType {
  if (type === "confidential" || type === "public") return type;
  return fallback;
}

export function createDefaultConfidentialClient(): Omit<ApsClient, "id" | "created_at" | "updated_at"> {
  return {
    client_id: DEFAULT_CONFIDENTIAL_CLIENT_ID,
    client_secret: DEFAULT_CONFIDENTIAL_CLIENT_SECRET,
    name: "Sample APS Web App",
    type: "confidential",
    redirect_uris: ["http://localhost:3000/api/auth/callback/aps", "http://localhost:3000/callback"],
  };
}

export function createDefaultPublicClient(): Omit<ApsClient, "id" | "created_at" | "updated_at"> {
  return {
    client_id: DEFAULT_PUBLIC_CLIENT_ID,
    client_secret: "",
    name: "Sample APS Desktop App",
    type: "public",
    redirect_uris: ["http://localhost:3000/callback"],
  };
}

export function createDefaultUser(): Omit<ApsUser, "id" | "created_at" | "updated_at"> {
  return {
    user_id: generateUserId(),
    email: DEFAULT_USER_EMAIL,
    name: "Test User",
    first_name: "Test",
    last_name: "User",
    picture: null,
  };
}
