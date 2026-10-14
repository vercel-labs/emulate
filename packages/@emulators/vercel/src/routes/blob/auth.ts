import { createHmac, timingSafeEqual } from "crypto";
import type { Context } from "@emulators/core";
import type { VercelStore } from "../../store.js";
import { blobErr } from "./errors.js";

export type BlobOperation = "put" | "copy" | "head" | "list" | "delete" | "mpu_create" | "mpu_upload" | "mpu_complete";

export type BlobAuthType = "rw-token" | "client-token" | "oidc";

// The options a server signed into a browser client token. They take
// precedence over the equivalent request headers.
export interface BlobSignedParams {
  pathname: string;
  validUntil: number;
  onUploadCompleted?: { callbackUrl: string; tokenPayload?: string | null };
  maximumSizeInBytes?: number;
  allowedContentTypes?: string[];
  addRandomSuffix?: boolean;
  cacheControlMaxAge?: number;
  allowOverwrite?: boolean;
  ifMatch?: string;
}

export interface BlobAuth {
  storeId: string;
  authType: BlobAuthType;
  signedParams?: BlobSignedParams;
}

export type Authenticate = (c: Context, operation: BlobOperation) => BlobAuth | Response;

const RW_TOKEN_PREFIX = "vercel_blob_rw_";
const CLIENT_TOKEN_PREFIX = "vercel_blob_client_";
const CLIENT_TOKEN_OPERATIONS: readonly BlobOperation[] = ["put", "mpu_create", "mpu_upload", "mpu_complete"];
const LOCAL_OIDC_TOKEN = "local-oidc-token";
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(c: Context): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
  return match ? match[1] : null;
}

// Builds a client token the same way the SDK signs one, so a presented token
// can be compared with one signed by the store's read-write token.
function signClientToken(storeId: string, rwToken: string, payload: BlobSignedParams): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64");
  const signature = createHmac("sha256", rwToken).update(encodedPayload).digest("hex");
  return `${CLIENT_TOKEN_PREFIX}${storeId}_${Buffer.from(`${signature}.${encodedPayload}`).toString("base64")}`;
}

function decodeClientToken(token: string): BlobSignedParams | null {
  try {
    const signed = Buffer.from(token.split("_")[4] ?? "", "base64").toString();
    const encodedPayload = signed.split(".")[1] ?? "";
    const payload: unknown = JSON.parse(Buffer.from(encodedPayload, "base64").toString());
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
    const { pathname, validUntil } = payload as Record<string, unknown>;
    if (typeof pathname !== "string" || typeof validUntil !== "number") return null;
    return payload as BlobSignedParams;
  } catch {
    return null;
  }
}

export function createAuthenticator(vs: VercelStore): Authenticate {
  return (c, operation) => {
    const token = bearerToken(c);
    if (!token) return blobErr(c, 403, "forbidden", "Missing authorization token");

    const isRwToken = token.startsWith(RW_TOKEN_PREFIX);
    const isClientToken = token.startsWith(CLIENT_TOKEN_PREFIX);

    // Blob tokens carry their store id; the store-id header only applies to OIDC.
    const storeId = isRwToken || isClientToken ? token.split("_")[3] : c.req.header("x-vercel-blob-store-id")?.trim();
    if (!storeId) return blobErr(c, 403, "forbidden", "Missing store id");

    if (!isRwToken && !isClientToken) {
      // OIDC tokens cannot be verified offline, so the fixed local token and any
      // JWT-shaped token are accepted for the store named in the header.
      if (token !== LOCAL_OIDC_TOKEN && !JWT_SHAPE.test(token)) {
        return blobErr(c, 403, "forbidden", "Invalid token");
      }
      return { storeId, authType: "oidc" };
    }

    if (isClientToken && !CLIENT_TOKEN_OPERATIONS.includes(operation)) {
      return blobErr(c, 403, "client_token_not_allowed", "Operation not allowed with client token");
    }

    const store = vs.blobStores.findOneBy("storeId", storeId);

    if (isRwToken) {
      if (!store) {
        // Zero-config: the first well-formed read-write token for an unknown
        // store registers it, and only that exact token is accepted afterwards.
        if (!token.split("_")[4]) return blobErr(c, 403, "forbidden", "Invalid token");
        vs.blobStores.insert({ storeId, rwToken: token, access: "public", createdAt: new Date().toISOString() });
      } else if (!safeEqual(token, store.rwToken)) {
        return blobErr(c, 403, "forbidden", "Token mismatch");
      }
      return { storeId, authType: "rw-token" };
    }

    if (!store) return blobErr(c, 404, "store_not_found", "Store not found");

    const signedParams = decodeClientToken(token);
    if (!signedParams) return blobErr(c, 400, "bad_request", "Invalid client token");
    if (Date.now() >= signedParams.validUntil) return blobErr(c, 403, "forbidden", "Token expired");
    if (!safeEqual(token, signClientToken(storeId, store.rwToken, signedParams))) {
      return blobErr(c, 403, "forbidden", "Token mismatch");
    }
    return { storeId, authType: "client-token", signedParams };
  };
}
