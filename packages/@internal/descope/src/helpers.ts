import { randomBytes } from "crypto";

export function generateUid(prefix = "descope"): string {
  const id = randomBytes(12).toString("base64url").slice(0, 20);
  return `${prefix}_${id}`;
}
