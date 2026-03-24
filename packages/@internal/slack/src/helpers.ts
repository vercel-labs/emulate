import { randomBytes } from "crypto";
import type { Context } from "hono";

let tsCounter = 0;

export function generateSlackId(prefix: string): string {
  return prefix + randomBytes(5).toString("hex").toUpperCase().slice(0, 9);
}

export function generateTs(): string {
  const now = Math.floor(Date.now() / 1000);
  tsCounter++;
  return `${now}.${String(tsCounter).padStart(6, "0")}`;
}

export function slackOk<T extends Record<string, unknown>>(c: Context, data: T) {
  return c.json({ ok: true, ...data });
}

export function slackError(c: Context, error: string, status = 200) {
  return c.json({ ok: false, error }, status);
}

export async function parseSlackBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type") ?? "";
  const rawText = await c.req.text();

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(rawText);
    } catch {
      return {};
    }
  }

  // Slack SDKs send application/x-www-form-urlencoded by default
  const params = new URLSearchParams(rawText);
  const result: Record<string, unknown> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}

export function resetTsCounter(): void {
  tsCounter = 0;
}
