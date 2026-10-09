import type { Context } from "@emulators/core";
import type { ContentfulStatusCode } from "@emulators/core";

export function blobErr(c: Context, status: ContentfulStatusCode, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

export function forbidden(c: Context): Response {
  return blobErr(c, 403, "forbidden", "Access denied");
}
