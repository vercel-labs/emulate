import { internalRequest, type RouteContext } from "@emulators/core";
import { rootDocument } from "./meta.js";

const PREFIX = "/api/v3";

// First path segments of REST API URLs. Web URLs (html_url, avatars, apps, settings) stay at the host root, as on GHES.
const API_ROOTS = [
  "app",
  "authorizations",
  "emojis",
  "events",
  "feeds",
  "gists",
  "hub",
  "installation",
  "issues",
  "notifications",
  "orgs",
  "rate_limit",
  "repos",
  "search",
  "teams",
  "user",
  "users",
];

function isWebKey(key: string | undefined): boolean {
  return key !== undefined && (key === "html" || key.endsWith("html_url"));
}

export function apiV3Rewriter(baseUrl: string) {
  const origin = baseUrl.replace(/\/$/, "");
  const apiUrl = new RegExp(`^${escapeRegExp(origin)}/(?:${API_ROOTS.join("|")})(?=[/?{#]|$)`);
  const rewrite = (url: string) => (apiUrl.test(url) ? origin + PREFIX + url.slice(origin.length) : url);

  const walk = (value: unknown, key: string | undefined, webParent: boolean): unknown => {
    if (typeof value === "string") return webParent || isWebKey(key) ? value : rewrite(value);
    if (Array.isArray(value)) return value.map((item) => walk(item, key, webParent));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, walk(v, k, webParent || (key === "_links" && k === "html"))]),
      );
    }
    return value;
  };

  return {
    body: (value: unknown) => walk(value, undefined, false),
    link: (header: string) => header.replace(/<([^>]+)>/g, (_, url: string) => `<${rewrite(url)}>`),
    location: rewrite,
  };
}

export function apiV3Routes({ app, baseUrl }: RouteContext): void {
  const rewriter = apiV3Rewriter(baseUrl);

  for (const path of [PREFIX, `${PREFIX}/`]) {
    app.get(path, (c) => c.json(rewriter.body(rootDocument(baseUrl))));
  }

  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    app.on(method, `${PREFIX}/:path{.+}`, async (c) => {
      const url = new URL(c.req.url);
      url.pathname = url.pathname.slice(PREFIX.length);
      const response = await app.fetch(internalRequest(url.toString(), c.req.raw));
      const headers = new Headers(response.headers);
      const link = headers.get("Link");
      if (link) headers.set("Link", rewriter.link(link));
      const location = headers.get("Location");
      if (location) headers.set("Location", rewriter.location(location));
      if (!(headers.get("Content-Type") ?? "").includes("application/json")) {
        return new Response(response.body, { status: response.status, headers });
      }
      const text = await response.text();
      headers.delete("Content-Length");
      const body = text ? JSON.stringify(rewriter.body(JSON.parse(text))) : text;
      return new Response(body, { status: response.status, headers });
    });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
