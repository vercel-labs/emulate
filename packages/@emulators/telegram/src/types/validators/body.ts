import type { Context } from "hono";
import { z } from "zod";
import { parseTelegramBody, tgError } from "../../http.js";

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

export async function parseJsonBody<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<ParseResult<T>> {
  const raw = await parseTelegramBody(c);
  return parseWithSchema(c, schema, raw);
}

export function parseWithSchema<T>(
  c: Context,
  schema: z.ZodType<T>,
  raw: unknown,
): ParseResult<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: tgError(c, firstZodError(parsed.error)) };
  }
  return { ok: true, data: parsed.data };
}

// Translate a zod parsing failure into the closest Bot API-style error
// message. The emulator keeps the wording close to real Telegram so
// that tests asserting on exact "Bad Request: X" strings keep working.
export function firstZodError(err: z.ZodError): string {
  const issue = err.issues[0];
  const path = issue.path.length ? issue.path.join(".") : "body";

  if (issue.code === "invalid_type") {
    // zod 4 folds the "received" marker into the issue message
    // ("expected number, received undefined") — a missing required
    // field is reported as `received undefined`, which we normalise
    // to Telegram's canonical "field is required" wording.
    if (/received undefined/.test(issue.message)) {
      return `Bad Request: ${path} is required`;
    }
    return `Bad Request: ${path} has invalid type`;
  }

  if (issue.code === "invalid_union") {
    return `Bad Request: ${path} has invalid type`;
  }

  return `Bad Request: ${path}: ${issue.message}`;
}
