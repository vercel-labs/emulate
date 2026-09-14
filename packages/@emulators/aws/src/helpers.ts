import { randomBytes, createHash } from "crypto";
import type { Context } from "@emulators/core";
import type { ContentfulStatusCode } from "@emulators/core";
import type { S3Object } from "./entities.js";

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

export function md5(content: string | Uint8Array): string {
  return createHash("md5").update(content).digest("hex");
}

export function decodeS3ObjectBody(object: Pick<S3Object, "body_base64"> & { body?: string }): Buffer {
  if (typeof object.body_base64 === "string") {
    return Buffer.from(object.body_base64, "base64");
  }
  return Buffer.from(object.body ?? "", "utf8");
}

export function getAccountId(): string {
  return ACCOUNT_ID;
}

export function getDefaultRegion(): string {
  return DEFAULT_REGION;
}

export function awsXmlResponse(c: Context, xml: string, status: ContentfulStatusCode = 200) {
  return c.text(xml, status, { "Content-Type": "application/xml" });
}

export function awsErrorXml(c: Context, code: string, message: string, status: ContentfulStatusCode = 400) {
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

// AWS JSON 1.1 protocol (used by KMS). Unlike the query/XML services, these
// endpoints take a JSON body with an X-Amz-Target header and return JSON.
export function awsJsonResponse(c: Context, payload: unknown, status: ContentfulStatusCode = 200) {
  return c.body(JSON.stringify(payload), status, { "Content-Type": "application/x-amz-json-1.1" });
}

export function awsErrorJson(c: Context, type: string, message: string, status: ContentfulStatusCode = 400) {
  return c.body(JSON.stringify({ __type: type, message }), status, {
    "Content-Type": "application/x-amz-json-1.1",
    "x-amzn-ErrorType": type,
    "x-amzn-RequestId": generateMessageId(),
  });
}

// Buffer.from(s, "base64") silently ignores anything it cannot decode, which
// would turn a malformed blob into a confusing crypto failure further down.
export function decodeBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  return Buffer.from(value, "base64");
}
