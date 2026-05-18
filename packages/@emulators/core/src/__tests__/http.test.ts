import { describe, expect, it } from "vitest";
import { Hono, cors } from "../http.js";

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
