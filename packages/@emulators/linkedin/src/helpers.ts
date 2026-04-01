import { randomUUID } from "crypto";

/**
 * Generate a LinkedIn-style subject identifier (UUID v4).
 */
export function generateSub(): string {
  return randomUUID();
}
