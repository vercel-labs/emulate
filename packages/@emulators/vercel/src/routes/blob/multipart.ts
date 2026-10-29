import { randomBytes } from "crypto";
import type { Context } from "@emulators/core";
import type { BlobRouteContext } from "./context.js";
import type { BlobOperation } from "./auth.js";
import { blobErr } from "./errors.js";
import { cacheControlFor, contentTypeFor, resolveUploadTarget, signedUploadError } from "./upload.js";

const MPU_OPERATIONS: Record<string, BlobOperation> = {
  create: "mpu_create",
  upload: "mpu_upload",
  complete: "mpu_complete",
};

export function registerMultipart({ app, vs, authenticate }: BlobRouteContext): void {
  // Multipart uploads. Creation records a session; uploading parts and
  // completing the upload are not supported yet.

  const notSupported = (c: Context): Response =>
    blobErr(c, 400, "bad_request", "Multipart uploads are not supported by the emulator yet");

  const handleMpu = (c: Context): Response => {
    const operation = MPU_OPERATIONS[c.req.header("x-mpu-action") ?? ""];
    if (!operation) return notSupported(c);
    const auth = authenticate(c, operation);
    if (auth instanceof Response) return auth;
    if (operation !== "mpu_create" || c.req.method !== "POST") return notSupported(c);

    const { storeId, signedParams } = auth;
    const target = resolveUploadTarget(c, signedParams);
    if (target instanceof Response) return target;
    const { pathname, key, options } = target;

    const contentType = contentTypeFor(c, pathname);
    if (signedParams) {
      // No parts exist yet, so only the pathname and content type can be checked.
      const message = signedUploadError(signedParams, { pathname, contentType, contentLength: 0 });
      if (message) return blobErr(c, 403, "forbidden", message);
    }

    const uploadId = randomBytes(16).toString("hex");
    vs.blobUploads.insert({
      uploadId,
      storeId,
      pathname: key,
      contentType,
      cacheControl: cacheControlFor(options.cacheControlMaxAge),
      createdAt: new Date().toISOString(),
      parts: [],
    });
    return c.json({ key, uploadId });
  };
  app.post("/api/blob/mpu", handleMpu);
  app.put("/api/blob/mpu", handleMpu);
}
