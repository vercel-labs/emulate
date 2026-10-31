import type { Context } from "@emulators/core";
import { awsErrorXml, awsXmlResponse, escapeXml, generateMessageId } from "../helpers.js";

export interface SqsResult {
  QueueUrl?: string;
  QueueUrls?: string[];
  Attributes?: Record<string, string>;
  MessageId?: string;
  MD5OfMessageBody?: string;
  Messages?: Array<{
    MessageId: string;
    ReceiptHandle: string;
    MD5OfBody: string;
    Body: string;
    Attributes: Record<string, string>;
  }>;
}

export function isSqsJson(c: Context): boolean {
  return c.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() === "application/x-amz-json-1.0";
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object.");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string.");
  return value;
}

// Normalize JSON maps and numbers into the existing Query action parameters.
export function parseSqsJson(body: string): Record<string, string> {
  const input = object(JSON.parse(body));
  const params: Record<string, string> = {};
  for (const name of ["QueueName", "QueueNamePrefix", "QueueUrl", "MessageBody", "ReceiptHandle"]) {
    if (input[name] != null) params[name] = string(input[name]);
  }
  for (const name of ["MaxNumberOfMessages", "VisibilityTimeout"]) {
    if (input[name] == null) continue;
    if (typeof input[name] !== "number" || !Number.isInteger(input[name])) throw new Error("Expected an integer.");
    params[name] = String(input[name]);
  }
  if (input.Attributes != null) {
    let i = 1;
    for (const [name, value] of Object.entries(object(input.Attributes))) {
      params[`Attribute.${i}.Name`] = name;
      params[`Attribute.${i}.Value`] = string(value);
      i++;
    }
  }
  if (input.MessageAttributes != null) {
    let i = 1;
    for (const [name, value] of Object.entries(object(input.MessageAttributes))) {
      const attribute = object(value);
      params[`MessageAttribute.${i}.Name`] = name;
      for (const field of ["DataType", "StringValue", "BinaryValue"]) {
        if (attribute[field] != null) params[`MessageAttribute.${i}.Value.${field}`] = string(attribute[field]);
      }
      i++;
    }
  }
  return params;
}

function attributesXml(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .map(([name, value]) => `<Attribute><Name>${escapeXml(name)}</Name><Value>${escapeXml(value)}</Value></Attribute>`)
    .join("");
}

export function sqsResponse(c: Context, action: string, result: SqsResult = {}) {
  const requestId = generateMessageId();
  c.header("x-amzn-requestid", requestId);
  if (isSqsJson(c)) {
    return c.json(result, 200, { "Content-Type": "application/x-amz-json-1.0" });
  }

  let content = "";
  if (result.QueueUrl != null) content += `<QueueUrl>${escapeXml(result.QueueUrl)}</QueueUrl>`;
  for (const url of result.QueueUrls ?? []) content += `<QueueUrl>${escapeXml(url)}</QueueUrl>`;
  if (result.Attributes) content += attributesXml(result.Attributes);
  if (result.MessageId) content += `<MessageId>${escapeXml(result.MessageId)}</MessageId>`;
  if (result.MD5OfMessageBody) content += `<MD5OfMessageBody>${result.MD5OfMessageBody}</MD5OfMessageBody>`;
  for (const message of result.Messages ?? []) {
    content += `<Message>
      <MessageId>${escapeXml(message.MessageId)}</MessageId>
      <ReceiptHandle>${escapeXml(message.ReceiptHandle)}</ReceiptHandle>
      <MD5OfBody>${message.MD5OfBody}</MD5OfBody>
      <Body>${escapeXml(message.Body)}</Body>
      ${attributesXml(message.Attributes)}
    </Message>`;
  }
  const resultXml = Object.keys(result).length ? `<${action}Result>${content}</${action}Result>` : "";
  return awsXmlResponse(
    c,
    `<?xml version="1.0" encoding="UTF-8"?>
<${action}Response>
  ${resultXml}
  <ResponseMetadata><RequestId>${requestId}</RequestId></ResponseMetadata>
</${action}Response>`,
  );
}

export function sqsError(c: Context, code: string, message: string) {
  if (!isSqsJson(c)) return awsErrorXml(c, code, message, 400);
  const type = code === "AWS.SimpleQueueService.NonExistentQueue" ? "QueueDoesNotExist" : code;
  return c.json({ __type: type, message }, 400, {
    "Content-Type": "application/x-amz-json-1.0",
    "x-amzn-requestid": generateMessageId(),
    "x-amzn-query-error": `${code};Sender`,
  });
}
