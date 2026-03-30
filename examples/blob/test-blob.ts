/**
 * Integration test for the Vercel Blob emulator.
 *
 * Usage:
 *   cd /path/to/emulate
 *   pnpm build
 *   npx tsx examples/blob/test-blob.ts
 */

const BASE = "http://localhost:4000";
const TOKEN = "vercel_blob_rw_mystore_secret123";

const headers = {
  Authorization: `Bearer ${TOKEN}`,
};

let passed = 0;
let failed = 0;

async function assert(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err: any) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${err.message}`);
  }
}

function eq(actual: unknown, expected: unknown, label = "") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  // Start emulator
  const { createEmulator } = await import("../../packages/emulate/dist/api.js");
  const emu = await createEmulator({ service: "vercel", port: 4000 });
  console.log(`\nEmulator running at ${emu.url}\n`);

  try {
    // -----------------------------------------------------------------------
    console.log("PUT (upload)");
    // -----------------------------------------------------------------------

    await assert("uploads a blob", async () => {
      const res = await fetch(`${BASE}/api/blob?pathname=hello.txt`, {
        method: "PUT",
        headers: { ...headers, "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "Hello from the emulator!",
      });
      eq(res.status, 200, "status");
      const json = await res.json();
      eq(json.pathname, "hello.txt", "pathname");
      eq(json.contentType, "text/plain", "contentType");
      eq(json.url.includes("mystore/public/hello.txt"), true, "url");
    });

    await assert("applies random suffix by default", async () => {
      const res = await fetch(`${BASE}/api/blob?pathname=random.txt`, {
        method: "PUT",
        headers: { ...headers, "x-vercel-blob-access": "public" },
        body: "data",
      });
      const json = await res.json();
      eq(/^random-[A-Za-z0-9]{6}\.txt$/.test(json.pathname), true, "pathname has suffix");
    });

    await assert("creates a folder", async () => {
      const res = await fetch(`${BASE}/api/blob?pathname=my-folder/`, {
        method: "PUT",
        headers: { ...headers, "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
      });
      const json = await res.json();
      eq(json.pathname, "my-folder/", "pathname");
      eq(json.contentType, "application/x-directory", "contentType");
    });

    // -----------------------------------------------------------------------
    console.log("\nHEAD (metadata)");
    // -----------------------------------------------------------------------

    await assert("returns blob metadata", async () => {
      const res = await fetch(`${BASE}/api/blob?url=${encodeURIComponent(`${BASE}/mystore/public/hello.txt`)}`, {
        headers,
      });
      eq(res.status, 200, "status");
      const json = await res.json();
      eq(json.pathname, "hello.txt", "pathname");
      eq(json.size, 24, "size");
      eq(json.contentType, "text/plain", "contentType");
    });

    await assert("returns 404 for unknown blob", async () => {
      const res = await fetch(`${BASE}/api/blob?url=${encodeURIComponent(`${BASE}/mystore/public/nope.txt`)}`, {
        headers,
      });
      eq(res.status, 404, "status");
    });

    // -----------------------------------------------------------------------
    console.log("\nLIST");
    // -----------------------------------------------------------------------

    await assert("lists blobs", async () => {
      const res = await fetch(`${BASE}/api/blob`, { headers });
      const json = await res.json();
      eq(json.blobs.length >= 2, true, "has blobs");
      eq(json.hasMore, false, "hasMore");
    });

    await assert("filters by prefix", async () => {
      const res = await fetch(`${BASE}/api/blob?prefix=my-folder`, { headers });
      const json = await res.json();
      eq(json.blobs.length, 1, "count");
    });

    await assert("folded mode returns folders", async () => {
      // Add a nested blob first
      await fetch(`${BASE}/api/blob?pathname=nested/deep/file.txt`, {
        method: "PUT",
        headers: { ...headers, "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "nested",
      });
      const res = await fetch(`${BASE}/api/blob?mode=folded`, { headers });
      const json = await res.json();
      eq(Array.isArray(json.folders), true, "has folders array");
      eq(json.folders.includes("nested/"), true, "includes nested/");
    });

    // -----------------------------------------------------------------------
    console.log("\nCOPY");
    // -----------------------------------------------------------------------

    await assert("copies a blob", async () => {
      const fromUrl = `${BASE}/mystore/public/hello.txt`;
      const res = await fetch(`${BASE}/api/blob?pathname=hello-copy.txt&fromUrl=${encodeURIComponent(fromUrl)}`, {
        method: "PUT",
        headers: { ...headers, "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
      });
      eq(res.status, 200, "status");
      const json = await res.json();
      eq(json.pathname, "hello-copy.txt", "pathname");
    });

    // -----------------------------------------------------------------------
    console.log("\nDOWNLOAD (content serving)");
    // -----------------------------------------------------------------------

    await assert("serves blob content", async () => {
      const res = await fetch(`${BASE}/mystore/public/hello.txt`);
      eq(res.status, 200, "status");
      eq(await res.text(), "Hello from the emulator!", "body");
      eq(res.headers.get("content-type"), "text/plain", "content-type");
    });

    await assert("304 on matching ETag", async () => {
      const head = await fetch(`${BASE}/api/blob?url=${encodeURIComponent(`${BASE}/mystore/public/hello.txt`)}`, {
        headers,
      });
      const { etag } = await head.json();

      const res = await fetch(`${BASE}/mystore/public/hello.txt`, {
        headers: { "if-none-match": etag },
      });
      eq(res.status, 304, "status");
    });

    await assert("private blobs require auth", async () => {
      await fetch(`${BASE}/api/blob?pathname=secret.txt`, {
        method: "PUT",
        headers: { ...headers, "x-vercel-blob-access": "private", "x-add-random-suffix": "0" },
        body: "secret data",
      });

      const noAuth = await fetch(`${BASE}/mystore/private/secret.txt`);
      eq(noAuth.status, 403, "no auth → 403");

      const withAuth = await fetch(`${BASE}/mystore/private/secret.txt`, { headers });
      eq(withAuth.status, 200, "with auth → 200");
      eq(await withAuth.text(), "secret data", "body");
    });

    // -----------------------------------------------------------------------
    console.log("\nOVERWRITE + CONDITIONAL");
    // -----------------------------------------------------------------------

    await assert("blocks overwrite by default", async () => {
      const res = await fetch(`${BASE}/api/blob?pathname=hello.txt`, {
        method: "PUT",
        headers: { ...headers, "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "overwrite attempt",
      });
      eq(res.status, 409, "status");
    });

    await assert("allows overwrite with header", async () => {
      const res = await fetch(`${BASE}/api/blob?pathname=hello.txt`, {
        method: "PUT",
        headers: { ...headers, "x-vercel-blob-access": "public", "x-add-random-suffix": "0", "x-allow-overwrite": "1" },
        body: "overwritten!",
      });
      eq(res.status, 200, "status");
    });

    await assert("412 on ETag mismatch", async () => {
      const res = await fetch(`${BASE}/api/blob?pathname=hello.txt`, {
        method: "PUT",
        headers: {
          ...headers,
          "x-vercel-blob-access": "public",
          "x-add-random-suffix": "0",
          "x-allow-overwrite": "1",
          "x-if-match": '"bad-etag"',
        },
        body: "should fail",
      });
      eq(res.status, 412, "status");
    });

    // -----------------------------------------------------------------------
    console.log("\nDELETE");
    // -----------------------------------------------------------------------

    await assert("deletes a blob", async () => {
      const url = `${BASE}/mystore/public/hello-copy.txt`;
      const res = await fetch(`${BASE}/api/blob/delete`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ urls: [url] }),
      });
      eq(res.status, 200, "status");

      const head = await fetch(`${BASE}/api/blob?url=${encodeURIComponent(url)}`, { headers });
      eq(head.status, 404, "gone after delete");
    });

    // -----------------------------------------------------------------------
    console.log("\nMULTIPART UPLOAD");
    // -----------------------------------------------------------------------

    await assert("full multipart flow", async () => {
      // Create
      const createRes = await fetch(`${BASE}/api/blob/mpu?pathname=big.bin`, {
        method: "POST",
        headers: { ...headers, "x-mpu-action": "create", "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
      });
      eq(createRes.status, 200, "create status");
      const { uploadId, key } = await createRes.json();

      // Upload parts
      const p1Res = await fetch(`${BASE}/api/blob/mpu?pathname=big.bin`, {
        method: "POST",
        headers: { ...headers, "x-mpu-action": "upload", "x-mpu-upload-id": uploadId, "x-mpu-key": key, "x-mpu-part-number": "1" },
        body: "AAAA",
      });
      const p1 = await p1Res.json();

      const p2Res = await fetch(`${BASE}/api/blob/mpu?pathname=big.bin`, {
        method: "POST",
        headers: { ...headers, "x-mpu-action": "upload", "x-mpu-upload-id": uploadId, "x-mpu-key": key, "x-mpu-part-number": "2" },
        body: "BBBB",
      });
      const p2 = await p2Res.json();

      // Complete
      const completeRes = await fetch(`${BASE}/api/blob/mpu?pathname=big.bin`, {
        method: "POST",
        headers: { ...headers, "x-mpu-action": "complete", "x-mpu-upload-id": uploadId, "x-mpu-key": key, "content-type": "application/json" },
        body: JSON.stringify([{ etag: p1.etag, partNumber: 1 }, { etag: p2.etag, partNumber: 2 }]),
      });
      eq(completeRes.status, 200, "complete status");
      const blob = await completeRes.json();

      // Verify content
      const dl = await fetch(blob.url);
      eq(await dl.text(), "AAAABBBB", "concatenated content");
    });

    // -----------------------------------------------------------------------
    console.log("\nCLIENT TOKENS");
    // -----------------------------------------------------------------------

    await assert("generate token + upload with it", async () => {
      const genRes = await fetch(`${BASE}/api/blob/handle-blob-upload`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          type: "blob.generate-client-token",
          payload: { pathname: "client.txt", callbackUrl: `${BASE}/api/blob/handle-blob-upload` },
        }),
      });
      eq(genRes.status, 200, "gen status");
      const { clientToken } = await genRes.json();
      eq(clientToken.startsWith("vercel_blob_client_"), true, "token format");

      const uploadRes = await fetch(`${BASE}/api/blob?pathname=client.txt`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${clientToken}`, "x-vercel-blob-access": "public", "x-add-random-suffix": "0" },
        body: "client content",
      });
      eq(uploadRes.status, 200, "upload status");
      const blob = await uploadRes.json();
      eq(blob.pathname, "client.txt", "pathname");
    });

    // -----------------------------------------------------------------------
    console.log("\nRESET");
    // -----------------------------------------------------------------------

    await assert("reset clears all blobs", async () => {
      emu.reset();
      const res = await fetch(`${BASE}/api/blob`, { headers });
      const json = await res.json();
      eq(json.blobs.length, 0, "empty after reset");
    });

  } finally {
    await emu.close();
  }

  // -----------------------------------------------------------------------
  console.log(`\n\x1b[${failed ? 31 : 32}m${passed} passed, ${failed} failed\x1b[0m\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
