import { randomBytes } from "node:crypto";

export function twilioSid(prefix: string): string {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

export function fixedSid(prefix: string): string {
  return `${prefix}${"0".repeat(32)}`;
}
