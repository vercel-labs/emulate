import { randomUUID } from "crypto";

/** Default tenant ID used when none is configured */
export const DEFAULT_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

/**
 * Generate a Microsoft-style object ID (UUID v4 format).
 */
export function generateOid(): string {
  return randomUUID();
}
