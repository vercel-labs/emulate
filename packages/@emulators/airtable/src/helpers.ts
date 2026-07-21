import type { Context, ContentfulStatusCode } from "@emulators/core";

/**
 * Airtable uses two error envelope shapes, both confirmed against the live API:
 *  - object form  `{"error":{"type","message"}}` for most errors
 *  - bare-string  `{"error":"NOT_FOUND"}` for an unknown base or record
 * The service owns these directly; it never uses the kernel's GitHub-shaped handler.
 */
export function airtableError(c: Context, status: number, type: string, message: string): Response {
  return c.json({ error: { type, message } }, status as ContentfulStatusCode);
}

export function airtableNotFound(c: Context): Response {
  return c.json({ error: "NOT_FOUND" }, 404);
}

export async function parseJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

// Opaque, Airtable-shaped pagination token (`itr<rand>/<index>`). Clients treat it
// as opaque and round-trip it verbatim; we only decode our own start index from it.
export function encodeOffset(index: number): string {
  return `itr${Math.random().toString(36).slice(2, 10)}/${index}`;
}

export function decodeOffset(token: string | undefined): number {
  if (!token) return 0;
  const slash = token.lastIndexOf("/");
  const raw = slash >= 0 ? token.slice(slash + 1) : token;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
