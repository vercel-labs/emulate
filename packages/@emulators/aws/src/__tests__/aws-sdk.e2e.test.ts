import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  IAMClient,
  ListUsersCommand,
  GetUserCommand,
  CreateUserCommand,
  DeleteUserCommand,
  CreateAccessKeyCommand,
  ListAccessKeysCommand,
  DeleteAccessKeyCommand,
  CreateRoleCommand,
  GetRoleCommand,
  ListRolesCommand,
  DeleteRoleCommand,
} from "@aws-sdk/client-iam";
import {
  DynamoDBClient,
  BatchGetItemCommand,
  BatchWriteItemCommand,
  CreateTableCommand,
  DeleteTableCommand as DeleteDynamoDBTableCommand,
  GetItemCommand,
  ListTablesCommand,
  PutItemCommand,
  QueryCommand,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  EventBridgeClient,
  CreateEventBusCommand,
  DeleteEventBusCommand,
  DeleteRuleCommand,
  DescribeRuleCommand,
  ListEventBusesCommand,
  ListRulesCommand,
  ListTagsForResourceCommand as ListEventBridgeTagsForResourceCommand,
  ListTargetsByRuleCommand,
  PutEventsCommand,
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
  TagResourceCommand as TagEventBridgeResourceCommand,
  UntagResourceCommand as UntagEventBridgeResourceCommand,
} from "@aws-sdk/client-eventbridge";
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  DeleteLogGroupCommand,
  DeleteLogStreamCommand,
  DeleteRetentionPolicyCommand,
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  FilterLogEventsCommand,
  GetLogEventsCommand,
  ListTagsForResourceCommand as ListLogsTagsForResourceCommand,
  PutLogEventsCommand,
  PutRetentionPolicyCommand,
  TagResourceCommand as TagLogsResourceCommand,
  UntagResourceCommand as UntagLogsResourceCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  S3Client,
  ListBucketsCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  SQSClient,
  ListQueuesCommand,
  CreateQueueCommand as CreateSQSQueueCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  PurgeQueueCommand,
  DeleteQueueCommand as DeleteSQSQueueCommand,
} from "@aws-sdk/client-sqs";
import {
  SNSClient,
  CreateTopicCommand,
  DeleteTopicCommand as DeleteSNSTopicCommand,
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  ListTagsForResourceCommand,
  ListTopicsCommand,
  PublishCommand,
  SetTopicAttributesCommand,
  SubscribeCommand,
  TagResourceCommand,
  UnsubscribeCommand,
  UntagResourceCommand,
} from "@aws-sdk/client-sns";
import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

type EmulatorHandle = { url: string; close: () => Promise<void> };

async function startEmulator(): Promise<EmulatorHandle> {
  const override = process.env.AWS_EMULATOR_E2E_URL;
  if (override) {
    return { url: override, close: async () => {} };
  }
  throw new Error("AWS_EMULATOR_E2E_URL is required for native AWS SDK conformance tests");
}

async function streamToString(stream: unknown): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString();
}

const describeExternalS3E2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const describeExternalSqsE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const describeExternalSnsE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const describeExternalIamStsE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const describeExternalDynamoDBE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const describeExternalEventBridgeE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const describeExternalCloudWatchLogsE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;

describeExternalS3E2E("AWS native runtime - real @aws-sdk/client-s3 E2E", () => {
  let emulator: EmulatorHandle;
  let s3: S3Client;

  beforeAll(async () => {
    emulator = await startEmulator();
    s3 = new S3Client({
      endpoint: emulator.url,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    });
  });

  afterAll(async () => {
    s3.destroy();
    await emulator.close();
  });

  it("ListBuckets returns the seeded default bucket", async () => {
    const res = await s3.send(new ListBucketsCommand({}));
    const names = (res.Buckets ?? []).map((b) => b.Name);
    expect(names).toContain("emulate-default");
  });

  it("HeadBucket succeeds for an existing bucket", async () => {
    await expect(s3.send(new HeadBucketCommand({ Bucket: "emulate-default" }))).resolves.toBeDefined();
  });

  it("CreateBucket and DeleteBucket roundtrip", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "sdk-e2e-create" }));
    const after = await s3.send(new ListBucketsCommand({}));
    expect((after.Buckets ?? []).map((b) => b.Name)).toContain("sdk-e2e-create");
    await s3.send(new DeleteBucketCommand({ Bucket: "sdk-e2e-create" }));
    const final = await s3.send(new ListBucketsCommand({}));
    expect((final.Buckets ?? []).map((b) => b.Name)).not.toContain("sdk-e2e-create");
  });

  it("PutObject / GetObject / HeadObject roundtrip with correct Last-Modified", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "emulate-default",
        Key: "e2e/put-get.txt",
        Body: "hello via sdk",
        ContentType: "text/plain",
      }),
    );

    const get = await s3.send(new GetObjectCommand({ Bucket: "emulate-default", Key: "e2e/put-get.txt" }));
    expect(get.ContentType).toBe("text/plain");
    expect(get.LastModified).toBeInstanceOf(Date);
    expect(await streamToString(get.Body)).toBe("hello via sdk");

    const head = await s3.send(new HeadObjectCommand({ Bucket: "emulate-default", Key: "e2e/put-get.txt" }));
    expect(head.ContentType).toBe("text/plain");
    expect(head.LastModified).toBeInstanceOf(Date);
  });

  it("CopyObject preserves body and returns a parseable response", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "emulate-default",
        Key: "e2e/copy-src.txt",
        Body: "copy me",
        ContentType: "text/plain",
      }),
    );

    const copy = await s3.send(
      new CopyObjectCommand({
        Bucket: "emulate-default",
        Key: "e2e/copy-dst.txt",
        CopySource: "/emulate-default/e2e/copy-src.txt",
      }),
    );
    expect(copy.CopyObjectResult).toBeDefined();

    const get = await s3.send(new GetObjectCommand({ Bucket: "emulate-default", Key: "e2e/copy-dst.txt" }));
    expect(await streamToString(get.Body)).toBe("copy me");
  });

  it("DeleteObject removes the object", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "emulate-default",
        Key: "e2e/to-delete.txt",
        Body: "bye",
        ContentType: "text/plain",
      }),
    );
    await s3.send(new DeleteObjectCommand({ Bucket: "emulate-default", Key: "e2e/to-delete.txt" }));
    await expect(
      s3.send(new GetObjectCommand({ Bucket: "emulate-default", Key: "e2e/to-delete.txt" })),
    ).rejects.toMatchObject({ name: "NoSuchKey" });
  });

  it("ListObjectsV2 paginates with MaxKeys and ContinuationToken", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "sdk-e2e-pages" }));
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        s3.send(
          new PutObjectCommand({
            Bucket: "sdk-e2e-pages",
            Key: `page-${String(i).padStart(2, "0")}.txt`,
            Body: String(i),
          }),
        ),
      ),
    );

    const page1 = await s3.send(new ListObjectsV2Command({ Bucket: "sdk-e2e-pages", MaxKeys: 2 }));
    expect(page1.IsTruncated).toBe(true);
    expect(page1.Contents).toHaveLength(2);
    expect(page1.NextContinuationToken).toBeTruthy();

    const page2 = await s3.send(
      new ListObjectsV2Command({
        Bucket: "sdk-e2e-pages",
        MaxKeys: 2,
        ContinuationToken: page1.NextContinuationToken,
      }),
    );
    expect(page2.Contents).toHaveLength(2);

    const page3 = await s3.send(
      new ListObjectsV2Command({
        Bucket: "sdk-e2e-pages",
        MaxKeys: 2,
        ContinuationToken: page2.NextContinuationToken,
      }),
    );
    expect(page3.IsTruncated).toBe(false);
    expect(page3.Contents).toHaveLength(1);
  });

  it("ListObjectsV2 honors StartAfter", async () => {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: "sdk-e2e-pages",
        Prefix: "page-",
        StartAfter: "page-02.txt",
      }),
    );
    const keys = (res.Contents ?? []).map((o) => o.Key);
    expect(keys).not.toContain("page-00.txt");
    expect(keys).not.toContain("page-01.txt");
    expect(keys).not.toContain("page-02.txt");
    expect(keys).toContain("page-03.txt");
    expect(keys).toContain("page-04.txt");
  });

  it("createPresignedPost uploads a file", async () => {
    const post = await createPresignedPost(s3, {
      Bucket: "emulate-default",
      Key: "e2e/presigned-upload.txt",
      Conditions: [
        ["content-length-range", 0, 1024],
        ["starts-with", "$Content-Type", "text/"],
      ],
      Expires: 60,
    });

    const form = new FormData();
    for (const [k, v] of Object.entries(post.fields)) {
      form.append(k, v);
    }
    form.append("Content-Type", "text/plain");
    form.append("file", new Blob(["hello from presigned post"], { type: "text/plain" }), "upload.txt");

    const res = await fetch(post.url, { method: "POST", body: form });
    expect(res.status).toBe(204);

    const get = await s3.send(new GetObjectCommand({ Bucket: "emulate-default", Key: "e2e/presigned-upload.txt" }));
    expect(await streamToString(get.Body)).toBe("hello from presigned post");
  });

  it("createPresignedPost enforces content-length-range", async () => {
    const post = await createPresignedPost(s3, {
      Bucket: "emulate-default",
      Key: "e2e/too-big.bin",
      Conditions: [["content-length-range", 0, 5]],
      Expires: 60,
    });

    const form = new FormData();
    for (const [k, v] of Object.entries(post.fields)) {
      form.append(k, v);
    }
    form.append("file", new Blob(["this payload is definitely larger than five bytes"]));

    const res = await fetch(post.url, { method: "POST", body: form });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("EntityTooLarge");
  });
});

describeExternalSqsE2E("AWS native runtime - real @aws-sdk/client-sqs E2E", () => {
  let emulator: EmulatorHandle;
  let sqs: SQSClient;

  beforeAll(async () => {
    emulator = await startEmulator();
    sqs = new SQSClient({
      endpoint: `${emulator.url.replace(/\/$/, "")}/sqs/`,
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    });
  });

  afterAll(async () => {
    sqs.destroy();
    await emulator.close();
  });

  it("ListQueues returns the seeded default queue", async () => {
    const res = await sqs.send(new ListQueuesCommand({}));
    expect(res.QueueUrls ?? []).toEqual(expect.arrayContaining([expect.stringContaining("emulate-default-queue")]));
  });

  it("CreateQueue, GetQueueUrl, GetQueueAttributes, and DeleteQueue roundtrip", async () => {
    const created = await sqs.send(
      new CreateSQSQueueCommand({
        QueueName: "sdk-e2e-queue",
        Attributes: { VisibilityTimeout: "45" },
      }),
    );
    expect(created.QueueUrl).toContain("sdk-e2e-queue");

    const byName = await sqs.send(new GetQueueUrlCommand({ QueueName: "sdk-e2e-queue" }));
    expect(byName.QueueUrl).toBe(created.QueueUrl);

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: created.QueueUrl,
        AttributeNames: ["All"],
      }),
    );
    expect(attrs.Attributes?.QueueArn).toContain("sdk-e2e-queue");
    expect(attrs.Attributes?.VisibilityTimeout).toBe("45");

    const listed = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "sdk-e2e-" }));
    expect(listed.QueueUrls ?? []).toContain(created.QueueUrl);

    await sqs.send(new DeleteSQSQueueCommand({ QueueUrl: created.QueueUrl }));
    const afterDelete = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "sdk-e2e-queue" }));
    expect(afterDelete.QueueUrls ?? []).not.toContain(created.QueueUrl);
  });

  it("SendMessage, ReceiveMessage, and DeleteMessage roundtrip", async () => {
    const { QueueUrl } = await sqs.send(new CreateSQSQueueCommand({ QueueName: "sdk-e2e-messages" }));
    expect(QueueUrl).toBeTruthy();

    const sent = await sqs.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: "hello from sqs sdk",
        MessageAttributes: { color: { DataType: "String", StringValue: "blue" } },
      }),
    );
    expect(sent.MessageId).toBeTruthy();
    expect(sent.MD5OfMessageBody).toBeTruthy();
    expect(sent.MD5OfMessageAttributes).toBeTruthy();

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: 1,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["All"],
      }),
    );
    expect(received.Messages).toHaveLength(1);
    expect(received.Messages?.[0]?.Body).toBe("hello from sqs sdk");
    expect(received.Messages?.[0]?.ReceiptHandle).toBeTruthy();
    expect(received.Messages?.[0]?.Attributes?.SenderId).toBe("123456789012");
    expect(received.Messages?.[0]?.MD5OfMessageAttributes).toBe(sent.MD5OfMessageAttributes);
    expect(received.Messages?.[0]?.MessageAttributes?.color?.StringValue).toBe("blue");

    await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: received.Messages?.[0]?.ReceiptHandle }));
    const afterDelete = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1 }));
    expect(afterDelete.Messages ?? []).toHaveLength(0);

    await sqs.send(new DeleteSQSQueueCommand({ QueueUrl }));
  });

  it("SendMessage DelaySeconds keeps a message hidden initially", async () => {
    const { QueueUrl } = await sqs.send(new CreateSQSQueueCommand({ QueueName: "sdk-e2e-delay" }));
    expect(QueueUrl).toBeTruthy();

    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: "not yet", DelaySeconds: 5 }));

    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1 }));
    expect(received.Messages ?? []).toHaveLength(0);

    await sqs.send(new DeleteSQSQueueCommand({ QueueUrl }));
  });

  it("PurgeQueue removes visible messages", async () => {
    const { QueueUrl } = await sqs.send(new CreateSQSQueueCommand({ QueueName: "sdk-e2e-purge" }));
    expect(QueueUrl).toBeTruthy();

    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: "one" }));
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: "two" }));
    await sqs.send(new PurgeQueueCommand({ QueueUrl }));

    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }));
    expect(received.Messages ?? []).toHaveLength(0);

    await sqs.send(new DeleteSQSQueueCommand({ QueueUrl }));
  });
});

describeExternalSnsE2E("AWS native runtime - real @aws-sdk/client-sns E2E", () => {
  let emulator: EmulatorHandle;
  let sns: SNSClient;
  let sqs: SQSClient;

  beforeAll(async () => {
    emulator = await startEmulator();
    sns = new SNSClient({
      endpoint: `${emulator.url.replace(/\/$/, "")}/sns/`,
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
    sqs = new SQSClient({
      endpoint: `${emulator.url.replace(/\/$/, "")}/sqs/`,
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
  });

  afterAll(async () => {
    sns.destroy();
    sqs.destroy();
    await emulator.close();
  });

  it("CreateTopic, Subscribe, Publish to SQS, and DeleteTopic roundtrip", async () => {
    const created = await sns.send(
      new CreateTopicCommand({
        Name: "sdk-e2e-topic",
        Attributes: { DisplayName: "SDK Topic" },
        Tags: [{ Key: "env", Value: "test" }],
      }),
    );
    expect(created.TopicArn).toBe("arn:aws:sns:us-east-1:123456789012:sdk-e2e-topic");

    const listed = await sns.send(new ListTopicsCommand({}));
    expect((listed.Topics ?? []).map((topic) => topic.TopicArn)).toContain(created.TopicArn);

    const attrs = await sns.send(new GetTopicAttributesCommand({ TopicArn: created.TopicArn }));
    expect(attrs.Attributes?.DisplayName).toBe("SDK Topic");
    expect(attrs.Attributes?.SubscriptionsConfirmed).toBe("0");

    await sns.send(
      new SetTopicAttributesCommand({
        TopicArn: created.TopicArn,
        AttributeName: "DeliveryPolicy",
        AttributeValue: JSON.stringify({ healthyRetryPolicy: { numRetries: 1 } }),
      }),
    );

    await sns.send(
      new TagResourceCommand({ ResourceArn: created.TopicArn, Tags: [{ Key: "team", Value: "platform" }] }),
    );
    const tags = await sns.send(new ListTagsForResourceCommand({ ResourceArn: created.TopicArn }));
    expect(tags.Tags).toEqual(expect.arrayContaining([{ Key: "team", Value: "platform" }]));
    await sns.send(new UntagResourceCommand({ ResourceArn: created.TopicArn, TagKeys: ["team"] }));
    const afterUntag = await sns.send(new ListTagsForResourceCommand({ ResourceArn: created.TopicArn }));
    expect(afterUntag.Tags ?? []).not.toEqual(expect.arrayContaining([{ Key: "team", Value: "platform" }]));

    const queue = await sqs.send(new CreateSQSQueueCommand({ QueueName: "sdk-e2e-sns-target" }));
    const queueAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    expect(queueAttrs.Attributes?.QueueArn).toBeTruthy();

    const subscription = await sns.send(
      new SubscribeCommand({
        TopicArn: created.TopicArn,
        Protocol: "sqs",
        Endpoint: queueAttrs.Attributes?.QueueArn,
        Attributes: { RawMessageDelivery: "false" },
        ReturnSubscriptionArn: true,
      }),
    );
    expect(subscription.SubscriptionArn).toContain(`${created.TopicArn}:`);

    const subscriptions = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: created.TopicArn }));
    expect((subscriptions.Subscriptions ?? []).map((item) => item.SubscriptionArn)).toContain(
      subscription.SubscriptionArn,
    );

    const published = await sns.send(
      new PublishCommand({
        TopicArn: created.TopicArn,
        Subject: "created",
        Message: "order created",
        MessageAttributes: { trace: { DataType: "String", StringValue: "abc123" } },
      }),
    );
    expect(published.MessageId).toBeTruthy();

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl,
        MaxNumberOfMessages: 1,
        MessageAttributeNames: ["All"],
      }),
    );
    expect(received.Messages).toHaveLength(1);
    const body = JSON.parse(received.Messages?.[0]?.Body ?? "{}") as {
      Type?: string;
      TopicArn?: string;
      Message?: string;
      MessageAttributes?: Record<string, { Type?: string; Value?: string }>;
    };
    expect(body.Type).toBe("Notification");
    expect(body.TopicArn).toBe(created.TopicArn);
    expect(body.Message).toBe("order created");
    expect(body.MessageAttributes?.trace).toEqual({ Type: "String", Value: "abc123" });
    expect(received.Messages?.[0]?.MessageAttributes).toBeUndefined();

    await sns.send(new UnsubscribeCommand({ SubscriptionArn: subscription.SubscriptionArn }));
    await sns.send(new DeleteSNSTopicCommand({ TopicArn: created.TopicArn }));
    await sqs.send(new DeleteSQSQueueCommand({ QueueUrl: queue.QueueUrl }));
  });
});

describeExternalDynamoDBE2E("AWS native runtime - real @aws-sdk/client-dynamodb E2E", () => {
  let emulator: EmulatorHandle;
  let dynamodb: DynamoDBClient;

  beforeAll(async () => {
    emulator = await startEmulator();
    dynamodb = new DynamoDBClient({
      endpoint: `${emulator.url.replace(/\/$/, "")}/dynamodb/`,
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
  });

  afterAll(async () => {
    dynamodb.destroy();
    await emulator.close();
  });

  it("CreateTable, PutItem, GetItem, Query, and DeleteTable roundtrip", async () => {
    await dynamodb.send(
      new CreateTableCommand({
        TableName: "sdk-e2e-items",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );

    const listed = await dynamodb.send(new ListTablesCommand({}));
    expect(listed.TableNames ?? []).toContain("sdk-e2e-items");

    const updated = await dynamodb.send(
      new UpdateTableCommand({
        TableName: "sdk-e2e-items",
        BillingMode: "PROVISIONED",
        ProvisionedThroughput: {
          ReadCapacityUnits: 2,
          WriteCapacityUnits: 1,
        },
      }),
    );
    expect(updated.TableDescription?.BillingModeSummary?.BillingMode).toBe("PROVISIONED");

    await dynamodb.send(
      new PutItemCommand({
        TableName: "sdk-e2e-items",
        Item: {
          pk: { S: "acct#1" },
          sk: { S: "profile" },
          name: { S: "Ada" },
          count: { N: "3" },
        },
      }),
    );

    const found = await dynamodb.send(
      new GetItemCommand({
        TableName: "sdk-e2e-items",
        Key: {
          pk: { S: "acct#1" },
          sk: { S: "profile" },
        },
      }),
    );
    expect(found.Item?.name?.S).toBe("Ada");
    expect(found.Item?.count?.N).toBe("3");

    const queried = await dynamodb.send(
      new QueryCommand({
        TableName: "sdk-e2e-items",
        KeyConditionExpression: "#pk = :pk AND #sk = :sk",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#sk": "sk",
        },
        ExpressionAttributeValues: {
          ":pk": { S: "acct#1" },
          ":sk": { S: "profile" },
        },
      }),
    );
    expect(queried.Count).toBe(1);
    expect(queried.Items?.[0]?.name?.S).toBe("Ada");

    await dynamodb.send(new DeleteDynamoDBTableCommand({ TableName: "sdk-e2e-items" }));
  });

  it("BatchWriteItem and BatchGetItem roundtrip", async () => {
    await dynamodb.send(
      new CreateTableCommand({
        TableName: "sdk-e2e-events",
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );

    await dynamodb.send(
      new BatchWriteItemCommand({
        RequestItems: {
          "sdk-e2e-events": [
            { PutRequest: { Item: { id: { S: "evt#1" }, type: { S: "push" } } } },
            { PutRequest: { Item: { id: { S: "evt#2" }, type: { S: "pull_request" } } } },
          ],
        },
      }),
    );

    const batch = await dynamodb.send(
      new BatchGetItemCommand({
        RequestItems: {
          "sdk-e2e-events": {
            Keys: [{ id: { S: "evt#1" } }, { id: { S: "evt#2" } }],
          },
        },
      }),
    );
    expect(batch.Responses?.["sdk-e2e-events"]).toHaveLength(2);

    await dynamodb.send(new DeleteDynamoDBTableCommand({ TableName: "sdk-e2e-events" }));
  });
});

describeExternalEventBridgeE2E("AWS native runtime - real @aws-sdk/client-eventbridge E2E", () => {
  let emulator: EmulatorHandle;
  let events: EventBridgeClient;
  let sqs: SQSClient;

  beforeAll(async () => {
    emulator = await startEmulator();
    events = new EventBridgeClient({
      endpoint: `${emulator.url.replace(/\/$/, "")}/events/`,
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
    sqs = new SQSClient({
      endpoint: `${emulator.url.replace(/\/$/, "")}/sqs/`,
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
  });

  afterAll(async () => {
    events.destroy();
    sqs.destroy();
    await emulator.close();
  });

  it("CreateEventBus, PutRule, PutTargets, and PutEvents route matching events to SQS", async () => {
    const suffix = Date.now().toString(36);
    const busName = `sdk-e2e-bus-${suffix}`;
    const ruleName = `sdk-e2e-rule-${suffix}`;
    const queueName = `sdk-e2e-events-${suffix}`;

    const bus = await events.send(
      new CreateEventBusCommand({
        Name: busName,
        Tags: [{ Key: "env", Value: "test" }],
      }),
    );
    expect(bus.EventBusArn).toBe(`arn:aws:events:us-east-1:123456789012:event-bus/${busName}`);

    const buses = await events.send(new ListEventBusesCommand({ NamePrefix: "sdk-e2e-bus-" }));
    expect((buses.EventBuses ?? []).map((item) => item.Name)).toContain(busName);

    await events.send(
      new TagEventBridgeResourceCommand({
        ResourceARN: bus.EventBusArn,
        Tags: [{ Key: "team", Value: "platform" }],
      }),
    );
    const tags = await events.send(new ListEventBridgeTagsForResourceCommand({ ResourceARN: bus.EventBusArn }));
    expect(tags.Tags).toEqual(expect.arrayContaining([{ Key: "team", Value: "platform" }]));
    await events.send(new UntagEventBridgeResourceCommand({ ResourceARN: bus.EventBusArn, TagKeys: ["team"] }));

    const queue = await sqs.send(new CreateSQSQueueCommand({ QueueName: queueName }));
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    expect(attrs.Attributes?.QueueArn).toBeTruthy();

    const rule = await events.send(
      new PutRuleCommand({
        Name: ruleName,
        EventBusName: busName,
        EventPattern: JSON.stringify({
          source: ["app.orders"],
          "detail-type": ["OrderCreated"],
          detail: { tenant: ["acme"] },
        }),
      }),
    );
    expect(rule.RuleArn).toContain(`:rule/${busName}/${ruleName}`);

    const described = await events.send(new DescribeRuleCommand({ Name: ruleName, EventBusName: busName }));
    expect(described.State).toBe("ENABLED");
    expect(described.EventBusName).toBe(busName);

    const rules = await events.send(new ListRulesCommand({ EventBusName: busName, NamePrefix: "sdk-e2e-rule-" }));
    expect((rules.Rules ?? []).map((item) => item.Name)).toContain(ruleName);

    const targets = await events.send(
      new PutTargetsCommand({
        Rule: ruleName,
        EventBusName: busName,
        Targets: [{ Id: "queue", Arn: attrs.Attributes?.QueueArn }],
      }),
    );
    expect(targets.FailedEntryCount).toBe(0);

    const listedTargets = await events.send(new ListTargetsByRuleCommand({ Rule: ruleName, EventBusName: busName }));
    expect((listedTargets.Targets ?? []).map((item) => item.Id)).toContain("queue");

    const published = await events.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: busName,
            Source: "app.orders",
            DetailType: "OrderCreated",
            Detail: JSON.stringify({ tenant: "acme", id: "ord_1" }),
          },
          {
            EventBusName: busName,
            Source: "app.orders",
            DetailType: "OrderCreated",
            Detail: JSON.stringify({ tenant: "other", id: "ord_2" }),
          },
        ],
      }),
    );
    expect(published.FailedEntryCount).toBe(0);
    expect(published.Entries?.[0]?.EventId).toBeTruthy();

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl,
        MaxNumberOfMessages: 10,
      }),
    );
    expect(received.Messages).toHaveLength(1);
    const event = JSON.parse(received.Messages?.[0]?.Body ?? "{}") as {
      source?: string;
      "detail-type"?: string;
      detail?: { tenant?: string; id?: string };
    };
    expect(event.source).toBe("app.orders");
    expect(event["detail-type"]).toBe("OrderCreated");
    expect(event.detail).toEqual({ tenant: "acme", id: "ord_1" });

    await events.send(new RemoveTargetsCommand({ Rule: ruleName, EventBusName: busName, Ids: ["queue"] }));
    const afterRemove = await events.send(new ListTargetsByRuleCommand({ Rule: ruleName, EventBusName: busName }));
    expect((afterRemove.Targets ?? []).map((item) => item.Id)).not.toContain("queue");

    await events.send(new DeleteRuleCommand({ Name: ruleName, EventBusName: busName }));
    await events.send(new DeleteEventBusCommand({ Name: busName }));
    await sqs.send(new DeleteSQSQueueCommand({ QueueUrl: queue.QueueUrl }));
  });
});

describeExternalCloudWatchLogsE2E("AWS native runtime - real @aws-sdk/client-cloudwatch-logs E2E", () => {
  let emulator: EmulatorHandle;
  let logs: CloudWatchLogsClient;

  beforeAll(async () => {
    emulator = await startEmulator();
    logs = new CloudWatchLogsClient({
      endpoint: `${emulator.url.replace(/\/$/, "")}/logs/`,
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
  });

  afterAll(async () => {
    logs.destroy();
    await emulator.close();
  });

  it("CreateLogGroup, PutLogEvents, query, tags, retention, and delete roundtrip", async () => {
    const suffix = Date.now().toString(36);
    const logGroupName = `sdk-e2e-logs-${suffix}`;
    const logStreamName = `web-${suffix}`;

    await logs.send(
      new CreateLogGroupCommand({
        logGroupName,
        tags: { env: "test" },
      }),
    );

    const groups = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: "sdk-e2e-logs-" }));
    const group = (groups.logGroups ?? []).find((item) => item.logGroupName === logGroupName);
    expect(group?.arn).toBe(`arn:aws:logs:us-east-1:123456789012:log-group:${logGroupName}:*`);
    expect(group?.logGroupArn).toBe(`arn:aws:logs:us-east-1:123456789012:log-group:${logGroupName}`);
    if (!group?.logGroupArn) {
      throw new Error("missing log group arn");
    }

    await logs.send(new PutRetentionPolicyCommand({ logGroupName, retentionInDays: 7 }));
    const retained = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroupName }));
    expect(retained.logGroups?.[0]?.retentionInDays).toBe(7);

    await logs.send(new CreateLogStreamCommand({ logGroupName, logStreamName }));
    const streams = await logs.send(new DescribeLogStreamsCommand({ logGroupName, logStreamNamePrefix: "web-" }));
    expect((streams.logStreams ?? []).map((item) => item.logStreamName)).toContain(logStreamName);
    const streamsByIdentifier = await logs.send(
      new DescribeLogStreamsCommand({ logGroupIdentifier: group.logGroupArn }),
    );
    expect((streamsByIdentifier.logStreams ?? []).map((item) => item.logStreamName)).toContain(logStreamName);
    await expect(
      logs.send(
        new DescribeLogStreamsCommand({
          logGroupName,
          logStreamNamePrefix: "web-",
          orderBy: "LastEventTime",
        }),
      ),
    ).rejects.toMatchObject({ name: "InvalidParameterException" });

    const put = await logs.send(
      new PutLogEventsCommand({
        logGroupName,
        logStreamName,
        logEvents: [
          { timestamp: 1700000000000, message: "first error" },
          { timestamp: 1700000001000, message: "second info" },
        ],
      }),
    );
    expect(put.nextSequenceToken).toBeTruthy();

    const got = await logs.send(new GetLogEventsCommand({ logGroupName, logStreamName }));
    expect((got.events ?? []).map((event) => event.message)).toEqual(["second info", "first error"]);
    const fromHead = await logs.send(new GetLogEventsCommand({ logGroupName, logStreamName, startFromHead: true }));
    expect((fromHead.events ?? []).map((event) => event.message)).toEqual(["first error", "second info"]);
    const fromIdentifier = await logs.send(
      new GetLogEventsCommand({
        logGroupIdentifier: group.logGroupArn,
        logStreamName,
        startFromHead: true,
        endTime: 1700000001000,
      }),
    );
    expect((fromIdentifier.events ?? []).map((event) => event.message)).toEqual(["first error"]);
    await expect(
      logs.send(
        new GetLogEventsCommand({
          logGroupName,
          logGroupIdentifier: group.logGroupArn,
          logStreamName,
        }),
      ),
    ).rejects.toMatchObject({ name: "InvalidParameterException" });

    await expect(
      logs.send(
        new PutLogEventsCommand({
          logGroupName,
          logStreamName,
          logEvents: [
            { timestamp: 1700000003000, message: "third" },
            { timestamp: 1700000002000, message: "out of order" },
          ],
        }),
      ),
    ).rejects.toMatchObject({ name: "InvalidParameterException" });

    const filtered = await logs.send(new FilterLogEventsCommand({ logGroupName, filterPattern: "error" }));
    expect((filtered.events ?? []).map((event) => event.message)).toEqual(["first error"]);
    expect(filtered.events?.[0]?.eventId).toBeTruthy();
    const filteredByIdentifier = await logs.send(
      new FilterLogEventsCommand({ logGroupIdentifier: group.logGroupArn, filterPattern: "error" }),
    );
    expect((filteredByIdentifier.events ?? []).map((event) => event.message)).toEqual(["first error"]);
    await expect(
      logs.send(
        new FilterLogEventsCommand({
          logGroupName,
          logStreamNames: [logStreamName],
          logStreamNamePrefix: "web-",
        }),
      ),
    ).rejects.toMatchObject({ name: "InvalidParameterException" });

    await logs.send(new TagLogsResourceCommand({ resourceArn: group.logGroupArn, tags: { team: "platform" } }));
    const tags = await logs.send(new ListLogsTagsForResourceCommand({ resourceArn: group.logGroupArn }));
    expect(tags.tags?.team).toBe("platform");
    await expect(
      logs.send(
        new TagLogsResourceCommand({
          resourceArn: `arn:aws:logs:us-west-2:123456789012:log-group:${logGroupName}`,
          tags: { region: "wrong" },
        }),
      ),
    ).rejects.toMatchObject({ name: "ResourceNotFoundException" });
    await logs.send(new UntagLogsResourceCommand({ resourceArn: group.logGroupArn, tagKeys: ["team"] }));

    await logs.send(new DeleteRetentionPolicyCommand({ logGroupName }));
    await logs.send(new DeleteLogStreamCommand({ logGroupName, logStreamName }));
    await logs.send(new DeleteLogGroupCommand({ logGroupName }));
  });
});

describeExternalIamStsE2E("AWS native runtime - real @aws-sdk/client-iam and @aws-sdk/client-sts E2E", () => {
  let emulator: EmulatorHandle;
  let iam: IAMClient;
  let sts: STSClient;

  beforeAll(async () => {
    emulator = await startEmulator();
    iam = new IAMClient({
      endpoint: `${emulator.url.replace(/\/$/, "")}/iam/`,
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
    sts = new STSClient({
      endpoint: `${emulator.url.replace(/\/$/, "")}/sts/`,
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
  });

  afterAll(async () => {
    iam.destroy();
    sts.destroy();
    await emulator.close();
  });

  it("ListUsers and GetUser return the seeded admin user", async () => {
    const listed = await iam.send(new ListUsersCommand({}));
    expect((listed.Users ?? []).map((user) => user.UserName)).toContain("admin");

    const admin = await iam.send(new GetUserCommand({ UserName: "admin" }));
    expect(admin.User?.Arn).toBe("arn:aws:iam::123456789012:user/admin");
  });

  it("CreateUser, CreateAccessKey, ListAccessKeys, and DeleteUser roundtrip", async () => {
    const created = await iam.send(new CreateUserCommand({ UserName: "sdk-user", Path: "/team/" }));
    expect(created.User?.Arn).toBe("arn:aws:iam::123456789012:user/team/sdk-user");

    const key = await iam.send(new CreateAccessKeyCommand({ UserName: "sdk-user" }));
    expect(key.AccessKey?.AccessKeyId).toMatch(/^AKIA/);
    expect(key.AccessKey?.SecretAccessKey).toBeTruthy();

    const keys = await iam.send(new ListAccessKeysCommand({ UserName: "sdk-user" }));
    expect((keys.AccessKeyMetadata ?? []).map((item) => item.AccessKeyId)).toContain(key.AccessKey?.AccessKeyId);

    await iam.send(new DeleteAccessKeyCommand({ UserName: "sdk-user", AccessKeyId: key.AccessKey?.AccessKeyId }));
    const afterDeleteKey = await iam.send(new ListAccessKeysCommand({ UserName: "sdk-user" }));
    expect((afterDeleteKey.AccessKeyMetadata ?? []).map((item) => item.AccessKeyId)).not.toContain(
      key.AccessKey?.AccessKeyId,
    );

    await iam.send(new DeleteUserCommand({ UserName: "sdk-user" }));
    const afterDelete = await iam.send(new ListUsersCommand({}));
    expect((afterDelete.Users ?? []).map((user) => user.UserName)).not.toContain("sdk-user");
  });

  it("CreateRole, GetRole, ListRoles, AssumeRole, and DeleteRole roundtrip", async () => {
    const created = await iam.send(
      new CreateRoleCommand({
        RoleName: "sdk-role",
        Description: "SDK role",
        AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [] }),
      }),
    );
    expect(created.Role?.Arn).toBe("arn:aws:iam::123456789012:role/sdk-role");

    const byName = await iam.send(new GetRoleCommand({ RoleName: "sdk-role" }));
    expect(byName.Role?.Description).toBe("SDK role");

    const listed = await iam.send(new ListRolesCommand({}));
    expect((listed.Roles ?? []).map((role) => role.RoleName)).toContain("sdk-role");

    const assumed = await sts.send(
      new AssumeRoleCommand({
        RoleArn: created.Role?.Arn,
        RoleSessionName: "sdk-session",
      }),
    );
    expect(assumed.Credentials?.AccessKeyId).toMatch(/^ASIA/);
    expect(assumed.Credentials?.SessionToken).toBeTruthy();
    expect(assumed.AssumedRoleUser?.Arn).toBe(`${created.Role?.Arn}/sdk-session`);

    const assumedSTS = new STSClient({
      endpoint: `${emulator.url.replace(/\/$/, "")}/sts/`,
      region: "us-east-1",
      credentials: {
        accessKeyId: assumed.Credentials?.AccessKeyId ?? "",
        secretAccessKey: assumed.Credentials?.SecretAccessKey ?? "",
        sessionToken: assumed.Credentials?.SessionToken,
      },
    });
    try {
      const identity = await assumedSTS.send(new GetCallerIdentityCommand({}));
      expect(identity.Arn).toBe(`${created.Role?.Arn}/sdk-session`);
    } finally {
      assumedSTS.destroy();
    }

    await iam.send(new DeleteRoleCommand({ RoleName: "sdk-role" }));
    const afterDelete = await iam.send(new ListRolesCommand({}));
    expect((afterDelete.Roles ?? []).map((role) => role.RoleName)).not.toContain("sdk-role");
  });

  it("GetCallerIdentity returns the known default admin principal", async () => {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    expect(identity.Account).toBe("123456789012");
    expect(identity.Arn).toBe("arn:aws:iam::123456789012:user/admin");
    expect(identity.UserId).toBeTruthy();
  });
});
