import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// `ok(c, result)` envelopes the method's response body. The payload
// may be any Bot API wire object (WireMessage, WireUser, WireChat,
// WireChatFullInfo, WireChatMember) or plain scalar (e.g. a bare
// `true` for setWebhook). Kept `unknown` at this layer — the emitting
// serializer is what stamps the concrete type.
export function ok(c: Context, result: unknown) {
  return c.json({ ok: true, result });
}

export function okRaw(c: Context, result: unknown) {
  return c.json({ ok: true, result });
}

export function tgError(
  c: Context,
  description: string,
  error_code: number = 400,
  status: ContentfulStatusCode = 400,
) {
  return c.json({ ok: false, error_code, description }, status);
}

// Transport-layer parser. Returns raw JSON — narrowing is the job of
// zod validators downstream (see src/types/validators/body.ts). The
// shape is effectively { [key: string]: unknown } at runtime for
// successful parses, but declaring it as `unknown` forces every
// consumer to go through a schema before touching fields.
export async function parseTelegramBody(c: Context): Promise<unknown> {
  const contentType = c.req.header("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const raw = await c.req.text();
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const raw = await c.req.text();
    const params = new URLSearchParams(raw);
    const result: { [key: string]: unknown } = {};
    for (const [key, value] of params) {
      result[key] = tryParseJsonScalar(value);
    }
    return result;
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const result: { [key: string]: unknown } = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value !== "string" && typeof (value as File).arrayBuffer === "function") {
        const file = value as File;
        const bytes = Buffer.from(await file.arrayBuffer());
        result[key] = { __file: true, name: file.name, type: file.type, bytes };
      } else {
        result[key] = tryParseJsonScalar(String(value));
      }
    }
    return result;
  }

  return {};
}

function tryParseJsonScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const first = trimmed[0];
  if (first === "{" || first === "[" || first === '"' || trimmed === "true" || trimmed === "false" || /^-?\d/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}
