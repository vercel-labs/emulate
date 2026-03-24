import { randomBytes, createHash } from "crypto";
import type { Context } from "hono";

const ACCOUNT_ID = "123456789012";
const DEFAULT_REGION = "us-east-1";

export function generateAwsId(prefix: string): string {
  return prefix + randomBytes(8).toString("hex").toUpperCase();
}

export function generateMessageId(): string {
  return [
    randomBytes(4).toString("hex"),
    randomBytes(2).toString("hex"),
    randomBytes(2).toString("hex"),
    randomBytes(2).toString("hex"),
    randomBytes(6).toString("hex"),
  ].join("-");
}

export function generateReceiptHandle(): string {
  return randomBytes(48).toString("base64url");
}

export function md5(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

export function getAccountId(): string {
  return ACCOUNT_ID;
}

export function getDefaultRegion(): string {
  return DEFAULT_REGION;
}

export function awsXmlResponse(c: Context, xml: string, status = 200) {
  return c.text(xml, status, { "Content-Type": "application/xml" });
}

export function awsErrorXml(c: Context, code: string, message: string, status = 400) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ErrorResponse>
  <Error>
    <Code>${escapeXml(code)}</Code>
    <Message>${escapeXml(message)}</Message>
  </Error>
  <RequestId>${generateMessageId()}</RequestId>
</ErrorResponse>`;
  return c.text(xml, status, { "Content-Type": "application/xml" });
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function parseQueryString(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}
