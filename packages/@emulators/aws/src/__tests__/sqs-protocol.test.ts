import { beforeEach, describe, expect, it } from "vitest";
import { getAwsStore } from "../store.js";
import { createTestApp, testAuthHeaders, testBaseUrl } from "./helpers.js";

describe("SQS wire protocols", () => {
  let app: ReturnType<typeof createTestApp>["app"];
  let store: ReturnType<typeof createTestApp>["store"];

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  function json(action: string, body: unknown) {
    return app.request(`${testBaseUrl}/sqs/`, {
      method: "POST",
      headers: {
        ...testAuthHeaders(),
        "Content-Type": "application/x-amz-json-1.0; charset=utf-8",
        "X-Amz-Target": `AmazonSQS.${action}`,
      },
      body: JSON.stringify(body),
    });
  }

  function query(params: Record<string, string>) {
    return app.request(`${testBaseUrl}/sqs/`, {
      method: "POST",
      headers: { ...testAuthHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
  }

  it("returns unwrapped JSON results with protocol headers", async () => {
    const res = await json("ListQueues", {});
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-amz-json-1.0");
    expect(res.headers.get("x-amzn-requestid")).toBeTruthy();
    expect(await res.json()).toEqual({ QueueUrls: [`${testBaseUrl}/sqs/123456789012/emulate-default-queue`] });
  });

  it.each(["json", "query"])("accepts a returned queue URL as a %s endpoint", async (protocol) => {
    const QueueUrl = `${testBaseUrl}/sqs/123456789012/emulate-default-queue`;
    const res = await app.request(QueueUrl, {
      method: "POST",
      headers: {
        ...testAuthHeaders(),
        "Content-Type": protocol === "json" ? "application/x-amz-json-1.0" : "application/x-www-form-urlencoded",
        "X-Amz-Target": "AmazonSQS.SendMessage",
      },
      body:
        protocol === "json"
          ? JSON.stringify({ QueueUrl, MessageBody: "queue endpoint" })
          : new URLSearchParams({ Action: "SendMessage", QueueUrl, MessageBody: "queue endpoint" }),
    });
    expect(res.status).toBe(200);
    expect(getAwsStore(store).sqsMessages.findBy("queue_name", "emulate-default-queue")[0].body).toBe("queue endpoint");
  });

  it("shares queue and message state between JSON and Query requests", async () => {
    const created = await json("CreateQueue", { QueueName: "shared", Attributes: { VisibilityTimeout: "0" } });
    const { QueueUrl } = (await created.json()) as { QueueUrl: string };
    const sent = await query({ Action: "SendMessage", QueueUrl, MessageBody: '<message> & "hello"' });
    expect(sent.headers.get("Content-Type")).toBe("application/xml");
    expect(await sent.text()).toContain("<SendMessageResponse>");
    const received = await json("ReceiveMessage", { QueueUrl });
    expect(await received.json()).toMatchObject({ Messages: [{ Body: '<message> & "hello"' }] });

    await json("SendMessage", { QueueUrl, MessageBody: "json <body> & characters" });
    const xml = await query({ Action: "ReceiveMessage", QueueUrl, MaxNumberOfMessages: "10" });
    expect(await xml.text()).toContain("<Body>json &lt;body&gt; &amp; characters</Body>");
  });

  it("normalizes queue attributes and message attribute maps", async () => {
    const created = await json("CreateQueue", {
      QueueName: "attributes",
      Attributes: { VisibilityTimeout: "12", MaximumMessageSize: "64", DelaySeconds: "0" },
    });
    const { QueueUrl } = (await created.json()) as { QueueUrl: string };
    const attributes = await json("GetQueueAttributes", { QueueUrl, AttributeNames: ["All"] });
    expect(await attributes.json()).toMatchObject({
      Attributes: { VisibilityTimeout: "12", MaximumMessageSize: "64", DelaySeconds: "0" },
    });
    const messageAttributes = {
      kind: { DataType: "String", StringValue: "event" },
      count: { DataType: "Number", StringValue: "2" },
      bytes: { DataType: "Binary", BinaryValue: "AP8=" },
    };
    const sent = await json("SendMessage", { QueueUrl, MessageBody: "hello", MessageAttributes: messageAttributes });
    expect(sent.status).toBe(200);
    expect(getAwsStore(store).sqsMessages.findBy("queue_name", "attributes")[0].message_attributes).toEqual(
      messageAttributes,
    );

    const oversized = await json("SendMessage", { QueueUrl, MessageBody: "x".repeat(65) });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ __type: "InvalidParameterValue" });
  });

  it.each([
    "{",
    "null",
    "[]",
    '"string"',
    '{"QueueName":{}}',
    '{"Attributes":[]}',
    '{"VisibilityTimeout":"30"}',
    '{"MessageAttributes":{"bad":null}}',
  ])("returns a JSON error for invalid input %s without creating state", async (body) => {
    const res = await app.request(`${testBaseUrl}/sqs/`, {
      method: "POST",
      headers: {
        ...testAuthHeaders(),
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "AmazonSQS.CreateQueue",
      },
      body,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("application/x-amz-json-1.0");
    expect(await res.json()).toMatchObject({ __type: "SerializationException" });
    expect(getAwsStore(store).sqsQueues.all()).toHaveLength(1);
  });

  it.each(["", "OtherService.ListQueues", "AmazonSQS.UnknownAction"])(
    "rejects an invalid JSON target %s",
    async (target) => {
      const res = await app.request(`${testBaseUrl}/sqs/`, {
        method: "POST",
        headers: { ...testAuthHeaders(), "Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": target },
        body: '{"Action":"ListQueues"}',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ __type: "InvalidAction" });
    },
  );

  it("uses each protocol's queue-not-found error format", async () => {
    const jsonRes = await json("GetQueueUrl", { QueueName: "missing" });
    expect(jsonRes.status).toBe(400);
    expect(jsonRes.headers.get("x-amzn-requestid")).toBeTruthy();
    expect(jsonRes.headers.get("x-amzn-query-error")).toBe("AWS.SimpleQueueService.NonExistentQueue;Sender");
    expect(await jsonRes.json()).toEqual({
      __type: "QueueDoesNotExist",
      message: "The specified queue does not exist.",
    });

    const xmlRes = await query({ Action: "GetQueueUrl", QueueName: "missing" });
    expect(xmlRes.status).toBe(400);
    expect(xmlRes.headers.get("Content-Type")).toBe("application/xml");
    expect(await xmlRes.text()).toContain("<Code>AWS.SimpleQueueService.NonExistentQueue</Code>");
  });
});
