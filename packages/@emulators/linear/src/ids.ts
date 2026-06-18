import { randomBytes, randomUUID } from "node:crypto";

export function linearId(): string {
  return randomUUID();
}

export function token(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
