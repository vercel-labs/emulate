import { randomUUID } from "crypto";

export function generateUuid(): string {
  return randomUUID();
}
