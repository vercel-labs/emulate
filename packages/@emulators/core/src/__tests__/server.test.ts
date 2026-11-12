import { describe, expect, it } from "vitest";
import { createServer } from "../server.js";
import { requireAppAuth, requireAuth } from "../middleware/auth.js";
import type { ServicePlugin } from "../plugin.js";

const docsUrl = "https://emulate.dev/test";

function testPlugin(overrides: Partial<ServicePlugin> = {}): ServicePlugin {
  return {
    name: "test",
    register(app) {
      app.get("/ping", (c) => c.json({ ok: true }));
    },
    ...overrides,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Internal Server Error";
}

describe("createServer error formatting", () => {
  it("renders a thrown error with its status through formatError", async () => {
    const server = createServer(
      testPlugin({
        register(app) {
          app.get("/teapot", () => {
            throw Object.assign(new Error("short and stout"), { status: 418 });
          });
        },
        formatError: (error, c, status) => c.json({ error: messageOf(error), status }, status),
      }),
      { docsUrl },
    );

    const response = await server.app.request("/teapot");

    expect(response.status).toBe(418);
    expect(await response.json()).toEqual({ error: "short and stout", status: 418 });
  });

  it("renders unmatched routes through formatError", async () => {
    const server = createServer(
      testPlugin({
        formatError: (error, c, status) => c.json({ error: messageOf(error), status }, status),
      }),
      { docsUrl },
    );

    const response = await server.app.request("/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not Found", status: 404 });
  });

  it("renders auth rejections through formatError", async () => {
    const server = createServer(
      testPlugin({
        register(app) {
          app.get("/protected", requireAuth(), (c) => c.json({ user: c.get("authUser") }));
          app.get("/app", requireAppAuth(), (c) => c.json({ app: c.get("authApp") }));
        },
        formatError: (error, c, status) => c.json({ error: messageOf(error), status }, status),
      }),
      { docsUrl },
    );

    const protectedResponse = await server.app.request("/protected");
    expect(protectedResponse.status).toBe(401);
    expect(await protectedResponse.json()).toEqual({ error: "Requires authentication", status: 401 });

    const appResponse = await server.app.request("/app");
    expect(appResponse.status).toBe(401);
    expect(await appResponse.json()).toEqual({ error: "A JSON web token could not be decoded", status: 401 });
  });

  it("renders the rate limit failure through formatError and keeps the headers", async () => {
    const server = createServer(
      testPlugin({
        formatError: (error, c, status) => c.json({ error: messageOf(error), status }, status),
      }),
      { docsUrl },
    );

    let response: Response | undefined;
    for (let i = 0; i < 5000; i++) {
      response = await server.app.request("/ping");
    }

    expect(response?.status).toBe(403);
    expect(await response!.json()).toEqual({ error: "API rate limit exceeded", status: 403 });
    expect(response!.headers.get("X-RateLimit-Limit")).toBe("5000");
    expect(response!.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response!.headers.get("X-RateLimit-Reset")).not.toBeNull();
  });

  it("keeps the GitHub shaped bodies when formatError is absent", async () => {
    const server = createServer(
      testPlugin({
        register(app) {
          app.get("/ping", (c) => c.json({ ok: true }));
          app.get("/protected", requireAuth(), (c) => c.json({ user: c.get("authUser") }));
          app.get("/app", requireAppAuth(), (c) => c.json({ app: c.get("authApp") }));
        },
      }),
      { docsUrl },
    );

    const missing = await server.app.request("/missing");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "Not Found", documentation_url: docsUrl });

    const protectedResponse = await server.app.request("/protected");
    expect(protectedResponse.status).toBe(401);
    expect(await protectedResponse.json()).toEqual({
      message: "Requires authentication",
      documentation_url: docsUrl,
    });

    const appResponse = await server.app.request("/app");
    expect(appResponse.status).toBe(401);
    expect(await appResponse.json()).toEqual({
      message: "A JSON web token could not be decoded",
      documentation_url: docsUrl,
    });

    let limited: Response | undefined;
    for (let i = 0; i < 5000; i++) {
      limited = await server.app.request("/ping");
    }
    expect(limited?.status).toBe(403);
    expect(await limited!.json()).toEqual({ message: "API rate limit exceeded", documentation_url: docsUrl });
  });

  it("skips the rate limiter when rateLimit is false", async () => {
    const server = createServer(testPlugin({ rateLimit: false }), { docsUrl });

    const first = await server.app.request("/ping");
    expect(first.status).toBe(200);
    expect(first.headers.has("X-RateLimit-Limit")).toBe(false);

    let last: Response | undefined;
    for (let i = 0; i < 5001; i++) {
      last = await server.app.request("/ping");
    }
    expect(last?.status).toBe(200);
    expect(last!.headers.has("X-RateLimit-Limit")).toBe(false);
  });
});
