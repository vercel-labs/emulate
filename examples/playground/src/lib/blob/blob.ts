/**
 * Points the @vercel/blob SDK at the emulator embedded in this app unless a real store is already configured.
 * The SDK reads its endpoint and token from the environment on every call, so these are set at import time.
 * Any token of the form vercel_blob_rw_<storeId>_<secret> is accepted; the storeId must not contain underscores.
 */
import { origin } from "@/lib/origin";

process.env.VERCEL_BLOB_API_URL ??= `${origin}/emulate/vercel/api/blob`;
process.env.BLOB_READ_WRITE_TOKEN ??= "vercel_blob_rw_devstore_devsecret";

export { put, head, list, del, BlobNotFoundError } from "@vercel/blob";
