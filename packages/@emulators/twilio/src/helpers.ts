import { randomBytes } from "crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function generateSid(prefix: string): string {
  return prefix + randomBytes(16).toString("hex").slice(0, 32);
}

export function twilioError(c: Context, statusCode: number, code: number, message: string) {
  return c.json(
    { status: statusCode, code, message, more_info: `https://www.twilio.com/docs/errors/${code}` },
    statusCode as ContentfulStatusCode,
  );
}

export async function parseTwilioBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await c.req.text();
    const params = new URLSearchParams(text);
    const result: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) {
      result[key] = value;
    }
    return result;
  }

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

export function generateVerificationCode(length: number): string {
  const digits = "0123456789";
  let code = "";
  const bytes = randomBytes(length);
  for (let i = 0; i < length; i++) {
    code += digits[bytes[i] % 10];
  }
  return code;
}
