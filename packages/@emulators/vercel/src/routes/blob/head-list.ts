import type { Context } from "@emulators/core";
import type { VercelBlob } from "../../entities.js";
import type { BlobRouteContext } from "./context.js";
import { DEFAULT_LIST_LIMIT } from "./constants.js";
import { blobErr, forbidden } from "./errors.js";
import { resolveStoreId } from "./auth.js";
import { blobUrl, downloadUrl, resolveBlobRef } from "./paths.js";
import { findBlobRef, headResponse } from "./lookup.js";

export function registerHeadList({ app, vs, baseUrl, parsedBaseUrl }: BlobRouteContext): void {
  // Head and list.
  // The SDK sends GET <api>?url=<urlOrPathname> for head and
  // GET <api>?prefix=&limit=&cursor=&mode= for list.

  const handleGet = (c: Context): Response => {
    const storeId = resolveStoreId(c);
    if (!storeId) return forbidden(c);

    const urlParam = c.req.query("url");
    if (urlParam !== undefined) {
      const blob = findBlobRef(vs, storeId, resolveBlobRef(urlParam, parsedBaseUrl));
      if (!blob) {
        return blobErr(c, 404, "not_found", "The requested blob does not exist");
      }
      return c.json(headResponse(baseUrl, blob));
    }

    const prefix = c.req.query("prefix") ?? "";
    const limitParam = parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_LIST_LIMIT;
    const cursor = c.req.query("cursor");
    const folded = c.req.query("mode") === "folded";

    // Folded listings paginate over folders and root blobs together, so each
    // entry is keyed by its folder prefix or its pathname.
    const entries = new Map<string, VercelBlob | null>();
    for (const b of vs.blobs.findBy("storeId", storeId)) {
      if (!b.pathname.startsWith(prefix)) continue;
      const slash = folded ? b.pathname.indexOf("/", prefix.length) : -1;
      if (slash === -1) {
        entries.set(b.pathname, b);
      } else {
        entries.set(b.pathname.slice(0, slash + 1), null);
      }
    }

    let keys = [...entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (cursor) {
      keys = keys.filter((key) => key > cursor);
    }

    const hasMore = keys.length > limit;
    const pageKeys = keys.slice(0, limit);
    const page = pageKeys.flatMap((key) => entries.get(key) ?? []);

    const result: Record<string, unknown> = {
      blobs: page.map((b) => {
        const url = blobUrl(baseUrl, b.storeId, b.pathname);
        return {
          url,
          downloadUrl: downloadUrl(url),
          pathname: b.pathname,
          size: b.size,
          uploadedAt: b.uploadedAt,
          etag: b.etag,
        };
      }),
      hasMore,
    };
    if (hasMore && pageKeys.length > 0) {
      result.cursor = pageKeys[pageKeys.length - 1];
    }
    if (folded) {
      result.folders = pageKeys.filter((key) => entries.get(key) === null);
    }
    return c.json(result);
  };

  app.get("/api/blob", handleGet);
  app.get("/api/blob/", handleGet);
}
