import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Hono, Store, WebhookDispatcher, serve } from "@emulators/core";
import { BlobNotFoundError, copy, del, head, list, put } from "@vercel/blob";
import { vercelPlugin } from "../index.js";
import { checkContract, localOnlyFetch } from "./blob-contract-support.js";

const API_VERSION = "12";
const TOKEN = "vercel_blob_rw_contractstore_local";
const STORE_ID = "contractstore";
const API_REVISION = "d649a49eb8bd43eefc812e0dd75aec8de2af6e38";
const enforceContracts = process.env.BLOB_CONTRACT_ENFORCE === "1";

const knownGaps = {
  "delete-empty": {
    reason: "An empty deletion list succeeds rather than being rejected",
    source: "services/api-blob/src/operations/del.ts",
  },
  "delete-malformed": {
    reason: "Malformed deletion JSON succeeds rather than being rejected",
    source: "services/api-blob/src/operations/del.ts",
  },
  "copy-source-match": {
    reason: "Conditional copy checks the nonexistent destination instead of the source",
    source: "services/api-blob/src/operations/copy.ts",
  },
  "copy-source-mismatch": {
    reason: "Conditional copy accepts the destination ETag despite a different source ETag",
    source: "services/api-blob/src/operations/copy.ts",
  },
  "folded-pagination": {
    reason: "Folded listing paginates blobs but not common prefixes",
    source: "services/api-blob/src/operations/list.ts",
  },
  "content-type-fallback": {
    reason: "An extensionless upload ignores the Content-Type header",
    source: "services/api-blob/src/common/http-headers.ts",
  },
  "cache-minimum": {
    reason: "Modern cache max-age is not clamped to at least 60 seconds",
    source: "services/api-blob/src/common/http-headers.ts",
  },
  "leading-slash": {
    reason: "A leading pathname slash is retained rather than removed",
    source: "services/api-blob/src/common/utils.ts",
  },
  "multipart-create": {
    reason: "Multipart creation returns the explicit unsupported-operation error",
    source: "services/api-blob/src/operations/mpu.ts",
  },
} as const;

interface BlobResult {
  url: string;
  pathname: string;
  contentType: string;
  contentDisposition: string;
  cacheControl: string;
  etag: string;
}

interface ErrorResult {
  error?: { code: string; message: string };
}

const store = new Store();
let server: Server | undefined;
let origin: string;
let apiUrl: string;
let originalFetch: typeof fetch;
const environmentKeys = ["VERCEL_BLOB_API_URL", "NEXT_PUBLIC_VERCEL_BLOB_API_URL", "BLOB_READ_WRITE_TOKEN"] as const;
const previousEnvironment = new Map<string, string | undefined>();
const verifiedGaps = new Set<keyof typeof knownGaps>();

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, "x-api-version": API_VERSION, ...extra };
}

async function upload(pathname: string, body = "fixture", extra: Record<string, string> = {}): Promise<BlobResult> {
  const response = await fetch(`${apiUrl}?${new URLSearchParams({ pathname })}`, {
    method: "PUT",
    headers: authHeaders({ "x-vercel-blob-access": "public", "x-add-random-suffix": "0", ...extra }),
    body,
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as BlobResult;
  expect(typeof result.url).toBe("string");
  expect(typeof result.etag).toBe("string");
  return result;
}

async function content(pathname: string): Promise<string | null> {
  const response = await fetch(`${origin}/blob/${STORE_ID}/${pathname}`);
  if (response.status === 404) {
    expect(((await response.json()) as ErrorResult).error?.code).toBe("not_found");
    return null;
  }
  expect(response.status).toBe(200);
  return response.text();
}

async function responseShape(response: Response): Promise<{ status: number; error: ErrorResult["error"] | null }> {
  const body = (await response.json()) as ErrorResult | null;
  return { status: response.status, error: body?.error ?? null };
}

async function gapCheck<Observation>(
  id: keyof typeof knownGaps,
  observe: () => Promise<Observation>,
  expected: Observation,
  current: Observation,
): Promise<void> {
  const outcome = await checkContract(
    observe,
    expected,
    enforceContracts ? undefined : { id, ...knownGaps[id], current },
  );
  if (outcome === "known-gap") verifiedGaps.add(id);
}

beforeAll(async () => {
  originalFetch = globalThis.fetch;
  for (const key of environmentKeys) previousEnvironment.set(key, process.env[key]);
  const app = new Hono();
  const activeServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  server = activeServer;
  await new Promise<void>((resolve, reject) => {
    activeServer.once("listening", resolve);
    activeServer.once("error", reject);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  apiUrl = `${origin}/api/blob`;
  vercelPlugin.register(app, store, new WebhookDispatcher(), origin);
  process.env.VERCEL_BLOB_API_URL = apiUrl;
  process.env.NEXT_PUBLIC_VERCEL_BLOB_API_URL = apiUrl;
  process.env.BLOB_READ_WRITE_TOKEN = TOKEN;
  globalThis.fetch = localOnlyFetch(origin, originalFetch);
});

beforeEach(() => store.reset());

afterAll(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (server) {
    const activeServer = server;
    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => (error ? reject(error) : resolve()));
      activeServer.closeAllConnections();
    });
  }
  console.info(
    enforceContracts
      ? "Blob contracts: strict enforcement; no expected failures accepted"
      : `Blob contracts: ${verifiedGaps.size}/${Object.keys(knownGaps).length} expected gaps verified (not implemented)`,
  );
});

describe("Blob v12 compatibility: passing contracts (SDK 2.4.0 and raw HTTP)", () => {
  it("round-trips binary SDK uploads and metadata", async () => {
    const bytes = Buffer.from([0, 255, 1, 128, 42]);
    const result = await put("roundtrip.bin", bytes, { access: "public", addRandomSuffix: false, token: TOKEN });
    const response = await fetch(result.url);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("etag")).toBe(result.etag);
    const metadata = await head(result.url, { token: TOKEN });
    expect(metadata.size).toBe(bytes.length);
    expect(metadata.pathname).toBe("roundtrip.bin");
    expect(metadata.etag).toBe(result.etag);
  });

  it("copies through the SDK and preserves the source", async () => {
    const source = await upload("source.bin", "source bytes");
    const result = await copy(source.url, "copy.bin", { access: "public", token: TOKEN });
    expect(await content("source.bin")).toBe("source bytes");
    expect(await content(result.pathname)).toBe("source bytes");
  });

  it("paginates SDK listings without duplicates or omissions", async () => {
    for (const pathname of ["page/a.bin", "page/b.bin", "page/c.bin"]) await upload(pathname);
    const first = await list({ prefix: "page/", limit: 2, token: TOKEN });
    expect(first.blobs.map((blob) => blob.pathname)).toEqual(["page/a.bin", "page/b.bin"]);
    expect(first.hasMore).toBe(true);
    expect(typeof first.cursor).toBe("string");
    const second = await list({ prefix: "page/", limit: 2, cursor: first.cursor, token: TOKEN });
    expect(second.blobs.map((blob) => blob.pathname)).toEqual(["page/c.bin"]);
    expect(second.hasMore).toBe(false);
  });

  it("deletes through the SDK and reports a subsequent metadata miss", async () => {
    const result = await upload("delete.bin");
    await del(result.url, { token: TOKEN });
    expect(await content("delete.bin")).toBeNull();
    await expect(head(result.url, { token: TOKEN })).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it("returns a v12 JSON forbidden error without credentials", async () => {
    const response = await fetch(apiUrl, { headers: { "x-api-version": API_VERSION } });
    expect(await responseShape(response)).toEqual({
      status: 403,
      error: { code: "forbidden", message: "Access denied" },
    });
  });

  it("rejects a stale conditional PUT without changing stored bytes", async () => {
    await upload("conditional.bin", "original");
    const response = await fetch(`${apiUrl}?pathname=conditional.bin`, {
      method: "PUT",
      headers: authHeaders({ "x-if-match": '"stale"' }),
      body: "replacement",
    });
    expect((await responseShape(response)).status).toBe(412);
    expect(await content("conditional.bin")).toBe("original");
  });

  it("accepts a matching conditional PUT and changes the ETag", async () => {
    const original = await upload("conditional.bin", "original");
    const updated = await upload("conditional.bin", "updated", { "x-if-match": original.etag });
    expect(updated.etag).not.toBe(original.etag);
    expect(await content("conditional.bin")).toBe("updated");
  });

  it("serves an exact If-None-Match as a bodyless 304", async () => {
    const result = await upload("cached.bin");
    const response = await fetch(result.url, { headers: { "if-none-match": result.etag } });
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(result.etag);
    expect(await response.text()).toBe("");
  });
});

describe(`Blob v12 compatibility: executable known gaps (API ${API_REVISION})`, () => {
  it("[delete-empty] rejects an empty batch without deleting fixtures", async () => {
    await upload("survivor.bin", "survives");
    await gapCheck(
      "delete-empty",
      async () => {
        const response = await fetch(`${apiUrl}/delete`, {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ urls: [] }),
        });
        return { ...(await responseShape(response)), survivor: await content("survivor.bin") };
      },
      { status: 400, error: { code: "bad_request", message: "Missing urls in request body" }, survivor: "survives" },
      { status: 200, error: null, survivor: "survives" },
    );
  });

  it("[delete-malformed] rejects malformed JSON without deleting fixtures", async () => {
    await upload("survivor.bin", "survives");
    await gapCheck(
      "delete-malformed",
      async () => {
        const response = await fetch(`${apiUrl}/delete`, {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: "not json",
        });
        return { ...(await responseShape(response)), survivor: await content("survivor.bin") };
      },
      {
        status: 400,
        error: { code: "bad_request", message: "Cannot delete more than 1,000 urls at once or body is malformed" },
        survivor: "survives",
      },
      { status: 200, error: null, survivor: "survives" },
    );
  });

  it("[copy-source-match] checks the source ETag when the destination does not exist", async () => {
    const source = await upload("source.bin", "source");
    await gapCheck(
      "copy-source-match",
      async () => {
        const response = await fetch(
          `${apiUrl}?${new URLSearchParams({ pathname: "destination.bin", fromUrl: source.url })}`,
          {
            method: "PUT",
            headers: authHeaders({ "x-if-match": source.etag }),
          },
        );
        return {
          ...(await responseShape(response)),
          source: await content("source.bin"),
          destination: await content("destination.bin"),
        };
      },
      { status: 200, error: null, source: "source", destination: "source" },
      {
        status: 412,
        error: { code: "precondition_failed", message: "Precondition failed: ETag mismatch." },
        source: "source",
        destination: null,
      },
    );
  });

  it("[copy-source-mismatch] rejects a destination ETag and preserves both objects", async () => {
    const source = await upload("source.bin", "source");
    const destination = await upload("destination.bin", "destination");
    expect(source.etag).not.toBe(destination.etag);
    await gapCheck(
      "copy-source-mismatch",
      async () => {
        const response = await fetch(
          `${apiUrl}?${new URLSearchParams({ pathname: destination.pathname, fromUrl: source.url })}`,
          {
            method: "PUT",
            headers: authHeaders({ "x-if-match": destination.etag }),
          },
        );
        return {
          ...(await responseShape(response)),
          source: await content("source.bin"),
          destination: await content("destination.bin"),
        };
      },
      {
        status: 412,
        error: { code: "precondition_failed", message: "Precondition failed: ETag mismatch." },
        source: "source",
        destination: "destination",
      },
      { status: 200, error: null, source: "source", destination: "source" },
    );
  });

  it("[folded-pagination] counts common prefixes against the page limit", async () => {
    await upload("folders/a/file.bin");
    await upload("folders/b/file.bin");
    await gapCheck(
      "folded-pagination",
      async () => {
        const response = await fetch(`${apiUrl}?prefix=folders%2F&mode=folded&limit=1`, { headers: authHeaders() });
        expect(response.status).toBe(200);
        const result = (await response.json()) as {
          blobs: unknown[];
          folders: string[];
          hasMore: boolean;
          cursor?: string;
        };
        expect(Array.isArray(result.blobs)).toBe(true);
        expect(Array.isArray(result.folders)).toBe(true);
        return {
          blobs: result.blobs.length,
          folders: result.folders,
          hasMore: result.hasMore,
          cursorPresent: typeof result.cursor === "string" && result.cursor.length > 0,
        };
      },
      { blobs: 0, folders: ["folders/a/"], hasMore: true, cursorPresent: true },
      { blobs: 0, folders: ["folders/a/", "folders/b/"], hasMore: false, cursorPresent: false },
    );
  });

  it("[content-type-fallback] preserves Content-Type on extensionless uploads", async () => {
    await gapCheck(
      "content-type-fallback",
      async () => {
        const uploaded = await upload("extensionless", "bytes", { "content-type": "application/x-contract-fixture" });
        const response = await fetch(uploaded.url);
        expect(response.status).toBe(200);
        return {
          contentType: uploaded.contentType,
          servedContentType: response.headers.get("content-type"),
          bytes: await response.text(),
        };
      },
      {
        contentType: "application/x-contract-fixture",
        servedContentType: "application/x-contract-fixture",
        bytes: "bytes",
      },
      { contentType: "application/octet-stream", servedContentType: "application/octet-stream", bytes: "bytes" },
    );
  });

  it("[cache-minimum] clamps modern max-age to one minute", async () => {
    await gapCheck(
      "cache-minimum",
      async () => {
        const uploaded = await upload("cache.bin", "bytes", { "x-cache-control-max-age": "0" });
        const response = await fetch(`${apiUrl}?${new URLSearchParams({ url: uploaded.url })}`, {
          headers: authHeaders(),
        });
        expect(response.status).toBe(200);
        return {
          cacheControl: ((await response.json()) as BlobResult).cacheControl,
          bytes: await content("cache.bin"),
        };
      },
      { cacheControl: "public, max-age=60", bytes: "bytes" },
      { cacheControl: "public, max-age=0", bytes: "bytes" },
    );
  });

  it("[leading-slash] normalizes the returned pathname", async () => {
    await gapCheck(
      "leading-slash",
      async () => {
        const uploaded = await upload("/leading.bin");
        const response = await fetch(`${apiUrl}?${new URLSearchParams({ url: uploaded.url })}`, {
          headers: authHeaders(),
        });
        expect(response.status).toBe(200);
        return { pathname: uploaded.pathname, metadataPathname: ((await response.json()) as BlobResult).pathname };
      },
      { pathname: "leading.bin", metadataPathname: "leading.bin" },
      { pathname: "/leading.bin", metadataPathname: "/leading.bin" },
    );
  });

  it("[multipart-create] creates a session without publishing a blob", async () => {
    await gapCheck(
      "multipart-create",
      async () => {
        const response = await fetch(`${apiUrl}/mpu?pathname=multipart.bin`, {
          method: "POST",
          headers: authHeaders({
            "x-mpu-action": "create",
            "x-vercel-blob-access": "public",
            "x-add-random-suffix": "0",
          }),
        });
        const body = (await response.json()) as ErrorResult & { key?: string; uploadId?: string };
        return {
          status: response.status,
          error: body.error ?? null,
          key: body.key ?? null,
          uploadIdPresent: typeof body.uploadId === "string" && body.uploadId.length > 0,
          published: await content("multipart.bin"),
        };
      },
      { status: 200, error: null, key: "multipart.bin", uploadIdPresent: true, published: null },
      {
        status: 400,
        error: { code: "bad_request", message: "Multipart uploads are not supported by the emulator yet" },
        key: null,
        uploadIdPresent: false,
        published: null,
      },
    );
  });
});
