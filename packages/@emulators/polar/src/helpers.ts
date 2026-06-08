import { randomBytes } from "node:crypto";

export function polarId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}
