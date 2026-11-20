import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { startAwsTarget, type AwsTarget } from "./helpers.js";

async function streamToString(stream: unknown): Promise<string> {
  return (await streamToBuffer(stream)).toString();
}

async function streamToBuffer(stream: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("AWS plugin - real @aws-sdk/client-s3 E2E", () => {
  let emulator: AwsTarget;
  let s3: S3Client;

  beforeAll(async () => {
    emulator = await startAwsTarget();
    s3 = new S3Client({
      endpoint: emulator.endpoint("s3"),
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    });
    if (emulator.external) {
      // External targets may lack emulate's seed; create the default bucket the suite relies on.
      await s3.send(new CreateBucketCommand({ Bucket: "emulate-default" })).catch((error: { name?: string }) => {
        if (error.name !== "BucketAlreadyOwnedByYou") throw error;
      });
    }
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

  it("PutObject / GetObject preserves arbitrary binary bytes", async () => {
    const body = Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff]);
    await s3.send(
      new PutObjectCommand({
        Bucket: "emulate-default",
        Key: "e2e/binary.bin",
        Body: body,
        ContentType: "application/octet-stream",
      }),
    );

    const get = await s3.send(new GetObjectCommand({ Bucket: "emulate-default", Key: "e2e/binary.bin" }));
    expect(get.ContentLength).toBe(body.byteLength);
    expect(await streamToBuffer(get.Body)).toEqual(body);
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

  it("PutObject honors IfNoneMatch and IfMatch", async () => {
    const Bucket = "emulate-default";
    const Key = "sdk-conditional.txt";
    await s3.send(new DeleteObjectCommand({ Bucket, Key }));
    const created = await s3.send(new PutObjectCommand({ Bucket, Key, Body: "one", IfNoneMatch: "*" }));
    await expect(s3.send(new PutObjectCommand({ Bucket, Key, Body: "two", IfNoneMatch: "*" }))).rejects.toMatchObject({
      $metadata: { httpStatusCode: 412 },
    });
    const swapped = await s3.send(new PutObjectCommand({ Bucket, Key, Body: "two", IfMatch: created.ETag }));
    await expect(
      s3.send(new PutObjectCommand({ Bucket, Key, Body: "stale", IfMatch: created.ETag })),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    const got = await s3.send(new GetObjectCommand({ Bucket, Key }));
    expect(got.ETag).toBe(swapped.ETag);
    expect(await streamToString(got.Body)).toBe("two");
  });

  it("GetObject and HeadObject honor conditions and ranges", async () => {
    const Bucket = "emulate-default";
    const Key = "sdk-read.txt";
    const { ETag } = await s3.send(new PutObjectCommand({ Bucket, Key, Body: "abcdefghij" }));

    await expect(s3.send(new GetObjectCommand({ Bucket, Key, IfNoneMatch: ETag }))).rejects.toMatchObject({
      $metadata: { httpStatusCode: 304 },
    });
    await expect(s3.send(new HeadObjectCommand({ Bucket, Key, IfMatch: '"0"' }))).rejects.toMatchObject({
      $metadata: { httpStatusCode: 412 },
    });

    const ranged = await s3.send(new GetObjectCommand({ Bucket, Key, Range: "bytes=2-4", IfMatch: ETag }));
    expect(ranged.$metadata.httpStatusCode).toBe(206);
    expect(ranged.ContentRange).toBe("bytes 2-4/10");
    expect(await streamToString(ranged.Body)).toBe("cde");
  });

  it("CopyObject honors source conditions", async () => {
    const Bucket = "emulate-default";
    const { ETag } = await s3.send(new PutObjectCommand({ Bucket, Key: "sdk copy src.txt", Body: "copy me" }));
    await expect(
      s3.send(
        new CopyObjectCommand({
          Bucket,
          Key: "sdk-copy-dst.txt",
          CopySource: `${Bucket}/${encodeURIComponent("sdk copy src.txt")}`,
          CopySourceIfNoneMatch: ETag,
        }),
      ),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    await s3.send(
      new CopyObjectCommand({
        Bucket,
        Key: "sdk-copy-dst.txt",
        CopySource: `${Bucket}/${encodeURIComponent("sdk copy src.txt")}`,
        CopySourceIfMatch: ETag,
      }),
    );
    const got = await s3.send(new GetObjectCommand({ Bucket, Key: "sdk-copy-dst.txt" }));
    expect(await streamToString(got.Body)).toBe("copy me");
  });

  it("DeleteObjects deletes only objects whose ETag matches", async () => {
    const Bucket = "emulate-default";
    const { ETag } = await s3.send(new PutObjectCommand({ Bucket, Key: "sdk-del-a", Body: "a" }));
    await s3.send(new PutObjectCommand({ Bucket, Key: "sdk-del-b", Body: "b" }));
    const res = await s3.send(
      new DeleteObjectsCommand({
        Bucket,
        Delete: {
          Objects: [
            { Key: "sdk-del-a", ETag },
            { Key: "sdk-del-b", ETag: '"00000000000000000000000000000000"' },
          ],
        },
      }),
    );
    expect((res.Deleted ?? []).map((d) => d.Key)).toEqual(["sdk-del-a"]);
    expect(res.Errors?.[0]).toMatchObject({ Key: "sdk-del-b", Code: "PreconditionFailed" });
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
