import type { RouteContext } from "@emulators/core";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { SqsMessage } from "../entities.js";
import { getAwsStore } from "../store.js";
import {
  awsXmlResponse,
  awsErrorXml,
  generateMessageId,
  generateReceiptHandle,
  md5,
  getAccountId,
  parseQueryString,
  escapeXml,
} from "../helpers.js";

type SqsProtocol = "query" | "json";

export function sqsRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const aws = () => getAwsStore(store);
  const accountId = getAccountId();

  // SQS supports both the legacy AWS Query protocol and modern AwsJson1.0.
  app.post("/sqs/", async (c) => {
    const body = await c.req.text();
    const request = parseSqsRequest(c, body);
    if ("response" in request) {
      return request.response;
    }

    const { params, action, protocol } = request;

    switch (action) {
      case "CreateQueue":
        return createQueue(c, params, protocol);
      case "DeleteQueue":
        return deleteQueue(c, params, protocol);
      case "ListQueues":
        return listQueues(c, params, protocol);
      case "GetQueueUrl":
        return getQueueUrl(c, params, protocol);
      case "GetQueueAttributes":
        return getQueueAttributes(c, params, protocol);
      case "SendMessage":
        return sendMessage(c, params, protocol);
      case "ReceiveMessage":
        return receiveMessage(c, params, protocol);
      case "DeleteMessage":
        return deleteMessage(c, params, protocol);
      case "PurgeQueue":
        return purgeQueue(c, params, protocol);
      default:
        return awsError(c, protocol, "InvalidAction", `The action ${action} is not valid for this endpoint.`, 400);
    }
  });

  function createQueue(c: Context, params: Record<string, string>, protocol: SqsProtocol) {
    const queueName = params["QueueName"] ?? "";
    if (!queueName) {
      return awsError(c, protocol, "MissingParameter", "The request must contain the parameter QueueName.", 400);
    }

    const existing = aws().sqsQueues.findOneBy("queue_name", queueName);
    if (existing) {
      if (protocol === "json") {
        return awsJsonResponse(c, { QueueUrl: existing.queue_url });
      }

      // SQS returns success with existing queue URL if attributes match
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CreateQueueResponse>
  <CreateQueueResult>
    <QueueUrl>${escapeXml(existing.queue_url)}</QueueUrl>
  </CreateQueueResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</CreateQueueResponse>`;
      return awsXmlResponse(c, xml);
    }

    const fifo = queueName.endsWith(".fifo");
    const queueUrl = `${baseUrl}/sqs/${accountId}/${queueName}`;
    const arn = `arn:aws:sqs:us-east-1:${accountId}:${queueName}`;

    // Parse numbered Attribute.N.Name / Attribute.N.Value pairs
    const attrs: Record<string, string> = {};
    for (let i = 1; params[`Attribute.${i}.Name`]; i++) {
      attrs[params[`Attribute.${i}.Name`]] = params[`Attribute.${i}.Value`] ?? "";
    }

    aws().sqsQueues.insert({
      queue_name: queueName,
      queue_url: queueUrl,
      arn,
      visibility_timeout: parseInt(attrs["VisibilityTimeout"] ?? "30", 10),
      delay_seconds: parseInt(attrs["DelaySeconds"] ?? "0", 10),
      max_message_size: parseInt(attrs["MaximumMessageSize"] ?? "262144", 10),
      message_retention_period: parseInt(attrs["MessageRetentionPeriod"] ?? "345600", 10),
      receive_message_wait_time: parseInt(attrs["ReceiveMessageWaitTimeSeconds"] ?? "0", 10),
      fifo,
    });

    if (protocol === "json") {
      return awsJsonResponse(c, { QueueUrl: queueUrl });
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CreateQueueResponse>
  <CreateQueueResult>
    <QueueUrl>${escapeXml(queueUrl)}</QueueUrl>
  </CreateQueueResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</CreateQueueResponse>`;
    return awsXmlResponse(c, xml);
  }

  function deleteQueue(c: Context, params: Record<string, string>, protocol: SqsProtocol) {
    const queueUrl = params["QueueUrl"] ?? "";
    const queue = aws().sqsQueues.findOneBy("queue_url", queueUrl);
    if (!queue) {
      return awsError(
        c,
        protocol,
        "AWS.SimpleQueueService.NonExistentQueue",
        "The specified queue does not exist.",
        400,
      );
    }

    // Delete all messages in the queue
    const messages = aws().sqsMessages.findBy("queue_name", queue.queue_name);
    for (const msg of messages) {
      aws().sqsMessages.delete(msg.id);
    }
    aws().sqsQueues.delete(queue.id);

    if (protocol === "json") {
      return awsJsonResponse(c, {});
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DeleteQueueResponse>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</DeleteQueueResponse>`;
    return awsXmlResponse(c, xml);
  }

  function listQueues(c: Context, params: Record<string, string>, protocol: SqsProtocol) {
    const prefix = params["QueueNamePrefix"] ?? "";
    let queues = aws().sqsQueues.all();
    if (prefix) {
      queues = queues.filter((q) => q.queue_name.startsWith(prefix));
    }

    if (protocol === "json") {
      return awsJsonResponse(c, { QueueUrls: queues.map((q) => q.queue_url) });
    }

    const queueUrlsXml = queues.map((q) => `    <QueueUrl>${escapeXml(q.queue_url)}</QueueUrl>`).join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListQueuesResponse>
  <ListQueuesResult>
${queueUrlsXml}
  </ListQueuesResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</ListQueuesResponse>`;
    return awsXmlResponse(c, xml);
  }

  function getQueueUrl(c: Context, params: Record<string, string>, protocol: SqsProtocol) {
    const queueName = params["QueueName"] ?? "";
    const queue = aws().sqsQueues.findOneBy("queue_name", queueName);
    if (!queue) {
      return awsError(
        c,
        protocol,
        "AWS.SimpleQueueService.NonExistentQueue",
        "The specified queue does not exist.",
        400,
      );
    }

    if (protocol === "json") {
      return awsJsonResponse(c, { QueueUrl: queue.queue_url });
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetQueueUrlResponse>
  <GetQueueUrlResult>
    <QueueUrl>${escapeXml(queue.queue_url)}</QueueUrl>
  </GetQueueUrlResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</GetQueueUrlResponse>`;
    return awsXmlResponse(c, xml);
  }

  function getQueueAttributes(c: Context, params: Record<string, string>, protocol: SqsProtocol) {
    const queueUrl = params["QueueUrl"] ?? "";
    const queue = aws().sqsQueues.findOneBy("queue_url", queueUrl);
    if (!queue) {
      return awsError(
        c,
        protocol,
        "AWS.SimpleQueueService.NonExistentQueue",
        "The specified queue does not exist.",
        400,
      );
    }

    const messages = aws().sqsMessages.findBy("queue_name", queue.queue_name);
    const now = Date.now();
    const visibleCount = messages.filter((m) => m.visible_after <= now).length;
    const inFlightCount = messages.filter((m) => m.visible_after > now).length;
    const attributes = queueAttributes(queue, visibleCount, inFlightCount);

    if (protocol === "json") {
      return awsJsonResponse(c, { Attributes: attributes });
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetQueueAttributesResponse>
  <GetQueueAttributesResult>
${Object.entries(attributes)
  .map(([name, value]) => `    <Attribute><Name>${name}</Name><Value>${value}</Value></Attribute>`)
  .join("\n")}
  </GetQueueAttributesResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</GetQueueAttributesResponse>`;
    return awsXmlResponse(c, xml);
  }

  function sendMessage(c: Context, params: Record<string, string>, protocol: SqsProtocol) {
    const queueUrl = params["QueueUrl"] ?? "";
    const messageBody = params["MessageBody"] ?? "";

    const queue = aws().sqsQueues.findOneBy("queue_url", queueUrl);
    if (!queue) {
      return awsError(
        c,
        protocol,
        "AWS.SimpleQueueService.NonExistentQueue",
        "The specified queue does not exist.",
        400,
      );
    }

    if (!messageBody) {
      return awsError(c, protocol, "MissingParameter", "The request must contain the parameter MessageBody.", 400);
    }

    const bodyBytes = new TextEncoder().encode(messageBody).byteLength;
    if (bodyBytes > queue.max_message_size) {
      return awsError(
        c,
        protocol,
        "InvalidParameterValue",
        `One or more parameters are invalid. Reason: Message must be shorter than ${queue.max_message_size} bytes.`,
        400,
      );
    }

    const messageId = generateMessageId();
    const bodyMd5 = md5(messageBody);
    const now = Date.now();

    // Parse message attributes
    const messageAttributes: Record<string, { DataType: string; StringValue?: string; BinaryValue?: string }> = {};
    let attrIndex = 1;
    while (params[`MessageAttribute.${attrIndex}.Name`]) {
      const name = params[`MessageAttribute.${attrIndex}.Name`];
      const dataType = params[`MessageAttribute.${attrIndex}.Value.DataType`] ?? "String";
      const stringValue = params[`MessageAttribute.${attrIndex}.Value.StringValue`];
      messageAttributes[name] = { DataType: dataType, StringValue: stringValue };
      attrIndex++;
    }

    aws().sqsMessages.insert({
      queue_name: queue.queue_name,
      message_id: messageId,
      receipt_handle: generateReceiptHandle(),
      body: messageBody,
      md5_of_body: bodyMd5,
      attributes: {
        SentTimestamp: String(now),
        ApproximateReceiveCount: "0",
        ApproximateFirstReceiveTimestamp: "",
        SenderId: getAccountId(),
      },
      message_attributes: messageAttributes,
      visible_after: now + queue.delay_seconds * 1000,
      sent_timestamp: now,
      receive_count: 0,
    });

    if (protocol === "json") {
      return awsJsonResponse(c, {
        MD5OfMessageBody: bodyMd5,
        MessageId: messageId,
      });
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SendMessageResponse>
  <SendMessageResult>
    <MessageId>${messageId}</MessageId>
    <MD5OfMessageBody>${bodyMd5}</MD5OfMessageBody>
  </SendMessageResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</SendMessageResponse>`;
    return awsXmlResponse(c, xml);
  }

  function receiveMessage(c: Context, params: Record<string, string>, protocol: SqsProtocol) {
    const queueUrl = params["QueueUrl"] ?? "";
    const maxMessages = Math.min(parseInt(params["MaxNumberOfMessages"] ?? "1", 10), 10);
    const visibilityTimeout = parseInt(params["VisibilityTimeout"] ?? "", 10);

    const queue = aws().sqsQueues.findOneBy("queue_url", queueUrl);
    if (!queue) {
      return awsError(
        c,
        protocol,
        "AWS.SimpleQueueService.NonExistentQueue",
        "The specified queue does not exist.",
        400,
      );
    }

    const now = Date.now();
    const timeout = isNaN(visibilityTimeout) ? queue.visibility_timeout : visibilityTimeout;
    const allMessages = aws().sqsMessages.findBy("queue_name", queue.queue_name);
    const visible = allMessages.filter((m) => m.visible_after <= now);
    const batch = visible.slice(0, maxMessages);

    for (const msg of batch) {
      const newReceiptHandle = generateReceiptHandle();
      aws().sqsMessages.update(msg.id, {
        receipt_handle: newReceiptHandle,
        visible_after: now + timeout * 1000,
        receive_count: msg.receive_count + 1,
      });
      msg.receipt_handle = newReceiptHandle;
      msg.receive_count += 1;
    }

    if (protocol === "json") {
      return awsJsonResponse(c, { Messages: batch.map(jsonMessage) });
    }

    const messagesXml = batch
      .map(
        (m) => `    <Message>
      <MessageId>${m.message_id}</MessageId>
      <ReceiptHandle>${m.receipt_handle}</ReceiptHandle>
      <MD5OfBody>${m.md5_of_body}</MD5OfBody>
      <Body>${escapeXml(m.body)}</Body>
      <Attribute><Name>SentTimestamp</Name><Value>${m.sent_timestamp}</Value></Attribute>
      <Attribute><Name>ApproximateReceiveCount</Name><Value>${m.receive_count}</Value></Attribute>
      <Attribute><Name>ApproximateFirstReceiveTimestamp</Name><Value>${m.sent_timestamp}</Value></Attribute>
    </Message>`,
      )
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ReceiveMessageResponse>
  <ReceiveMessageResult>
${messagesXml}
  </ReceiveMessageResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</ReceiveMessageResponse>`;
    return awsXmlResponse(c, xml);
  }

  function deleteMessage(c: Context, params: Record<string, string>, protocol: SqsProtocol) {
    const queueUrl = params["QueueUrl"] ?? "";
    const receiptHandle = params["ReceiptHandle"] ?? "";

    const queue = aws().sqsQueues.findOneBy("queue_url", queueUrl);
    if (!queue) {
      return awsError(
        c,
        protocol,
        "AWS.SimpleQueueService.NonExistentQueue",
        "The specified queue does not exist.",
        400,
      );
    }

    const messages = aws().sqsMessages.findBy("queue_name", queue.queue_name);
    const msg = messages.find((m) => m.receipt_handle === receiptHandle);
    if (msg) {
      aws().sqsMessages.delete(msg.id);
    }

    if (protocol === "json") {
      return awsJsonResponse(c, {});
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DeleteMessageResponse>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</DeleteMessageResponse>`;
    return awsXmlResponse(c, xml);
  }

  function purgeQueue(c: Context, params: Record<string, string>, protocol: SqsProtocol) {
    const queueUrl = params["QueueUrl"] ?? "";
    const queue = aws().sqsQueues.findOneBy("queue_url", queueUrl);
    if (!queue) {
      return awsError(
        c,
        protocol,
        "AWS.SimpleQueueService.NonExistentQueue",
        "The specified queue does not exist.",
        400,
      );
    }

    const messages = aws().sqsMessages.findBy("queue_name", queue.queue_name);
    for (const msg of messages) {
      aws().sqsMessages.delete(msg.id);
    }

    if (protocol === "json") {
      return awsJsonResponse(c, {});
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PurgeQueueResponse>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</PurgeQueueResponse>`;
    return awsXmlResponse(c, xml);
  }
}

function parseSqsRequest(
  c: Context,
  body: string,
): { action: string; params: Record<string, string>; protocol: SqsProtocol } | { response: Response } {
  if (isAwsJsonRequest(c)) {
    try {
      const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      const target = c.req.header("X-Amz-Target") ?? "";
      const action = target.startsWith("AmazonSQS.") ? target.slice("AmazonSQS.".length) : "";
      return { action, params: normalizeJsonParams(payload), protocol: "json" };
    } catch {
      return { response: awsError(c, "json", "InvalidRequestContent", "Could not parse request body into JSON.", 400) };
    }
  }

  const params = parseQueryString(body);
  return { action: params["Action"] ?? c.req.query("Action") ?? "", params, protocol: "query" };
}

function isAwsJsonRequest(c: Context): boolean {
  const contentType = c.req.header("Content-Type") ?? "";
  const target = c.req.header("X-Amz-Target") ?? "";
  return contentType.includes("application/x-amz-json-1.0") || target.startsWith("AmazonSQS.");
}

function normalizeJsonParams(payload: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (key === "Attributes" && isRecord(value)) {
      let index = 1;
      for (const [name, attrValue] of Object.entries(value)) {
        params[`Attribute.${index}.Name`] = name;
        params[`Attribute.${index}.Value`] = String(attrValue);
        index++;
      }
      continue;
    }
    if (key === "MessageAttributes" && isRecord(value)) {
      let index = 1;
      for (const [name, attrValue] of Object.entries(value)) {
        if (!isRecord(attrValue)) {
          continue;
        }
        params[`MessageAttribute.${index}.Name`] = name;
        params[`MessageAttribute.${index}.Value.DataType`] = String(attrValue.DataType ?? "String");
        if (attrValue.StringValue !== undefined) {
          params[`MessageAttribute.${index}.Value.StringValue`] = String(attrValue.StringValue);
        }
        if (attrValue.BinaryValue !== undefined) {
          params[`MessageAttribute.${index}.Value.BinaryValue`] = String(attrValue.BinaryValue);
        }
        index++;
      }
      continue;
    }
    params[key] = String(value);
  }
  return params;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function awsJsonResponse(c: Context, body: Record<string, unknown>, status: ContentfulStatusCode = 200) {
  return c.body(JSON.stringify(body), status, { "Content-Type": "application/x-amz-json-1.0" });
}

function awsError(
  c: Context,
  protocol: SqsProtocol,
  code: string,
  message: string,
  status: ContentfulStatusCode = 400,
) {
  if (protocol === "json") {
    return awsJsonResponse(c, { __type: code, message }, status);
  }

  return awsErrorXml(c, code, message, status);
}

function queueAttributes(
  queue: {
    arn: string;
    visibility_timeout: number;
    max_message_size: number;
    message_retention_period: number;
    delay_seconds: number;
    receive_message_wait_time: number;
    fifo: boolean;
  },
  visibleCount: number,
  inFlightCount: number,
): Record<string, string> {
  return {
    QueueArn: queue.arn,
    ApproximateNumberOfMessages: String(visibleCount),
    ApproximateNumberOfMessagesNotVisible: String(inFlightCount),
    VisibilityTimeout: String(queue.visibility_timeout),
    MaximumMessageSize: String(queue.max_message_size),
    MessageRetentionPeriod: String(queue.message_retention_period),
    DelaySeconds: String(queue.delay_seconds),
    ReceiveMessageWaitTimeSeconds: String(queue.receive_message_wait_time),
    FifoQueue: String(queue.fifo),
  };
}

function jsonMessage(message: SqsMessage): Record<string, unknown> {
  return {
    MessageId: message.message_id,
    ReceiptHandle: message.receipt_handle,
    MD5OfBody: message.md5_of_body,
    Body: message.body,
    Attributes: {
      ...message.attributes,
      ApproximateReceiveCount: String(message.receive_count),
      ApproximateFirstReceiveTimestamp: String(message.sent_timestamp),
    },
    MessageAttributes: message.message_attributes,
  };
}
