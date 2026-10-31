import { createHash } from "crypto";
import type { Context } from "@emulators/core";
import type { BlobRouteContext } from "./context.js";
import { blobErr } from "./errors.js";
import { blobUrl, contentDispositionFor, downloadUrl, resolveBlobRef } from "./paths.js";
import { findBlob, findBlobRef } from "./lookup.js";
import { etagMatches } from "./etag.js";
import { cacheControlFor, contentTypeFor, resolveUploadTarget } from "./upload.js";

export function registerPut({ app, vs, baseUrl, parsedBaseUrl }: BlobRouteContext): void {
  // Upload. The SDK sends PUT <api>/?pathname=<pathname> with the raw bytes as body.
  // Copy sends the same request with ?fromUrl= and no body.

  const handlePut = async (c: Context): Promise<Response> => {
    const target = resolveUploadTarget(c);
    if (target instanceof Response) return target;
    const { storeId, pathname } = target;

    const ifMatch = c.req.header("x-if-match") || undefined;
    const fromUrl = c.req.query("fromUrl");
    const source = fromUrl === undefined ? undefined : findBlobRef(vs, storeId, resolveBlobRef(fromUrl, parsedBaseUrl));
    if (fromUrl !== undefined && !source) {
      return blobErr(c, 404, "not_found", "The requested blob does not exist");
    }

    const existing = findBlob(vs, storeId, pathname);

    // A copy's ifMatch guards the source; a plain upload's ifMatch guards the destination.
    if (ifMatch && !etagMatches(source ? source.etag : existing?.etag, ifMatch)) {
      return blobErr(c, 412, "precondition_failed", "Precondition failed: ETag mismatch.");
    }
    // Copies always replace the destination, like the real service.
    const overwriteAllowed = source !== undefined || ifMatch !== undefined || c.req.header("x-allow-overwrite") === "1";
    if (existing && !overwriteAllowed) {
      return blobErr(c, 400, "bad_request", "This blob already exists, use allowOverwrite: true to overwrite it");
    }

    const body = source ? Buffer.from(source.dataBase64, "base64") : Buffer.from(await c.req.arrayBuffer());
    const contentType = contentTypeFor(c, pathname, { useRequestHeader: !source });
    const cacheControl = cacheControlFor(c.req.header("x-cache-control-max-age"));
    const contentDisposition = contentDispositionFor(pathname);
    const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    const uploadedAt = new Date().toISOString();

    const fields = {
      pathname,
      storeId,
      contentType,
      contentDisposition,
      cacheControl,
      size: body.byteLength,
      etag,
      uploadedAt,
      dataBase64: body.toString("base64"),
    };

    if (existing) {
      vs.blobs.update(existing.id, fields);
    } else {
      vs.blobs.insert(fields);
    }

    const url = blobUrl(baseUrl, storeId, pathname);
    return c.json({
      url,
      downloadUrl: downloadUrl(url),
      pathname,
      contentType,
      contentDisposition,
      etag,
    });
  };

  app.put("/api/blob", handlePut);
  app.put("/api/blob/", handlePut);
}
