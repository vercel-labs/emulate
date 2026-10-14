import { createHmac } from "crypto";
import type { VercelStore } from "../../store.js";
import type { BlobSignedParams } from "./auth.js";

// After a client-token upload, tells the server that issued the token, signing
// the body with the store's read-write token so the SDK's handleUpload can
// verify it. Delivery runs in the background and failures are ignored, so a
// broken callback never fails the upload itself.
export function sendUploadCompleted(
  vs: VercelStore,
  {
    storeId,
    signedParams,
    blob,
    apiVersion,
  }: { storeId: string; signedParams: BlobSignedParams; blob: Record<string, unknown>; apiVersion: number },
): void {
  const onUploadCompleted = signedParams.onUploadCompleted;
  const rwToken = vs.blobStores.findOneBy("storeId", storeId)?.rwToken;
  if (!onUploadCompleted?.callbackUrl || !rwToken) return;

  const body = JSON.stringify({
    type: "blob.upload-completed",
    payload: { blob, tokenPayload: onUploadCompleted.tokenPayload },
  });
  const headers: Record<string, string> = {
    "x-vercel-signature": createHmac("sha256", rwToken).update(body).digest("hex"),
    "x-vercel-signature-type": "rw_token",
  };
  // Older SDKs expect the callback without a JSON content type.
  if (apiVersion > 4) headers["content-type"] = "application/json";

  void (async () => {
    try {
      // Sent as bytes so fetch does not add a text content type of its own.
      const response = await fetch(onUploadCompleted.callbackUrl, { method: "POST", headers, body: Buffer.from(body) });
      await response.body?.cancel();
    } catch {
      // The callback is best effort.
    }
  })();
}
