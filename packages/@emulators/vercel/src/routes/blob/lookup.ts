import type { VercelStore } from "../../store.js";
import type { VercelBlob } from "../../entities.js";
import { blobUrl, downloadUrl } from "./paths.js";
import type { BlobRef } from "./paths.js";

export function findBlob(vs: VercelStore, storeId: string, pathname: string): VercelBlob | undefined {
  return vs.blobs.findBy("pathname", pathname).find((b) => b.storeId === storeId);
}

export function findBlobRef(vs: VercelStore, storeId: string, ref: BlobRef): VercelBlob | undefined {
  if (ref.storeId && ref.storeId !== storeId) return undefined;
  return findBlob(vs, storeId, ref.pathname);
}

export function headResponse(baseUrl: string, blob: VercelBlob): Record<string, unknown> {
  const url = blobUrl(baseUrl, blob.storeId, blob.pathname);
  return {
    url,
    downloadUrl: downloadUrl(url),
    pathname: blob.pathname,
    size: blob.size,
    contentType: blob.contentType,
    contentDisposition: blob.contentDisposition,
    cacheControl: blob.cacheControl,
    uploadedAt: blob.uploadedAt,
    etag: blob.etag,
  };
}
