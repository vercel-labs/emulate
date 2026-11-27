import type { Context } from "@emulators/core";
import { DEFAULT_CACHE_MAX_AGE, MIN_CACHE_MAX_AGE } from "./constants.js";
import { blobErr } from "./errors.js";
import type { BlobSignedParams } from "./auth.js";
import { knownContentType, withRandomSuffix } from "./paths.js";

export interface UploadOptions {
  addRandomSuffix: boolean;
  cacheControlMaxAge?: number;
  allowOverwrite: boolean;
  ifMatch?: string;
}

export interface UploadTarget {
  // The pathname the client asked for, which signed params are checked against.
  pathname: string;
  // Where the blob is stored: the pathname plus any random suffix.
  key: string;
  options: UploadOptions;
}

// Like the real service, strip exactly one leading slash and accept "//"
// elsewhere; only the SDK rejects "//" before sending the request. Signed
// pathnames go through the same normalization so both sides compare equal.
function normalizePathname(pathname: string): string {
  return pathname.replace(/^\//, "");
}

// A client token's signed options replace the request headers entirely, so a
// browser cannot opt into behavior its server did not sign.
function uploadOptions(c: Context, signedParams?: BlobSignedParams): UploadOptions {
  if (signedParams) {
    return {
      addRandomSuffix: signedParams.addRandomSuffix ?? false,
      cacheControlMaxAge: signedParams.cacheControlMaxAge,
      allowOverwrite: signedParams.allowOverwrite ?? false,
      ifMatch: signedParams.ifMatch || undefined,
    };
  }
  const maxAge = parseInt(c.req.header("x-cache-control-max-age") ?? "", 10);
  return {
    addRandomSuffix: c.req.header("x-add-random-suffix") === "1",
    cacheControlMaxAge: Number.isFinite(maxAge) ? maxAge : undefined,
    allowOverwrite: c.req.header("x-allow-overwrite") === "1",
    ifMatch: c.req.header("x-if-match") || undefined,
  };
}

// Shared by single PUT uploads, copies and multipart creation: turns the
// pathname query into the requested pathname and the stored key.
export function resolveUploadTarget(c: Context, signedParams?: BlobSignedParams): UploadTarget | Response {
  const pathname = normalizePathname(c.req.query("pathname") ?? "");
  if (!pathname) {
    return blobErr(c, 400, "bad_request", "pathname is required");
  }

  const access = c.req.header("x-vercel-blob-access") ?? "public";
  if (access !== "public") {
    return blobErr(c, 400, "bad_request", "Only access: public is supported by the emulator");
  }

  const options = uploadOptions(c, signedParams);
  const key = options.addRandomSuffix ? withRandomSuffix(pathname) : pathname;
  return { pathname, key, options };
}

function contentTypeAllowed(contentType: string, allowed: string[]): boolean {
  const [type] = contentType.split("/");
  return allowed.includes(contentType) || allowed.includes(`${type}/*`);
}

// Checks an upload against the constraints signed into its client token and
// returns the message for the first one it breaks.
export function signedUploadError(
  signedParams: BlobSignedParams,
  { pathname, contentType, contentLength }: { pathname: string; contentType: string; contentLength: number },
): string | undefined {
  if (normalizePathname(signedParams.pathname) !== pathname) {
    return `"pathname" ${pathname} does not match the token payload`;
  }
  if (signedParams.allowedContentTypes && !contentTypeAllowed(contentType, signedParams.allowedContentTypes)) {
    return `"contentType" ${contentType} is not allowed`;
  }
  if (signedParams.maximumSizeInBytes && contentLength > signedParams.maximumSizeInBytes) {
    return `the file length cannot be greater than ${signedParams.maximumSizeInBytes} bytes`;
  }
  return undefined;
}

export function contentTypeFor(c: Context, pathname: string, { useRequestHeader = true } = {}): string {
  return (
    c.req.header("x-content-type") ||
    knownContentType(pathname) ||
    (useRequestHeader ? c.req.header("content-type") : undefined) ||
    "application/octet-stream"
  );
}

export function cacheControlFor(maxAge: number | undefined): string {
  return `public, max-age=${maxAge === undefined ? DEFAULT_CACHE_MAX_AGE : Math.max(maxAge, MIN_CACHE_MAX_AGE)}`;
}
