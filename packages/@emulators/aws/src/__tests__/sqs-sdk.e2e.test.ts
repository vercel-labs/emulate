import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  PurgeQueueCommand,
} from "@aws-sdk/client-sqs";
import { externalTarget, startAwsTarget } from "./helpers.js";

describe("AWS plugin - real @aws-sdk/client-sqs E2E", () => {
  let sqs: SQSClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const target = await startAwsTarget();
    close = target.close;
    sqs = new SQSClient({
      endpoint: target.endpoint("sqs"),
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      maxAttempts: 1,
    });
  });

  afterAll(async () => {
    sqs?.destroy();
    await close?.();
  });

  it.skipIf(externalTarget)("lists the seeded queue with a request ID", async () => {
    const result = await sqs.send(new ListQueuesCommand({}));
    expect(result.QueueUrls).toEqual([expect.stringContaining("/sqs/123456789012/emulate-default-queue")]);
    expect(result.$metadata.httpStatusCode).toBe(200);
    expect(result.$metadata.requestId).toBeTruthy();
  });

  it("creates, finds, inspects, and deletes a queue", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName: "sdk-queue", Attributes: { VisibilityTimeout: "0", DelaySeconds: "0" } }),
    );
    expect(QueueUrl).toContain(externalTarget ? "/sdk-queue" : "/sqs/123456789012/sdk-queue");
    expect(await sqs.send(new GetQueueUrlCommand({ QueueName: "sdk-queue" }))).toMatchObject({ QueueUrl });
    expect(await sqs.send(new CreateQueueCommand({ QueueName: "sdk-queue" }))).toMatchObject({ QueueUrl });
    expect(await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "sdk-" }))).toMatchObject({ QueueUrls: [QueueUrl] });
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["All"] }));
    expect(Attributes).toMatchObject({ VisibilityTimeout: "0", DelaySeconds: "0", ApproximateNumberOfMessages: "0" });
    await sqs.send(new DeleteQueueCommand({ QueueUrl }));
    expect(await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "sdk-" }))).toMatchObject({ QueueUrls: [] });
    await expect(sqs.send(new GetQueueUrlCommand({ QueueName: "sdk-queue" }))).rejects.toMatchObject({
      name: "QueueDoesNotExist",
      $metadata: { httpStatusCode: 400 },
    });
  });

  it("sends, receives, and deletes messages using the returned queue URL", async () => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: "sdk-messages" }));
    const body = 'Hello <SQS> & "JSON" \u2603';
    const sent = await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: body }));
    expect(sent.MessageId).toBeTruthy();
    expect(sent.MD5OfMessageBody).toMatch(/^[a-f0-9]{32}$/);
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: 2,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ["All"],
      }),
    );
    expect(Messages).toEqual([
      expect.objectContaining({
        MessageId: sent.MessageId,
        Body: body,
        MD5OfBody: sent.MD5OfMessageBody,
        ReceiptHandle: expect.any(String),
        Attributes: expect.objectContaining({ ApproximateReceiveCount: "1" }),
      }),
    ]);
    expect(await sqs.send(new ReceiveMessageCommand({ QueueUrl }))).toMatchObject({ Messages: [] });
    await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: Messages![0].ReceiptHandle }));
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["All"] }));
    expect(Attributes).toMatchObject({ ApproximateNumberOfMessages: "0", ApproximateNumberOfMessagesNotVisible: "0" });
  });

  it("accepts numeric receive parameters and purges the queue", async () => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: "sdk-purge" }));
    for (const MessageBody of ["one", "two", "three"]) {
      await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody }));
    }
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 2, VisibilityTimeout: 0 }),
    );
    expect(Messages).toHaveLength(2);
    await sqs.send(new PurgeQueueCommand({ QueueUrl }));
    expect(await sqs.send(new ReceiveMessageCommand({ QueueUrl }))).toMatchObject({ Messages: [] });
  });

  it("deserializes service errors instead of failing to parse XML", async () => {
    await expect(sqs.send(new CreateQueueCommand({ QueueName: "" }))).rejects.toMatchObject({
      name: "MissingParameter",
      message: "The request must contain the parameter QueueName.",
      $metadata: { httpStatusCode: 400, requestId: expect.any(String) },
    });
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: "sdk-validation" }));
    await expect(sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: "" }))).rejects.toMatchObject({
      name: "MissingParameter",
      $metadata: { httpStatusCode: 400 },
    });
  });
});
