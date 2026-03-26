import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import type { AppEnv } from "./middleware/auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FONTS: Record<string, Buffer> = {
  "geist-sans.woff2": readFileSync(join(__dirname, "fonts", "geist-sans.woff2")),
  "GeistPixel-Square.woff2": readFileSync(join(__dirname, "fonts", "GeistPixel-Square.woff2")),
};

export function registerFontRoutes(app: Hono<AppEnv>): void {
  app.get("/_emulate/fonts/:name", (c) => {
    const name = c.req.param("name");
    const buf = FONTS[name];
    if (!buf) return c.notFound();
    return new Response(buf, {
      headers: {
        "Content-Type": "font/woff2",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });
}
