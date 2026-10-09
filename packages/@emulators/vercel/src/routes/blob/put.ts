import { createHash } from "crypto";
import type { Context } from "@emulators/core";
import type { BlobRouteContext } from "./context.js";
import { DEFAULT_CACHE_MAX_AGE } from "./constants.js";
import { blobErr, forbidden } from "./errors.js";
import { resolveStoreId } from "./auth.js";
import {
  blobUrl,
  contentDispositionFor,
  downloadUrl,
  inferContentType,
  resolveBlobRef,
  withRandomSuffix,
} from "./paths.js";
import { findBlob, findBlobRef } from "./lookup.js";

export function registerPut({ app, vs, baseUrl, parsedBaseUrl }: BlobRouteContext): void {
  // Upload. The SDK sends PUT <api>/?pathname=<pathname> with the raw bytes as body.

  const handlePut = async (c: Context): Promise<Response> => {
    const storeId = resolveStoreId(c);
    if (!storeId) return forbidden(c);

    const rawPathname = c.req.query("pathname");
    if (!rawPathname) {
      return blobErr(c, 400, "bad_request", "pathname is required");
    }
    if (rawPathname.includes("//")) {
      return blobErr(c, 400, "bad_request", "pathname cannot contain //");
    }

    const access = c.req.header("x-vercel-blob-access") ?? "public";
    if (access !== "public") {
      return blobErr(c, 400, "bad_request", "Only access: public is supported by the emulator");
    }

    const pathname = c.req.header("x-add-random-suffix") === "1" ? withRandomSuffix(rawPathname) : rawPathname;

    const existing = findBlob(vs, storeId, pathname);

    const ifMatch = c.req.header("x-if-match");
    if (ifMatch) {
      const normalized = ifMatch.startsWith('"') ? ifMatch : `"${ifMatch}"`;
      if (!existing || existing.etag !== normalized) {
        return blobErr(c, 412, "precondition_failed", "Precondition failed: ETag mismatch.");
      }
    } else if (existing && c.req.header("x-allow-overwrite") !== "1") {
      return blobErr(c, 400, "bad_request", "This blob already exists, use allowOverwrite: true to overwrite it");
    }

    const fromUrl = c.req.query("fromUrl");
    const source = fromUrl === undefined ? undefined : findBlobRef(vs, storeId, resolveBlobRef(fromUrl, parsedBaseUrl));
    if (fromUrl !== undefined && !source) {
      return blobErr(c, 404, "not_found", "The requested blob does not exist");
    }

    const body = source ? Buffer.from(source.dataBase64, "base64") : Buffer.from(await c.req.arrayBuffer());
    const contentType = c.req.header("x-content-type") || inferContentType(pathname);
    const maxAgeHeader = c.req.header("x-cache-control-max-age");
    const maxAge = maxAgeHeader ? parseInt(maxAgeHeader, 10) : NaN;
    const cacheControl = `public, max-age=${Number.isFinite(maxAge) ? maxAge : DEFAULT_CACHE_MAX_AGE}`;
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
