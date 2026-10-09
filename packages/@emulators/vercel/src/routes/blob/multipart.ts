import type { Context } from "@emulators/core";
import type { BlobRouteContext } from "./context.js";
import { blobErr } from "./errors.js";

export function registerMultipart({ app }: BlobRouteContext): void {
  // Multipart uploads are not supported yet.

  const handleMpu = (c: Context): Response =>
    blobErr(c, 400, "bad_request", "Multipart uploads are not supported by the emulator yet");
  app.post("/api/blob/mpu", handleMpu);
  app.put("/api/blob/mpu", handleMpu);
}
