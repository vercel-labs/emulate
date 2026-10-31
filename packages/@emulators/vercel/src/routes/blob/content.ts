import type { BlobRouteContext } from "./context.js";
import { blobErr } from "./errors.js";
import { findBlob } from "./lookup.js";

export function registerContent({ app, vs }: BlobRouteContext): void {
  // Public content serving.
  // Blob URLs point here. Public access, no authentication.

  app.get("/blob/:storeId/:pathname{.+}", (c) => {
    const storeId = c.req.param("storeId");
    const pathname = c.req.param("pathname");
    const blob = findBlob(vs, storeId, pathname);
    if (!blob) {
      return blobErr(c, 404, "not_found", "The requested blob does not exist");
    }

    const headers: Record<string, string> = {
      etag: blob.etag,
      "cache-control": blob.cacheControl,
    };

    if (c.req.header("if-none-match") === blob.etag) {
      return c.body(null, 304, headers);
    }

    headers["content-type"] = blob.contentType;
    if (c.req.query("download") === "1") {
      headers["content-disposition"] = blob.contentDisposition;
    }
    return c.body(Buffer.from(blob.dataBase64, "base64"), 200, headers);
  });
}
