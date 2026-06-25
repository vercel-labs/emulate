import type { RouteContext } from "@emulators/core";

// Serves the clerk-js browser bundle by proxying jsDelivr, so a frontend app can
// load it from the emulator origin (via proxyUrl) instead of Clerk's CDN.
// Not part of the Clerk API surface — purely a dev convenience for browser demos.
export function clerkJsProxyRoutes({ app }: RouteContext): void {
  app.get("/npm/:path{.+}", async (c) => {
    const path = c.req.param("path");
    try {
      const cdnRes = await fetch(`https://cdn.jsdelivr.net/npm/${path}`);
      const body = await cdnRes.text();
      const contentType = cdnRes.headers.get("content-type") ?? "application/javascript";
      return c.body(body, 200, { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" });
    } catch {
      return c.text("Failed to load clerk-js", 502);
    }
  });
}
