import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { connectRuntime, selectRuntime, startRuntime, waitForHttp } from "../src/harness.mjs";

test("selectRuntime defaults to the TypeScript runtime", () => {
  assert.equal(selectRuntime({}), "typescript");
  assert.equal(selectRuntime({ EMULATE_TARGET_URL: "http://127.0.0.1:4000" }), "external");
  assert.equal(selectRuntime({ EMULATE_SDK_RUNTIME: "go" }), "go");
});

test("connectRuntime returns an external target handle", async () => {
  const target = connectRuntime({ url: "http://127.0.0.1:65535/", service: "github" });
  assert.equal(target.runtime, "external");
  assert.equal(target.service, "github");
  assert.equal(target.baseUrl, "http://127.0.0.1:65535");
  assert.equal(target.child, null);
  await target.stop();
});

test("TypeScript runtime starts and serves the GitHub rate limit route", async (t) => {
  const target = await startRuntime({ runtime: "typescript", service: "github", readinessPath: "/rate_limit" });
  t.after(async () => {
    await target.stop();
  });

  const response = await fetch(new URL("/rate_limit", `${target.baseUrl}/`));
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.rate.resource, "core");
  assert.equal(body.resources.core.limit, 5000);
});

test("waitForHttp applies the request timeout while reading the response body", async (t) => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
    socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\npartial");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  t.after(() => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
  });

  const address = server.address();
  assert(address && typeof address !== "string");

  await assert.rejects(
    () =>
      waitForHttp(`http://127.0.0.1:${address.port}/ready`, {
        intervalMs: 5,
        requestTimeoutMs: 20,
        timeoutMs: 75,
      }),
    /Timed out waiting/,
  );
});
