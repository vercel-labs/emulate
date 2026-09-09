import { randomBytes } from "node:crypto";

export function messageId(domain: string): string {
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `<${stamp}.${randomBytes(4).readUInt32BE(0) % 100000}.${randomBytes(8).toString("hex").toUpperCase()}@${domain}>`;
}

export function storageKey(): string {
  return randomBytes(45).toString("base64url");
}

export function eventId(): string {
  return randomBytes(16).toString("base64url").slice(0, 22);
}

export function token(length = 50): string {
  return randomBytes(length).toString("hex").slice(0, length);
}

export function routeId(): string {
  return randomBytes(12).toString("hex");
}

export function templateVersionId(): string {
  return `${randomBytes(4).toString("hex")}-${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}-${randomBytes(6).toString("hex")}`;
}
