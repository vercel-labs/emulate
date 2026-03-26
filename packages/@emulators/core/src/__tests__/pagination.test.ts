import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { parsePagination, setLinkHeader } from "../middleware/pagination.js";

function parseLinkHeader(link: string | null): Map<string, string> {
  const relToUrl = new Map<string, string>();
  if (!link) return relToUrl;
  for (const part of link.split(/,\s*(?=<)/)) {
    const m = part.match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (m) relToUrl.set(m[2], m[1]);
  }
  return relToUrl;
}

describe("parsePagination", () => {
  function makeApp() {
    const app = new Hono();
    app.get("/items", (c) => c.json(parsePagination(c)));
    return app;
  }

  it("uses page 1 and per_page 30 when there are no query params", async () => {
    const app = makeApp();
    const res = await app.request("/items");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ page: 1, per_page: 30 });
  });

  it("parses custom page and per_page from query string", async () => {
    const app = makeApp();
    const res = await app.request("/items?page=2&per_page=10");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ page: 2, per_page: 10 });
  });

  it("clamps per_page to 100, enforces minimum per_page 1, and minimum page 1", async () => {
    const app = makeApp();

    const high = await app.request("/items?page=1&per_page=200");
    expect(await high.json()).toEqual({ page: 1, per_page: 100 });

    const lowPer = await app.request("/items?page=1&per_page=-1");
    expect(await lowPer.json()).toEqual({ page: 1, per_page: 1 });

    const lowPage = await app.request("/items?page=-5&per_page=30");
    expect(await lowPage.json()).toEqual({ page: 1, per_page: 30 });
  });
});

describe("setLinkHeader", () => {
  it("on the first page of multi-page results, includes next and last only", async () => {
    const app = new Hono();
    app.get("/items", (c) => {
      setLinkHeader(c, 100, 1, 10);
      return c.json({ ok: true });
    });

    const res = await app.request("http://localhost/items?page=1&per_page=10");
    const link = res.headers.get("Link");
    const map = parseLinkHeader(link);
    expect(map.size).toBe(2);
    expect(map.has("next")).toBe(true);
    expect(map.has("last")).toBe(true);
    expect(new URL(map.get("next")!).searchParams.get("page")).toBe("2");
    expect(new URL(map.get("last")!).searchParams.get("page")).toBe("10");
  });

  it("on a middle page, includes first, prev, next, and last", async () => {
    const app = new Hono();
    app.get("/items", (c) => {
      setLinkHeader(c, 100, 5, 10);
      return c.json({ ok: true });
    });

    const res = await app.request("http://localhost/items?page=5&per_page=10");
    const link = res.headers.get("Link");
    const map = parseLinkHeader(link);
    expect(map.size).toBe(4);
    expect(map.has("first")).toBe(true);
    expect(map.has("prev")).toBe(true);
    expect(map.has("next")).toBe(true);
    expect(map.has("last")).toBe(true);
    expect(new URL(map.get("first")!).searchParams.get("page")).toBe("1");
    expect(new URL(map.get("prev")!).searchParams.get("page")).toBe("4");
    expect(new URL(map.get("next")!).searchParams.get("page")).toBe("6");
    expect(new URL(map.get("last")!).searchParams.get("page")).toBe("10");
  });

  it("on the last page, includes first and prev only", async () => {
    const app = new Hono();
    app.get("/items", (c) => {
      setLinkHeader(c, 100, 10, 10);
      return c.json({ ok: true });
    });

    const res = await app.request("http://localhost/items?page=10&per_page=10");
    const link = res.headers.get("Link");
    const map = parseLinkHeader(link);
    expect(map.size).toBe(2);
    expect(map.has("first")).toBe(true);
    expect(map.has("prev")).toBe(true);
    expect(new URL(map.get("first")!).searchParams.get("page")).toBe("1");
    expect(new URL(map.get("prev")!).searchParams.get("page")).toBe("9");
  });

  it("omits the Link header when there is only one page", async () => {
    const app = new Hono();
    app.get("/items", (c) => {
      setLinkHeader(c, 5, 1, 10);
      return c.json({ ok: true });
    });

    const res = await app.request("http://localhost/items?page=1&per_page=10");
    expect(res.headers.get("Link")).toBeNull();
  });
});
