import { randomBytes } from "crypto";

export const MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  css: "text/css",
  csv: "text/csv",
  gif: "image/gif",
  gz: "application/gzip",
  html: "text/html",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  wasm: "application/wasm",
  webm: "video/webm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml",
  zip: "application/zip",
};

export function inferContentType(pathname: string): string {
  const basename = pathname.split("/").pop() ?? "";
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return "application/octet-stream";
  const ext = basename.slice(dot + 1).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

export function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export function withRandomSuffix(pathname: string): string {
  const suffix = randomSuffix();
  const slash = pathname.lastIndexOf("/");
  const dot = pathname.lastIndexOf(".");
  if (dot > slash + 1) {
    return `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}`;
  }
  return `${pathname}-${suffix}`;
}

export function encodePathname(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function blobUrl(baseUrl: string, storeId: string, pathname: string): string {
  return `${baseUrl}/blob/${encodeURIComponent(storeId)}/${encodePathname(pathname)}`;
}

export function downloadUrl(url: string): string {
  return `${url}?download=1`;
}

export function contentDispositionFor(pathname: string): string {
  const basename = (pathname.split("/").pop() ?? pathname).replace(/"/g, "");
  return `attachment; filename="${basename}"`;
}

export interface BlobRef {
  pathname: string;
  storeId?: string;
}

export function resolveBlobRef(urlOrPathname: string, baseUrl?: URL): BlobRef {
  if (!/^https?:\/\//i.test(urlOrPathname)) {
    return { pathname: urlOrPathname };
  }
  let url: URL;
  try {
    url = new URL(urlOrPathname);
  } catch {
    return { pathname: urlOrPathname };
  }
  let path = decodeURIComponent(url.pathname);
  const basePath = baseUrl?.pathname.replace(/\/$/, "") ?? "";
  if (basePath && url.origin === baseUrl?.origin && path.startsWith(`${basePath}/blob/`)) {
    path = path.slice(basePath.length);
  }
  const match = /^\/blob\/([^/]+)\/(.+)$/.exec(path);
  if (match) {
    return { storeId: match[1], pathname: match[2] };
  }
  const vercelHost = /^([^.]+)\.(?:public|private)\.blob\.vercel-storage\.com$/i.exec(url.hostname);
  if (vercelHost) {
    return { storeId: vercelHost[1], pathname: path.replace(/^\//, "") };
  }
  return { pathname: path.replace(/^\//, "") };
}
