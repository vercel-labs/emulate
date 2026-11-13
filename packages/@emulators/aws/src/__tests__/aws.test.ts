import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { Hono } from "@emulators/core";
import { Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { awsPlugin, seedFromConfig, getAwsStore } from "../index.js";
import { md5 } from "../helpers.js";
import { createTestApp, testAuthHeaders as authHeaders, testBaseUrl as base } from "./helpers.js";

describe("AWS plugin - S3 Buckets", () => {
  let app: Hono<AppEnv>;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("lists default buckets", async () => {
    const res = await app.request(`${base}/`, { method: "GET", headers: authHeaders() });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("emulate-default");
    expect(text).toContain("ListAllMyBucketsResult");
  });

  it("creates a bucket", async () => {
    const res = await app.request(`${base}/my-test-bucket`, {
      method: "PUT",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);

    // Verify bucket appears in list
    const listRes = await app.request(`${base}/`, { method: "GET", headers: authHeaders() });
    const text = await listRes.text();
    expect(text).toContain("my-test-bucket");
  });

  it("rejects duplicate bucket", async () => {
    await app.request(`${base}/dup-bucket`, { method: "PUT", headers: authHeaders() });
    const res = await app.request(`${base}/dup-bucket`, { method: "PUT", headers: authHeaders() });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("BucketAlreadyOwnedByYou");
  });

  it("deletes a bucket", async () => {
    await app.request(`${base}/del-bucket`, { method: "PUT", headers: authHeaders() });
    const res = await app.request(`${base}/del-bucket`, { method: "DELETE", headers: authHeaders() });
    expect(res.status).toBe(204);
  });

  it("rejects deleting non-empty bucket", async () => {
    await app.request(`${base}/full-bucket`, { method: "PUT", headers: authHeaders() });
    await app.request(`${base}/full-bucket/file.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "hello",
    });
    const res = await app.request(`${base}/full-bucket`, { method: "DELETE", headers: authHeaders() });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("BucketNotEmpty");
  });

  it("checks bucket existence with HEAD", async () => {
    const res = await app.request(`${base}/emulate-default`, { method: "HEAD", headers: authHeaders() });
    expect(res.status).toBe(200);

    const notFound = await app.request(`${base}/nonexistent`, { method: "HEAD", headers: authHeaders() });
    expect(notFound.status).toBe(404);
  });
});

describe("AWS plugin - S3 Objects", () => {
  let app: Hono<AppEnv>;
  let store: Store;

  beforeEach(() => {
    const testApp = createTestApp();
    app = testApp.app;
    store = testApp.store;
  });

  it("puts and gets an object", async () => {
    const putRes = await app.request(`${base}/emulate-default/test.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "hello world",
    });
    expect(putRes.status).toBe(200);
    expect(putRes.headers.get("ETag")).toBeDefined();

    const getRes = await app.request(`${base}/emulate-default/test.txt`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(200);
    const body = await getRes.text();
    expect(body).toBe("hello world");
    expect(getRes.headers.get("Content-Type")).toBe("text/plain");
  });

  it("roundtrips arbitrary bytes with the correct length and ETag", async () => {
    const payload = Buffer.from([0x00, 0x80, 0xff, 0xc3, 0x28, 0xed, 0xa0, 0x80, 0x00]);
    const putRes = await app.request(`${base}/emulate-default/binary.bin`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/octet-stream" },
      body: payload,
    });

    expect(putRes.status).toBe(200);
    expect(putRes.headers.get("ETag")).toBe(`"${md5(payload)}"`);

    const getRes = await app.request(`${base}/emulate-default/binary.bin`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(200);
    expect(Buffer.from(await getRes.arrayBuffer())).toEqual(payload);
    expect(getRes.headers.get("Content-Length")).toBe(String(payload.byteLength));
    expect(getRes.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(getRes.headers.get("ETag")).toBe(`"${md5(payload)}"`);
    expect(getRes.headers.get("Last-Modified")).toBeTruthy();
  });

  it("returns 404 for missing object", async () => {
    const res = await app.request(`${base}/emulate-default/missing.txt`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain("NoSuchKey");
  });

  it("overwrites an existing object", async () => {
    await app.request(`${base}/emulate-default/overwrite.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "version 1",
    });
    await app.request(`${base}/emulate-default/overwrite.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "version 2",
    });

    const res = await app.request(`${base}/emulate-default/overwrite.txt`, {
      method: "GET",
      headers: authHeaders(),
    });
    const body = await res.text();
    expect(body).toBe("version 2");
  });

  it("deletes an object", async () => {
    await app.request(`${base}/emulate-default/to-delete.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "delete me",
    });

    const delRes = await app.request(`${base}/emulate-default/to-delete.txt`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(delRes.status).toBe(204);

    const getRes = await app.request(`${base}/emulate-default/to-delete.txt`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(404);
  });

  it("lists objects in a bucket", async () => {
    await app.request(`${base}/emulate-default/dir/a.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "a",
    });
    await app.request(`${base}/emulate-default/dir/b.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "b",
    });

    const res = await app.request(`${base}/emulate-default?prefix=dir/`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("dir/a.txt");
    expect(text).toContain("dir/b.txt");
  });

  it("handles HEAD for objects", async () => {
    await app.request(`${base}/emulate-default/head-test.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "head test",
    });

    const res = await app.request(`${base}/emulate-default/head-test.txt`, {
      method: "HEAD",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  it("copies an object with x-amz-copy-source", async () => {
    const body = "copy me";
    await app.request(`${base}/emulate-default/source.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body,
    });

    const copyRes = await app.request(`${base}/emulate-default/dest.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "x-amz-copy-source": "/emulate-default/source.txt" },
    });
    expect(copyRes.status).toBe(200);
    const copyText = await copyRes.text();
    expect(copyText).toContain("CopyObjectResult");

    const getRes = await app.request(`${base}/emulate-default/dest.txt`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe(body);
  });

  it("reads legacy UTF-8 bodies and stores copied objects as base64", async () => {
    const body = "legacy body";
    getAwsStore(store).s3Objects.insert({
      bucket_name: "emulate-default",
      key: "legacy.txt",
      body,
      content_type: "text/plain",
      content_length: Buffer.byteLength(body),
      etag: createHash("md5").update(body).digest("hex"),
      last_modified: new Date().toISOString(),
      metadata: {},
    });

    const getRes = await app.request(`${base}/emulate-default/legacy.txt`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(Buffer.from(await getRes.arrayBuffer()).toString()).toBe(body);

    const copyRes = await app.request(`${base}/emulate-default/legacy-copy.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "x-amz-copy-source": "/emulate-default/legacy.txt" },
    });
    expect(copyRes.status).toBe(200);

    const copied = getAwsStore(store).s3Objects.findOneBy("key", "legacy-copy.txt");
    expect(copied?.body_base64).toBe(Buffer.from(body).toString("base64"));
    expect(copied?.body).toBeUndefined();
  });

  it("copies binary data byte-for-byte", async () => {
    const payload = Buffer.from([0x00, 0x7f, 0x80, 0xff, 0xc3, 0x28]);
    await app.request(`${base}/emulate-default/binary-source.bin`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/octet-stream" },
      body: payload,
    });

    const copyRes = await app.request(`${base}/emulate-default/binary-dest.bin`, {
      method: "PUT",
      headers: { ...authHeaders(), "x-amz-copy-source": "/emulate-default/binary-source.bin" },
    });
    expect(copyRes.status).toBe(200);

    const getRes = await app.request(`${base}/emulate-default/binary-dest.bin`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(Buffer.from(await getRes.arrayBuffer())).toEqual(payload);
    expect(getRes.headers.get("Content-Length")).toBe(String(payload.byteLength));
    expect(getRes.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(getRes.headers.get("ETag")).toBe(`"${md5(payload)}"`);
  });
});

describe("AWS plugin - S3 ListObjectsV2 pagination", () => {
  let app: Hono<AppEnv>;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("paginates with max-keys and continuation-token", async () => {
    // Upload 5 objects
    for (let i = 0; i < 5; i++) {
      await app.request(`${base}/emulate-default/page-${String(i).padStart(2, "0")}.txt`, {
        method: "PUT",
        headers: { ...authHeaders(), "Content-Type": "text/plain" },
        body: `file ${i}`,
      });
    }

    // First page: max-keys=2
    const page1 = await app.request(`${base}/emulate-default?max-keys=2`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(page1.status).toBe(200);
    const text1 = await page1.text();
    expect(text1).toContain("<IsTruncated>true</IsTruncated>");
    expect(text1).toContain("<KeyCount>2</KeyCount>");
    expect(text1).toContain("NextContinuationToken");

    // Extract continuation token
    const tokenMatch = text1.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/);
    expect(tokenMatch).toBeTruthy();
    const token = tokenMatch![1];

    // Second page
    const page2 = await app.request(
      `${base}/emulate-default?max-keys=2&continuation-token=${encodeURIComponent(token)}`,
      { method: "GET", headers: authHeaders() },
    );
    expect(page2.status).toBe(200);
    const text2 = await page2.text();
    expect(text2).toContain("<KeyCount>2</KeyCount>");
    expect(text2).toContain("<ContinuationToken>");

    // Third page (last)
    const tokenMatch2 = text2.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/);
    expect(tokenMatch2).toBeTruthy();
    const page3 = await app.request(
      `${base}/emulate-default?max-keys=2&continuation-token=${encodeURIComponent(tokenMatch2![1])}`,
      { method: "GET", headers: authHeaders() },
    );
    const text3 = await page3.text();
    expect(text3).toContain("<IsTruncated>false</IsTruncated>");
    expect(text3).toContain("<KeyCount>1</KeyCount>");
    expect(text3).not.toContain("NextContinuationToken");
  });

  it("supports start-after parameter", async () => {
    await app.request(`${base}/emulate-default/sa-a.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "a",
    });
    await app.request(`${base}/emulate-default/sa-b.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "b",
    });
    await app.request(`${base}/emulate-default/sa-c.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "c",
    });

    const res = await app.request(`${base}/emulate-default?start-after=sa-a.txt`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("<Key>sa-a.txt</Key>");
    expect(text).toContain("<Key>sa-b.txt</Key>");
    expect(text).toContain("<Key>sa-c.txt</Key>");
    expect(text).toContain("<StartAfter>sa-a.txt</StartAfter>");
  });
});

describe("AWS plugin - S3 Presigned POST", () => {
  let app: Hono<AppEnv>;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("uploads a file via presigned POST", async () => {
    const form = new FormData();
    form.append("key", "upload.txt");
    form.append("Content-Type", "text/plain");
    form.append("file", new Blob(["hello upload"], { type: "text/plain" }));

    const res = await app.request(`${base}/emulate-default`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(204);

    // Verify the object was stored
    const getRes = await app.request(`${base}/emulate-default/upload.txt`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(200);
    const body = await getRes.text();
    expect(body).toBe("hello upload");
  });

  it("roundtrips arbitrary bytes from a presigned POST", async () => {
    const payload = Buffer.from([0x00, 0x80, 0xff, 0xc3, 0x28, 0xed, 0xa0, 0x80]);
    const form = new FormData();
    form.append("key", "binary-upload.bin");
    form.append("Content-Type", "application/octet-stream");
    form.append("file", new Blob([payload], { type: "application/octet-stream" }));

    const res = await app.request(`${base}/emulate-default`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(204);

    const getRes = await app.request(`${base}/emulate-default/binary-upload.bin`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(200);
    expect(Buffer.from(await getRes.arrayBuffer())).toEqual(payload);
    expect(getRes.headers.get("Content-Length")).toBe(String(payload.byteLength));
    expect(getRes.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(getRes.headers.get("ETag")).toBe(`"${md5(payload)}"`);
  });

  it("returns 201 XML when success_action_status is 201", async () => {
    const form = new FormData();
    form.append("key", "upload-201.txt");
    form.append("Content-Type", "text/plain");
    form.append("success_action_status", "201");
    form.append("file", new Blob(["data"], { type: "text/plain" }));

    const res = await app.request(`${base}/emulate-default`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).toContain("<PostResponse>");
    expect(text).toContain("<Key>upload-201.txt</Key>");
    expect(text).toContain("<ETag>");
  });

  it("validates policy with content-length-range", async () => {
    const policy = Buffer.from(
      JSON.stringify({
        expiration: new Date(Date.now() + 60_000).toISOString(),
        conditions: [{ bucket: "emulate-default" }, ["content-length-range", 0, 5]],
      }),
    ).toString("base64");

    const form = new FormData();
    form.append("key", "too-big.txt");
    form.append("Policy", policy);
    form.append("X-Amz-Signature", "fake");
    form.append("file", new Blob(["this is way too big for the limit"], { type: "text/plain" }));

    const res = await app.request(`${base}/emulate-default`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("EntityTooLarge");
  });

  it("validates policy with starts-with on Content-Type", async () => {
    const policy = Buffer.from(
      JSON.stringify({
        expiration: new Date(Date.now() + 60_000).toISOString(),
        conditions: [{ bucket: "emulate-default" }, ["starts-with", "$Content-Type", "image/"]],
      }),
    ).toString("base64");

    const form = new FormData();
    form.append("key", "wrong-type.txt");
    form.append("Content-Type", "text/plain");
    form.append("Policy", policy);
    form.append("X-Amz-Signature", "fake");
    form.append("file", new Blob(["data"], { type: "text/plain" }));

    const res = await app.request(`${base}/emulate-default`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("AccessDenied");
    expect(text).toContain("starts-with");
  });

  it("rejects expired policy", async () => {
    const policy = Buffer.from(
      JSON.stringify({
        expiration: new Date(Date.now() - 60_000).toISOString(),
        conditions: [{ bucket: "emulate-default" }],
      }),
    ).toString("base64");

    const form = new FormData();
    form.append("key", "expired.txt");
    form.append("Policy", policy);
    form.append("X-Amz-Signature", "fake");
    form.append("file", new Blob(["data"], { type: "text/plain" }));

    const res = await app.request(`${base}/emulate-default`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("AccessDenied");
    expect(text).toContain("expired");
  });

  it("returns 404 for non-existent bucket", async () => {
    const form = new FormData();
    form.append("key", "file.txt");
    form.append("file", new Blob(["data"], { type: "text/plain" }));

    const res = await app.request(`${base}/no-such-bucket`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain("NoSuchBucket");
  });
});

describe("AWS plugin - SQS", () => {
  let app: Hono<AppEnv>;

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
  let app: Hono<AppEnv>;

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
  let app: Hono<AppEnv>;

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

describe("AWS plugin - STS AssumeRoleWithWebIdentity", () => {
  let app: Hono<AppEnv>;
  const roleArn = "arn:aws:iam::123456789012:role/ci/web-identity-role";

  function idToken(claims: Record<string, unknown>): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`;
  }

  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    sub: "repo:octo-org/app:ref:refs/heads/main",
    aud: "sts.amazonaws.com",
    exp: Math.floor(Date.now() / 1000) + 600,
  };

  // AssumeRoleWithWebIdentity is unsigned, so these requests carry no Authorization header.
  function assume(fields: Record<string, string>) {
    return app.request(`${base}/sts/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ Action: "AssumeRoleWithWebIdentity", ...fields }).toString(),
    });
  }

  beforeEach(() => {
    const created = createTestApp();
    app = created.app;
    seedFromConfig(created.store, base, { iam: { roles: [{ role_name: "web-identity-role", path: "/ci/" }] } });
  });

  it("returns temporary credentials and the token's subject, audience, and issuer", async () => {
    const before = Date.now();
    const res = await assume({
      RoleArn: roleArn,
      RoleSessionName: "deploy",
      WebIdentityToken: idToken(claims),
      DurationSeconds: "900",
    });
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">');
    expect(xml).toMatch(/<AccessKeyId>ASIA[0-9A-F]{16}<\/AccessKeyId>/);
    expect(xml).toContain("<SecretAccessKey>");
    expect(xml).toContain("<SessionToken>");
    expect(xml).toContain(
      "<SubjectFromWebIdentityToken>repo:octo-org/app:ref:refs/heads/main</SubjectFromWebIdentityToken>",
    );
    expect(xml).toContain("<Audience>sts.amazonaws.com</Audience>");
    expect(xml).toContain("<Provider>https://token.actions.githubusercontent.com</Provider>");
    expect(xml).toContain("<Arn>arn:aws:sts::123456789012:assumed-role/web-identity-role/deploy</Arn>");
    expect(xml).toMatch(/<AssumedRoleId>AROA[0-9A-F]{16}:deploy<\/AssumedRoleId>/);
    expect(xml).not.toContain("<SourceIdentity>");
    const expiration = Date.parse(xml.match(/<Expiration>(.*?)<\/Expiration>/)?.[1] ?? "");
    expect(expiration).toBeGreaterThanOrEqual(before + 900_000);
    expect(expiration).toBeLessThanOrEqual(Date.now() + 900_000);
  });

  it("defaults the session to one hour and returns the source identity claim", async () => {
    const before = Date.now();
    const res = await assume({
      RoleArn: roleArn,
      RoleSessionName: "deploy",
      WebIdentityToken: idToken({
        ...claims,
        aud: ["other-client", "sts.amazonaws.com"],
        azp: "sts.amazonaws.com",
        "https://aws.amazon.com/source_identity": "alice<&",
      }),
    });
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<Audience>sts.amazonaws.com</Audience>");
    expect(xml).toContain("<SourceIdentity>alice&lt;&amp;</SourceIdentity>");
    const expiration = Date.parse(xml.match(/<Expiration>(.*?)<\/Expiration>/)?.[1] ?? "");
    expect(expiration).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  it("accepts an opaque OAuth 2.0 access token when ProviderId is set", async () => {
    const res = await assume({
      RoleArn: roleArn,
      RoleSessionName: "app1",
      WebIdentityToken: "Atza|opaque-access-token",
      ProviderId: "www.amazon.com",
    });
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<Provider>www.amazon.com</Provider>");
    expect(xml).toMatch(/<SubjectFromWebIdentityToken>[0-9a-f]{32}<\/SubjectFromWebIdentityToken>/);
    expect(xml).not.toContain("<Audience>");
  });

  it("rejects a token that is not a JWT", async () => {
    const res = await assume({ RoleArn: roleArn, RoleSessionName: "deploy", WebIdentityToken: "opaque-token" });
    expect(res.status).toBe(400);
    const xml = await res.text();
    expect(xml).toContain("<Code>InvalidIdentityToken</Code>");
    expect(xml).toContain("not a valid JWT");
  });

  it("rejects a token without a subject claim", async () => {
    const { sub: _sub, ...withoutSubject } = claims;
    const res = await assume({
      RoleArn: roleArn,
      RoleSessionName: "deploy",
      WebIdentityToken: idToken(withoutSubject),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("<Code>InvalidIdentityToken</Code>");
  });

  it("rejects an expired token", async () => {
    const res = await assume({
      RoleArn: roleArn,
      RoleSessionName: "deploy",
      WebIdentityToken: idToken({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 }),
    });
    expect(res.status).toBe(400);
    const xml = await res.text();
    expect(xml).toContain("<Code>ExpiredToken</Code>");
    expect(xml).toContain("Token expired: current date/time");
  });

  it("denies a role that does not exist", async () => {
    const res = await assume({
      RoleArn: "arn:aws:iam::123456789012:role/missing-role",
      RoleSessionName: "deploy",
      WebIdentityToken: idToken(claims),
    });
    expect(res.status).toBe(403);
    const xml = await res.text();
    expect(xml).toContain("<Code>AccessDenied</Code>");
    expect(xml).toContain("Not authorized to perform sts:AssumeRoleWithWebIdentity");
  });

  it("reports every missing required parameter in one validation error", async () => {
    const res = await assume({});
    expect(res.status).toBe(400);
    const xml = await res.text();
    expect(xml).toContain("<Code>ValidationError</Code>");
    expect(xml).toContain("3 validation errors detected:");
    expect(xml).toContain("Value null at &apos;roleArn&apos; failed to satisfy constraint: Member must not be null");
    expect(xml).toContain("Value null at &apos;roleSessionName&apos;");
    expect(xml).toContain("Value null at &apos;webIdentityToken&apos;");
  });

  it("validates the session name and duration bounds", async () => {
    for (const [fields, expected] of [
      [{ RoleSessionName: "has space" }, "Member must satisfy regular expression pattern"],
      [{ RoleSessionName: "a" }, "Member must have length greater than or equal to 2"],
      [{ DurationSeconds: "899" }, "Member must have value greater than or equal to 900"],
      [{ DurationSeconds: "43201" }, "Member must have value less than or equal to 43200"],
      [{ DurationSeconds: "1.5" }, "at &apos;durationSeconds&apos;"],
    ] as const) {
      const res = await assume({
        RoleArn: roleArn,
        RoleSessionName: "deploy",
        WebIdentityToken: idToken(claims),
        ...fields,
      });
      expect(res.status).toBe(400);
      const xml = await res.text();
      expect(xml).toContain("1 validation error detected:");
      expect(xml).toContain(expected);
    }
  });
});

describe("AWS plugin - KMS", () => {
  let app: Hono<AppEnv>;
  const keyId = "1234abcd-12ab-34cd-56ef-1234567890ab";
  const keyArn = `arn:aws:kms:us-east-1:123456789012:key/${keyId}`;

  beforeEach(() => {
    const created = createTestApp();
    app = created.app;
    seedFromConfig(created.store, base, { kms: { keys: [{ key_id: keyId, aliases: ["alias/app-key"] }] } });
  });

  async function kms(operation: string, body: unknown) {
    const res = await app.request(`${base}/kms/`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `TrentService.${operation}`,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, json: (await res.json()) as Record<string, any> };
  }

  const plaintext = Buffer.from([0, 1, 2, 250, 255]).toString("base64");

  it("encrypts and decrypts with a key ID, key ARN, alias name, or alias ARN", async () => {
    for (const identifier of [keyId, keyArn, "alias/app-key", "arn:aws:kms:us-east-1:123456789012:alias/app-key"]) {
      const encrypted = await kms("Encrypt", { KeyId: identifier, Plaintext: plaintext });
      expect(encrypted.status).toBe(200);
      expect(encrypted.headers.get("content-type")).toBe("application/x-amz-json-1.1");
      expect(encrypted.json).toMatchObject({ KeyId: keyArn, EncryptionAlgorithm: "SYMMETRIC_DEFAULT" });
      expect(encrypted.json.CiphertextBlob).not.toContain(plaintext);

      const decrypted = await kms("Decrypt", { CiphertextBlob: encrypted.json.CiphertextBlob });
      expect(decrypted.status).toBe(200);
      expect(decrypted.json).toMatchObject({
        KeyId: keyArn,
        Plaintext: plaintext,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      });
      expect(decrypted.json.KeyMaterialId).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("requires the same encryption context to decrypt", async () => {
    const encrypted = await kms("Encrypt", {
      KeyId: keyId,
      Plaintext: plaintext,
      EncryptionContext: { tenant: "acme", purpose: "test" },
    });
    const reordered = await kms("Decrypt", {
      CiphertextBlob: encrypted.json.CiphertextBlob,
      EncryptionContext: { purpose: "test", tenant: "acme" },
    });
    expect(reordered.status).toBe(200);
    expect(reordered.json.Plaintext).toBe(plaintext);

    for (const context of [undefined, { tenant: "other", purpose: "test" }, { tenant: "acme" }]) {
      const res = await kms("Decrypt", { CiphertextBlob: encrypted.json.CiphertextBlob, EncryptionContext: context });
      expect(res.status).toBe(400);
      expect(res.json.__type).toBe("InvalidCiphertextException");
    }
  });

  it("rejects tampered ciphertext", async () => {
    const encrypted = await kms("Encrypt", { KeyId: keyId, Plaintext: plaintext });
    const blob = Buffer.from(encrypted.json.CiphertextBlob, "base64");
    blob[blob.length - 1] ^= 1;
    const tampered = await kms("Decrypt", { CiphertextBlob: blob.toString("base64") });
    expect(tampered.status).toBe(400);
    expect(tampered.json.__type).toBe("InvalidCiphertextException");

    const garbage = await kms("Decrypt", { CiphertextBlob: Buffer.from("not a kms blob").toString("base64") });
    expect(garbage.json.__type).toBe("InvalidCiphertextException");
  });

  it("checks a Decrypt KeyId against the key that encrypted the data", async () => {
    const created = await kms("CreateKey", {});
    const otherKeyId = created.json.KeyMetadata.KeyId;
    const encrypted = await kms("Encrypt", { KeyId: keyId, Plaintext: plaintext });

    const matching = await kms("Decrypt", { CiphertextBlob: encrypted.json.CiphertextBlob, KeyId: "alias/app-key" });
    expect(matching.status).toBe(200);

    const wrong = await kms("Decrypt", { CiphertextBlob: encrypted.json.CiphertextBlob, KeyId: otherKeyId });
    expect(wrong.status).toBe(400);
    expect(wrong.json.__type).toBe("IncorrectKeyException");
  });

  it("returns NotFoundException for unknown keys and aliases", async () => {
    const missingKey = await kms("Encrypt", { KeyId: "00000000-0000-4000-8000-000000000000", Plaintext: plaintext });
    expect(missingKey.status).toBe(400);
    expect(missingKey.json).toEqual({
      __type: "NotFoundException",
      message: "Key 'arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000' does not exist",
    });
    expect(missingKey.headers.get("x-amzn-errortype")).toBe("NotFoundException");

    const missingAlias = await kms("DescribeKey", { KeyId: "alias/missing" });
    expect(missingAlias.json).toEqual({
      __type: "NotFoundException",
      message: "Alias arn:aws:kms:us-east-1:123456789012:alias/missing is not found.",
    });
  });

  it("validates request members", async () => {
    const missing = await kms("Encrypt", {});
    expect(missing.status).toBe(400);
    expect(missing.json.__type).toBe("ValidationException");
    expect(missing.json.message).toBe(
      "2 validation errors detected: Value null at 'keyId' failed to satisfy constraint: Member must not be null; " +
        "Value null at 'plaintext' failed to satisfy constraint: Member must not be null",
    );

    const tooLarge = await kms("Encrypt", { KeyId: keyId, Plaintext: Buffer.alloc(4097).toString("base64") });
    expect(tooLarge.json.message).toBe(
      "1 validation error detected: Value at 'plaintext' failed to satisfy constraint: Member must have length less than or equal to 4096",
    );

    const badAlgorithm = await kms("Encrypt", { KeyId: keyId, Plaintext: plaintext, EncryptionAlgorithm: "AES" });
    expect(badAlgorithm.json.__type).toBe("ValidationException");

    const asymmetricAlgorithm = await kms("Encrypt", {
      KeyId: keyId,
      Plaintext: plaintext,
      EncryptionAlgorithm: "RSAES_OAEP_SHA_256",
    });
    expect(asymmetricAlgorithm.json.__type).toBe("InvalidKeyUsageException");

    const badContext = await kms("Encrypt", { KeyId: keyId, Plaintext: plaintext, EncryptionContext: { n: 1 } });
    expect(badContext.json.__type).toBe("SerializationException");

    const badJson = await kms("Encrypt", "{");
    expect(badJson.json.__type).toBe("SerializationException");
  });

  it("honors DryRun", async () => {
    const res = await kms("Encrypt", { KeyId: keyId, Plaintext: plaintext, DryRun: true });
    expect(res.status).toBe(400);
    expect(res.json.__type).toBe("DryRunOperationException");
  });

  it("creates, describes, and lists keys with pagination", async () => {
    const created = await kms("CreateKey", { Description: "orders" });
    expect(created.status).toBe(200);
    const metadata = created.json.KeyMetadata;
    expect(metadata).toMatchObject({
      AWSAccountId: "123456789012",
      Description: "orders",
      Enabled: true,
      KeyState: "Enabled",
      KeyUsage: "ENCRYPT_DECRYPT",
      KeySpec: "SYMMETRIC_DEFAULT",
      Origin: "AWS_KMS",
      KeyManager: "CUSTOMER",
      EncryptionAlgorithms: ["SYMMETRIC_DEFAULT"],
      MultiRegion: false,
    });
    expect(metadata.KeyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(metadata.Arn).toBe(`arn:aws:kms:us-east-1:123456789012:key/${metadata.KeyId}`);
    expect(typeof metadata.CreationDate).toBe("number");

    const described = await kms("DescribeKey", { KeyId: metadata.Arn });
    expect(described.json.KeyMetadata).toEqual(metadata);

    // The default key, the seeded key, and the created key.
    const firstPage = await kms("ListKeys", { Limit: 2 });
    expect(firstPage.json.Keys).toHaveLength(2);
    expect(firstPage.json.Truncated).toBe(true);
    const secondPage = await kms("ListKeys", { Limit: 2, Marker: firstPage.json.NextMarker });
    expect(secondPage.json).toEqual({ Keys: [{ KeyId: metadata.KeyId, KeyArn: metadata.Arn }], Truncated: false });

    const badMarker = await kms("ListKeys", { Marker: "nope" });
    expect(badMarker.json.__type).toBe("InvalidMarkerException");
  });

  it("rejects key types the emulator does not model", async () => {
    const res = await kms("CreateKey", { KeySpec: "RSA_2048", KeyUsage: "ENCRYPT_DECRYPT" });
    expect(res.status).toBe(400);
    expect(res.json.__type).toBe("UnsupportedOperationException");
  });

  it("seeds a default key with the alias/emulate-default alias", async () => {
    const res = await kms("DescribeKey", { KeyId: "alias/emulate-default" });
    expect(res.status).toBe(200);
    expect(res.json.KeyMetadata.Description).toBe("Default emulate key");
  });

  it("rejects a seeded key_id that is not a UUID", () => {
    const { store } = createTestApp();
    expect(() => seedFromConfig(store, base, { kms: { keys: [{ key_id: "my-key" }] } })).toThrow(/UUID/);
  });

  it("rejects an unknown operation", async () => {
    const res = await kms("ScheduleKeyDeletion", { KeyId: keyId });
    expect(res.status).toBe(400);
    expect(res.json.__type).toBe("UnknownOperationException");
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
  let app: Hono<AppEnv>;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("renders the S3 inspector page", async () => {
    const res = await app.request(`${base}/_inspector`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("AWS Emulator");
    expect(html).toContain("Inspector");
    expect(html).toContain("emulate-default");
  });

  it("shows SQS tab", async () => {
    const res = await app.request(`${base}/_inspector?tab=sqs`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("SQS Queues");
    expect(html).toContain("emulate-default-queue");
  });

  it("shows IAM tab", async () => {
    const res = await app.request(`${base}/_inspector?tab=iam`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("IAM Users");
    expect(html).toContain("admin");
  });

  it("does not serve inspector at GET / (reserved for ListBuckets)", async () => {
    const res = await app.request(`${base}/`, { method: "GET", headers: authHeaders() });
    expect(res.status).toBe(200);
    const text = await res.text();
    // Should be XML ListBuckets response, not HTML inspector
    expect(text).toContain("ListAllMyBucketsResult");
    expect(text).not.toContain("<!DOCTYPE html>");
  });
});

describe("AWS plugin - S3 backward-compat /s3/ aliases", () => {
  let app: Hono<AppEnv>;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("lists buckets via /s3/", async () => {
    const res = await app.request(`${base}/s3/`, { method: "GET", headers: authHeaders() });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("ListAllMyBucketsResult");
    expect(text).toContain("emulate-default");
  });

  it("creates and lists objects via /s3/ prefix", async () => {
    await app.request(`${base}/s3/emulate-default/compat.txt`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "backward compat",
    });

    const getRes = await app.request(`${base}/s3/emulate-default/compat.txt`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe("backward compat");

    const listRes = await app.request(`${base}/s3/emulate-default?prefix=compat`, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(listRes.status).toBe(200);
    expect(await listRes.text()).toContain("compat.txt");
  });
});
