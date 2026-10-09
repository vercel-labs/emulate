import type { BlobRouteContext } from "./context.js";
import { blobErr, forbidden } from "./errors.js";
import { resolveStoreId } from "./auth.js";
import { resolveBlobRef } from "./paths.js";
import { findBlobRef } from "./lookup.js";

export function registerDelete({ app, vs, parsedBaseUrl }: BlobRouteContext): void {
  // Delete.

  app.post("/api/blob/delete", async (c) => {
    const storeId = resolveStoreId(c);
    if (!storeId) return forbidden(c);

    let body: { urls?: unknown };
    try {
      body = (await c.req.json()) as { urls?: unknown };
    } catch {
      body = {};
    }
    const urls = Array.isArray(body.urls) ? body.urls.filter((u): u is string => typeof u === "string") : [];

    const ifMatch = c.req.header("x-if-match");
    for (const urlOrPathname of urls) {
      const blob = findBlobRef(vs, storeId, resolveBlobRef(urlOrPathname, parsedBaseUrl));
      if (!blob) continue;
      if (ifMatch) {
        const normalized = ifMatch.startsWith('"') ? ifMatch : `"${ifMatch}"`;
        if (blob.etag !== normalized) {
          return blobErr(c, 412, "precondition_failed", "Precondition failed: ETag mismatch.");
        }
      }
      vs.blobs.delete(blob.id);
    }

    return c.json(null);
  });
}
