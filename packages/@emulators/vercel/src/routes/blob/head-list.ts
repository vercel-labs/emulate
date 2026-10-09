import type { Context } from "@emulators/core";
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

    let items = vs.blobs
      .findBy("storeId", storeId)
      .filter((b) => b.pathname.startsWith(prefix))
      .sort((a, b) => (a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0));

    const folders = new Set<string>();
    if (folded) {
      items = items.filter((b) => {
        const rest = b.pathname.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) return true;
        folders.add(prefix + rest.slice(0, slash + 1));
        return false;
      });
    }

    if (cursor) {
      items = items.filter((b) => b.pathname > cursor);
    }

    const hasMore = items.length > limit;
    const page = items.slice(0, limit);

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
    if (hasMore && page.length > 0) {
      result.cursor = page[page.length - 1].pathname;
    }
    if (folded) {
      result.folders = [...folders].sort();
    }
    return c.json(result);
  };

  app.get("/api/blob", handleGet);
  app.get("/api/blob/", handleGet);
}
