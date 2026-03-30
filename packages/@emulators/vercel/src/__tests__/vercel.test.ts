import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher, authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { vercelPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const TEST_RW_TOKEN = "vercel_blob_rw_teststore_testsecret";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "testuser", id: 1, scopes: ["user"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  vercelPlugin.register(app as any, store, webhooks, base, tokenMap);
  vercelPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ username: "testuser", email: "testuser@example.com" }],
  });

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): HeadersInit {
  return { Authorization: "Bearer test-token" };
}

function blobHeaders(token = TEST_RW_TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

describe("Vercel plugin integration", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("GET /v2/user returns the current user", async () => {
    const res = await app.request(`${base}/v2/user`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string; email: string } };
    expect(body.user).toBeDefined();
    expect(body.user.username).toBe("testuser");
    expect(body.user.email).toBe("testuser@example.com");
  });

  it("GET /v10/projects lists projects for the authenticated account", async () => {
    const res = await app.request(`${base}/v10/projects`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: unknown[]; pagination: unknown };
    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.pagination).toBeDefined();
  });

  it("POST /v11/projects creates a project", async () => {
    const name = `it-project-${Date.now()}`;
    const res = await app.request(`${base}/v11/projects`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { name: string; id: string };
    expect(body.name).toBe(name);
    expect(body.id).toBeDefined();
  });

  it("GET /v6/deployments returns deployments for the account", async () => {
    const res = await app.request(`${base}/v6/deployments`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deployments: unknown[]; pagination: unknown };
    expect(Array.isArray(body.deployments)).toBe(true);
    expect(body.pagination).toBeDefined();
  });
});

describe("Vercel Blob", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  describe("authentication", () => {
    it("rejects requests without auth", async () => {
      const res = await app.request(`${base}/api/blob?pathname=test.txt`, {
        method: "PUT",
        headers: { "x-vercel-blob-access": "public" },
        body: "hello",
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe("blob_access_error");
    });

    it("accepts vercel_blob_rw_ tokens", async () => {
      const res = await app.request(`${base}/api/blob?pathname=test.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public" },
        body: "hello",
      });
      expect(res.status).toBe(200);
    });

    it("accepts generic tokens from token map", async () => {
      const res = await app.request(`${base}/api/blob?pathname=test.txt`, {
        method: "PUT",
        headers: { ...blobHeaders("test-token"), "x-vercel-blob-access": "public" },
        body: "hello",
      });
      expect(res.status).toBe(200);
    });
  });

  describe("PUT /api/blob", () => {
    it("uploads a blob and returns metadata", async () => {
      const res = await app.request(`${base}/api/blob?pathname=docs/hello.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public" },
        body: "hello world",
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.pathname).toContain("docs/hello");
      expect(json.pathname).toContain(".txt");
      expect(json.contentType).toBe("text/plain");
      expect(json.url).toContain("teststore/public/");
      expect(json.downloadUrl).toContain("?download=1");
      expect(json.etag).toMatch(/^"[a-f0-9]+"$/);
    });

    it("applies random suffix by default", async () => {
      const res = await app.request(`${base}/api/blob?pathname=file.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public" },
        body: "data",
      });
      const json = await res.json();
      expect(json.pathname).toMatch(/^file-[A-Za-z0-9]{6}\.txt$/);
    });

    it("skips random suffix when x-add-random-suffix is 0", async () => {
      const res = await app.request(`${base}/api/blob?pathname=exact.txt`, {
        method: "PUT",
        headers: {
          ...blobHeaders(),
          "x-vercel-blob-access": "public",
          "x-add-random-suffix": "0",
        },
        body: "data",
      });
      const json = await res.json();
      expect(json.pathname).toBe("exact.txt");
    });

    it("uses x-content-type header when provided", async () => {
      const res = await app.request(`${base}/api/blob?pathname=data.bin`, {
        method: "PUT",
        headers: {
          ...blobHeaders(),
          "x-vercel-blob-access": "public",
          "x-content-type": "application/json",
          "x-add-random-suffix": "0",
        },
        body: '{"key":"value"}',
      });
      const json = await res.json();
      expect(json.contentType).toBe("application/json");
    });

    it("infers content type from extension", async () => {
      const res = await app.request(`${base}/api/blob?pathname=image.png`, {
        method: "PUT",
        headers: {
          ...blobHeaders(),
          "x-vercel-blob-access": "public",
          "x-add-random-suffix": "0",
        },
        body: "fake png data",
      });
      const json = await res.json();
      expect(json.contentType).toBe("image/png");
    });

    it("uses generic store ID for non-rw tokens", async () => {
      const res = await app.request(`${base}/api/blob?pathname=test.txt`, {
        method: "PUT",
        headers: {
          ...blobHeaders("test-token"),
          "x-vercel-blob-access": "public",
          "x-add-random-suffix": "0",
        },
        body: "data",
      });
      const json = await res.json();
      expect(json.url).toContain("default/public/");
    });

    it("creates a folder with trailing slash pathname", async () => {
      const res = await app.request(`${base}/api/blob?pathname=my-folder/`, {
        method: "PUT",
        headers: {
          ...blobHeaders(),
          "x-vercel-blob-access": "public",
          "x-add-random-suffix": "0",
        },
        body: "",
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.pathname).toBe("my-folder/");
      expect(json.contentType).toBe("application/x-directory");
    });
  });

  describe("GET /api/blob (head)", () => {
    it("returns blob metadata by URL", async () => {
      const putRes = await app.request(`${base}/api/blob?pathname=meta.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "metadata test",
      });
      const { url } = await putRes.json();

      const res = await app.request(`${base}/api/blob?url=${encodeURIComponent(url)}`, {
        headers: blobHeaders(),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.pathname).toBe("meta.txt");
      expect(json.size).toBe(13);
      expect(json.contentType).toBe("text/plain");
      expect(json.url).toBe(url);
      expect(json.uploadedAt).toBeDefined();
    });

    it("returns 404 for unknown blob", async () => {
      const res = await app.request(`${base}/api/blob?url=${encodeURIComponent(`${base}/no/such/blob`)}`, {
        headers: blobHeaders(),
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe("blob_not_found");
    });
  });

  describe("POST /api/blob/delete", () => {
    it("deletes blobs by URL", async () => {
      const putRes = await app.request(`${base}/api/blob?pathname=to-delete.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "delete me",
      });
      const { url } = await putRes.json();

      const delRes = await app.request(`${base}/api/blob/delete`, {
        method: "POST",
        headers: { ...blobHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ urls: [url] }),
      });
      expect(delRes.status).toBe(200);

      const headRes = await app.request(`${base}/api/blob?url=${encodeURIComponent(url)}`, {
        headers: blobHeaders(),
      });
      expect(headRes.status).toBe(404);
    });

    it("silently skips unknown URLs", async () => {
      const res = await app.request(`${base}/api/blob/delete`, {
        method: "POST",
        headers: { ...blobHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ urls: [`${base}/no/such/blob`] }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("GET /api/blob (list)", () => {
    async function seedBlobs() {
      const paths = ["a.txt", "b.txt", "dir/c.txt", "dir/d.txt", "dir/sub/e.txt"];
      for (const p of paths) {
        await app.request(`${base}/api/blob?pathname=${p}`, {
          method: "PUT",
          headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
          body: `content of ${p}`,
        });
      }
    }

    it("lists all blobs", async () => {
      await seedBlobs();
      const res = await app.request(`${base}/api/blob`, { headers: blobHeaders() });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.blobs).toHaveLength(5);
      expect(json.hasMore).toBe(false);
    });

    it("filters by prefix", async () => {
      await seedBlobs();
      const res = await app.request(`${base}/api/blob?prefix=dir/`, { headers: blobHeaders() });
      const json = await res.json();
      expect(json.blobs).toHaveLength(3);
      expect(json.blobs.every((b: any) => b.pathname.startsWith("dir/"))).toBe(true);
    });

    it("paginates with limit and cursor", async () => {
      await seedBlobs();
      const res1 = await app.request(`${base}/api/blob?limit=2`, { headers: blobHeaders() });
      const json1 = await res1.json();
      expect(json1.blobs).toHaveLength(2);
      expect(json1.hasMore).toBe(true);
      expect(json1.cursor).toBeDefined();

      const res2 = await app.request(`${base}/api/blob?limit=2&cursor=${json1.cursor}`, { headers: blobHeaders() });
      const json2 = await res2.json();
      expect(json2.blobs).toHaveLength(2);

      const res3 = await app.request(`${base}/api/blob?limit=2&cursor=${json2.cursor}`, { headers: blobHeaders() });
      const json3 = await res3.json();
      expect(json3.blobs).toHaveLength(1);
      expect(json3.hasMore).toBe(false);
    });

    it("returns folders in folded mode", async () => {
      await seedBlobs();
      const res = await app.request(`${base}/api/blob?mode=folded`, { headers: blobHeaders() });
      const json = await res.json();
      expect(json.blobs.map((b: any) => b.pathname)).toEqual(["a.txt", "b.txt"]);
      expect(json.folders).toEqual(["dir/"]);
    });

    it("returns folders in folded mode with prefix", async () => {
      await seedBlobs();
      const res = await app.request(`${base}/api/blob?mode=folded&prefix=dir/`, { headers: blobHeaders() });
      const json = await res.json();
      expect(json.blobs.map((b: any) => b.pathname)).toEqual(["dir/c.txt", "dir/d.txt"]);
      expect(json.folders).toEqual(["dir/sub/"]);
    });
  });

  describe("PUT /api/blob (copy)", () => {
    it("copies a blob to a new pathname", async () => {
      const putRes = await app.request(`${base}/api/blob?pathname=original.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "copy me",
      });
      const { url: fromUrl } = await putRes.json();

      const copyRes = await app.request(
        `${base}/api/blob?pathname=copied.txt&fromUrl=${encodeURIComponent(fromUrl)}`,
        {
          method: "PUT",
          headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        }
      );
      expect(copyRes.status).toBe(200);
      const json = await copyRes.json();
      expect(json.pathname).toBe("copied.txt");
      expect(json.contentType).toBe("text/plain");
    });

    it("returns 404 when source blob does not exist", async () => {
      const res = await app.request(
        `${base}/api/blob?pathname=dest.txt&fromUrl=${encodeURIComponent(`${base}/no/such/blob`)}`,
        {
          method: "PUT",
          headers: { ...blobHeaders(), "x-vercel-blob-access": "public" },
        }
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /:storeId/:access/* (download)", () => {
    it("serves blob content", async () => {
      const putRes = await app.request(`${base}/api/blob?pathname=download.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "file content here",
      });
      const { url } = await putRes.json();

      const res = await app.request(url);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("file content here");
      expect(res.headers.get("content-type")).toBe("text/plain");
      expect(res.headers.get("etag")).toMatch(/^"[a-f0-9]+"$/);
    });

    it("returns 304 for matching If-None-Match", async () => {
      const putRes = await app.request(`${base}/api/blob?pathname=cached.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "cached content",
      });
      const { etag, url } = await putRes.json();

      const res = await app.request(url, {
        headers: { "if-none-match": etag },
      });
      expect(res.status).toBe(304);
    });

    it("sets attachment disposition with ?download=1", async () => {
      const putRes = await app.request(`${base}/api/blob?pathname=attach.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "download me",
      });
      const { downloadUrl } = await putRes.json();

      const res = await app.request(downloadUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
    });

    it("requires auth for private blobs", async () => {
      const putRes = await app.request(`${base}/api/blob?pathname=secret.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "private", "x-add-random-suffix": "0" },
        body: "secret",
      });
      const { url } = await putRes.json();

      const res = await app.request(url);
      expect(res.status).toBe(403);

      const authedRes = await app.request(url, { headers: blobHeaders() });
      expect(authedRes.status).toBe(200);
    });

    it("returns 404 for non-blob paths", async () => {
      const res = await app.request(`${base}/teststore/public/nonexistent.txt`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/blob/mpu (multipart)", () => {
    it("completes a full multipart upload flow", async () => {
      const createRes = await app.request(`${base}/api/blob/mpu?pathname=big-file.bin`, {
        method: "POST",
        headers: {
          ...blobHeaders(),
          "x-mpu-action": "create",
          "x-vercel-blob-access": "public",
          "x-add-random-suffix": "0",
        },
      });
      expect(createRes.status).toBe(200);
      const { uploadId, key } = await createRes.json();
      expect(uploadId).toBeDefined();
      expect(key).toBeDefined();

      const part1 = await app.request(`${base}/api/blob/mpu?pathname=big-file.bin`, {
        method: "POST",
        headers: {
          ...blobHeaders(),
          "x-mpu-action": "upload",
          "x-mpu-upload-id": uploadId,
          "x-mpu-key": key,
          "x-mpu-part-number": "1",
        },
        body: "part one data ",
      });
      expect(part1.status).toBe(200);
      const p1 = await part1.json();
      expect(p1.etag).toBeDefined();

      const part2 = await app.request(`${base}/api/blob/mpu?pathname=big-file.bin`, {
        method: "POST",
        headers: {
          ...blobHeaders(),
          "x-mpu-action": "upload",
          "x-mpu-upload-id": uploadId,
          "x-mpu-key": key,
          "x-mpu-part-number": "2",
        },
        body: "part two data",
      });
      expect(part2.status).toBe(200);
      const p2 = await part2.json();

      const completeRes = await app.request(`${base}/api/blob/mpu?pathname=big-file.bin`, {
        method: "POST",
        headers: {
          ...blobHeaders(),
          "x-mpu-action": "complete",
          "x-mpu-upload-id": uploadId,
          "x-mpu-key": key,
          "content-type": "application/json",
        },
        body: JSON.stringify([
          { etag: p1.etag, partNumber: 1 },
          { etag: p2.etag, partNumber: 2 },
        ]),
      });
      expect(completeRes.status).toBe(200);
      const result = await completeRes.json();
      expect(result.pathname).toBe("big-file.bin");
      expect(result.url).toContain("teststore/public/big-file.bin");

      const dlRes = await app.request(result.url);
      expect(dlRes.status).toBe(200);
      expect(await dlRes.text()).toBe("part one data part two data");
    });
  });

  describe("overwrite + conditional operations", () => {
    it("blocks overwrite by default when no random suffix", async () => {
      await app.request(`${base}/api/blob?pathname=ow.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "first",
      });
      const res = await app.request(`${base}/api/blob?pathname=ow.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "second",
      });
      expect(res.status).toBe(409);
    });

    it("allows overwrite with x-allow-overwrite", async () => {
      await app.request(`${base}/api/blob?pathname=ow2.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "first",
      });
      const res = await app.request(`${base}/api/blob?pathname=ow2.txt`, {
        method: "PUT",
        headers: {
          ...blobHeaders(),
          "x-vercel-blob-access": "public",
          "x-add-random-suffix": "0",
          "x-allow-overwrite": "1",
        },
        body: "second",
      });
      expect(res.status).toBe(200);
    });

    it("returns 412 on ETag mismatch for put", async () => {
      await app.request(`${base}/api/blob?pathname=cond.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "original",
      });
      const res = await app.request(`${base}/api/blob?pathname=cond.txt`, {
        method: "PUT",
        headers: {
          ...blobHeaders(),
          "x-vercel-blob-access": "public",
          "x-add-random-suffix": "0",
          "x-allow-overwrite": "1",
          "x-if-match": '"wrong-etag"',
        },
        body: "updated",
      });
      expect(res.status).toBe(412);
    });

    it("succeeds on ETag match for put", async () => {
      const putRes = await app.request(`${base}/api/blob?pathname=cond2.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "original",
      });
      const { etag } = await putRes.json();
      const res = await app.request(`${base}/api/blob?pathname=cond2.txt`, {
        method: "PUT",
        headers: {
          ...blobHeaders(),
          "x-vercel-blob-access": "public",
          "x-add-random-suffix": "0",
          "x-allow-overwrite": "1",
          "x-if-match": etag,
        },
        body: "updated",
      });
      expect(res.status).toBe(200);
    });

    it("returns 412 on ETag mismatch for delete", async () => {
      const putRes = await app.request(`${base}/api/blob?pathname=cond-del.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "delete me",
      });
      const { url } = await putRes.json();
      const res = await app.request(`${base}/api/blob/delete`, {
        method: "POST",
        headers: { ...blobHeaders(), "content-type": "application/json", "x-if-match": '"wrong"' },
        body: JSON.stringify({ urls: [url] }),
      });
      expect(res.status).toBe(412);
    });
  });

  describe("seed configuration", () => {
    it("seeds blobs from config", async () => {
      const seededApp = (() => {
        const s = new Store();
        const w = new WebhookDispatcher();
        const tm: TokenMap = new Map();
        const a = new Hono();
        a.onError(createApiErrorHandler());
        a.use("*", createErrorHandler());
        a.use("*", authMiddleware(tm));
        vercelPlugin.register(a, s, w, base, tm);
        vercelPlugin.seed?.(s, base);
        seedFromConfig(s, base, {
          blob_stores: [
            {
              store_id: "seedstore",
              token: "vercel_blob_rw_seedstore_secret",
              access: "public" as const,
              blobs: [
                { pathname: "seeded.txt", content: "seeded content", content_type: "text/plain" },
                { pathname: "seeded.bin", content_base64: Buffer.from("binary data").toString("base64"), content_type: "application/octet-stream" },
              ],
            },
          ],
        }, tm);
        return a;
      })();

      const res = await seededApp.request(`${base}/api/blob`, {
        headers: { Authorization: "Bearer vercel_blob_rw_seedstore_secret" },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.blobs).toHaveLength(2);
      expect(json.blobs.map((b: any) => b.pathname).sort()).toEqual(["seeded.bin", "seeded.txt"]);
    });
  });

  describe("POST /api/blob/handle-blob-upload (client tokens)", () => {
    it("generates a client token and uses it to upload", async () => {
      await app.request(`${base}/api/blob?pathname=warmup.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "warmup",
      });

      const genRes = await app.request(`${base}/api/blob/handle-blob-upload`, {
        method: "POST",
        headers: { ...blobHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          type: "blob.generate-client-token",
          payload: {
            pathname: "client-upload.txt",
            callbackUrl: `${base}/api/blob/handle-blob-upload`,
            multipart: false,
            clientPayload: null,
          },
        }),
      });
      expect(genRes.status).toBe(200);
      const genJson = await genRes.json();
      expect(genJson.type).toBe("blob.generate-client-token");
      expect(genJson.clientToken).toMatch(/^vercel_blob_client_/);

      const uploadRes = await app.request(`${base}/api/blob?pathname=client-upload.txt`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${genJson.clientToken}`,
          "x-vercel-blob-access": "public",
          "x-add-random-suffix": "0",
        },
        body: "client uploaded content",
      });
      expect(uploadRes.status).toBe(200);
      const uploadJson = await uploadRes.json();
      expect(uploadJson.pathname).toBe("client-upload.txt");
    });

    it("acknowledges upload-completed callback", async () => {
      const res = await app.request(`${base}/api/blob/handle-blob-upload`, {
        method: "POST",
        headers: { ...blobHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          type: "blob.upload-completed",
          payload: { blob: { url: "http://example.com/blob" }, tokenPayload: null },
        }),
      });
      expect(res.status).toBe(200);
    });

    it("rejects expired client token", async () => {
      await app.request(`${base}/api/blob?pathname=warmup2.txt`, {
        method: "PUT",
        headers: { ...blobHeaders(), "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "warmup",
      });

      const genRes = await app.request(`${base}/api/blob/handle-blob-upload`, {
        method: "POST",
        headers: { ...blobHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          type: "blob.generate-client-token",
          payload: {
            pathname: "expired.txt",
            callbackUrl: `${base}/api/blob/handle-blob-upload`,
            validUntil: 0,
          },
        }),
      });
      const { clientToken } = await genRes.json();

      const res = await app.request(`${base}/api/blob?pathname=expired.txt`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${clientToken}`,
          "x-vercel-blob-access": "public",
          "x-add-random-suffix": "0",
        },
        body: "should fail",
      });
      expect(res.status).toBe(403);
    });
  });
});
