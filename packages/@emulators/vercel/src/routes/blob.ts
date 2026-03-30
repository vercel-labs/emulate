import { createHash, createHmac, randomBytes } from "crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { RouteContext, Store } from "@emulators/core";
import { getVercelStore } from "../store.js";
import type { VercelBlob } from "../entities.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function blobErr(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

interface ParsedBlobToken {
  token: string;
  storeId: string;
  type: "rw" | "client" | "generic";
}

export function parseBlobToken(authHeader: string | undefined): ParsedBlobToken | null {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const rwMatch = token.match(/^vercel_blob_rw_([^_]+)_(.+)$/);
  if (rwMatch) return { token, storeId: rwMatch[1], type: "rw" };

  const clientMatch = token.match(/^vercel_blob_client_([^_]+)_(.+)$/);
  if (clientMatch) return { token, storeId: clientMatch[1], type: "client" };

  return { token, storeId: "default", type: "generic" };
}

export function computeEtag(content: Buffer): string {
  return `"${createHash("md5").update(content).digest("hex")}"`;
}

export function applyRandomSuffix(pathname: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(6);
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += chars[bytes[i] % chars.length];

  const lastDot = pathname.lastIndexOf(".");
  const lastSlash = pathname.lastIndexOf("/");
  if (lastDot === -1 || lastDot < lastSlash) return `${pathname}-${suffix}`;
  return `${pathname.slice(0, lastDot)}-${suffix}${pathname.slice(lastDot)}`;
}

const CONTENT_TYPE_MAP: Record<string, string> = {
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
  ".json": "application/json", ".txt": "text/plain", ".xml": "application/xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".ico": "image/x-icon", ".pdf": "application/pdf", ".zip": "application/zip",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm",
  ".csv": "text/csv", ".md": "text/markdown",
};

export function inferContentType(pathname: string): string {
  const dot = pathname.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = pathname.slice(dot).toLowerCase();
  return CONTENT_TYPE_MAP[ext] ?? "application/octet-stream";
}

function buildBlobUrl(baseUrl: string, storeId: string, access: string, pathname: string): string {
  return `${baseUrl}/${storeId}/${access}/${pathname}`;
}

function contentDispositionFor(pathname: string): string {
  const filename = pathname.split("/").pop() ?? pathname;
  return `attachment; filename="${filename}"`;
}

function requireBlobAuth(c: Context): ParsedBlobToken | null {
  return parseBlobToken(c.req.header("authorization"));
}

function formatBlobResult(blob: VercelBlob) {
  return {
    pathname: blob.pathname,
    contentType: blob.contentType,
    contentDisposition: blob.contentDisposition,
    url: blob.url,
    downloadUrl: blob.downloadUrl,
    etag: blob.etag,
  };
}

function formatBlobHead(blob: VercelBlob) {
  return {
    url: blob.url,
    downloadUrl: blob.downloadUrl,
    pathname: blob.pathname,
    size: blob.size,
    uploadedAt: blob.created_at,
    contentType: blob.contentType,
    contentDisposition: blob.contentDisposition,
    cacheControl: blob.cacheControl,
    etag: blob.etag,
  };
}

interface ClientTokenPayload {
  pathname: string;
  maximumSizeInBytes: number | null;
  allowedContentTypes: string[] | null;
  validUntil: number;
  addRandomSuffix: boolean;
  allowOverwrite: boolean;
  cacheControlMaxAge: number;
}

function verifyClientToken(auth: ParsedBlobToken, store: Store): {
  valid: boolean;
  code?: string;
  message?: string;
  payload?: ClientTokenPayload;
} {
  const tokenMap = store.getData<Map<string, string>>("vercel.blob_rw_tokens");
  if (!tokenMap) return { valid: false, code: "blob_access_error", message: "No RW token found for store" };

  const rwToken = tokenMap.get(auth.storeId);
  if (!rwToken) return { valid: false, code: "blob_access_error", message: "No RW token found for store" };

  try {
    const encoded = auth.token.replace(`vercel_blob_client_${auth.storeId}_`, "");
    const decoded = Buffer.from(encoded, "base64url").toString();
    const dotIdx = decoded.indexOf(".");
    if (dotIdx === -1) return { valid: false, code: "blob_access_error", message: "Invalid client token" };

    const signature = decoded.slice(0, dotIdx);
    const payloadStr = decoded.slice(dotIdx + 1);

    const expectedSig = createHmac("sha256", rwToken).update(payloadStr).digest("base64url");
    if (signature !== expectedSig) {
      return { valid: false, code: "blob_access_error", message: "Invalid client token signature" };
    }

    const payload: ClientTokenPayload = JSON.parse(payloadStr);

    if (payload.validUntil < Date.now()) {
      return { valid: false, code: "blob_access_error", message: "Client token expired" };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false, code: "blob_access_error", message: "Invalid client token" };
  }
}

/* ------------------------------------------------------------------ */
/*  Routes                                                            */
/* ------------------------------------------------------------------ */

export function blobRoutes({ app, store, baseUrl }: RouteContext): void {
  const vs = getVercelStore(store);

  // PUT /api/blob — put or copy
  app.put("/api/blob", async (c) => {
    const auth = requireBlobAuth(c);
    if (!auth) return blobErr(c, 403, "blob_access_error", "Authentication required");

    const pathname = c.req.query("pathname");
    if (!pathname) return blobErr(c, 400, "blob_unknown_error", "Missing pathname");

    const fromUrl = c.req.query("fromUrl");
    if (fromUrl) {
      return handleCopy(c, vs, auth, pathname, fromUrl, baseUrl);
    }
    return handlePut(c, vs, auth, pathname, baseUrl, store);
  });

  // GET /api/blob — head (with url param) or list (without)
  app.get("/api/blob", (c) => {
    const auth = requireBlobAuth(c);
    if (!auth) return blobErr(c, 403, "blob_access_error", "Authentication required");

    const url = c.req.query("url");
    if (url) {
      return handleHead(c, vs, url);
    }
    return handleList(c, vs, auth);
  });

  // POST /api/blob/delete
  app.post("/api/blob/delete", async (c) => {
    const auth = requireBlobAuth(c);
    if (!auth) return blobErr(c, 403, "blob_access_error", "Authentication required");
    return handleDelete(c, vs);
  });

  // POST /api/blob/mpu — multipart upload
  app.post("/api/blob/mpu", async (c) => {
    const auth = requireBlobAuth(c);
    if (!auth) return blobErr(c, 403, "blob_access_error", "Authentication required");
    return handleMpu(c, vs, auth, baseUrl, store);
  });

  // POST /api/blob/handle-blob-upload — client token flow
  app.post("/api/blob/handle-blob-upload", async (c) => {
    const auth = requireBlobAuth(c);
    if (!auth) return blobErr(c, 403, "blob_access_error", "Authentication required");
    return handleBlobUpload(c, auth, store);
  });

  // GET /:storeId/:access/* — content serving (registered last)
  app.get("/:storeId/:access/*", (c) => {
    const access = c.req.param("access");
    if (access !== "public" && access !== "private") return c.notFound();

    const storeId = c.req.param("storeId");
    const pathname = c.req.path.slice(`/${storeId}/${access}/`.length);
    if (!pathname) return c.notFound();

    if (access === "private") {
      const auth = requireBlobAuth(c);
      if (!auth) return blobErr(c, 403, "blob_access_error", "Authentication required for private blobs");
    }

    const blob = vs.blobs
      .findBy("storeId", storeId as VercelBlob["storeId"])
      .find((b) => b.pathname === pathname);
    if (!blob) return c.notFound();

    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch && ifNoneMatch === blob.etag) {
      return new Response(null, { status: 304, headers: { etag: blob.etag } });
    }

    const isDownload = c.req.query("download") === "1";
    const disposition = isDownload ? contentDispositionFor(blob.pathname) : "inline";

    return new Response(blob.content, {
      status: 200,
      headers: {
        "content-type": blob.contentType,
        "content-disposition": disposition,
        "content-length": String(blob.size),
        "cache-control": blob.cacheControl,
        etag: blob.etag,
      },
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Handler implementations                                           */
/* ------------------------------------------------------------------ */

async function handlePut(
  c: Context,
  vs: ReturnType<typeof getVercelStore>,
  auth: ParsedBlobToken,
  pathname: string,
  baseUrl: string,
  store: Store,
) {
  // Client token verification
  let clientPayload: ClientTokenPayload | undefined;
  if (auth.type === "client") {
    const verification = verifyClientToken(auth, store);
    if (!verification.valid) {
      return blobErr(c, 403, verification.code!, verification.message!);
    }
    clientPayload = verification.payload;
  }

  const access = (c.req.header("x-vercel-blob-access") ?? "public") as "public" | "private";
  const addSuffix = c.req.header("x-add-random-suffix") !== "0";
  const allowOverwrite = c.req.header("x-allow-overwrite") === "1";
  const cacheMaxAge = parseInt(c.req.header("x-cache-control-max-age") ?? "2592000", 10);
  const ifMatch = c.req.header("x-if-match");
  const contentType = c.req.header("x-content-type") ?? inferContentType(pathname);

  // Folder creation: trailing slash pathname
  if (pathname.endsWith("/")) {
    const url = buildBlobUrl(baseUrl, auth.storeId, access, pathname);
    const blob = vs.blobs.insert({
      storeId: auth.storeId,
      pathname,
      url,
      downloadUrl: `${url}?download=1`,
      access,
      contentType: "application/x-directory",
      contentDisposition: contentDispositionFor(pathname),
      cacheControl: `public, max-age=${cacheMaxAge}`,
      size: 0,
      etag: computeEtag(Buffer.alloc(0)),
      content: Buffer.alloc(0),
    });
    return c.json(formatBlobResult(blob));
  }

  const resolvedPathname = addSuffix ? applyRandomSuffix(pathname) : pathname;

  // Overwrite / conditional check
  const existing = vs.blobs
    .findBy("storeId", auth.storeId as VercelBlob["storeId"])
    .find((b) => b.pathname === resolvedPathname);

  if (ifMatch && existing && existing.etag !== ifMatch) {
    return blobErr(c, 412, "blob_precondition_failed", "ETag mismatch");
  }
  if (existing && !allowOverwrite && !addSuffix) {
    return blobErr(c, 409, "blob_unknown_error", "Blob already exists. Use allowOverwrite or addRandomSuffix.");
  }

  const buf = Buffer.from(await c.req.arrayBuffer());

  if (clientPayload) {
    if (clientPayload.maximumSizeInBytes !== null && buf.length > clientPayload.maximumSizeInBytes) {
      return blobErr(c, 400, "blob_file_too_large", `File exceeds maximum size of ${clientPayload.maximumSizeInBytes} bytes`);
    }
    if (clientPayload.allowedContentTypes !== null && !clientPayload.allowedContentTypes.includes(contentType)) {
      return blobErr(c, 400, "blob_content_type_not_allowed", `Content type ${contentType} is not allowed`);
    }
  }

  const etag = computeEtag(buf);
  const url = buildBlobUrl(baseUrl, auth.storeId, access, resolvedPathname);
  const downloadUrl = `${url}?download=1`;

  // If overwriting, delete old blob first
  if (existing && allowOverwrite) {
    vs.blobs.delete(existing.id);
  }

  // Record the rw token for client token verification later
  if (auth.type === "rw") {
    const tokenMap = store.getData<Map<string, string>>("vercel.blob_rw_tokens") ?? new Map();
    tokenMap.set(auth.storeId, auth.token);
    store.setData("vercel.blob_rw_tokens", tokenMap);
  }

  const blob = vs.blobs.insert({
    storeId: auth.storeId,
    pathname: resolvedPathname,
    url,
    downloadUrl,
    access,
    contentType,
    contentDisposition: contentDispositionFor(resolvedPathname),
    cacheControl: `public, max-age=${cacheMaxAge}`,
    size: buf.length,
    etag,
    content: buf,
  });

  return c.json(formatBlobResult(blob));
}

function handleHead(c: Context, vs: ReturnType<typeof getVercelStore>, url: string) {
  const blob = vs.blobs.findOneBy("url", url as VercelBlob["url"]);
  if (!blob) return blobErr(c, 404, "blob_not_found", "The requested blob does not exist");
  return c.json(formatBlobHead(blob));
}

async function handleDelete(c: Context, vs: ReturnType<typeof getVercelStore>) {
  const body = await c.req.json();
  const urls: string[] = body.urls ?? [];
  const ifMatch = c.req.header("x-if-match");

  for (const url of urls) {
    const blob = vs.blobs.findOneBy("url", url as VercelBlob["url"]);
    if (!blob) continue;
    if (ifMatch && blob.etag !== ifMatch) {
      return blobErr(c, 412, "blob_precondition_failed", "ETag mismatch");
    }
    vs.blobs.delete(blob.id);
  }

  return c.body(null, 200);
}

function handleList(c: Context, vs: ReturnType<typeof getVercelStore>, auth: ParsedBlobToken) {
  const limit = Math.min(1000, Math.max(1, parseInt(c.req.query("limit") ?? "1000", 10)));
  const prefix = c.req.query("prefix") ?? "";
  const cursor = c.req.query("cursor");
  const mode = c.req.query("mode") ?? "expanded";

  let blobs = vs.blobs
    .findBy("storeId", auth.storeId as VercelBlob["storeId"])
    .filter((b) => b.pathname.startsWith(prefix))
    .sort((a, b) => a.pathname.localeCompare(b.pathname));

  const offset = cursor ? parseInt(Buffer.from(cursor, "base64url").toString(), 10) : 0;
  blobs = blobs.slice(offset);

  const hasMore = blobs.length > limit;
  const page = blobs.slice(0, limit);
  const nextCursor = hasMore ? Buffer.from(String(offset + limit)).toString("base64url") : undefined;

  if (mode === "folded") {
    const folderSet = new Set<string>();
    const directBlobs: typeof page = [];

    for (const blob of page) {
      const rest = blob.pathname.slice(prefix.length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx !== -1) {
        folderSet.add(prefix + rest.slice(0, slashIdx + 1));
      } else {
        directBlobs.push(blob);
      }
    }

    return c.json({
      blobs: directBlobs.map((b) => ({
        url: b.url,
        downloadUrl: b.downloadUrl,
        pathname: b.pathname,
        size: b.size,
        uploadedAt: b.created_at,
        etag: b.etag,
      })),
      folders: [...folderSet].sort(),
      cursor: nextCursor,
      hasMore,
    });
  }

  return c.json({
    blobs: page.map((b) => ({
      url: b.url,
      downloadUrl: b.downloadUrl,
      pathname: b.pathname,
      size: b.size,
      uploadedAt: b.created_at,
      etag: b.etag,
    })),
    cursor: nextCursor,
    hasMore,
  });
}

async function handleCopy(
  c: Context,
  vs: ReturnType<typeof getVercelStore>,
  auth: ParsedBlobToken,
  toPathname: string,
  fromUrl: string,
  baseUrl: string,
) {
  const source = vs.blobs.findOneBy("url", fromUrl as VercelBlob["url"]);
  if (!source) return blobErr(c, 404, "blob_not_found", "Source blob not found");

  const access = (c.req.header("x-vercel-blob-access") ?? source.access) as "public" | "private";
  const addSuffix = c.req.header("x-add-random-suffix") !== "0";
  const allowOverwrite = c.req.header("x-allow-overwrite") === "1";
  const cacheMaxAge = parseInt(c.req.header("x-cache-control-max-age") ?? "2592000", 10);
  const ifMatch = c.req.header("x-if-match");
  const contentType = c.req.header("x-content-type") ?? source.contentType;

  const resolvedPathname = addSuffix ? applyRandomSuffix(toPathname) : toPathname;

  const existing = vs.blobs
    .findBy("storeId", auth.storeId as VercelBlob["storeId"])
    .find((b) => b.pathname === resolvedPathname);

  if (ifMatch && existing && existing.etag !== ifMatch) {
    return blobErr(c, 412, "blob_precondition_failed", "ETag mismatch");
  }
  if (existing && !allowOverwrite && !addSuffix) {
    return blobErr(c, 409, "blob_unknown_error", "Blob already exists. Use allowOverwrite or addRandomSuffix.");
  }
  if (existing && allowOverwrite) {
    vs.blobs.delete(existing.id);
  }

  const url = buildBlobUrl(baseUrl, auth.storeId, access, resolvedPathname);
  const blob = vs.blobs.insert({
    storeId: auth.storeId,
    pathname: resolvedPathname,
    url,
    downloadUrl: `${url}?download=1`,
    access,
    contentType,
    contentDisposition: contentDispositionFor(resolvedPathname),
    cacheControl: `public, max-age=${cacheMaxAge}`,
    size: source.size,
    etag: source.etag,
    content: Buffer.from(source.content),
  });

  return c.json(formatBlobResult(blob));
}

async function handleMpu(
  c: Context,
  vs: ReturnType<typeof getVercelStore>,
  auth: ParsedBlobToken,
  baseUrl: string,
  store: Store,
) {
  const action = c.req.header("x-mpu-action");

  if (action === "create") {
    const pathname = c.req.query("pathname");
    if (!pathname) return blobErr(c, 400, "blob_unknown_error", "Missing pathname");

    const access = (c.req.header("x-vercel-blob-access") ?? "public") as "public" | "private";
    const addSuffix = c.req.header("x-add-random-suffix") !== "0";
    const contentType = c.req.header("x-content-type") ?? inferContentType(pathname);
    const resolvedPathname = addSuffix ? applyRandomSuffix(pathname) : pathname;

    const uploadId = randomBytes(16).toString("hex");
    const key = resolvedPathname;

    vs.blobMultipartUploads.insert({
      storeId: auth.storeId,
      pathname: resolvedPathname,
      uploadId,
      key,
      access,
      contentType,
    });

    if (auth.type === "rw") {
      const tokenMap = store.getData<Map<string, string>>("vercel.blob_rw_tokens") ?? new Map();
      tokenMap.set(auth.storeId, auth.token);
      store.setData("vercel.blob_rw_tokens", tokenMap);
    }

    return c.json({ uploadId, key });
  }

  if (action === "upload") {
    const uploadId = c.req.header("x-mpu-upload-id");
    const partNumber = parseInt(c.req.header("x-mpu-part-number") ?? "0", 10);
    if (!uploadId || !partNumber) {
      return blobErr(c, 400, "blob_unknown_error", "Missing uploadId or partNumber");
    }

    const upload = vs.blobMultipartUploads.findOneBy("uploadId", uploadId as any);
    if (!upload) return blobErr(c, 404, "blob_not_found", "Upload not found");

    const buf = Buffer.from(await c.req.arrayBuffer());
    const etag = computeEtag(buf);

    vs.blobMultipartParts.insert({
      uploadId,
      partNumber,
      etag,
      content: buf,
      size: buf.length,
    });

    return c.json({ etag, partNumber });
  }

  if (action === "complete") {
    const uploadId = c.req.header("x-mpu-upload-id");
    if (!uploadId) return blobErr(c, 400, "blob_unknown_error", "Missing uploadId");

    const upload = vs.blobMultipartUploads.findOneBy("uploadId", uploadId as any);
    if (!upload) return blobErr(c, 404, "blob_not_found", "Upload not found");

    const parts = vs.blobMultipartParts
      .findBy("uploadId", uploadId as any)
      .sort((a, b) => a.partNumber - b.partNumber);

    const content = Buffer.concat(parts.map((p) => p.content));
    const etag = computeEtag(content);
    const cacheMaxAge = parseInt(c.req.header("x-cache-control-max-age") ?? "2592000", 10);
    const url = buildBlobUrl(baseUrl, upload.storeId, upload.access, upload.pathname);

    const blob = vs.blobs.insert({
      storeId: upload.storeId,
      pathname: upload.pathname,
      url,
      downloadUrl: `${url}?download=1`,
      access: upload.access,
      contentType: upload.contentType,
      contentDisposition: contentDispositionFor(upload.pathname),
      cacheControl: `public, max-age=${cacheMaxAge}`,
      size: content.length,
      etag,
      content,
    });

    // Cleanup multipart state
    for (const part of parts) vs.blobMultipartParts.delete(part.id);
    vs.blobMultipartUploads.delete(upload.id);

    return c.json(formatBlobResult(blob));
  }

  return blobErr(c, 400, "blob_unknown_error", `Unknown mpu action: ${action}`);
}

async function handleBlobUpload(c: Context, auth: ParsedBlobToken, store: Store) {
  const body = await c.req.json();

  if (body.type === "blob.generate-client-token") {
    const payload = body.payload ?? {};
    const validUntil = payload.validUntil ?? (Date.now() + 3600_000);

    const tokenPayload = JSON.stringify({
      pathname: payload.pathname,
      maximumSizeInBytes: payload.maximumSizeInBytes ?? null,
      allowedContentTypes: payload.allowedContentTypes ?? null,
      validUntil,
      addRandomSuffix: payload.addRandomSuffix ?? true,
      allowOverwrite: payload.allowOverwrite ?? false,
      cacheControlMaxAge: payload.cacheControlMaxAge ?? 2592000,
    });

    const signature = createHmac("sha256", auth.token).update(tokenPayload).digest("base64url");
    const encoded = Buffer.from(`${signature}.${tokenPayload}`).toString("base64url");
    const clientToken = `vercel_blob_client_${auth.storeId}_${encoded}`;

    // Store the rw token so we can verify client tokens later
    const tokenMap = store.getData<Map<string, string>>("vercel.blob_rw_tokens") ?? new Map();
    tokenMap.set(auth.storeId, auth.token);
    store.setData("vercel.blob_rw_tokens", tokenMap);

    return c.json({ type: "blob.generate-client-token", clientToken });
  }

  if (body.type === "blob.upload-completed") {
    return c.json({ received: true });
  }

  return blobErr(c, 400, "blob_unknown_error", `Unknown type: ${body.type}`);
}
