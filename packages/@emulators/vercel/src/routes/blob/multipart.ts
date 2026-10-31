import { randomBytes } from "crypto";
import type { Context } from "@emulators/core";
import type { BlobRouteContext } from "./context.js";
import { blobErr } from "./errors.js";
import { cacheControlFor, contentTypeFor, resolveUploadTarget } from "./upload.js";

export function registerMultipart({ app, vs }: BlobRouteContext): void {
  // Multipart uploads. Creation records a session; uploading parts and
  // completing the upload are not supported yet.

  const handleCreate = (c: Context): Response => {
    const target = resolveUploadTarget(c);
    if (target instanceof Response) return target;
    const { storeId, pathname } = target;

    const uploadId = randomBytes(16).toString("hex");
    vs.blobUploads.insert({
      uploadId,
      storeId,
      pathname,
      contentType: contentTypeFor(c, pathname),
      cacheControl: cacheControlFor(c.req.header("x-cache-control-max-age")),
      createdAt: new Date().toISOString(),
      parts: [],
    });
    return c.json({ key: pathname, uploadId });
  };

  const handleMpu = (c: Context): Response => {
    if (c.req.method === "POST" && c.req.header("x-mpu-action") === "create") {
      return handleCreate(c);
    }
    return blobErr(c, 400, "bad_request", "Multipart uploads are not supported by the emulator yet");
  };
  app.post("/api/blob/mpu", handleMpu);
  app.put("/api/blob/mpu", handleMpu);
}
