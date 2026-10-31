import type { RouteContext } from "@emulators/core";
import type { Context } from "@emulators/core";
import { getAwsStore } from "../store.js";
import { generateMessageId, generateReceiptHandle, md5, getAccountId, parseQueryString } from "../helpers.js";
import { isSqsJson, parseSqsJson, sqsError, sqsResponse } from "./sqs-protocol.js";

export function sqsRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const aws = () => getAwsStore(store);
  const accountId = getAccountId();

  async function handleRequest(c: Context) {
    const body = await c.req.text();
    let params: Record<string, string>;
    let action: string;
    if (isSqsJson(c)) {
      try {
        params = parseSqsJson(body);
      } catch {
        return sqsError(c, "SerializationException", "Could not deserialize the request body.");
      }
      const target = c.req.header("X-Amz-Target") ?? "";
      action = target.startsWith("AmazonSQS.") ? target.slice("AmazonSQS.".length) : "";
    } else {
      params = parseQueryString(body);
      action = params["Action"] ?? c.req.query("Action") ?? "";
    }

    switch (action) {
      case "CreateQueue":
        return createQueue(c, params);
      case "DeleteQueue":
        return deleteQueue(c, params);
      case "ListQueues":
        return listQueues(c, params);
      case "GetQueueUrl":
        return getQueueUrl(c, params);
      case "GetQueueAttributes":
        return getQueueAttributes(c, params);
      case "SendMessage":
        return sendMessage(c, params);
      case "ReceiveMessage":
        return receiveMessage(c, params);
      case "DeleteMessage":
        return deleteMessage(c, params);
      case "PurgeQueue":
        return purgeQueue(c, params);
      default:
        return sqsError(c, "InvalidAction", `The action ${action} is not valid for this endpoint.`);
    }
  }

  app.post("/sqs/", handleRequest);
  // SDKs use QueueUrl as the endpoint for queue-specific operations.
  app.post("/sqs/:accountId/:queueName", handleRequest);

  function createQueue(c: Context, params: Record<string, string>) {
    const queueName = params["QueueName"] ?? "";
    if (!queueName) {
      return sqsError(c, "MissingParameter", "The request must contain the parameter QueueName.");
    }

    const existing = aws().sqsQueues.findOneBy("queue_name", queueName);
    if (existing) {
      // SQS returns success with existing queue URL if attributes match
      return sqsResponse(c, "CreateQueue", { QueueUrl: existing.queue_url });
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

    return sqsResponse(c, "CreateQueue", { QueueUrl: queueUrl });
  }

  function deleteQueue(c: Context, params: Record<string, string>) {
    const queueUrl = params["QueueUrl"] ?? "";
    const queue = aws().sqsQueues.findOneBy("queue_url", queueUrl);
    if (!queue) {
      return sqsError(c, "AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.");
    }

    // Delete all messages in the queue
    const messages = aws().sqsMessages.findBy("queue_name", queue.queue_name);
    for (const msg of messages) {
      aws().sqsMessages.delete(msg.id);
    }
    aws().sqsQueues.delete(queue.id);

    return sqsResponse(c, "DeleteQueue");
  }

  function listQueues(c: Context, params: Record<string, string>) {
    const prefix = params["QueueNamePrefix"] ?? "";
    let queues = aws().sqsQueues.all();
    if (prefix) {
      queues = queues.filter((q) => q.queue_name.startsWith(prefix));
    }

    return sqsResponse(c, "ListQueues", { QueueUrls: queues.map((q) => q.queue_url) });
  }

  function getQueueUrl(c: Context, params: Record<string, string>) {
    const queueName = params["QueueName"] ?? "";
    const queue = aws().sqsQueues.findOneBy("queue_name", queueName);
    if (!queue) {
      return sqsError(c, "AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.");
    }

    return sqsResponse(c, "GetQueueUrl", { QueueUrl: queue.queue_url });
  }

  function getQueueAttributes(c: Context, params: Record<string, string>) {
    const queueUrl = params["QueueUrl"] ?? "";
    const queue = aws().sqsQueues.findOneBy("queue_url", queueUrl);
    if (!queue) {
      return sqsError(c, "AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.");
    }

    const messages = aws().sqsMessages.findBy("queue_name", queue.queue_name);
    const now = Date.now();
    const visibleCount = messages.filter((m) => m.visible_after <= now).length;
    const inFlightCount = messages.filter((m) => m.visible_after > now).length;

    return sqsResponse(c, "GetQueueAttributes", {
      Attributes: {
        QueueArn: queue.arn,
        ApproximateNumberOfMessages: String(visibleCount),
        ApproximateNumberOfMessagesNotVisible: String(inFlightCount),
        VisibilityTimeout: String(queue.visibility_timeout),
        MaximumMessageSize: String(queue.max_message_size),
        MessageRetentionPeriod: String(queue.message_retention_period),
        DelaySeconds: String(queue.delay_seconds),
        ReceiveMessageWaitTimeSeconds: String(queue.receive_message_wait_time),
        FifoQueue: String(queue.fifo),
      },
    });
  }

  function sendMessage(c: Context, params: Record<string, string>) {
    const queueUrl = params["QueueUrl"] ?? "";
    const messageBody = params["MessageBody"] ?? "";

    const queue = aws().sqsQueues.findOneBy("queue_url", queueUrl);
    if (!queue) {
      return sqsError(c, "AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.");
    }

    if (!messageBody) {
      return sqsError(c, "MissingParameter", "The request must contain the parameter MessageBody.");
    }

    const bodyBytes = new TextEncoder().encode(messageBody).byteLength;
    if (bodyBytes > queue.max_message_size) {
      return sqsError(
        c,
        "InvalidParameterValue",
        `One or more parameters are invalid. Reason: Message must be shorter than ${queue.max_message_size} bytes.`,
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
      const binaryValue = params[`MessageAttribute.${attrIndex}.Value.BinaryValue`];
      messageAttributes[name] = { DataType: dataType, StringValue: stringValue, BinaryValue: binaryValue };
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

    return sqsResponse(c, "SendMessage", { MessageId: messageId, MD5OfMessageBody: bodyMd5 });
  }

  function receiveMessage(c: Context, params: Record<string, string>) {
    const queueUrl = params["QueueUrl"] ?? "";
    const maxMessages = Math.min(parseInt(params["MaxNumberOfMessages"] ?? "1", 10), 10);
    const visibilityTimeout = parseInt(params["VisibilityTimeout"] ?? "", 10);

    const queue = aws().sqsQueues.findOneBy("queue_url", queueUrl);
    if (!queue) {
      return sqsError(c, "AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.");
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

    return sqsResponse(c, "ReceiveMessage", {
      Messages: batch.map((m) => ({
        MessageId: m.message_id,
        ReceiptHandle: m.receipt_handle,
        MD5OfBody: m.md5_of_body,
        Body: m.body,
        Attributes: {
          SentTimestamp: String(m.sent_timestamp),
          ApproximateReceiveCount: String(m.receive_count),
          ApproximateFirstReceiveTimestamp: String(m.sent_timestamp),
        },
      })),
    });
  }

  function deleteMessage(c: Context, params: Record<string, string>) {
    const queueUrl = params["QueueUrl"] ?? "";
    const receiptHandle = params["ReceiptHandle"] ?? "";

    const queue = aws().sqsQueues.findOneBy("queue_url", queueUrl);
    if (!queue) {
      return sqsError(c, "AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.");
    }

    const messages = aws().sqsMessages.findBy("queue_name", queue.queue_name);
    const msg = messages.find((m) => m.receipt_handle === receiptHandle);
    if (msg) {
      aws().sqsMessages.delete(msg.id);
    }

    return sqsResponse(c, "DeleteMessage");
  }

  function purgeQueue(c: Context, params: Record<string, string>) {
    const queueUrl = params["QueueUrl"] ?? "";
    const queue = aws().sqsQueues.findOneBy("queue_url", queueUrl);
    if (!queue) {
      return sqsError(c, "AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.");
    }

    const messages = aws().sqsMessages.findBy("queue_name", queue.queue_name);
    for (const msg of messages) {
      aws().sqsMessages.delete(msg.id);
    }

    return sqsResponse(c, "PurgeQueue");
  }
}
