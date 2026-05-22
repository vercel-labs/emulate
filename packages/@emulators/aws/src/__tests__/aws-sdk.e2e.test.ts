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
  PutUserPolicyCommand,
  GetUserPolicyCommand,
  ListUserPoliciesCommand,
  DeleteUserPolicyCommand,
  PutRolePolicyCommand,
  GetRolePolicyCommand,
  ListRolePoliciesCommand,
  DeleteRolePolicyCommand,
  CreatePolicyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  ListPoliciesCommand,
  DeletePolicyCommand,
  AttachUserPolicyCommand,
  DetachUserPolicyCommand,
  ListAttachedUserPoliciesCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
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
  KMSClient,
  CreateAliasCommand,
  CreateKeyCommand,
  DecryptCommand,
  DescribeKeyCommand,
  EncryptCommand,
  GenerateDataKeyCommand,
  ListAliasesCommand,
  ListKeysCommand,
} from "@aws-sdk/client-kms";
import {
  LambdaClient,
  AddPermissionCommand,
  CreateAliasCommand as CreateLambdaAliasCommand,
  CreateFunctionCommand,
  DeleteAliasCommand as DeleteLambdaAliasCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  GetPolicyCommand as GetLambdaPolicyCommand,
  InvokeCommand,
  ListAliasesCommand as ListLambdaAliasesCommand,
  ListFunctionsCommand,
  ListTagsCommand as ListLambdaTagsCommand,
  ListVersionsByFunctionCommand,
  PublishVersionCommand,
  RemovePermissionCommand,
  TagResourceCommand as TagLambdaResourceCommand,
  UntagResourceCommand as UntagLambdaResourceCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import {
  SecretsManagerClient,
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  ListSecretVersionIdsCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  RestoreSecretCommand,
  TagResourceCommand as TagSecretResourceCommand,
  UntagResourceCommand as UntagSecretResourceCommand,
  UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  SSMClient,
  AddTagsToResourceCommand as AddSSMTagsToResourceCommand,
  DeleteParameterCommand,
  DeleteParametersCommand,
  DescribeParametersCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  GetParametersCommand,
  ListTagsForResourceCommand as ListSSMTagsForResourceCommand,
  PutParameterCommand,
  RemoveTagsFromResourceCommand,
} from "@aws-sdk/client-ssm";
import {
  S3Client,
  ListBucketsCommand,
  HeadBucketCommand,
  GetBucketLocationCommand,
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
  SetQueueAttributesCommand,
  SendMessageCommand,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  DeleteMessageBatchCommand,
  ChangeMessageVisibilityCommand,
  ChangeMessageVisibilityBatchCommand,
  PurgeQueueCommand,
  DeleteQueueCommand as DeleteSQSQueueCommand,
  TagQueueCommand,
  UntagQueueCommand,
  ListQueueTagsCommand,
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

function awsQueryEncoded(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

const describeExternalS3E2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const describeExternalSqsE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const describeExternalSnsE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const describeExternalIamStsE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const describeExternalDynamoDBE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const describeExternalEventBridgeE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const describeExternalCloudWatchLogsE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const describeExternalKMSE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const describeExternalLambdaE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const itExternalLocalLambdaE2E = process.env.AWS_EMULATOR_ALLOW_LOCAL_LAMBDA ? it : it.skip;
const lambdaNodeRunnerZipBase64 =
  "UEsDBBQAAAAIAAAAIVyFNywbwgAAAC8BAAAIAAAAaW5kZXguanNljUEKwjAQRfeeYhAXLZTgulJXunChQvEADe23BtKJJqlWinc3rVQXwmxm5v330V2N9U5cJFcaljKS7sklRbiDfUKlYY/Ox5StqZ/RsDujIbSpozmbCmRbZth5QmNCsGyQ0NWaEs4J8F3sj5vtVyTOLZdeGT4ELl4Fo4VvLY9yoiaEZI2Uigu0NrTof9ZXkXyY0Jr+N4w/i1sL53dV+i2UD5dP1wlqpGLF9Q+q4fPpelINdrxXWisXxbSm5RB7rWZh3lBLAQIUAxQAAAAIAAAAIVyFNywbwgAAAC8BAAAIAAAAAAAAAAAAAACkAQAAAABpbmRleC5qc1BLBQYAAAAAAQABADYAAADoAAAAAAA=";
const lambdaEventBridgeTargetZipBase64 =
  "UEsDBBQAAAAIAC92tlxVY73JegAAAJYAAAAIAAAAaW5kZXguanM9jEEKgzAQRfee4uNKQXKAij1C7zAmUxsaJyWZiEV696YuCn/zH4/H+ysmzeZB4gInTKD8FouONxYdYKMo79pjuuJo8Ps5BjYhLl17OnPybmEEWmdH7YATGsdKPhihlf8Rcy9i1Ue5VdqPtZZYSxIciM8LNBXGZ2zqvlBLAQIUAxQAAAAIAC92tlxVY73JegAAAJYAAAAIAAAAAAAAAAAAAACAAQAAAABpbmRleC5qc1BLBQYAAAAAAQABADYAAACgAAAAAAA=";

const describeExternalSecretsManagerE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;
const describeExternalSSME2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;

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

  it("GetBucketLocation returns configured bucket regions", async () => {
    const bucket = "sdk-e2e-regional";
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        CreateBucketConfiguration: { LocationConstraint: "eu-west-1" },
      }),
    );
    const location = await s3.send(new GetBucketLocationCommand({ Bucket: bucket }));
    expect(location.LocationConstraint).toBe("eu-west-1");
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
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
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: "alias/local",
      }),
    );

    const get = await s3.send(new GetObjectCommand({ Bucket: "emulate-default", Key: "e2e/put-get.txt" }));
    expect(get.ContentType).toBe("text/plain");
    expect(get.LastModified).toBeInstanceOf(Date);
    expect(await streamToString(get.Body)).toBe("hello via sdk");

    const head = await s3.send(new HeadObjectCommand({ Bucket: "emulate-default", Key: "e2e/put-get.txt" }));
    expect(head.ContentType).toBe("text/plain");
    expect(head.LastModified).toBeInstanceOf(Date);
    expect(head.ServerSideEncryption).toBe("aws:kms");
    expect(head.SSEKMSKeyId).toBe("alias/local");

    const range = await s3.send(
      new GetObjectCommand({ Bucket: "emulate-default", Key: "e2e/put-get.txt", Range: "bytes=0-4" }),
    );
    expect(range.ContentRange).toBe("bytes 0-4/13");
    expect(range.ContentLength).toBe(5);
    expect(await streamToString(range.Body)).toBe("hello");

    await expect(
      s3.send(new GetObjectCommand({ Bucket: "emulate-default", Key: "e2e/put-get.txt", IfNoneMatch: head.ETag })),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 304 } });
    await expect(
      s3.send(new GetObjectCommand({ Bucket: "emulate-default", Key: "e2e/put-get.txt", IfMatch: '"not-the-etag"' })),
    ).rejects.toMatchObject({ name: "PreconditionFailed" });
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

  it("batch APIs, visibility changes, queue attributes, and tags roundtrip", async () => {
    const { QueueUrl } = await sqs.send(new CreateSQSQueueCommand({ QueueName: "sdk-e2e-sqs-hardening" }));
    expect(QueueUrl).toBeTruthy();

    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl,
        Attributes: { VisibilityTimeout: "20", ReceiveMessageWaitTimeSeconds: "0" },
      }),
    );
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: ["VisibilityTimeout", "ReceiveMessageWaitTimeSeconds"],
      }),
    );
    expect(attrs.Attributes?.VisibilityTimeout).toBe("20");
    expect(attrs.Attributes?.ReceiveMessageWaitTimeSeconds).toBe("0");

    await sqs.send(new TagQueueCommand({ QueueUrl, Tags: { env: "test", team: "infra" } }));
    let tags = await sqs.send(new ListQueueTagsCommand({ QueueUrl }));
    expect(tags.Tags).toMatchObject({ env: "test", team: "infra" });
    await sqs.send(new UntagQueueCommand({ QueueUrl, TagKeys: ["team"] }));
    tags = await sqs.send(new ListQueueTagsCommand({ QueueUrl }));
    expect(tags.Tags).toMatchObject({ env: "test" });
    expect(tags.Tags?.team).toBeUndefined();

    const sent = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl,
        Entries: [
          {
            Id: "one",
            MessageBody: "batch one",
            MessageAttributes: { kind: { DataType: "String", StringValue: "sdk" } },
          },
          { Id: "two", MessageBody: "batch two" },
        ],
      }),
    );
    expect(sent.Failed ?? []).toHaveLength(0);
    expect(sent.Successful?.map((entry) => entry.Id)).toEqual(expect.arrayContaining(["one", "two"]));
    expect(sent.Successful?.find((entry) => entry.Id === "one")?.MD5OfMessageAttributes).toBeTruthy();

    const firstReceive = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 2 }));
    expect(firstReceive.Messages ?? []).toHaveLength(2);
    const firstReceipts = firstReceive.Messages?.map((message) => message.ReceiptHandle).filter(Boolean) ?? [];
    expect(firstReceipts).toHaveLength(2);

    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl,
        ReceiptHandle: firstReceipts[0],
        VisibilityTimeout: 0,
      }),
    );
    await sqs.send(
      new ChangeMessageVisibilityBatchCommand({
        QueueUrl,
        Entries: [{ Id: "two", ReceiptHandle: firstReceipts[1], VisibilityTimeout: 0 }],
      }),
    );

    const secondReceive = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 2 }));
    expect(secondReceive.Messages?.map((message) => message.Body)).toEqual(
      expect.arrayContaining(["batch one", "batch two"]),
    );
    const deleteEntries =
      secondReceive.Messages?.map((message, index) => ({
        Id: `delete-${index + 1}`,
        ReceiptHandle: message.ReceiptHandle ?? "",
      })) ?? [];
    expect(deleteEntries).toHaveLength(2);

    const deleted = await sqs.send(new DeleteMessageBatchCommand({ QueueUrl, Entries: deleteEntries }));
    expect(deleted.Failed ?? []).toHaveLength(0);
    expect(deleted.Successful ?? []).toHaveLength(2);

    const afterDelete = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }));
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
  let lambda: LambdaClient;
  let logs: CloudWatchLogsClient;

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
    lambda = new LambdaClient({
      endpoint: emulator.url,
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
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
    events.destroy();
    sqs.destroy();
    lambda.destroy();
    logs.destroy();
    await emulator.close();
  });

  itExternalLocalLambdaE2E("routes matching events to a local Lambda target", async () => {
    const suffix = Date.now().toString(36);
    const functionName = `sdk-events-lambda-${suffix}`;
    const ruleName = `sdk-events-lambda-rule-${suffix}`;

    const created = await lambda.send(
      new CreateFunctionCommand({
        FunctionName: functionName,
        Runtime: "nodejs22.x",
        Role: "arn:aws:iam::123456789012:role/lambda-execution-role",
        Handler: "index.handler",
        Code: { ZipFile: Buffer.from(lambdaEventBridgeTargetZipBase64, "base64") },
      }),
    );
    expect(created.FunctionArn).toContain(`:function:${functionName}`);

    await events.send(
      new PutRuleCommand({
        Name: ruleName,
        EventPattern: JSON.stringify({ source: ["app.orders"], "detail-type": ["OrderCreated"] }),
      }),
    );
    await events.send(new PutTargetsCommand({ Rule: ruleName, Targets: [{ Id: "lambda", Arn: created.FunctionArn }] }));

    const published = await events.send(
      new PutEventsCommand({
        Entries: [{ Source: "app.orders", DetailType: "OrderCreated", Detail: JSON.stringify({ name: "Ada" }) }],
      }),
    );
    expect(published.FailedEntryCount).toBe(0);

    const filtered = await logs.send(
      new FilterLogEventsCommand({
        logGroupName: `/aws/lambda/${functionName}`,
        filterPattern: "eventbridge lambda",
      }),
    );
    expect((filtered.events ?? []).map((event) => event.message).join("\n")).toContain(
      `eventbridge lambda Ada ${functionName}`,
    );

    await events.send(new RemoveTargetsCommand({ Rule: ruleName, Ids: ["lambda"] }));
    await events.send(new DeleteRuleCommand({ Name: ruleName }));
    await lambda.send(new DeleteFunctionCommand({ FunctionName: functionName }));
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

describeExternalKMSE2E("AWS native runtime - real @aws-sdk/client-kms E2E", () => {
  let emulator: EmulatorHandle;
  let kms: KMSClient;

  beforeAll(async () => {
    emulator = await startEmulator();
    kms = new KMSClient({
      endpoint: `${emulator.url.replace(/\/$/, "")}/kms/`,
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
  });

  afterAll(async () => {
    kms.destroy();
    await emulator.close();
  });

  it("CreateKey, aliases, Encrypt, Decrypt, and GenerateDataKey roundtrip", async () => {
    const suffix = Date.now().toString(36);
    const aliasName = `alias/sdk-e2e-${suffix}`;

    const created = await kms.send(
      new CreateKeyCommand({
        Description: "SDK KMS key",
        Tags: [{ TagKey: "env", TagValue: "test" }],
      }),
    );
    expect(created.KeyMetadata?.KeyId).toBeTruthy();
    expect(created.KeyMetadata?.Arn).toContain(":key/");
    expect(created.KeyMetadata?.KeyState).toBe("Enabled");

    await kms.send(new CreateAliasCommand({ AliasName: aliasName, TargetKeyId: created.KeyMetadata?.KeyId }));

    const described = await kms.send(new DescribeKeyCommand({ KeyId: aliasName }));
    expect(described.KeyMetadata?.KeyId).toBe(created.KeyMetadata?.KeyId);
    expect(described.KeyMetadata?.Description).toBe("SDK KMS key");

    const keys = await kms.send(new ListKeysCommand({}));
    expect((keys.Keys ?? []).map((key) => key.KeyId)).toContain(created.KeyMetadata?.KeyId);

    const aliases = await kms.send(new ListAliasesCommand({ KeyId: created.KeyMetadata?.KeyId }));
    expect((aliases.Aliases ?? []).map((alias) => alias.AliasName)).toContain(aliasName);

    const encrypted = await kms.send(
      new EncryptCommand({
        KeyId: aliasName,
        Plaintext: Buffer.from("hello kms"),
      }),
    );
    expect(encrypted.CiphertextBlob?.byteLength).toBeGreaterThan(0);
    expect(encrypted.KeyId).toBe(created.KeyMetadata?.Arn);

    const decrypted = await kms.send(
      new DecryptCommand({
        CiphertextBlob: encrypted.CiphertextBlob,
        KeyId: created.KeyMetadata?.Arn,
      }),
    );
    expect(Buffer.from(decrypted.Plaintext ?? []).toString()).toBe("hello kms");

    const dataKey = await kms.send(
      new GenerateDataKeyCommand({ KeyId: created.KeyMetadata?.KeyId, KeySpec: "AES_128" }),
    );
    expect(dataKey.CiphertextBlob?.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(dataKey.Plaintext ?? [])).toHaveLength(16);
    expect(dataKey.KeyId).toBe(created.KeyMetadata?.Arn);
  });
});

describeExternalSecretsManagerE2E("AWS native runtime - real @aws-sdk/client-secrets-manager E2E", () => {
  let emulator: EmulatorHandle;
  let secrets: SecretsManagerClient;

  beforeAll(async () => {
    emulator = await startEmulator();
    secrets = new SecretsManagerClient({
      endpoint: `${emulator.url.replace(/\/$/, "")}/secretsmanager/`,
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
  });

  afterAll(async () => {
    secrets.destroy();
    await emulator.close();
  });

  it("CreateSecret, GetSecretValue, version stages, tags, delete, and restore roundtrip", async () => {
    const suffix = Date.now().toString(36);
    const secretName = `sdk-e2e-secret-${suffix}`;

    const created = await secrets.send(
      new CreateSecretCommand({
        Name: secretName,
        Description: "SDK secret",
        KmsKeyId: "alias/local",
        ClientRequestToken: `${suffix}-one`,
        SecretString: "initial",
        Tags: [{ Key: "env", Value: "test" }],
      }),
    );
    expect(created.ARN).toContain(`:secret:${secretName}-`);
    expect(created.VersionId).toBe(`${suffix}-one`);

    const createdAgain = await secrets.send(
      new CreateSecretCommand({
        Name: secretName,
        Description: "SDK secret",
        KmsKeyId: "alias/local",
        ClientRequestToken: `${suffix}-one`,
        SecretString: "initial",
        Tags: [{ Key: "env", Value: "test" }],
      }),
    );
    expect(createdAgain.VersionId).toBe(`${suffix}-one`);

    const initial = await secrets.send(new GetSecretValueCommand({ SecretId: secretName }));
    expect(initial.SecretString).toBe("initial");
    expect(initial.VersionStages).toEqual(["AWSCURRENT"]);

    const rotated = await secrets.send(
      new PutSecretValueCommand({
        SecretId: created.ARN,
        ClientRequestToken: `${suffix}-two`,
        SecretString: "rotated",
      }),
    );
    expect(rotated.VersionId).toBe(`${suffix}-two`);

    const current = await secrets.send(new GetSecretValueCommand({ SecretId: secretName }));
    expect(current.SecretString).toBe("rotated");
    expect(current.VersionStages).toEqual(["AWSCURRENT"]);

    const previous = await secrets.send(
      new GetSecretValueCommand({
        SecretId: secretName,
        VersionId: created.VersionId,
      }),
    );
    expect(previous.SecretString).toBe("initial");
    expect(previous.VersionStages).toEqual(["AWSPREVIOUS"]);

    const updated = await secrets.send(
      new UpdateSecretCommand({
        SecretId: secretName,
        Description: "Updated SDK secret",
        ClientRequestToken: `${suffix}-three`,
        SecretString: "updated",
      }),
    );
    expect(updated.VersionId).toBe(`${suffix}-three`);
    const afterUpdate = await secrets.send(new GetSecretValueCommand({ SecretId: secretName }));
    expect(afterUpdate.SecretString).toBe("updated");

    await secrets.send(
      new TagSecretResourceCommand({
        SecretId: secretName,
        Tags: [{ Key: "team", Value: "platform" }],
      }),
    );
    await secrets.send(new UntagSecretResourceCommand({ SecretId: secretName, TagKeys: ["team"] }));
    const described = await secrets.send(new DescribeSecretCommand({ SecretId: secretName }));
    expect(described.Description).toBe("Updated SDK secret");
    expect(described.KmsKeyId).toBe("alias/local");
    expect(described.Tags).toEqual(expect.arrayContaining([{ Key: "env", Value: "test" }]));
    expect(described.Tags ?? []).not.toEqual(expect.arrayContaining([{ Key: "team", Value: "platform" }]));
    expect(described.VersionIdsToStages?.[`${suffix}-one`] ?? []).toEqual([]);
    expect(described.VersionIdsToStages?.[`${suffix}-two`]).toEqual(["AWSPREVIOUS"]);
    expect(described.VersionIdsToStages?.[`${suffix}-three`]).toEqual(["AWSCURRENT"]);

    const versions = await secrets.send(new ListSecretVersionIdsCommand({ SecretId: secretName }));
    expect((versions.Versions ?? []).map((item) => item.VersionId)).toEqual(
      expect.arrayContaining([`${suffix}-two`, `${suffix}-three`]),
    );

    const listed = await secrets.send(new ListSecretsCommand({}));
    expect((listed.SecretList ?? []).map((item) => item.Name)).toContain(secretName);

    await secrets.send(new DeleteSecretCommand({ SecretId: secretName, RecoveryWindowInDays: 7 }));
    await expect(secrets.send(new GetSecretValueCommand({ SecretId: secretName }))).rejects.toMatchObject({
      name: "InvalidRequestException",
    });

    const plannedDeletion = await secrets.send(new ListSecretsCommand({ IncludePlannedDeletion: true }));
    expect((plannedDeletion.SecretList ?? []).map((item) => item.Name)).toContain(secretName);

    await secrets.send(new RestoreSecretCommand({ SecretId: secretName }));
    const restored = await secrets.send(new GetSecretValueCommand({ SecretId: secretName }));
    expect(restored.SecretString).toBe("updated");

    await secrets.send(new DeleteSecretCommand({ SecretId: secretName, ForceDeleteWithoutRecovery: true }));
    await expect(secrets.send(new RestoreSecretCommand({ SecretId: secretName }))).rejects.toMatchObject({
      name: "ResourceNotFoundException",
    });

    const recreated = await secrets.send(
      new CreateSecretCommand({
        Name: secretName,
        ClientRequestToken: `${suffix}-after-force`,
        SecretString: "after-force",
      }),
    );
    expect(recreated.VersionId).toBe(`${suffix}-after-force`);
    await secrets.send(new DeleteSecretCommand({ SecretId: secretName, ForceDeleteWithoutRecovery: true }));
  });

  it("SecretBinary roundtrips as Uint8Array", async () => {
    const suffix = Date.now().toString(36);
    const secretName = `sdk-e2e-binary-${suffix}`;
    await secrets.send(
      new CreateSecretCommand({
        Name: secretName,
        SecretBinary: new Uint8Array([1, 2, 3, 4]),
      }),
    );

    const got = await secrets.send(new GetSecretValueCommand({ SecretId: secretName }));
    expect(Buffer.from(got.SecretBinary ?? [])).toEqual(Buffer.from([1, 2, 3, 4]));

    await secrets.send(new DeleteSecretCommand({ SecretId: secretName, ForceDeleteWithoutRecovery: true }));
  });
});

describeExternalLambdaE2E("AWS native runtime - real @aws-sdk/client-lambda E2E", () => {
  let emulator: EmulatorHandle;
  let lambda: LambdaClient;

  beforeAll(async () => {
    emulator = await startEmulator();
    lambda = new LambdaClient({
      endpoint: emulator.url,
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
  });

  afterAll(async () => {
    lambda.destroy();
    await emulator.close();
  });

  itExternalLocalLambdaE2E("runs a zipped Node.js handler and returns logs", async () => {
    const suffix = Date.now().toString(36);
    const functionName = `sdk-lambda-runner-${suffix}`;

    await lambda.send(
      new CreateFunctionCommand({
        FunctionName: functionName,
        Runtime: "nodejs22.x",
        Role: "arn:aws:iam::123456789012:role/lambda-execution-role",
        Handler: "index.handler",
        Code: { ZipFile: Buffer.from(lambdaNodeRunnerZipBase64, "base64") },
        Environment: { Variables: { MODE: "sdk" } },
      }),
    );

    const invoked = await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        Payload: Buffer.from(JSON.stringify({ name: "Ada" })),
        LogType: "Tail",
      }),
    );
    expect(invoked.StatusCode).toBe(200);
    expect(invoked.FunctionError).toBeUndefined();
    const payload = JSON.parse(Buffer.from(invoked.Payload ?? []).toString());
    expect(payload).toMatchObject({ message: "hello Ada", mode: "sdk", remaining: true });
    expect(payload.requestId).toBeTruthy();
    expect(Buffer.from(invoked.LogResult ?? "", "base64").toString()).toContain(`node runner Ada sdk ${functionName}`);

    await lambda.send(new DeleteFunctionCommand({ FunctionName: functionName }));
  });

  it("function CRUD, invoke stubs, aliases, versions, tags, and policy roundtrip", async () => {
    const suffix = Date.now().toString(36);
    const functionName = `sdk-lambda-${suffix}`;
    const zip = Buffer.from("exports.handler = async () => ({ ok: true })");

    const created = await lambda.send(
      new CreateFunctionCommand({
        FunctionName: functionName,
        Runtime: "python3.12",
        Role: "arn:aws:iam::123456789012:role/lambda-execution-role",
        Handler: "index.handler",
        Code: { ZipFile: zip },
        Description: "SDK Lambda function",
        Environment: { Variables: { MODE: "test" } },
        Tags: { team: "platform" },
      }),
    );
    expect(created.FunctionName).toBe(functionName);
    expect(created.FunctionArn).toContain(`:function:${functionName}`);
    expect(created.State).toBe("Active");
    expect(created.CodeSize).toBe(zip.byteLength);

    const listed = await lambda.send(new ListFunctionsCommand({}));
    expect((listed.Functions ?? []).map((fn) => fn.FunctionName)).toContain(functionName);

    const got = await lambda.send(new GetFunctionCommand({ FunctionName: functionName }));
    expect(got.Configuration?.FunctionName).toBe(functionName);
    expect(got.Tags?.team).toBe("platform");

    const updatedConfig = await lambda.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: functionName,
        Timeout: 9,
        MemorySize: 256,
        Environment: { Variables: { MODE: "updated" } },
      }),
    );
    expect(updatedConfig.Timeout).toBe(9);
    expect(updatedConfig.MemorySize).toBe(256);
    expect(updatedConfig.Environment?.Variables?.MODE).toBe("updated");

    const updatedCode = await lambda.send(
      new UpdateFunctionCodeCommand({
        FunctionName: functionName,
        ZipFile: Buffer.from("exports.handler = async () => ({ ok: 'updated' })"),
      }),
    );
    expect(updatedCode.CodeSize).toBeGreaterThan(0);

    const invoked = await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        Payload: Buffer.from(JSON.stringify({ hello: "world" })),
        LogType: "Tail",
      }),
    );
    expect(invoked.StatusCode).toBe(200);
    expect(Buffer.from(invoked.Payload ?? []).toString()).toBe("{}");
    expect(invoked.LogResult).toBeTruthy();

    const version = await lambda.send(new PublishVersionCommand({ FunctionName: functionName, Description: "first" }));
    expect(version.Version).toBe("1");

    const versions = await lambda.send(new ListVersionsByFunctionCommand({ FunctionName: functionName }));
    expect((versions.Versions ?? []).map((item) => item.Version)).toEqual(expect.arrayContaining(["$LATEST", "1"]));

    const allFunctions = await lambda.send(new ListFunctionsCommand({ FunctionVersion: "ALL" }));
    expect(
      (allFunctions.Functions ?? []).filter((item) => item.FunctionName === functionName).map((item) => item.Version),
    ).toEqual(expect.arrayContaining(["$LATEST", "1"]));

    const alias = await lambda.send(
      new CreateLambdaAliasCommand({ FunctionName: functionName, Name: "live", FunctionVersion: "1" }),
    );
    expect(alias.Name).toBe("live");
    expect(alias.FunctionVersion).toBe("1");

    const aliases = await lambda.send(new ListLambdaAliasesCommand({ FunctionName: functionName }));
    expect((aliases.Aliases ?? []).map((item) => item.Name)).toContain("live");

    const liveArn = `${created.FunctionArn}:live`;
    const qualifiedConfig = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: liveArn }));
    expect(qualifiedConfig.Version).toBe("1");

    const qualifiedInvoked = await lambda.send(new InvokeCommand({ FunctionName: liveArn }));
    expect(qualifiedInvoked.StatusCode).toBe(200);
    expect(qualifiedInvoked.ExecutedVersion).toBe("1");

    await lambda.send(new TagLambdaResourceCommand({ Resource: created.FunctionArn, Tags: { stage: "dev" } }));
    const tags = await lambda.send(new ListLambdaTagsCommand({ Resource: created.FunctionArn }));
    expect(tags.Tags?.team).toBe("platform");
    expect(tags.Tags?.stage).toBe("dev");
    await lambda.send(new UntagLambdaResourceCommand({ Resource: created.FunctionArn, TagKeys: ["stage"] }));

    const permission = await lambda.send(
      new AddPermissionCommand({
        FunctionName: functionName,
        StatementId: "allow-events",
        Action: "lambda:InvokeFunction",
        Principal: "events.amazonaws.com",
        SourceArn: "arn:aws:events:us-east-1:123456789012:rule/app",
      }),
    );
    expect(permission.Statement).toContain("allow-events");
    expect(JSON.parse(permission.Statement ?? "{}").Resource).toBe(created.FunctionArn);

    const qualifiedPermission = await lambda.send(
      new AddPermissionCommand({
        FunctionName: liveArn,
        StatementId: "allow-live",
        Action: "lambda:InvokeFunction",
        Principal: "events.amazonaws.com",
      }),
    );
    expect(JSON.parse(qualifiedPermission.Statement ?? "{}").Resource).toBe(liveArn);

    const policy = await lambda.send(new GetLambdaPolicyCommand({ FunctionName: functionName }));
    expect(policy.Policy).toContain("allow-events");
    expect(policy.Policy).toContain("allow-live");
    expect(policy.Policy).toContain(liveArn);

    await lambda.send(new RemovePermissionCommand({ FunctionName: functionName, StatementId: "allow-events" }));
    await lambda.send(new RemovePermissionCommand({ FunctionName: liveArn, StatementId: "allow-live" }));
    await lambda.send(new DeleteLambdaAliasCommand({ FunctionName: functionName, Name: "live" }));
    await lambda.send(new DeleteFunctionCommand({ FunctionName: `${created.FunctionArn}:1` }));
    const latestAfterVersionDelete = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: functionName }),
    );
    expect(latestAfterVersionDelete.Version).toBe("$LATEST");
    await lambda.send(new DeleteFunctionCommand({ FunctionName: functionName }));
    await expect(
      lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName })),
    ).rejects.toMatchObject({
      name: "ResourceNotFoundException",
    });
  });
});

describeExternalSSME2E("AWS native runtime - real @aws-sdk/client-ssm E2E", () => {
  let emulator: EmulatorHandle;
  let ssm: SSMClient;

  beforeAll(async () => {
    emulator = await startEmulator();
    ssm = new SSMClient({
      endpoint: `${emulator.url.replace(/\/$/, "")}/ssm/`,
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
  });

  afterAll(async () => {
    ssm.destroy();
    await emulator.close();
  });

  it("PutParameter, GetParameter, path queries, tags, describe, and deletes roundtrip", async () => {
    const suffix = Date.now().toString(36);
    const root = `/sdk/ssm/${suffix}`;
    const dbName = `${root}/database-url`;
    const listName = `${root}/list`;
    const nestedName = `${root}/nested/value`;

    const created = await ssm.send(
      new PutParameterCommand({
        Name: dbName,
        Type: "SecureString",
        Value: "postgres://initial",
        KeyId: "alias/local",
        Description: "SDK database URL",
        Tags: [{ Key: "env", Value: "test" }],
      }),
    );
    expect(created.Version).toBe(1);
    expect(created.Tier).toBe("Standard");

    await expect(ssm.send(new PutParameterCommand({ Name: dbName, Value: "duplicate" }))).rejects.toMatchObject({
      name: "ParameterAlreadyExists",
    });

    const overwritten = await ssm.send(
      new PutParameterCommand({
        Name: dbName,
        Type: "SecureString",
        Value: "postgres://rotated",
        Overwrite: true,
      }),
    );
    expect(overwritten.Version).toBe(2);

    await ssm.send(new PutParameterCommand({ Name: listName, Type: "StringList", Value: "one,two" }));
    await ssm.send(new PutParameterCommand({ Name: nestedName, Type: "String", Value: "nested" }));

    const current = await ssm.send(new GetParameterCommand({ Name: dbName, WithDecryption: true }));
    expect(current.Parameter?.Name).toBe(dbName);
    expect(current.Parameter?.Type).toBe("SecureString");
    expect(current.Parameter?.Value).toBe("postgres://rotated");
    expect(current.Parameter?.Version).toBe(2);
    expect(current.Parameter?.ARN).toBe(`arn:aws:ssm:us-east-1:123456789012:parameter${dbName}`);

    const previous = await ssm.send(new GetParameterCommand({ Name: `${dbName}:1`, WithDecryption: true }));
    expect(previous.Parameter?.Value).toBe("postgres://initial");
    expect(previous.Parameter?.Version).toBe(1);

    const batch = await ssm.send(
      new GetParametersCommand({ Names: [dbName, listName, `${root}/missing`], WithDecryption: true }),
    );
    expect((batch.Parameters ?? []).map((item) => item.Name)).toEqual([dbName, listName]);
    expect(batch.InvalidParameters).toEqual([`${root}/missing`]);

    const oneLevel = await ssm.send(new GetParametersByPathCommand({ Path: root, Recursive: false }));
    expect((oneLevel.Parameters ?? []).map((item) => item.Name)).toEqual([dbName, listName]);

    const pageOne = await ssm.send(new GetParametersByPathCommand({ Path: root, Recursive: true, MaxResults: 2 }));
    expect((pageOne.Parameters ?? []).map((item) => item.Name)).toEqual([dbName, listName]);
    expect(pageOne.NextToken).toBeTruthy();
    const pageTwo = await ssm.send(
      new GetParametersByPathCommand({ Path: root, Recursive: true, NextToken: pageOne.NextToken }),
    );
    expect((pageTwo.Parameters ?? []).map((item) => item.Name)).toEqual([nestedName]);

    await ssm.send(
      new AddSSMTagsToResourceCommand({
        ResourceType: "Parameter",
        ResourceId: dbName,
        Tags: [{ Key: "team", Value: "platform" }],
      }),
    );
    const tags = await ssm.send(new ListSSMTagsForResourceCommand({ ResourceType: "Parameter", ResourceId: dbName }));
    expect(tags.TagList).toEqual(
      expect.arrayContaining([
        { Key: "env", Value: "test" },
        { Key: "team", Value: "platform" },
      ]),
    );
    await ssm.send(
      new RemoveTagsFromResourceCommand({ ResourceType: "Parameter", ResourceId: dbName, TagKeys: ["team"] }),
    );
    const afterRemove = await ssm.send(
      new ListSSMTagsForResourceCommand({ ResourceType: "Parameter", ResourceId: dbName }),
    );
    expect(afterRemove.TagList ?? []).not.toEqual(expect.arrayContaining([{ Key: "team", Value: "platform" }]));

    const described = await ssm.send(
      new DescribeParametersCommand({
        ParameterFilters: [{ Key: "Path", Option: "Recursive", Values: [root] }],
      }),
    );
    expect((described.Parameters ?? []).map((item) => item.Name)).toEqual([dbName, listName, nestedName]);
    expect(described.Parameters?.find((item) => item.Name === dbName)?.KeyId).toBe("alias/local");

    await ssm.send(new DeleteParameterCommand({ Name: listName }));
    await ssm.send(new DeleteParametersCommand({ Names: [dbName, nestedName, `${root}/missing`] }));
    await expect(ssm.send(new GetParameterCommand({ Name: dbName }))).rejects.toMatchObject({
      name: "ParameterNotFound",
    });
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

  it("inline and managed policies roundtrip for users and roles", async () => {
    const policyDocument = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "s3:ListBucket", Resource: "*" }],
    });

    await iam.send(new CreateUserCommand({ UserName: "sdk-policy-user" }));
    await iam.send(
      new PutUserPolicyCommand({
        UserName: "sdk-policy-user",
        PolicyName: "inline-user",
        PolicyDocument: policyDocument,
      }),
    );
    const userPolicies = await iam.send(new ListUserPoliciesCommand({ UserName: "sdk-policy-user" }));
    expect(userPolicies.PolicyNames ?? []).toContain("inline-user");
    const userPolicy = await iam.send(
      new GetUserPolicyCommand({ UserName: "sdk-policy-user", PolicyName: "inline-user" }),
    );
    expect(userPolicy.PolicyDocument).toBe(awsQueryEncoded(policyDocument));

    const role = await iam.send(
      new CreateRoleCommand({
        RoleName: "sdk-policy-role",
        AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [] }),
      }),
    );
    await iam.send(
      new PutRolePolicyCommand({
        RoleName: "sdk-policy-role",
        PolicyName: "inline-role",
        PolicyDocument: policyDocument,
      }),
    );
    const rolePolicies = await iam.send(new ListRolePoliciesCommand({ RoleName: "sdk-policy-role" }));
    expect(rolePolicies.PolicyNames ?? []).toContain("inline-role");
    const rolePolicy = await iam.send(
      new GetRolePolicyCommand({ RoleName: "sdk-policy-role", PolicyName: "inline-role" }),
    );
    expect(rolePolicy.PolicyDocument).toBe(awsQueryEncoded(policyDocument));

    const managed = await iam.send(
      new CreatePolicyCommand({
        PolicyName: "sdk-managed-policy",
        Path: "/team/",
        Description: "SDK managed policy",
        PolicyDocument: policyDocument,
      }),
    );
    expect(managed.Policy?.Arn).toBe("arn:aws:iam::123456789012:policy/team/sdk-managed-policy");

    const policy = await iam.send(new GetPolicyCommand({ PolicyArn: managed.Policy?.Arn }));
    expect(policy.Policy?.PolicyName).toBe("sdk-managed-policy");
    const version = await iam.send(
      new GetPolicyVersionCommand({ PolicyArn: managed.Policy?.Arn, VersionId: policy.Policy?.DefaultVersionId }),
    );
    expect(version.PolicyVersion?.Document).toBe(awsQueryEncoded(policyDocument));

    const listed = await iam.send(new ListPoliciesCommand({ PathPrefix: "/team/" }));
    expect((listed.Policies ?? []).map((item) => item.Arn)).toContain(managed.Policy?.Arn);

    await iam.send(new AttachUserPolicyCommand({ UserName: "sdk-policy-user", PolicyArn: managed.Policy?.Arn }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: "sdk-policy-role", PolicyArn: managed.Policy?.Arn }));
    const attachedUserPolicies = await iam.send(new ListAttachedUserPoliciesCommand({ UserName: "sdk-policy-user" }));
    expect((attachedUserPolicies.AttachedPolicies ?? []).map((item) => item.PolicyArn)).toContain(managed.Policy?.Arn);
    const attachedRolePolicies = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: "sdk-policy-role" }));
    expect((attachedRolePolicies.AttachedPolicies ?? []).map((item) => item.PolicyArn)).toContain(managed.Policy?.Arn);

    const awsManagedPolicyArn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
    await iam.send(new AttachUserPolicyCommand({ UserName: "sdk-policy-user", PolicyArn: awsManagedPolicyArn }));
    await iam.send(new AttachRolePolicyCommand({ RoleName: "sdk-policy-role", PolicyArn: awsManagedPolicyArn }));
    const awsManagedUserPolicies = await iam.send(
      new ListAttachedUserPoliciesCommand({ UserName: "sdk-policy-user", PathPrefix: "/service-role/" }),
    );
    expect((awsManagedUserPolicies.AttachedPolicies ?? []).map((item) => item.PolicyArn)).toContain(
      awsManagedPolicyArn,
    );
    const awsManagedRolePolicies = await iam.send(
      new ListAttachedRolePoliciesCommand({ RoleName: "sdk-policy-role", PathPrefix: "/service-role/" }),
    );
    expect((awsManagedRolePolicies.AttachedPolicies ?? []).map((item) => item.PolicyArn)).toContain(
      awsManagedPolicyArn,
    );

    await iam.send(new DetachUserPolicyCommand({ UserName: "sdk-policy-user", PolicyArn: awsManagedPolicyArn }));
    await iam.send(new DetachRolePolicyCommand({ RoleName: "sdk-policy-role", PolicyArn: awsManagedPolicyArn }));
    await iam.send(new DetachUserPolicyCommand({ UserName: "sdk-policy-user", PolicyArn: managed.Policy?.Arn }));
    await iam.send(new DetachRolePolicyCommand({ RoleName: "sdk-policy-role", PolicyArn: managed.Policy?.Arn }));
    await iam.send(new DeleteUserPolicyCommand({ UserName: "sdk-policy-user", PolicyName: "inline-user" }));
    await iam.send(new DeleteRolePolicyCommand({ RoleName: "sdk-policy-role", PolicyName: "inline-role" }));
    await iam.send(new DeletePolicyCommand({ PolicyArn: managed.Policy?.Arn }));
    await iam.send(new DeleteUserCommand({ UserName: "sdk-policy-user" }));
    await iam.send(new DeleteRoleCommand({ RoleName: "sdk-policy-role" }));
    expect(role.Role?.Arn).toBe("arn:aws:iam::123456789012:role/sdk-policy-role");
  });

  it("CreateRole, GetRole, ListRoles, AssumeRole, and DeleteRole roundtrip", async () => {
    const created = await iam.send(
      new CreateRoleCommand({
        RoleName: "sdk-role",
        Description: "SDK role",
        MaxSessionDuration: 7200,
        AssumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [] }),
      }),
    );
    expect(created.Role?.Arn).toBe("arn:aws:iam::123456789012:role/sdk-role");
    expect(created.Role?.MaxSessionDuration).toBe(7200);

    const byName = await iam.send(new GetRoleCommand({ RoleName: "sdk-role" }));
    expect(byName.Role?.Description).toBe("SDK role");
    expect(byName.Role?.MaxSessionDuration).toBe(7200);

    const listed = await iam.send(new ListRolesCommand({}));
    expect((listed.Roles ?? []).map((role) => role.RoleName)).toContain("sdk-role");

    const assumed = await sts.send(
      new AssumeRoleCommand({
        RoleArn: created.Role?.Arn,
        RoleSessionName: "sdk-session",
        DurationSeconds: 7200,
        Tags: [{ Key: "env", Value: "test" }],
        TransitiveTagKeys: ["env"],
      }),
    );
    expect(assumed.Credentials?.AccessKeyId).toMatch(/^ASIA/);
    expect(assumed.Credentials?.SessionToken).toBeTruthy();
    expect(assumed.Credentials?.Expiration).toBeTruthy();
    expect(assumed.PackedPolicySize).toBe(0);
    const expectedAssumedArn = `arn:aws:sts::123456789012:assumed-role/${created.Role?.RoleName}/sdk-session`;
    expect(assumed.AssumedRoleUser?.Arn).toBe(expectedAssumedArn);

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
      expect(identity.Arn).toBe(expectedAssumedArn);
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
