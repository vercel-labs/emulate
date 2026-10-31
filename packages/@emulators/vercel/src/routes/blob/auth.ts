import type { Context } from "@emulators/core";

export function resolveStoreId(c: Context): string | null {
  const authHeader = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
  if (!match) return null;
  const token = match[1];
  if (token.startsWith("vercel_blob_rw_")) {
    const parts = token.split("_");
    if (parts.length >= 5 && parts[3] !== "" && parts[4] !== "") {
      return parts[3];
    }
    return null;
  }

  const storeId = c.req.header("x-vercel-blob-store-id")?.trim();
  return storeId ? storeId : null;
}
