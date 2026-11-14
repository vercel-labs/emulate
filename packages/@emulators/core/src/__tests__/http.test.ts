import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { Agent, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono, cors, serve } from "../http.js";

describe("HTTP listener", () => {
  it.each([
    { hostname: undefined, address: "127.0.0.1" },
    { hostname: "0.0.0.0", address: "0.0.0.0" },
  ])("binds to $address with hostname $hostname", async ({ hostname, address }) => {
    const server = serve({ fetch: () => new Response("ready"), port: 0, hostname });
    try {
      await once(server, "listening");
      const bound = server.address() as AddressInfo;
      expect(bound.address).toBe(address);
      expect(await (await fetch(`http://localhost:${bound.port}`)).text()).toBe("ready");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });

  it("closes the connection when a streamed response errors while the request body is unread", async () => {
    const parts = ["first|", "second|", "third|"];
    const encoder = new TextEncoder();
    const server = serve({
      port: 0,
      fetch: () => {
        let index = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (index < parts.length) {
              controller.enqueue(encoder.encode(parts[index]));
              index += 1;
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
            controller.error(new Error("stream failed"));
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/plain" } });
      },
    });
    try {
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;

      const result = await postIgnoredBody(port, 512 * 1024);

      try {
        expect(result.text).toBe(parts.join(""));
        expect(result.complete).toBe(false);
        expect(await waitForConnections(server, 0, 1000)).toBe(0);
      } finally {
        result.cleanup();
      }
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  it("delivers headers and queued chunks before tearing down a stream that errors immediately", async () => {
    const encoder = new TextEncoder();
    const server = serve({
      port: 0,
      fetch: () => {
        let sent = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent < 2) {
                sent += 1;
                controller.enqueue(encoder.encode(`frame${sent}|`));
                return;
              }
              controller.error(new Error("stream failed"));
            },
          }),
        );
      },
    });
    try {
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;

      const received = await new Promise<{ text: string; failed: boolean }>((resolve, reject) => {
        const req = httpRequest({ port, host: "127.0.0.1", agent: false }, (res) => {
          let text = "";
          res.on("data", (data: Buffer) => (text += data.toString()));
          res.on("error", () => resolve({ text, failed: true }));
          res.on("aborted", () => resolve({ text, failed: true }));
          res.on("end", () => resolve({ text, failed: false }));
        });
        req.on("error", reject);
        req.end();
      });

      expect(received).toEqual({ text: "frame1|frame2|", failed: true });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  it("aborts the request signal and cancels the body when a write fails", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x42);
    let signal: AbortSignal | undefined;
    let streamCancelled = false;
    const server = serve({
      port: 0,
      abortOnClose: true,
      fetch: (request) => {
        signal = request.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(chunk);
            },
            cancel() {
              streamCancelled = true;
            },
          }),
        );
      },
    });
    try {
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;

      await readThenDestroy(port, 1024 * 1024);

      expect(await waitFor(() => signal?.aborted === true, 2000)).toBe(true);
      expect(await waitFor(() => streamCancelled, 2000)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  it("cancels the body stream when a client destroys its socket without abortOnClose", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x43);
    let produced = 0;
    let producedAtCancel = -1;
    let cancelled = false;
    const server = serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              produced += 1;
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
              producedAtCancel = produced;
            },
          }),
        ),
    });
    try {
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;

      await readThenDestroy(port, 1024 * 1024);

      expect(await waitFor(() => cancelled, 2000)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(produced).toBe(producedAtCancel);
      expect(await waitForConnections(server, 0, 1000)).toBe(0);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  it.each([{ abortOnClose: false }, { abortOnClose: true }])(
    "delivers a large body to a slow reader intact with abortOnClose $abortOnClose",
    async ({ abortOnClose }) => {
      const chunkSize = 64 * 1024;
      const chunkCount = 128;
      const chunks: Uint8Array[] = [];
      const expected = createHash("sha256");
      for (let index = 0; index < chunkCount; index++) {
        const chunk = new Uint8Array(chunkSize);
        chunk.fill(index & 0xff);
        new DataView(chunk.buffer).setUint32(0, index);
        chunks.push(chunk);
        expected.update(chunk);
      }
      let signal: AbortSignal | undefined;
      const server = serve({
        port: 0,
        abortOnClose,
        fetch: (request) => {
          signal = request.signal;
          let index = 0;
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (index >= chunks.length) {
                  controller.close();
                  return;
                }
                controller.enqueue(chunks[index]);
                index += 1;
              },
            }),
          );
        },
      });
      try {
        await once(server, "listening");
        const { port } = server.address() as AddressInfo;

        const result = await readSlowly(port);

        expect(result.bytes).toBe(chunkSize * chunkCount);
        expect(result.digest).toBe(expected.digest("hex"));
        expect(await waitFor(() => signal?.aborted === true, 200)).toBe(false);
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    },
  );
});

describe("internal http layer", () => {
  it("dispatches middleware and route handlers with params", async () => {
    const app = new Hono();
    const calls: string[] = [];

    app.use("*", async (c, next) => {
      calls.push(`before:${c.req.method}`);
      c.set("seen", "yes");
      await next();
      calls.push("after");
    });
    app.get("/repos/:owner/:repo/git/ref/:ref{.+}", (c) => {
      calls.push(c.get("seen"));
      return c.json({
        owner: c.req.param("owner"),
        repo: c.req.param("repo"),
        ref: c.req.param("ref"),
      });
    });

    const res = await app.request("/repos/acme/widgets/git/ref/heads/main");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ owner: "acme", repo: "widgets", ref: "heads/main" });
    expect(calls).toEqual(["before:GET", "yes", "after"]);
  });

  it("respects explicit content type headers", async () => {
    const app = new Hono();
    app.get("/object", (c) => c.text("hello", 200, { "Content-Type": "text/plain" }));

    const res = await app.request("/object");

    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  it("prefers explicit HEAD routes over GET fallback", async () => {
    const app = new Hono();
    app.get("/object", (c) => c.text("get", 200, { "X-Handler": "get" }));
    app.on("HEAD", "/object", (c) => c.body(null, 200, { "X-Handler": "head" }));

    const res = await app.request("/object", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Handler")).toBe("head");
  });

  it("falls back to GET routes for HEAD requests", async () => {
    const app = new Hono();
    app.get("/object", (c) => c.text("get", 200, { "X-Handler": "get" }));

    const res = await app.request("/object", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Handler")).toBe("get");
  });

  it("handles CORS preflight requests", async () => {
    const app = new Hono();
    app.use("*", cors({ allowMethods: ["GET"], allowHeaders: ["x-test"], maxAge: 60 }));
    app.get("/items", (c) => c.json([]));

    const res = await app.request("/items", { method: "OPTIONS" });

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("x-test");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("60");
  });
});

/** POSTs a body the handler never reads and reports what the response stream delivered. */
function postIgnoredBody(
  port: number,
  bytes: number,
): Promise<{ text: string; complete: boolean; cleanup: () => void }> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    const agent = new Agent({ keepAlive: true });
    let responded = false;
    let settled = false;
    const settle = (complete: boolean) => {
      if (settled) return;
      settled = true;
      resolve({
        text: Buffer.concat(parts).toString(),
        complete,
        cleanup: () => {
          request.destroy();
          agent.destroy();
        },
      });
    };
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/",
        agent,
        headers: { "Content-Length": String(bytes), "Content-Type": "application/octet-stream" },
      },
      (response) => {
        responded = true;
        response.on("data", (chunk: Buffer) => parts.push(chunk));
        response.on("end", () => settle(response.complete));
        response.on("error", () => settle(false));
        response.on("close", () => settle(false));
      },
    );
    request.on("error", () => {
      if (!responded) settle(false);
    });
    request.end(Buffer.alloc(bytes, 0x41));
  });
}

/** Polls the server until it reports the expected connection count or the deadline passes. */
async function waitForConnections(server: Server, expected: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = await countConnections(server);
  while (count !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    count = await countConnections(server);
  }
  return count;
}

/** Requests the path, destroys the client socket after reading the given number of bytes, and settles. */
function readThenDestroy(port: number, bytes: number): Promise<void> {
  return new Promise((resolve) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: "/", agent: false }, (response) => {
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received >= bytes) {
          response.destroy();
          request.destroy();
          resolve();
        }
      });
    });
    request.on("error", () => resolve());
    request.end();
  });
}

/** Reads the response while pausing between chunks and returns the byte count and SHA-256 digest. */
function readSlowly(port: number): Promise<{ bytes: number; digest: string }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    const request = httpRequest({ host: "127.0.0.1", port, path: "/", agent: false }, (response) => {
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        hash.update(chunk);
        response.pause();
        setTimeout(() => response.resume(), 2);
      });
      response.on("end", () => resolve({ bytes, digest: hash.digest("hex") }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function countConnections(server: Server): Promise<number> {
  return new Promise((resolve, reject) =>
    server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
  );
}

describe("error status rendering", () => {
  it("answers a 500 with the thrown message when the status cannot be sent", async () => {
    for (const status of [600, 0, -1, 204, 304, 401.5, Number.NaN, "404"]) {
      const app = new Hono();
      app.get("/", () => {
        throw Object.assign(new Error("boom"), { status });
      });

      const res = await app.request("/");

      expect(res.status).toBe(500);
      expect(await res.text()).toBe("boom");
    }
  });
});
