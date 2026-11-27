import { createHash } from "crypto";
import type { Context } from "@emulators/core";
import type { BlobRouteContext } from "./context.js";
import { blobErr } from "./errors.js";
import { blobUrl, contentDispositionFor, downloadUrl, resolveBlobRef } from "./paths.js";
import { findBlob, findBlobRef } from "./lookup.js";
import { etagMatches } from "./etag.js";
import { cacheControlFor, contentTypeFor, resolveUploadTarget, signedUploadError } from "./upload.js";
import { sendUploadCompleted } from "./callback.js";

export function registerPut({ app, vs, baseUrl, parsedBaseUrl, authenticate }: BlobRouteContext): void {
  // Upload. The SDK sends PUT <api>/?pathname=<pathname> with the raw bytes as body.
  // Copy sends the same request with ?fromUrl= and no body.

  const handlePut = async (c: Context): Promise<Response> => {
    const fromUrl = c.req.query("fromUrl");
    const auth = authenticate(c, fromUrl === undefined ? "put" : "copy");
    if (auth instanceof Response) return auth;
    const { storeId, signedParams } = auth;

    const target = resolveUploadTarget(c, signedParams);
    if (target instanceof Response) return target;
    const { pathname, key, options } = target;

    const source = fromUrl === undefined ? undefined : findBlobRef(vs, storeId, resolveBlobRef(fromUrl, parsedBaseUrl));
    if (fromUrl !== undefined && !source) {
      return blobErr(c, 404, "not_found", "The requested blob does not exist");
    }

    const body = source ? Buffer.from(source.dataBase64, "base64") : Buffer.from(await c.req.arrayBuffer());
    const contentType = contentTypeFor(c, pathname, { useRequestHeader: !source });

    // Signed constraints apply to the requested pathname, before any suffix.
    if (signedParams) {
      const message = signedUploadError(signedParams, { pathname, contentType, contentLength: body.byteLength });
      if (message) return blobErr(c, 403, "forbidden", message);
    }

    const cacheControl = cacheControlFor(options.cacheControlMaxAge);
    const existing = findBlob(vs, storeId, key);
    const { ifMatch } = options;

    // A copy's ifMatch guards the source; a plain upload's ifMatch guards the destination.
    if (ifMatch && !etagMatches(source ? source.etag : existing?.etag, ifMatch)) {
      return blobErr(c, 412, "precondition_failed", "Precondition failed: ETag mismatch.");
    }
    // Copies always replace the destination, like the real service.
    const overwriteAllowed = source !== undefined || ifMatch !== undefined || options.allowOverwrite;
    if (existing && !overwriteAllowed) {
      return blobErr(c, 400, "bad_request", "This blob already exists, use allowOverwrite: true to overwrite it");
    }

    const contentDisposition = contentDispositionFor(key);
    const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    const uploadedAt = new Date().toISOString();

    const fields = {
      pathname: key,
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

    const url = blobUrl(baseUrl, storeId, key);
    const blob = {
      url,
      downloadUrl: downloadUrl(url),
      pathname: key,
      contentType,
      contentDisposition,
      etag,
    };
    const response = c.json(blob);

    if (signedParams) {
      const apiVersion = parseInt(c.req.header("x-api-version") ?? "", 10);
      sendUploadCompleted(vs, { storeId, signedParams, blob, apiVersion });
    }
    return response;
  };

  app.put("/api/blob", handlePut);
  app.put("/api/blob/", handlePut);
}
