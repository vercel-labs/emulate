import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes, createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Hono, serve } from "@emulators/core";
import { Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import {
  put,
  head,
  list,
  del,
  copy,
  get,
  createMultipartUpload,
  uploadPart,
  completeMultipartUpload,
  type IssueSignedTokenOptions,
  type IssuedSignedToken,
  presignUrl,
  BlobNotFoundError,
  BlobAccessError,
} from "@vercel/blob";
import { generateClientTokenFromReadWriteToken, handleUpload } from "@vercel/blob/client";
import { vercelPlugin, seedFromConfig } from "../index.js";

const token = "vercel_blob_rw_teststore_secret";
const storeId = "teststore";

let emulatorUrl: string;
let apiUrl: string;
let closeServer: () => Promise<void>;
let restoreFetch: () => void;
const unexpectedOrigins: string[] = [];
const completedUploads: Array<{ blob: { pathname: string }; tokenPayload?: string | null }> = [];
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(async () => {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("blob-admin-token", { login: "blob-admin", id: 1, scopes: ["user"] });
  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  app.get("/blob-test/image.png", () => new Response(imageBytes, { headers: { "content-type": "image/png" } }));
  app.post("/blob-test/completed", async (context) => {
    const result = await handleUpload({
      request: context.req.raw,
      body: await context.req.json(),
      token,
      onBeforeGenerateToken: async () => ({}),
      onUploadCompleted: async (payload) => {
        completedUploads.push(payload);
      },
    });
    return context.json(result);
  });

  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  emulatorUrl = `http://127.0.0.1:${port}`;
  apiUrl = `${emulatorUrl}/api/blob`;

  // Blob URLs embed the base URL, so register routes after the port is known.
  vercelPlugin.register(app as any, store, webhooks, emulatorUrl, tokenMap);
  vercelPlugin.seed?.(store, emulatorUrl);
  seedFromConfig(store, emulatorUrl, {
    users: [{ username: "blob-admin", email: "blob-admin@example.com" }],
    teams: [{ slug: "blob-contract" }],
    projects: [{ name: "blob-contract-project", team: "blob-contract" }],
  });

  process.env.VERCEL_BLOB_API_URL = apiUrl;
  process.env.BLOB_READ_WRITE_TOKEN = token;
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== emulatorUrl) {
      unexpectedOrigins.push(url.origin);
      throw new Error(`Blob tests cannot fetch outside the local server: ${url.origin}`);
    }
    return originalFetch(input, init);
  });
  restoreFetch = () => fetchSpy.mockRestore();

  closeServer = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
});

async function createSignedToken({
  token: credential = token,
  ...options
}: IssueSignedTokenOptions): Promise<IssuedSignedToken> {
  const response = await fetch(`${apiUrl}/signed-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "x-api-version": "12", "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as IssuedSignedToken;
}

afterAll(async () => {
  delete process.env.VERCEL_BLOB_API_URL;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  await closeServer();
  restoreFetch();
  expect(unexpectedOrigins).toEqual([]);
});

describe("Vercel Blob via the @vercel/blob SDK", () => {
  it("put uploads bytes and the returned url serves them back", async () => {
    const data = randomBytes(1024);
    const result = await put("round-trip/data.bin", data, { access: "public", token });

    expect(result.pathname).toBe("round-trip/data.bin");
    expect(result.url).toBe(`${emulatorUrl}/blob/${storeId}/round-trip/data.bin`);
    expect(result.contentType).toBe("application/octet-stream");
    expect(result.contentDisposition).toBe('attachment; filename="data.bin"');

    const res = await fetch(result.url);
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(data)).toBe(true);
    expect(res.headers.get("etag")).toBe(result.etag);
    expect(res.headers.get("cache-control")).toBe("public, max-age=2592000");
  });

  it("put with addRandomSuffix appends a suffix before the extension", async () => {
    const result = await put("suffix/report.txt", "hello suffix", {
      access: "public",
      token,
      addRandomSuffix: true,
    });

    expect(result.pathname).toMatch(/^suffix\/report-[a-z0-9]+\.txt$/);
    expect(result.pathname).not.toBe("suffix/report.txt");

    const res = await fetch(result.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello suffix");
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("put with allowOverwrite: false rejects when the blob already exists", async () => {
    await put("conflict/file.txt", "first", { access: "public", token });
    await expect(
      put("conflict/file.txt", "second", { access: "public", token, allowOverwrite: false }),
    ).rejects.toThrow(/allowOverwrite/);

    // The original content is untouched and allowOverwrite: true replaces it.
    const before = await fetch(`${emulatorUrl}/blob/${storeId}/conflict/file.txt`);
    expect(await before.text()).toBe("first");

    await put("conflict/file.txt", "second", { access: "public", token, allowOverwrite: true });
    const after = await fetch(`${emulatorUrl}/blob/${storeId}/conflict/file.txt`);
    expect(await after.text()).toBe("second");
  });

  it("head returns blob metadata", async () => {
    const uploaded = await put("meta/info.json", JSON.stringify({ ok: true }), {
      access: "public",
      token,
      cacheControlMaxAge: 60,
    });

    const meta = await head(uploaded.url, { token });
    expect(meta.pathname).toBe("meta/info.json");
    expect(meta.url).toBe(uploaded.url);
    expect(meta.downloadUrl).toBe(uploaded.downloadUrl);
    expect(meta.size).toBe(Buffer.byteLength(JSON.stringify({ ok: true })));
    expect(meta.contentType).toBe("application/json");
    expect(meta.contentDisposition).toBe('attachment; filename="info.json"');
    expect(meta.cacheControl).toBe("public, max-age=60");
    expect(meta.etag).toBe(uploaded.etag);
    expect(meta.uploadedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(meta.uploadedAt.getTime())).toBe(false);
  });

  it("head falls back to BLOB_READ_WRITE_TOKEN when no token option is given", async () => {
    const uploaded = await put("meta/env-token.txt", "env token", { access: "public", token });
    const meta = await head(uploaded.url);
    expect(meta.pathname).toBe("meta/env-token.txt");
  });

  it("put accepts SDK OIDC auth with an explicit storeId", async () => {
    const uploaded = await put("auth/oidc.txt", "oidc token", {
      access: "public",
      oidcToken: "local-oidc-token",
      storeId,
    });

    expect(uploaded.url).toBe(`${emulatorUrl}/blob/${storeId}/auth/oidc.txt`);
    const res = await fetch(uploaded.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("oidc token");
  });

  it("copy duplicates source content into the destination blob", async () => {
    const source = await put("copy/source.txt", "copy me", { access: "public", token });
    const copied = await copy(source.url, "copy/dest.txt", { access: "public", token });

    expect(copied.pathname).toBe("copy/dest.txt");
    const res = await fetch(copied.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("copy me");

    const meta = await head(copied.url, { token });
    expect(meta.size).toBe("copy me".length);
    expect(meta.etag).toBe(source.etag);
  });

  it("list filters by prefix and returns metadata", async () => {
    await put("listing/a.txt", "a", { access: "public", token });
    await put("listing/b.txt", "b", { access: "public", token });
    await put("other/c.txt", "c", { access: "public", token });

    const result = await list({ prefix: "listing/", token });
    const pathnames = result.blobs.map((b) => b.pathname);
    expect(pathnames).toEqual(["listing/a.txt", "listing/b.txt"]);
    expect(result.hasMore).toBe(false);
    for (const blob of result.blobs) {
      expect(blob.url).toBe(`${emulatorUrl}/blob/${storeId}/${blob.pathname}`);
      expect(blob.size).toBe(1);
      expect(blob.uploadedAt).toBeInstanceOf(Date);
      expect(blob.etag).toMatch(/^"[0-9a-f]{64}"$/);
    }
  });

  it("list paginates with limit and cursor", async () => {
    await put("paging/1.txt", "1", { access: "public", token });
    await put("paging/2.txt", "2", { access: "public", token });
    await put("paging/3.txt", "3", { access: "public", token });

    const first = await list({ prefix: "paging/", limit: 2, token });
    expect(first.blobs.map((b) => b.pathname)).toEqual(["paging/1.txt", "paging/2.txt"]);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBeDefined();

    const second = await list({ prefix: "paging/", cursor: first.cursor, token });
    expect(second.blobs.map((b) => b.pathname)).toEqual(["paging/3.txt"]);
    expect(second.hasMore).toBe(false);
  });

  it("del removes a blob and head then rejects with BlobNotFoundError", async () => {
    const uploaded = await put("deletion/gone.txt", "bye", { access: "public", token });
    await del(uploaded.url, { token });

    await expect(head(uploaded.url, { token })).rejects.toBeInstanceOf(BlobNotFoundError);
    const res = await fetch(uploaded.url);
    expect(res.status).toBe(404);
  });

  it("full blob URLs cannot target a different authenticated store", async () => {
    const otherToken = "vercel_blob_rw_otherstore_secret";
    const own = await put("store-scope/shared.txt", "own", { access: "public", token });
    const other = await put("store-scope/shared.txt", "other", { access: "public", token: otherToken });

    await expect(head(other.url, { token })).rejects.toBeInstanceOf(BlobNotFoundError);

    await del(other.url, { token });
    const ownRes = await fetch(own.url);
    const otherRes = await fetch(other.url);
    expect(ownRes.status).toBe(200);
    expect(await ownRes.text()).toBe("own");
    expect(otherRes.status).toBe(200);
    expect(await otherRes.text()).toBe("other");
  });

  it("downloadUrl serves the content with an attachment disposition", async () => {
    const uploaded = await put("downloads/manual.txt", "download me", { access: "public", token });

    const res = await fetch(uploaded.downloadUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="manual.txt"');
    expect(await res.text()).toBe("download me");

    // The plain url has no attachment disposition.
    const inline = await fetch(uploaded.url);
    expect(inline.headers.get("content-disposition")).toBeNull();
  });

  it("a bad token surfaces as BlobAccessError", async () => {
    await expect(list({ token: "not-a-blob-token" })).rejects.toBeInstanceOf(BlobAccessError);
  });
});

describe("Vercel Blob direct HTTP behavior", () => {
  const headers = {
    authorization: `Bearer ${token}`,
    "x-api-version": "12",
    "x-vercel-blob-access": "public",
    "x-add-random-suffix": "0",
  };

  let copySource: Awaited<ReturnType<typeof put>>;
  let copyDestination: Awaited<ReturnType<typeof put>>;
  let deletionSurvivor: Awaited<ReturnType<typeof put>>;

  beforeAll(async () => {
    copySource = await put("http-copy/source.bin", "source", { access: "public", token });
    copyDestination = await put("http-copy/existing.bin", "destination", { access: "public", token });
    deletionSurvivor = await put("http-delete/survivor.bin", "survives", { access: "public", token });
    await put("http-folded/a/file.bin", "first", { access: "public", token });
    await put("http-folded/b/file.bin", "second", { access: "public", token });
  });

  it("returns a 403 forbidden JSON body for a bad token", async () => {
    const res = await fetch(apiUrl, { headers: { authorization: "Bearer wrong" } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("forbidden");
    expect(typeof body.error.message).toBe("string");
  });

  it("returns a 404 not_found JSON body when head misses", async () => {
    const res = await fetch(`${apiUrl}?url=${encodeURIComponent("missing/never-uploaded.txt")}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toBe("The requested blob does not exist");
  });

  it("rejects a stale conditional PUT without changing stored bytes", async () => {
    const uploaded = await put("http-conditional/stale.bin", "original", { access: "public", token });
    const response = await fetch(`${apiUrl}?pathname=${encodeURIComponent(uploaded.pathname)}`, {
      method: "PUT",
      headers: { ...headers, "x-if-match": '"stale"' },
      body: "replacement",
    });
    expect(response.status).toBe(412);
    expect(await response.json()).toEqual({
      error: { code: "precondition_failed", message: "Precondition failed: ETag mismatch." },
    });
    expect(await (await fetch(uploaded.url)).text()).toBe("original");
  });

  it("accepts a matching conditional PUT and changes the ETag", async () => {
    const uploaded = await put("http-conditional/matching.bin", "original", { access: "public", token });
    const response = await fetch(`${apiUrl}?pathname=${encodeURIComponent(uploaded.pathname)}`, {
      method: "PUT",
      headers: { ...headers, "x-if-match": uploaded.etag },
      body: "updated",
    });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as { etag: string };
    expect(updated.etag).not.toBe(uploaded.etag);
    expect(await (await fetch(uploaded.url)).text()).toBe("updated");
  });

  it("serves an exact If-None-Match as a bodyless 304", async () => {
    const uploaded = await put("http-cache/conditional.bin", "cached", { access: "public", token });
    const response = await fetch(uploaded.url, { headers: { "if-none-match": uploaded.etag } });
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(uploaded.etag);
    expect(await response.text()).toBe("");
  });

  it.fails("rejects an empty deletion batch without changing stored content", async () => {
    const response = await fetch(`${apiUrl}/delete`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ urls: [] }),
    });
    const body = await response.json();
    const survivor = await fetch(deletionSurvivor.url);
    expect({ status: response.status, body, survivor: await survivor.text() }).toEqual({
      status: 400,
      body: { error: { code: "bad_request", message: "Missing urls in request body" } },
      survivor: "survives",
    });
  });

  it.fails("rejects malformed deletion JSON without changing stored content", async () => {
    const response = await fetch(`${apiUrl}/delete`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "not json",
    });
    const body = await response.json();
    const survivor = await fetch(deletionSurvivor.url);
    expect({ status: response.status, body, survivor: await survivor.text() }).toEqual({
      status: 400,
      body: {
        error: { code: "bad_request", message: "Cannot delete more than 1,000 urls at once or body is malformed" },
      },
      survivor: "survives",
    });
  });

  it.fails("copies to a new pathname when ifMatch matches the source ETag", async () => {
    const response = await fetch(
      `${apiUrl}?${new URLSearchParams({ pathname: "http-copy/new.bin", fromUrl: copySource.url })}`,
      { method: "PUT", headers: { ...headers, "x-if-match": copySource.etag } },
    );
    expect(response.status).toBe(200);
    const copied = (await response.json()) as { url: string };
    expect(await (await fetch(copySource.url)).text()).toBe("source");
    expect(await (await fetch(copied.url)).text()).toBe("source");
  });

  it.fails("rejects conditional copy when only the destination ETag matches", async () => {
    const response = await fetch(
      `${apiUrl}?${new URLSearchParams({ pathname: copyDestination.pathname, fromUrl: copySource.url })}`,
      { method: "PUT", headers: { ...headers, "x-if-match": copyDestination.etag } },
    );
    const body = await response.json();
    const source = await fetch(copySource.url);
    const destination = await fetch(copyDestination.url);
    expect({
      status: response.status,
      body,
      source: await source.text(),
      destination: await destination.text(),
    }).toEqual({
      status: 412,
      body: { error: { code: "precondition_failed", message: "Precondition failed: ETag mismatch." } },
      source: "source",
      destination: "destination",
    });
  });

  it.fails("paginates folded listings that contain only folders", async () => {
    const first = await list({ prefix: "http-folded/", mode: "folded", limit: 1, token });
    expect(first.blobs).toEqual([]);
    expect(first.folders).toEqual(["http-folded/a/"]);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBeDefined();
    const second = await list({ prefix: "http-folded/", mode: "folded", limit: 1, cursor: first.cursor, token });
    expect(second.blobs).toEqual([]);
    expect(second.folders).toEqual(["http-folded/b/"]);
    expect(second.hasMore).toBe(false);
  });

  it.fails("uses the Content-Type header for an extensionless upload", async () => {
    const response = await fetch(`${apiUrl}?pathname=http-metadata%2Fextensionless`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/x-test-fixture" },
      body: "bytes",
    });
    expect(response.status).toBe(200);
    const uploaded = (await response.json()) as { url: string; contentType: string };
    const download = await fetch(uploaded.url);
    expect({
      contentType: uploaded.contentType,
      servedContentType: download.headers.get("content-type"),
      bytes: await download.text(),
    }).toEqual({
      contentType: "application/x-test-fixture",
      servedContentType: "application/x-test-fixture",
      bytes: "bytes",
    });
  });

  it.fails("clamps modern cache max-age to at least one minute", async () => {
    const response = await fetch(`${apiUrl}?pathname=http-cache%2Fminimum.bin`, {
      method: "PUT",
      headers: { ...headers, "x-cache-control-max-age": "0" },
      body: "bytes",
    });
    expect(response.status).toBe(200);
    const uploaded = (await response.json()) as { url: string };
    const metadata = await head(uploaded.url, { token });
    expect(metadata.cacheControl).toBe("public, max-age=60");
    expect(await (await fetch(uploaded.url)).text()).toBe("bytes");
  });

  it.fails("removes a leading slash from the uploaded pathname", async () => {
    const response = await fetch(`${apiUrl}?pathname=%2Fhttp-paths%2Fleading.bin`, {
      method: "PUT",
      headers,
      body: "bytes",
    });
    expect(response.status).toBe(200);
    const uploaded = (await response.json()) as { url: string; pathname: string };
    const metadata = await head(uploaded.url, { token });
    expect({ pathname: uploaded.pathname, metadataPathname: metadata.pathname }).toEqual({
      pathname: "http-paths/leading.bin",
      metadataPathname: "http-paths/leading.bin",
    });
  });

  it.fails("creates a multipart session without publishing a blob", async () => {
    const response = await fetch(`${apiUrl}/mpu?pathname=http-multipart%2Fsession.bin`, {
      method: "POST",
      headers: { ...headers, "x-mpu-action": "create" },
    });
    expect(response.status).toBe(200);
    const session = (await response.json()) as { key: string; uploadId: string };
    expect(session.key).toBe("http-multipart/session.bin");
    expect(typeof session.uploadId).toBe("string");
    expect(session.uploadId.length).toBeGreaterThan(0);
    await expect(head("http-multipart/session.bin", { token })).rejects.toBeInstanceOf(BlobNotFoundError);
  });
});

describe("Vercel Blob local image and callback fixtures", () => {
  it("serves valid local image bytes for optimization tests", async () => {
    const response = await fetch(`${emulatorUrl}/blob-test/image.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(imageBytes);
    expect(imageBytes.readUInt32BE(16)).toBe(2);
    expect(imageBytes.readUInt32BE(20)).toBe(2);
  });

  it("verifies a signed callback with the SDK before recording its payload", async () => {
    const blob = await put("fixtures/callback.txt", "fixture", { access: "public", token });
    const body = JSON.stringify({ type: "blob.upload-completed", payload: { blob, tokenPayload: "callback-fixture" } });
    const signature = createHmac("sha256", token).update(body).digest("hex");
    const response = await fetch(`${emulatorUrl}/blob-test/completed`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vercel-signature": signature },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: "blob.upload-completed", response: "ok" });
    expect(completedUploads.find((payload) => payload.blob.pathname === blob.pathname)).toMatchObject({
      tokenPayload: "callback-fixture",
    });
  });
});

describe("Vercel Blob multipart uploads", () => {
  it.fails("publishes ordered parts only after completion, including retried parts", async () => {
    const pathname = "multipart/ordered.bin";
    const options = { access: "public" as const, token, addRandomSuffix: false };
    const session = await createMultipartUpload(pathname, options);
    const firstBytes = Buffer.alloc(5 * 1024 * 1024, "a");
    await uploadPart(pathname, Buffer.alloc(firstBytes.length, "x"), { ...options, ...session, partNumber: 1 });
    const first = await uploadPart(pathname, firstBytes, { ...options, ...session, partNumber: 1 });
    const last = await uploadPart(pathname, "tail", { ...options, ...session, partNumber: 2 });
    expect(first.etag).toEqual(expect.any(String));
    expect(last.partNumber).toBe(2);
    await expect(head(pathname, { token })).rejects.toBeInstanceOf(BlobNotFoundError);
    expect((await list({ prefix: pathname, token })).blobs).toEqual([]);
    const uploaded = await completeMultipartUpload(pathname, [last, first], { ...options, ...session });
    const downloaded = Buffer.from(await (await fetch(uploaded.url)).arrayBuffer());
    expect(downloaded).toEqual(Buffer.concat([firstBytes, Buffer.from("tail")]));
    expect((await head(uploaded.url, { token })).size).toBe(downloaded.length);
  });

  it.fails("rejects completion with an ETag that does not identify an uploaded part", async () => {
    const pathname = "multipart/invalid-etag.bin";
    const options = { access: "public" as const, token };
    const session = await createMultipartUpload(pathname, options);
    await uploadPart(pathname, "bytes", { ...options, ...session, partNumber: 1 });
    await expect(
      completeMultipartUpload(pathname, [{ partNumber: 1, etag: '"wrong"' }], { ...options, ...session }),
    ).rejects.toThrow();
    await expect(head(pathname, { token })).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it.fails("honors conditional overwrite and metadata on multipart completion", async () => {
    const pathname = "multipart/conditional.bin";
    const original = await put(pathname, "original", { access: "public", token });
    const options = {
      access: "public" as const,
      token,
      allowOverwrite: true,
      ifMatch: original.etag,
      contentType: "text/plain",
      cacheControlMaxAge: 120,
    };
    const session = await createMultipartUpload(pathname, options);
    const part = await uploadPart(pathname, "replacement", { ...options, ...session, partNumber: 1 });
    expect(await (await fetch(original.url)).text()).toBe("original");
    const uploaded = await completeMultipartUpload(pathname, [part], { ...options, ...session });
    const metadata = await head(uploaded.url, { token });
    expect(metadata.contentType).toBe("text/plain");
    expect(metadata.cacheControl).toBe("public, max-age=120");
    expect(await (await fetch(uploaded.url)).text()).toBe("replacement");
  });

  it.fails("refuses a stale conditional multipart upload without replacing the object", async () => {
    const pathname = "multipart/stale.bin";
    const original = await put(pathname, "original", { access: "public", token });
    const options = { access: "public" as const, token, allowOverwrite: true, ifMatch: original.etag };
    const session = await createMultipartUpload(pathname, options);
    const part = await uploadPart(pathname, "replacement", { ...options, ...session, partNumber: 1 });
    await put(pathname, "newer", { access: "public", token, allowOverwrite: true });
    await expect(completeMultipartUpload(pathname, [part], { ...options, ...session })).rejects.toThrow(
      /ETag|precondition/i,
    );
    expect(await (await fetch(original.url)).text()).toBe("newer");
  });

  it.fails("rejects multipart part numbers outside the S3 range", async () => {
    const pathname = "multipart/invalid-number.bin";
    const session = await createMultipartUpload(pathname, { access: "public", token });
    const response = await fetch(`${apiUrl}/mpu?pathname=${pathname}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-api-version": "12",
        "x-mpu-action": "upload",
        "x-mpu-key": session.key,
        "x-mpu-upload-id": session.uploadId,
        "x-mpu-part-number": "10001",
      },
      body: "bytes",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "bad_request", message: "Bad partNumber value, must be between 1 and 10,000" },
    });
  });
});

describe("Vercel Blob browser client tokens", () => {
  const headers = {
    "x-api-version": "12",
    "x-vercel-blob-access": "public",
    "x-vercel-blob-store-id": storeId,
    "x-add-random-suffix": "0",
  };

  it.fails("accepts a signed browser token without a store-id override", async () => {
    const pathname = "client/valid.txt";
    const clientToken = await generateClientTokenFromReadWriteToken({
      token,
      pathname,
      validUntil: Date.now() + 60_000,
    });
    const response = await fetch(`${apiUrl}?pathname=${pathname}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${clientToken}`, "x-api-version": "12", "x-vercel-blob-access": "public" },
      body: "browser bytes",
    });
    expect(response.status).toBe(200);
    const uploaded = (await response.json()) as { url: string; pathname: string };
    expect(uploaded.pathname).toBe(pathname);
    expect(await (await fetch(uploaded.url)).text()).toBe("browser bytes");
  });

  it.fails.each([
    {
      name: "expired token",
      options: { validUntil: 1 },
      pathname: "client/expired.txt",
      tokenPathname: "client/expired.txt",
      contentType: "text/plain",
      body: "ok",
      message: "Token expired",
    },
    {
      name: "pathname mismatch",
      options: {},
      pathname: "client/wrong.txt",
      tokenPathname: "client/scoped.txt",
      contentType: "text/plain",
      body: "ok",
      message: '"pathname" client/wrong.txt does not match the token payload',
    },
    {
      name: "disallowed MIME type",
      options: { allowedContentTypes: ["image/png"] },
      pathname: "client/mime.txt",
      tokenPathname: "client/mime.txt",
      contentType: "text/plain",
      body: "ok",
      message: '"contentType" text/plain is not allowed',
    },
    {
      name: "oversized body",
      options: { maximumSizeInBytes: 1 },
      pathname: "client/size.txt",
      tokenPathname: "client/size.txt",
      contentType: "text/plain",
      body: "too big",
      message: "the file length cannot be greater than 1 bytes",
    },
  ])("enforces $name on the server", async ({ options, pathname, tokenPathname, contentType, body, message }) => {
    const clientToken = await generateClientTokenFromReadWriteToken({
      token,
      pathname: tokenPathname,
      validUntil: Date.now() + 60_000,
      ...options,
    });
    const response = await fetch(`${apiUrl}?pathname=${pathname}`, {
      method: "PUT",
      headers: { ...headers, authorization: `Bearer ${clientToken}`, "x-content-type": contentType },
      body,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden", message } });
    await expect(head(pathname, { token })).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it.fails("rejects a browser token signed with the wrong store secret", async () => {
    const pathname = "client/forged.txt";
    const clientToken = await generateClientTokenFromReadWriteToken({
      token: "vercel_blob_rw_teststore_wrong",
      pathname,
      validUntil: Date.now() + 60_000,
    });
    const response = await fetch(`${apiUrl}?pathname=${pathname}`, {
      method: "PUT",
      headers: { ...headers, authorization: `Bearer ${clientToken}` },
      body: "forged",
    });
    expect(response.status).toBe(403);
    await expect(head(pathname, { token })).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it.fails("does not let request headers override signed upload options", async () => {
    const pathname = "client/signed-options.txt";
    const clientToken = await generateClientTokenFromReadWriteToken({
      token,
      pathname,
      addRandomSuffix: true,
      cacheControlMaxAge: 120,
      validUntil: Date.now() + 60_000,
    });
    const response = await fetch(`${apiUrl}?pathname=${pathname}`, {
      method: "PUT",
      headers: { ...headers, authorization: `Bearer ${clientToken}`, "x-cache-control-max-age": "3600" },
      body: "bytes",
    });
    expect(response.status).toBe(200);
    const uploaded = (await response.json()) as { url: string; pathname: string };
    expect(uploaded.pathname).toMatch(/^client\/signed-options-[a-zA-Z0-9]+\.txt$/);
    expect((await head(uploaded.url, { token })).cacheControl).toBe("public, max-age=120");
  });

  it.fails("delivers an authenticated upload-completed callback with its token payload", async () => {
    const pathname = "client/callback.txt";
    const clientToken = await generateClientTokenFromReadWriteToken({
      token,
      pathname,
      validUntil: Date.now() + 60_000,
      onUploadCompleted: { callbackUrl: `${emulatorUrl}/blob-test/completed`, tokenPayload: "local-fixture" },
    });
    const response = await fetch(`${apiUrl}?pathname=${pathname}`, {
      method: "PUT",
      headers: { ...headers, authorization: `Bearer ${clientToken}` },
      body: "callback bytes",
    });
    expect(response.status).toBe(200);
    await expect
      .poll(() => completedUploads.find((payload) => payload.blob.pathname === pathname), { timeout: 1000 })
      .toMatchObject({ blob: { pathname }, tokenPayload: "local-fixture" });
  });
});

describe("Vercel Blob browser multipart and permissions", () => {
  it.fails("publishes a browser multipart upload and signs its completion callback", async () => {
    const pathname = "client/multipart.txt";
    const clientToken = await generateClientTokenFromReadWriteToken({
      token,
      pathname,
      validUntil: Date.now() + 60_000,
      onUploadCompleted: { callbackUrl: `${emulatorUrl}/blob-test/completed`, tokenPayload: "multipart-fixture" },
    });
    const created = await fetch(`${apiUrl}/mpu?pathname=${pathname}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-api-version": "12",
        "x-vercel-blob-access": "public",
        "x-mpu-action": "create",
      },
    });
    expect(created.status).toBe(200);
    const session = (await created.json()) as { key: string; uploadId: string };
    const headers = {
      authorization: `Bearer ${clientToken}`,
      "x-api-version": "12",
      "x-mpu-key": session.key,
      "x-mpu-upload-id": session.uploadId,
    };
    const uploaded = await fetch(`${apiUrl}/mpu?pathname=${pathname}`, {
      method: "POST",
      headers: { ...headers, "x-mpu-action": "upload", "x-mpu-part-number": "1" },
      body: "browser multipart bytes",
    });
    expect(uploaded.status).toBe(200);
    const part = (await uploaded.json()) as { etag: string; partNumber: number };
    const completed = await fetch(`${apiUrl}/mpu?pathname=${pathname}`, {
      method: "POST",
      headers: { ...headers, "x-mpu-action": "complete", "content-type": "application/json" },
      body: JSON.stringify([part]),
    });
    expect(completed.status).toBe(200);
    const blob = (await completed.json()) as { url: string };
    expect(await (await fetch(blob.url)).text()).toBe("browser multipart bytes");
    await expect
      .poll(() => completedUploads.find((payload) => payload.blob.pathname === pathname), { timeout: 1000 })
      .toMatchObject({ tokenPayload: "multipart-fixture" });
  });

  it.fails.each(["list", "delete", "signed-token"])(
    "does not authorize %s with an upload-only client token",
    async (operation) => {
      const clientToken = await generateClientTokenFromReadWriteToken({
        token,
        pathname: "client/permissions.txt",
        validUntil: Date.now() + 60_000,
      });
      const response = await fetch(operation === "list" ? apiUrl : `${apiUrl}/${operation}`, {
        method: operation === "list" ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${clientToken}`,
          "x-api-version": "12",
          "x-vercel-blob-store-id": storeId,
          "content-type": "application/json",
        },
        body:
          operation === "list"
            ? undefined
            : JSON.stringify(operation === "delete" ? { urls: ["client/permissions.txt"] } : {}),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "client_token_not_allowed" } });
    },
  );
});

describe("Vercel Blob rename", () => {
  const headers = {
    authorization: `Bearer ${token}`,
    "x-api-version": "12",
    "x-vercel-blob-access": "public",
    "x-add-random-suffix": "0",
  };

  it.fails("moves bytes and metadata, then removes the source", async () => {
    const source = await put("rename/source.txt", "move me", { access: "public", token, cacheControlMaxAge: 120 });
    const response = await fetch(
      `${apiUrl}/rename?${new URLSearchParams({ fromUrl: source.url, pathname: "rename/destination.txt" })}`,
      { method: "POST", headers },
    );
    expect(response.status).toBe(200);
    const moved = (await response.json()) as { url: string; pathname: string };
    expect(moved.pathname).toBe("rename/destination.txt");
    expect(await (await fetch(moved.url)).text()).toBe("move me");
    expect((await head(moved.url, { token })).contentType).toBe("text/plain");
    await expect(head(source.url, { token })).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it.fails("preserves both objects when the destination cannot be overwritten", async () => {
    const source = await put("rename/conflict-source.txt", "source", { access: "public", token });
    const destination = await put("rename/conflict-destination.txt", "destination", { access: "public", token });
    const response = await fetch(
      `${apiUrl}/rename?${new URLSearchParams({ fromUrl: source.url, pathname: destination.pathname })}`,
      { method: "POST", headers },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "bad_request", message: expect.stringContaining("allowOverwrite") },
    });
    expect(await (await fetch(source.url)).text()).toBe("source");
    expect(await (await fetch(destination.url)).text()).toBe("destination");
  });

  it.fails("supports overwrite and does not delete a same-path rename", async () => {
    const source = await put("rename/same.txt", "keep me", { access: "public", token });
    const response = await fetch(
      `${apiUrl}/rename?${new URLSearchParams({ fromUrl: source.url, pathname: source.pathname })}`,
      { method: "POST", headers: { ...headers, "x-allow-overwrite": "1" } },
    );
    expect(response.status).toBe(200);
    expect(await (await fetch(source.url)).text()).toBe("keep me");
  });

  it.fails("returns the Blob not-found error for a missing rename source", async () => {
    const response = await fetch(
      `${apiUrl}/rename?${new URLSearchParams({ fromUrl: `${emulatorUrl}/blob/${storeId}/rename/missing.txt`, pathname: "rename/missing-target.txt" })}`,
      { method: "POST", headers },
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("Vercel Blob signed tokens and presigned operations", () => {
  it.fails("issues scoped expiring delegation and client-signing tokens", async () => {
    const validUntil = Date.now() + 60_000;
    const signed = await createSignedToken({
      token,
      pathname: "signed/scoped.txt",
      operations: ["get", "head", "put", "delete"],
      validUntil,
    });
    expect(signed.validUntil).toBe(validUntil);
    expect(signed.delegationToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(signed.clientSigningToken.length).toBeGreaterThan(0);
    const payload = JSON.parse(Buffer.from(signed.delegationToken.split(".")[0], "base64url").toString());
    expect(payload).toMatchObject({
      storeId,
      pathname: "signed/scoped.txt",
      operations: ["get", "head", "put", "delete"],
      validUntil,
    });
  });

  it.fails("accepts presigned PUT and DELETE without a bearer token", async () => {
    const pathname = "signed/write.txt";
    const signed = await createSignedToken({ token, pathname, operations: ["put", "delete"] });
    const upload = await presignUrl(signed, { operation: "put", pathname, addRandomSuffix: false, access: "public" });
    expect(new URL(upload.presignedUrl).origin).toBe(emulatorUrl);
    const response = await fetch(upload.presignedUrl, { method: "PUT", body: "signed bytes" });
    expect(response.status).toBe(200);
    const uploaded = (await response.json()) as { url: string };
    expect(await (await fetch(uploaded.url)).text()).toBe("signed bytes");
    const deletion = await presignUrl(signed, { operation: "delete", pathname, access: "public" });
    expect(new URL(deletion.presignedUrl).origin).toBe(emulatorUrl);
    expect((await fetch(deletion.presignedUrl, { method: "DELETE" })).status).toBe(200);
    await expect(head(pathname, { token })).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it.fails("rejects tampered presigned signatures without publishing bytes", async () => {
    const pathname = "signed/tampered.txt";
    const signed = await createSignedToken({ token, pathname, operations: ["put"] });
    const upload = await presignUrl(signed, { operation: "put", pathname, access: "public" });
    const url = new URL(upload.presignedUrl);
    expect(url.origin).toBe(emulatorUrl);
    url.searchParams.set("vercel-blob-signature", "invalid");
    expect((await fetch(url, { method: "PUT", body: "tampered" })).status).toBe(403);
    await expect(head(pathname, { token })).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it.fails("supports authenticated pathname DELETE independently of batch deletion", async () => {
    const uploaded = await put("signed/path-delete.txt", "delete me", { access: "public", token });
    const response = await fetch(`${apiUrl}?pathname=${uploaded.pathname}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "x-api-version": "12" },
    });
    expect(response.status).toBe(200);
    await expect(head(uploaded.url, { token })).rejects.toBeInstanceOf(BlobNotFoundError);
  });
});

describe("Vercel Blob presigned constraints and multipart", () => {
  it.fails.each(["pathname", "operation"])(
    "rejects a presigned request replayed with a different %s",
    async (changed) => {
      const signed = await createSignedToken({ pathname: "signed/replay.txt", operations: ["put"] });
      const { presignedUrl } = await presignUrl(signed, {
        operation: "put",
        pathname: "signed/replay.txt",
        access: "public",
      });
      const url = new URL(presignedUrl);
      expect(url.origin).toBe(emulatorUrl);
      if (changed === "pathname") url.searchParams.set("pathname", "signed/other.txt");
      const response = await fetch(url, {
        method: changed === "operation" ? "DELETE" : "PUT",
        body: changed === "operation" ? undefined : "bytes",
      });
      expect(response.status).toBe(403);
      await expect(head("signed/other.txt", { token })).rejects.toBeInstanceOf(BlobNotFoundError);
    },
  );

  it.fails("rejects an expired presigned request on the server", async () => {
    const signed = await createSignedToken({ pathname: "signed/expired.txt", operations: ["put"] });
    const validUntil = Date.now() + 200;
    const { presignedUrl } = await presignUrl(signed, {
      operation: "put",
      pathname: "signed/expired.txt",
      validUntil,
      access: "public",
    });
    expect(new URL(presignedUrl).origin).toBe(emulatorUrl);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, validUntil - Date.now()) + 20));
    expect((await fetch(presignedUrl, { method: "PUT", body: "expired" })).status).toBe(403);
    await expect(head("signed/expired.txt", { token })).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it.fails("enforces delegation MIME and size limits without a bearer credential", async () => {
    const pathname = "signed/constrained.txt";
    const signed = await createSignedToken({
      pathname,
      operations: ["put"],
      allowedContentTypes: ["text/plain"],
      maximumSizeInBytes: 3,
    });
    const { presignedUrl } = await presignUrl(signed, { operation: "put", pathname, access: "public" });
    expect(new URL(presignedUrl).origin).toBe(emulatorUrl);
    for (const [contentType, body] of [
      ["image/png", "ok"],
      ["text/plain", "too big"],
    ]) {
      const response = await fetch(presignedUrl, {
        method: "PUT",
        headers: { "content-type": contentType, "x-content-type": contentType },
        body,
      });
      expect(response.status).toBe(403);
    }
    await expect(head(pathname, { token })).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it.fails("completes presigned multipart writes without a bearer token", async () => {
    const pathname = "signed/multipart.txt";
    const signed = await createSignedToken({ pathname, operations: ["put"] });
    const { presignedUrl } = await presignUrl(signed, {
      operation: "put",
      pathname,
      access: "public",
      addRandomSuffix: false,
    });
    const url = new URL(presignedUrl);
    expect(url.origin).toBe(emulatorUrl);
    url.pathname = `${new URL(apiUrl).pathname}/mpu`;
    const created = await fetch(url, { method: "POST", headers: { "x-mpu-action": "create" } });
    expect(created.status).toBe(200);
    const session = (await created.json()) as { key: string; uploadId: string };
    const headers = { "x-mpu-key": session.key, "x-mpu-upload-id": session.uploadId };
    const uploaded = await fetch(url, {
      method: "POST",
      headers: { ...headers, "x-mpu-action": "upload", "x-mpu-part-number": "1" },
      body: "presigned multipart",
    });
    expect(uploaded.status).toBe(200);
    const part = (await uploaded.json()) as { partNumber: number; etag: string };
    const completed = await fetch(url, {
      method: "POST",
      headers: { ...headers, "x-mpu-action": "complete", "content-type": "application/json" },
      body: JSON.stringify([part]),
    });
    expect(completed.status).toBe(200);
    const blob = (await completed.json()) as { url: string };
    expect(await (await fetch(blob.url)).text()).toBe("presigned multipart");
  });

  it.fails.each([{ operations: [] }, { operations: ["unknown"] }, { validUntil: 1 }])(
    "validates signed-token issuance parameters %j",
    async (body) => {
      const response = await fetch(`${apiUrl}/signed-token`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-api-version": "12" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
    },
  );
});

describe("Vercel Blob private store lifecycle", () => {
  const headers = { authorization: "Bearer blob-admin-token", "content-type": "application/json" };

  async function createPrivateStore(name: string) {
    const created = await fetch(`${emulatorUrl}/storage/stores/blob?slug=blob-contract`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, access: "private", region: "iad1" }),
    });
    expect(created.status).toBe(200);
    const { store } = (await created.json()) as { store: { id: string; access: string } };
    expect(store.access).toBe("private");
    const secrets = await fetch(`${emulatorUrl}/storage/stores/${store.id}/secrets?slug=blob-contract`, { headers });
    expect(secrets.status).toBe(200);
    const { rwToken } = (await secrets.json()) as { rwToken: string };
    expect(rwToken).toEqual(expect.any(String));
    return { store, privateToken: rwToken };
  }

  it.fails("creates and retrieves a private store and its read-write token", async () => {
    const { store } = await createPrivateStore("private-configuration");
    const response = await fetch(`${emulatorUrl}/storage/stores/${store.id}?slug=blob-contract`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ store: { id: store.id, access: "private" } });
  });

  it.fails("serves private GET and HEAD only to the owning store's token", async () => {
    const { privateToken } = await createPrivateStore("private-content");
    const uploaded = await put("private/content.txt", "secret bytes", { access: "private", token: privateToken });
    const authorized = { authorization: `Bearer ${privateToken}` };
    const response = await fetch(uploaded.url, { headers: authorized });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("secret bytes");
    const metadata = await fetch(uploaded.url, { method: "HEAD", headers: authorized });
    expect(metadata.status).toBe(200);
    expect(await metadata.text()).toBe("");
    expect((await fetch(uploaded.url)).status).toBe(403);
    expect((await fetch(uploaded.url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    expect((await fetch(uploaded.url, { method: "HEAD" })).status).toBe(403);
  });

  it.fails("supports metadata, listing, copy and deletion inside a private store", async () => {
    const { privateToken } = await createPrivateStore("private-crud");
    const options = { access: "private" as const, token: privateToken };
    const uploaded = await put("private-crud/source.txt", "secret", options);
    expect((await head(uploaded.url, { token: privateToken })).size).toBe(6);
    expect((await list({ prefix: "private-crud/", token: privateToken })).blobs.map((blob) => blob.pathname)).toEqual([
      uploaded.pathname,
    ]);
    const copied = await copy(uploaded.url, "private-crud/copy.txt", options);
    expect(await (await fetch(copied.url, { headers: { authorization: `Bearer ${privateToken}` } })).text()).toBe(
      "secret",
    );
    await del([uploaded.url, copied.url], { token: privateToken });
    expect((await list({ prefix: "private-crud/", token: privateToken })).blobs).toEqual([]);
  });

  it.fails("rejects public uploads into a configured private store", async () => {
    const { privateToken } = await createPrivateStore("private-access-policy");
    await expect(put("private/mismatch.txt", "bytes", { access: "public", token: privateToken })).rejects.toThrow(
      /access|private/i,
    );
  });

  it.fails("accepts private presigned GET and HEAD without exposing anonymous content", async () => {
    const { privateToken } = await createPrivateStore("private-presigned");
    const uploaded = await put("private/signed.txt", "signed secret", { access: "private", token: privateToken });
    const signed = await createSignedToken({
      token: privateToken,
      pathname: uploaded.pathname,
      operations: ["get", "head"],
    });
    for (const operation of ["get", "head"] as const) {
      const { presignedUrl } = await presignUrl(signed, { operation, pathname: uploaded.pathname, access: "private" });
      const localUrl = new URL(uploaded.url);
      localUrl.search = new URL(presignedUrl).search;
      expect(localUrl.origin).toBe(emulatorUrl);
      const response = await fetch(localUrl, { method: operation.toUpperCase() });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(operation === "get" ? "signed secret" : "");
    }
    expect((await fetch(uploaded.url)).status).toBe(403);
  });

  it.fails("supports private multipart uploads without anonymous publication", async () => {
    const { privateToken } = await createPrivateStore("private-multipart");
    const pathname = "private/multipart.txt";
    const options = { access: "private" as const, token: privateToken };
    const session = await createMultipartUpload(pathname, options);
    const part = await uploadPart(pathname, "private multipart", { ...options, ...session, partNumber: 1 });
    const uploaded = await completeMultipartUpload(pathname, [part], { ...options, ...session });
    expect((await fetch(uploaded.url)).status).toBe(403);
    expect(await (await fetch(uploaded.url, { headers: { authorization: `Bearer ${privateToken}` } })).text()).toBe(
      "private multipart",
    );
  });

  it.fails("lists, renames and deletes a configured Blob store", async () => {
    const { store } = await createPrivateStore("private-management");
    const listing = await fetch(`${emulatorUrl}/storage/stores?slug=blob-contract`, { headers });
    expect(listing.status).toBe(200);
    expect(((await listing.json()) as { stores: Array<{ id: string }> }).stores).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: store.id })]),
    );
    const renamed = await fetch(`${emulatorUrl}/storage/stores/blob/${store.id}?slug=blob-contract`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ name: "private-renamed" }),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ store: { id: store.id, name: "private-renamed", access: "private" } });
    const deleted = await fetch(`${emulatorUrl}/storage/stores/blob/${store.id}?slug=blob-contract`, {
      method: "DELETE",
      headers,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ id: store.id });
    expect((await fetch(`${emulatorUrl}/storage/stores/${store.id}?slug=blob-contract`, { headers })).status).toBe(404);
  });

  it.fails("creates the project-default private store for OIDC-based workflows", async () => {
    const projectResponse = await fetch(`${emulatorUrl}/v9/projects/blob-contract-project?slug=blob-contract`, {
      headers,
    });
    expect(projectResponse.status).toBe(200);
    const project = (await projectResponse.json()) as { id: string };
    const response = await fetch(`${emulatorUrl}/storage/stores/blob/default-project-store?slug=blob-contract`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: project.id, region: "iad1" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      store: { id: `store_${project.id}`, access: "private", projectId: project.id },
    });
  });
});

describe("Vercel Blob optimized images", () => {
  const headers = {
    authorization: "Bearer local-oidc-token",
    "x-vercel-blob-store-id": storeId,
    "x-api-version": "12",
    "x-vercel-blob-access": "public",
    "x-add-random-suffix": "0",
    "content-type": "image/png",
  };

  it.fails.each(["put-optimized", "put-from-url"])("optimizes a local image through %s", async (operation) => {
    const query = new URLSearchParams({
      pathname: `images/${operation}.webp`,
      width: "1",
      quality: "75",
      format: "image/webp",
    });
    if (operation === "put-from-url") query.set("url", `${emulatorUrl}/blob-test/image.png`);
    const response = await fetch(`${apiUrl}/${operation}?${query}`, {
      method: "POST",
      headers,
      body: operation === "put-optimized" ? imageBytes : undefined,
    });
    expect(response.status).toBe(200);
    const uploaded = (await response.json()) as { url: string; contentType: string };
    expect(uploaded.contentType).toBe("image/webp");
    const bytes = Buffer.from(await (await fetch(uploaded.url)).arrayBuffer());
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString()).toBe("WEBP");
    expect((await head(uploaded.url, { token })).size).toBe(bytes.length);
  });

  it.fails("resizes optimized PNG bytes to the requested width", async () => {
    const response = await fetch(
      `${apiUrl}/put-optimized?pathname=images/resized.png&width=1&quality=75&format=image/png`,
      { method: "POST", headers, body: imageBytes },
    );
    expect(response.status).toBe(200);
    const uploaded = (await response.json()) as { url: string };
    const bytes = Buffer.from(await (await fetch(uploaded.url)).arrayBuffer());
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(bytes.readUInt32BE(16)).toBe(1);
    expect(bytes.readUInt32BE(20)).toBe(1);
  });

  it.fails("rejects image optimization with a read-write credential", async () => {
    const response = await fetch(
      `${apiUrl}/put-optimized?pathname=images/rw.webp&width=1&quality=75&format=image/webp`,
      { method: "POST", headers: { ...headers, authorization: `Bearer ${token}` }, body: imageBytes },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "client_token_not_allowed" } });
  });

  it.fails("rejects a pathname extension that contradicts the optimized format", async () => {
    const response = await fetch(
      `${apiUrl}/put-optimized?pathname=images/mismatch.png&width=1&quality=75&format=image/webp`,
      { method: "POST", headers, body: imageBytes },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "bad_request", message: expect.stringContaining("does not match") },
    });
  });
});

describe("Vercel Blob TTL", () => {
  const headers = {
    authorization: `Bearer ${token}`,
    "x-api-version": "12",
    "x-vercel-blob-access": "public",
    "x-add-random-suffix": "0",
  };

  it.fails.each(["0", "31", "1.5", "not-a-number"])("rejects invalid TTL %s", async (days) => {
    const pathname = `ttl/invalid-${days}.txt`;
    const response = await fetch(`${apiUrl}?pathname=${pathname}`, {
      method: "PUT",
      headers: { ...headers, "x-ttl-days": days },
      body: "bytes",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "bad_request", message: "ttlDays must be an integer between 1 and 30" },
    });
    await expect(head(pathname, { token })).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it.fails("exposes future lifecycle expiry for a TTL-enabled upload", async () => {
    const response = await fetch(`${apiUrl}?pathname=ttl/expiry.txt`, {
      method: "PUT",
      headers: { ...headers, "x-ttl-days": "1" },
      body: "temporary",
    });
    expect(response.status).toBe(200);
    const uploaded = (await response.json()) as { url: string };
    const metadata = await fetch(`${apiUrl}?url=${encodeURIComponent(uploaded.url)}`, { headers });
    expect(metadata.status).toBe(200);
    const { expiresAt } = (await metadata.json()) as { expiresAt: string };
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
  });

  it.fails("sets destination TTL on copy and clears it when copying without TTL", async () => {
    const source = await put("ttl/source.txt", "temporary", { access: "public", token });
    const response = await fetch(
      `${apiUrl}?${new URLSearchParams({ pathname: "ttl/copied.txt", fromUrl: source.url })}`,
      { method: "PUT", headers: { ...headers, "x-ttl-days": "2" } },
    );
    expect(response.status).toBe(200);
    const copied = (await response.json()) as { url: string };
    const metadata = await fetch(`${apiUrl}?url=${encodeURIComponent(copied.url)}`, { headers });
    expect(Date.parse(((await metadata.json()) as { expiresAt: string }).expiresAt)).toBeGreaterThan(Date.now());
    const permanent = await copy(copied.url, "ttl/permanent.txt", { access: "public", token });
    const permanentMetadata = await fetch(`${apiUrl}?url=${encodeURIComponent(permanent.url)}`, { headers });
    expect(await permanentMetadata.json()).not.toHaveProperty("expiresAt");
  });

  it.fails("preserves TTL from multipart creation through completion", async () => {
    const pathname = "ttl/multipart.txt";
    const response = await fetch(`${apiUrl}/mpu?pathname=${pathname}`, {
      method: "POST",
      headers: { ...headers, "x-mpu-action": "create", "x-ttl-days": "30" },
    });
    expect(response.status).toBe(200);
    const session = (await response.json()) as { key: string; uploadId: string };
    const options = { ...session, access: "public" as const, token };
    const part = await uploadPart(pathname, "temporary", { ...options, partNumber: 1 });
    const uploaded = await completeMultipartUpload(pathname, [part], options);
    const metadata = await fetch(`${apiUrl}?url=${encodeURIComponent(uploaded.url)}`, { headers });
    expect(Date.parse(((await metadata.json()) as { expiresAt: string }).expiresAt)).toBeGreaterThan(Date.now());
  });
});

describe("Vercel Blob content delivery and legacy compatibility", () => {
  it.fails("serves partial byte ranges with a Content-Range header", async () => {
    const uploaded = await put("delivery/range.txt", "0123456789", { access: "public", token });
    const response = await fetch(uploaded.url, { headers: { range: "bytes=2-5" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(await response.text()).toBe("2345");
  });

  it.fails("returns 416 for unsatisfiable content ranges", async () => {
    const uploaded = await put("delivery/unsatisfiable.txt", "bytes", { access: "public", token });
    const response = await fetch(uploaded.url, { headers: { range: "bytes=100-" } });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */5");
  });

  it.fails("provides Last-Modified and size on a bodyless content HEAD", async () => {
    const uploaded = await put("delivery/metadata.txt", "bytes", { access: "public", token });
    const metadata = await head(uploaded.url, { token });
    const response = await fetch(uploaded.url, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("last-modified")).toBe(metadata.uploadedAt.toUTCString());
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("etag")).toBe(uploaded.etag);
    expect(await response.text()).toBe("");
  });

  it.fails("supports legacy pathname-in-route uploads", async () => {
    const response = await fetch(`${apiUrl}/legacy/path.txt`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "x-api-version": "0", "x-add-random-suffix": "0" },
      body: "legacy bytes",
    });
    expect(response.status).toBe(200);
    const uploaded = (await response.json()) as { url: string; pathname: string };
    expect(uploaded.pathname).toBe("legacy/path.txt");
    expect(await (await fetch(uploaded.url)).text()).toBe("legacy bytes");
  });

  it.fails("rejects rename before API v9 rather than treating rename as a pathname", async () => {
    const response = await fetch(`${apiUrl}/rename?pathname=legacy/rename.txt&fromUrl=missing.txt`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-api-version": "8" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "bad_request", message: "Rename requires the x-api-version header to be 9 or newer" },
    });
  });
});

describe("Vercel Blob browser preflight and versioned responses", () => {
  it.fails("answers unauthenticated preflight for browser upload headers", async () => {
    const response = await fetch(apiUrl, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization,x-api-version,x-mpu-action,x-if-match",
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(response.headers.get("access-control-allow-methods")).toContain("DELETE");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-mpu-action");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-if-match");
  });

  it.fails.each(["put", "head", "list", "copy"])("omits ETags from API v11 %s responses", async (operation) => {
    const pathname = `legacy/v11-${operation}.txt`;
    const uploaded = await put(pathname, "legacy", { access: "public", token });
    const headers = {
      authorization: `Bearer ${token}`,
      "x-api-version": "11",
      "x-vercel-blob-access": "public",
      "x-add-random-suffix": "0",
      "x-allow-overwrite": "1",
    };
    const query = new URLSearchParams(
      operation === "head"
        ? { url: uploaded.url }
        : operation === "list"
          ? { prefix: pathname }
          : operation === "copy"
            ? { pathname: `${pathname}.copy`, fromUrl: uploaded.url }
            : { pathname },
    );
    const response = await fetch(`${apiUrl}?${query}`, {
      method: operation === "put" || operation === "copy" ? "PUT" : "GET",
      headers,
      body: operation === "put" ? "replacement" : undefined,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { blobs?: Array<Record<string, unknown>> };
    expect(operation === "list" ? body.blobs?.[0] : body).not.toHaveProperty("etag");
  });

  it.fails("returns the legacy deletion response rather than the modern null body", async () => {
    const uploaded = await put("legacy/delete-response.txt", "delete", { access: "public", token });
    const response = await fetch(`${apiUrl}/delete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-api-version": "0" },
      body: JSON.stringify({ urls: [uploaded.url] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ url: uploaded.url, size: 0 }]);
    await expect(head(uploaded.url, { token })).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it("allows SDK get to stream a local emulator URL", async () => {
    const uploaded = await put("delivery/sdk-get.txt", "SDK bytes", { access: "public", token });
    const result = await get(uploaded.url, { access: "public", token });
    expect(result?.statusCode).toBe(200);
    expect(await new Response(result?.stream).text()).toBe("SDK bytes");
  });

  it.fails("reports blob size from SDK get on a local emulator URL", async () => {
    const uploaded = await put("delivery/sdk-get-size.txt", "SDK bytes", { access: "public", token });
    const result = await get(uploaded.url, { access: "public", token });
    expect(result?.statusCode).toBe(200);
    expect(await new Response(result?.stream).text()).toBe("SDK bytes");
    expect(result?.blob.size).toBe(9);
  });
});

describe("Vercel Blob credential verification", () => {
  it.fails("rejects a read-write token with an incorrect secret", async () => {
    const uploaded = await put("auth/secret-check.txt", "private metadata", { access: "public", token });
    const response = await fetch(`${apiUrl}?url=${encodeURIComponent(uploaded.url)}`, {
      headers: { authorization: "Bearer vercel_blob_rw_teststore_wrong", "x-api-version": "12" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it.fails("does not authenticate an arbitrary bearer token via a store-id header", async () => {
    const response = await fetch(apiUrl, {
      headers: { authorization: "Bearer not-an-oidc-token", "x-vercel-blob-store-id": storeId, "x-api-version": "12" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
  });
});

describe("Vercel Blob mounted under a path prefix", () => {
  // When embedded (e.g. the Next.js adapter serves the emulator at
  // /emulate/vercel), blob URLs carry the mount prefix and head/del/copy must
  // still resolve them.
  const prefixedBase = "http://app.example/emulate/vercel";
  const headers = { authorization: `Bearer ${token}` };

  function createPrefixedApp(): Hono {
    const store = new Store();
    const webhooks = new WebhookDispatcher();
    const app = new Hono();
    vercelPlugin.register(app as any, store, webhooks, prefixedBase);
    return app;
  }

  it("head resolves a blob URL that includes the mount prefix", async () => {
    const app = createPrefixedApp();
    const putRes = await app.request("/api/blob?pathname=prefixed/head.txt", {
      method: "PUT",
      headers,
      body: "head me",
    });
    const uploaded = (await putRes.json()) as { url: string };
    expect(uploaded.url).toBe(`${prefixedBase}/blob/${storeId}/prefixed/head.txt`);

    const headRes = await app.request(`/api/blob?url=${encodeURIComponent(uploaded.url)}`, { headers });
    expect(headRes.status).toBe(200);
    expect(((await headRes.json()) as { pathname: string }).pathname).toBe("prefixed/head.txt");
  });

  it("del resolves a blob URL that includes the mount prefix", async () => {
    const app = createPrefixedApp();
    const putRes = await app.request("/api/blob?pathname=prefixed/del.txt", {
      method: "PUT",
      headers,
      body: "delete me",
    });
    const uploaded = (await putRes.json()) as { url: string };

    const delRes = await app.request("/api/blob/delete", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ urls: [uploaded.url] }),
    });
    expect(delRes.status).toBe(200);

    const listRes = await app.request("/api/blob?prefix=prefixed/", { headers });
    expect(((await listRes.json()) as { blobs: unknown[] }).blobs).toHaveLength(0);
  });

  it("copy resolves a blob URL that includes the mount prefix", async () => {
    const app = createPrefixedApp();
    const putRes = await app.request("/api/blob?pathname=prefixed/source.txt", {
      method: "PUT",
      headers,
      body: "copy source",
    });
    const uploaded = (await putRes.json()) as { url: string };

    const copyRes = await app.request(
      `/api/blob?pathname=prefixed/copy.txt&fromUrl=${encodeURIComponent(uploaded.url)}`,
      {
        method: "PUT",
        headers,
      },
    );
    expect(copyRes.status).toBe(200);

    const headRes = await app.request(
      `/api/blob?url=${encodeURIComponent(`${prefixedBase}/blob/${storeId}/prefixed/copy.txt`)}`,
      { headers },
    );
    expect(headRes.status).toBe(200);
    expect(((await headRes.json()) as { size: number }).size).toBe("copy source".length);
  });

  it("does not strip the mount prefix from hosted Vercel Blob URLs", async () => {
    const app = createPrefixedApp();
    await app.request("/api/blob?pathname=emulate/vercel/hosted.txt", {
      method: "PUT",
      headers,
      body: "hosted path",
    });

    const hostedUrl = `https://${storeId}.public.blob.vercel-storage.com/emulate/vercel/hosted.txt`;
    const headRes = await app.request(`/api/blob?url=${encodeURIComponent(hostedUrl)}`, { headers });
    expect(headRes.status).toBe(200);
    expect(((await headRes.json()) as { pathname: string }).pathname).toBe("emulate/vercel/hosted.txt");
  });
});
