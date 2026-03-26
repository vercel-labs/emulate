import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher, authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { awsPlugin, seedFromConfig, getAwsStore } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-aws-token", {
    login: "admin",
    id: 1,
    scopes: ["s3:*", "sqs:*", "iam:*", "sts:*"],
  });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  awsPlugin.register(app as any, store, webhooks, base, tokenMap);
  awsPlugin.seed!(store, base);

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): HeadersInit {
  return { Authorization: "Bearer test-aws-token" };
}

describe("AWS plugin - S3 Buckets", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("lists default buckets", async () => {
    const res = await app.request(`${base}/s3/`, { method: "GET", headers: authHeaders() });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("emulate-default");
    expect(text).toContain("ListAllMyBucketsResult");
  });

  it("creates a bucket", async () => {
    const res = await app.request(`${base}/s3/my-test-bucket`, {
      method: "PUT",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);

    // Verify bucket appears in list
    const listRes = await app.request(`${base}/s3/`, { method: "GET", headers: authHeaders() });
    const text = await listRes.text();
    expect(text).toContain("my-test-bucket");
  });

  it("rejects duplicate bucket", async () => {
    await app.request(`${base}/s3/dup-bucket`, { method: "PUT", headers: authHeaders() });
    const res = await app.request(`${base}/s3/dup-bucket`, { method: "PUT", headers: authHeaders() });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("BucketAlreadyOwnedByYou");
  });

  it("deletes a bucket", async () => {
    await app.request(`${base}/s3/del-bucket`, { method: "PUT", headers: authHeaders() });
    const res = await app.request(`${base}/s3/del-bucket`, { method: "DELETE", headers: authHeaders() });
    expect(res.status).toBe(204);
  });

  it("rejects deleting non-empty bucket", async () => {
    await app.request(`${base}/s3/full-bucket`, { method: "PUT", headers: authHeaders() });
    await app.request(`${base}/s3/full-bucket/file.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "hello",
    });
    const res = await app.request(`${base}/s3/full-bucket`, { method: "DELETE", headers: authHeaders() });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("BucketNotEmpty");
  });

  it("checks bucket existence with HEAD", async () => {
    const res = await app.request(`${base}/s3/emulate-default`, { method: "HEAD", headers: authHeaders() });
    expect(res.status).toBe(200);

    const notFound = await app.request(`${base}/s3/nonexistent`, { method: "HEAD", headers: authHeaders() });
    expect(notFound.status).toBe(404);
  });
});

describe("AWS plugin - S3 Objects", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("puts and gets an object", async () => {
    const putRes = await app.request(`${base}/s3/emulate-default/test.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "hello world",
    });
    expect(putRes.status).toBe(200);
    expect(putRes.headers.get("ETag")).toBeDefined();

    const getRes = await app.request(`${base}/s3/emulate-default/test.txt`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(200);
    const body = await getRes.text();
    expect(body).toBe("hello world");
    expect(getRes.headers.get("Content-Type")).toBe("text/plain");
  });

  it("returns 404 for missing object", async () => {
    const res = await app.request(`${base}/s3/emulate-default/missing.txt`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain("NoSuchKey");
  });

  it("overwrites an existing object", async () => {
    await app.request(`${base}/s3/emulate-default/overwrite.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "version 1",
    });
    await app.request(`${base}/s3/emulate-default/overwrite.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "version 2",
    });

    const res = await app.request(`${base}/s3/emulate-default/overwrite.txt`, {
      method: "GET",
      headers: authHeaders(),
    });
    const body = await res.text();
    expect(body).toBe("version 2");
  });

  it("deletes an object", async () => {
    await app.request(`${base}/s3/emulate-default/to-delete.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "delete me",
    });

    const delRes = await app.request(`${base}/s3/emulate-default/to-delete.txt`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(delRes.status).toBe(204);

    const getRes = await app.request(`${base}/s3/emulate-default/to-delete.txt`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(404);
  });

  it("lists objects in a bucket", async () => {
    await app.request(`${base}/s3/emulate-default/dir/a.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "a",
    });
    await app.request(`${base}/s3/emulate-default/dir/b.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "b",
    });

    const res = await app.request(`${base}/s3/emulate-default?prefix=dir/`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("dir/a.txt");
    expect(text).toContain("dir/b.txt");
  });

  it("handles HEAD for objects", async () => {
    await app.request(`${base}/s3/emulate-default/head-test.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "head test",
    });

    const res = await app.request(`${base}/s3/emulate-default/head-test.txt`, {
      method: "HEAD",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  it("copies an object with x-amz-copy-source", async () => {
    await app.request(`${base}/s3/emulate-default/source.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "copy me",
    });

    const copyRes = await app.request(`${base}/s3/emulate-default/dest.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "x-amz-copy-source": "/emulate-default/source.txt" },
    });
    expect(copyRes.status).toBe(200);
    const copyText = await copyRes.text();
    expect(copyText).toContain("CopyObjectResult");

    const getRes = await app.request(`${base}/s3/emulate-default/dest.txt`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(200);
    const body = await getRes.text();
    expect(body).toBe("copy me");
  });
});

describe("AWS plugin - SQS", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("creates a queue", async () => {
    const res = await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=CreateQueue&QueueName=test-queue",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("test-queue");
    expect(text).toContain("CreateQueueResponse");
  });

  it("lists queues", async () => {
    const res = await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=ListQueues",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("emulate-default-queue");
  });

  it("sends and receives a message", async () => {
    // Get queue URL
    const urlRes = await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=GetQueueUrl&QueueName=emulate-default-queue",
    });
    const urlText = await urlRes.text();
    const queueUrl = urlText.match(/<QueueUrl>(.*?)<\/QueueUrl>/)?.[1] ?? "";

    // Send message
    const sendRes = await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: `Action=SendMessage&QueueUrl=${encodeURIComponent(queueUrl)}&MessageBody=test+message`,
    });
    expect(sendRes.status).toBe(200);
    const sendText = await sendRes.text();
    expect(sendText).toContain("SendMessageResponse");
    expect(sendText).toContain("MessageId");

    // Receive message
    const recvRes = await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: `Action=ReceiveMessage&QueueUrl=${encodeURIComponent(queueUrl)}&MaxNumberOfMessages=1`,
    });
    expect(recvRes.status).toBe(200);
    const recvText = await recvRes.text();
    expect(recvText).toContain("test message");
    expect(recvText).toContain("ReceiptHandle");
  });

  it("deletes a message", async () => {
    const urlRes = await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=GetQueueUrl&QueueName=emulate-default-queue",
    });
    const urlText = await urlRes.text();
    const queueUrl = urlText.match(/<QueueUrl>(.*?)<\/QueueUrl>/)?.[1] ?? "";

    // Send message
    await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: `Action=SendMessage&QueueUrl=${encodeURIComponent(queueUrl)}&MessageBody=delete+me`,
    });

    // Receive to get receipt handle
    const recvRes = await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: `Action=ReceiveMessage&QueueUrl=${encodeURIComponent(queueUrl)}`,
    });
    const recvText = await recvRes.text();
    const receiptHandle = recvText.match(/<ReceiptHandle>(.*?)<\/ReceiptHandle>/)?.[1] ?? "";

    // Delete message
    const delRes = await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: `Action=DeleteMessage&QueueUrl=${encodeURIComponent(queueUrl)}&ReceiptHandle=${encodeURIComponent(receiptHandle)}`,
    });
    expect(delRes.status).toBe(200);
    const delText = await delRes.text();
    expect(delText).toContain("DeleteMessageResponse");
  });

  it("purges a queue", async () => {
    const urlRes = await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=GetQueueUrl&QueueName=emulate-default-queue",
    });
    const urlText = await urlRes.text();
    const queueUrl = urlText.match(/<QueueUrl>(.*?)<\/QueueUrl>/)?.[1] ?? "";

    // Send some messages
    for (let i = 0; i < 3; i++) {
      await app.request(`${base}/sqs/`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
        body: `Action=SendMessage&QueueUrl=${encodeURIComponent(queueUrl)}&MessageBody=msg${i}`,
      });
    }

    // Purge
    const purgeRes = await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: `Action=PurgeQueue&QueueUrl=${encodeURIComponent(queueUrl)}`,
    });
    expect(purgeRes.status).toBe(200);

    // Verify empty
    const recvRes = await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: `Action=ReceiveMessage&QueueUrl=${encodeURIComponent(queueUrl)}`,
    });
    const recvText = await recvRes.text();
    expect(recvText).not.toContain("<Message>");
  });

  it("gets queue attributes", async () => {
    const urlRes = await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=GetQueueUrl&QueueName=emulate-default-queue",
    });
    const urlText = await urlRes.text();
    const queueUrl = urlText.match(/<QueueUrl>(.*?)<\/QueueUrl>/)?.[1] ?? "";

    const res = await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: `Action=GetQueueAttributes&QueueUrl=${encodeURIComponent(queueUrl)}`,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("QueueArn");
    expect(text).toContain("VisibilityTimeout");
  });

  it("deletes a queue", async () => {
    // Create and then delete
    await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=CreateQueue&QueueName=delete-me-queue",
    });

    const urlRes = await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=GetQueueUrl&QueueName=delete-me-queue",
    });
    const urlText = await urlRes.text();
    const queueUrl = urlText.match(/<QueueUrl>(.*?)<\/QueueUrl>/)?.[1] ?? "";

    const res = await app.request(`${base}/sqs/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: `Action=DeleteQueue&QueueUrl=${encodeURIComponent(queueUrl)}`,
    });
    expect(res.status).toBe(200);
  });
});

describe("AWS plugin - IAM", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("creates a user", async () => {
    const res = await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=CreateUser&UserName=testuser",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("testuser");
    expect(text).toContain("CreateUserResponse");
  });

  it("gets a user", async () => {
    const res = await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=GetUser&UserName=admin",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("admin");
  });

  it("lists users", async () => {
    const res = await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=ListUsers",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("admin");
    expect(text).toContain("ListUsersResponse");
  });

  it("creates and lists access keys", async () => {
    const createRes = await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=CreateAccessKey&UserName=admin",
    });
    expect(createRes.status).toBe(200);
    const createText = await createRes.text();
    expect(createText).toContain("AccessKeyId");
    expect(createText).toContain("SecretAccessKey");

    const listRes = await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=ListAccessKeys&UserName=admin",
    });
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText).toContain("AccessKeyId");
  });

  it("deletes a user", async () => {
    // Create first
    await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=CreateUser&UserName=delete-me",
    });

    const res = await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=DeleteUser&UserName=delete-me",
    });
    expect(res.status).toBe(200);

    // Verify deleted
    const getRes = await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=GetUser&UserName=delete-me",
    });
    expect(getRes.status).toBe(404);
  });

  it("rejects duplicate user", async () => {
    await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=CreateUser&UserName=dup-user",
    });
    const res = await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=CreateUser&UserName=dup-user",
    });
    expect(res.status).toBe(409);
  });

  it("creates and gets a role", async () => {
    const createRes = await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=CreateRole&RoleName=test-role&Description=A+test+role",
    });
    expect(createRes.status).toBe(200);
    const createText = await createRes.text();
    expect(createText).toContain("test-role");

    const getRes = await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=GetRole&RoleName=test-role",
    });
    expect(getRes.status).toBe(200);
    const getText = await getRes.text();
    expect(getText).toContain("test-role");
    expect(getText).toContain("A test role");
  });

  it("lists roles", async () => {
    await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=CreateRole&RoleName=list-role",
    });

    const res = await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=ListRoles",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("list-role");
  });
});

describe("AWS plugin - STS", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("gets caller identity", async () => {
    const res = await app.request(`${base}/sts/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=GetCallerIdentity",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("GetCallerIdentityResponse");
    expect(text).toContain("Account");
    expect(text).toContain("123456789012");
  });

  it("assumes a role", async () => {
    // Create a role first
    await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=CreateRole&RoleName=assume-me",
    });

    // Get the role's ARN
    const getRoleRes = await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=GetRole&RoleName=assume-me",
    });
    const roleText = await getRoleRes.text();
    const roleArn = roleText.match(/<Arn>(.*?)<\/Arn>/)?.[1] ?? "";

    const res = await app.request(`${base}/sts/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: `Action=AssumeRole&RoleArn=${encodeURIComponent(roleArn)}&RoleSessionName=test-session`,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("AssumeRoleResponse");
    expect(text).toContain("AccessKeyId");
    expect(text).toContain("SecretAccessKey");
    expect(text).toContain("SessionToken");
  });
});

describe("AWS plugin - seedFromConfig", () => {
  it("seeds custom buckets, queues, users, and roles", () => {
    const store = new Store();
    const webhooks = new WebhookDispatcher();
    const app = new Hono();
    awsPlugin.register(app as any, store, webhooks, base);
    awsPlugin.seed!(store, base);

    seedFromConfig(store, base, {
      s3: {
        buckets: [{ name: "my-bucket" }, { name: "other-bucket", region: "eu-west-1" }],
      },
      sqs: {
        queues: [{ name: "my-queue" }, { name: "orders.fifo", fifo: true }],
      },
      iam: {
        users: [{ user_name: "alice", create_access_key: true }],
        roles: [{ role_name: "lambda-role", description: "Lambda execution" }],
      },
    });

    const aws = getAwsStore(store);

    // Default + 2 custom buckets
    const buckets = aws.s3Buckets.all();
    expect(buckets.length).toBe(3);
    expect(buckets.find((b) => b.bucket_name === "my-bucket")).toBeDefined();
    expect(buckets.find((b) => b.bucket_name === "other-bucket")?.region).toBe("eu-west-1");

    // Default + 2 custom queues
    const queues = aws.sqsQueues.all();
    expect(queues.length).toBe(3);
    expect(queues.find((q) => q.queue_name === "orders.fifo")?.fifo).toBe(true);

    // Default admin + alice
    const users = aws.iamUsers.all();
    expect(users.length).toBe(2);
    const alice = users.find((u) => u.user_name === "alice");
    expect(alice).toBeDefined();
    expect(alice!.access_keys.length).toBe(1);

    // 1 custom role
    const roles = aws.iamRoles.all();
    expect(roles.length).toBe(1);
    expect(roles[0].role_name).toBe("lambda-role");
    expect(roles[0].description).toBe("Lambda execution");
  });
});

describe("AWS plugin - Inspector", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("renders the S3 inspector page", async () => {
    const res = await app.request(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("AWS Emulator");
    expect(html).toContain("Inspector");
    expect(html).toContain("emulate-default");
  });

  it("shows SQS tab", async () => {
    const res = await app.request(`${base}/?tab=sqs`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("SQS Queues");
    expect(html).toContain("emulate-default-queue");
  });

  it("shows IAM tab", async () => {
    const res = await app.request(`${base}/?tab=iam`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("IAM Users");
    expect(html).toContain("admin");
  });
});
