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

// AWS validates request members together and reports every failed constraint
// in one message, for example "1 validation error detected: Value null at
// 'roleArn' failed to satisfy constraint: Member must not be null".
export function validationErrorMessage(failures: string[]): string {
  const count = failures.length === 1 ? "1 validation error" : `${failures.length} validation errors`;
  return `${count} detected: ${failures.join("; ")}`;
}

// Records a required-member or length failure. Sensitive members and binary
// blobs are reported without their value, as AWS does.
export function checkMemberLength(
  failures: string[],
  member: string,
  value: string | Buffer | undefined,
  min: number,
  max: number,
  sensitive = false,
): void {
  if (value === undefined) {
    failures.push(`Value null at '${member}' failed to satisfy constraint: Member must not be null`);
    return;
  }
  const subject = sensitive || typeof value !== "string" ? `Value at '${member}'` : `Value '${value}' at '${member}'`;
  if (value.length < min) {
    failures.push(`${subject} failed to satisfy constraint: Member must have length greater than or equal to ${min}`);
  } else if (value.length > max) {
    failures.push(`${subject} failed to satisfy constraint: Member must have length less than or equal to ${max}`);
  }
}
