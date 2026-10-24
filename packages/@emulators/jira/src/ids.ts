import { randomBytes, randomUUID } from "node:crypto";

export function accountId(): string {
  return `712020:${randomUUID()}`;
}

export function cloudId(): string {
  return randomUUID();
}

export function secretToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

/** Jira timestamps look like 2026-09-30T19:41:49.123+0000. */
export function jiraTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toISOString().replace("Z", "+0000");
}
