import { describe, it, expect } from "vitest";
import { defineEmulator } from "@emulators/core";
import { createEmulateHandler } from "../index.js";
import { customApiContract } from "../../../../../tests/contracts/custom-api.js";

customApiContract({
  describe,
  it,
  expect,
  defineEmulator,
  create(config) {
    const handler = createEmulateHandler(config);
    return {
      close: handler.close,
      request(path, init) {
        const segments = path.split("?")[0].split("/");
        return handler.GET(new Request(`http://localhost/local/${path}`, init), {
          params: Promise.resolve({ path: segments }),
        });
      },
    };
  },
});

it("forwards OPTIONS to default CORS and explicit custom routes", async () => {
  const handler = createEmulateHandler({
    services: {
      automatic: {
        emulator: defineEmulator({
          name: "automatic",
          state: () => ({}),
          setup({ app }) {
            app.get("/resource", (c) => c.json({ ok: true }));
          },
        }),
      },
      explicit: {
        emulator: defineEmulator({
          name: "explicit",
          state: () => ({}),
          cors: false,
          setup({ app }) {
            app.on("OPTIONS", "/resource", (c) => c.body(null, 204, { Allow: "GET, OPTIONS" }));
          },
        }),
      },
    },
  });
  try {
    const context = (name: string) => ({ params: Promise.resolve({ path: [name, "resource"] }) });
    const automatic = await handler.OPTIONS(
      new Request("http://localhost/local/automatic/resource", {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Method": "GET" },
      }),
      context("automatic"),
    );
    expect(automatic.status).toBe(204);
    expect(automatic.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const explicit = await handler.OPTIONS(
      new Request("http://localhost/local/explicit/resource", { method: "OPTIONS" }),
      context("explicit"),
    );
    expect(explicit.status).toBe(204);
    expect(explicit.headers.get("Allow")).toBe("GET, OPTIONS");
  } finally {
    await handler.close();
  }
});
