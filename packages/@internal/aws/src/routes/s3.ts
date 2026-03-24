import type { RouteContext } from "@internal/core";
import { getAwsStore } from "../store.js";
import { awsXmlResponse, awsErrorXml, md5, generateMessageId, escapeXml } from "../helpers.js";

export function s3Routes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const aws = () => getAwsStore(store);

  // ListBuckets - GET /s3/
  app.get("/s3/", (c) => {
    const buckets = aws().s3Buckets.all();
    const bucketXml = buckets
      .map(
        (b) => `    <Bucket>
      <Name>${escapeXml(b.bucket_name)}</Name>
      <CreationDate>${b.creation_date}</CreationDate>
    </Bucket>`,
      )
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult>
  <Owner>
    <ID>owner-id</ID>
    <DisplayName>emulate</DisplayName>
  </Owner>
  <Buckets>
${bucketXml}
  </Buckets>
</ListAllMyBucketsResult>`;
    return awsXmlResponse(c, xml);
  });

  // CreateBucket - PUT /s3/:bucket
  app.put("/s3/:bucket", (c) => {
    const bucketName = c.req.param("bucket");
    const existing = aws().s3Buckets.findOneBy("bucket_name", bucketName);
    if (existing) {
      return awsErrorXml(c, "BucketAlreadyOwnedByYou", "Your previous request to create the named bucket succeeded and you already own it.", 409);
    }

    aws().s3Buckets.insert({
      bucket_name: bucketName,
      region: "us-east-1",
      creation_date: new Date().toISOString(),
      acl: "private",
      versioning_enabled: false,
    });

    return c.text("", 200, { Location: `/${bucketName}` });
  });

  // DeleteBucket - DELETE /s3/:bucket
  app.delete("/s3/:bucket", (c) => {
    const bucketName = c.req.param("bucket");
    const bucket = aws().s3Buckets.findOneBy("bucket_name", bucketName);
    if (!bucket) {
      return awsErrorXml(c, "NoSuchBucket", "The specified bucket does not exist.", 404);
    }

    const objects = aws().s3Objects.findBy("bucket_name", bucketName);
    if (objects.length > 0) {
      return awsErrorXml(c, "BucketNotEmpty", "The bucket you tried to delete is not empty.", 409);
    }

    aws().s3Buckets.delete(bucket.id);
    return c.body(null, 204);
  });

  // HeadBucket - HEAD /s3/:bucket
  app.on("HEAD", "/s3/:bucket", (c) => {
    const bucketName = c.req.param("bucket");
    const bucket = aws().s3Buckets.findOneBy("bucket_name", bucketName);
    if (!bucket) {
      return c.text("", 404);
    }
    return c.text("", 200, { "x-amz-bucket-region": bucket.region });
  });

  // ListObjects (v2) - GET /s3/:bucket
  app.get("/s3/:bucket", (c) => {
    const bucketName = c.req.param("bucket");
    const bucket = aws().s3Buckets.findOneBy("bucket_name", bucketName);
    if (!bucket) {
      return awsErrorXml(c, "NoSuchBucket", "The specified bucket does not exist.", 404);
    }

    const prefix = c.req.query("prefix") ?? "";
    const delimiter = c.req.query("delimiter") ?? "";
    const maxKeys = Math.min(parseInt(c.req.query("max-keys") ?? "1000", 10), 1000);

    let objects = aws().s3Objects.findBy("bucket_name", bucketName);
    if (prefix) {
      objects = objects.filter((o) => o.key.startsWith(prefix));
    }

    const commonPrefixes: string[] = [];
    let contents = objects;
    if (delimiter) {
      const prefixSet = new Set<string>();
      contents = [];
      for (const obj of objects) {
        const remaining = obj.key.slice(prefix.length);
        const delimIndex = remaining.indexOf(delimiter);
        if (delimIndex >= 0) {
          prefixSet.add(prefix + remaining.slice(0, delimIndex + delimiter.length));
        } else {
          contents.push(obj);
        }
      }
      commonPrefixes.push(...Array.from(prefixSet).sort());
    }

    const truncated = contents.length > maxKeys;
    const page = contents.slice(0, maxKeys);

    const contentsXml = page
      .map(
        (o) => `  <Contents>
    <Key>${escapeXml(o.key)}</Key>
    <LastModified>${o.last_modified}</LastModified>
    <ETag>"${o.etag}"</ETag>
    <Size>${o.content_length}</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>`,
      )
      .join("\n");

    const prefixesXml = commonPrefixes
      .map((p) => `  <CommonPrefixes><Prefix>${escapeXml(p)}</Prefix></CommonPrefixes>`)
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>${escapeXml(bucketName)}</Name>
  <Prefix>${escapeXml(prefix)}</Prefix>
  <MaxKeys>${maxKeys}</MaxKeys>
  <IsTruncated>${truncated}</IsTruncated>
  <KeyCount>${page.length}</KeyCount>
${contentsXml}
${prefixesXml}
</ListBucketResult>`;
    return awsXmlResponse(c, xml);
  });

  // PutObject - PUT /s3/:bucket/:key{.+}
  // Also handles CopyObject when x-amz-copy-source header is present
  app.put("/s3/:bucket/:key{.+}", async (c) => {
    const bucketName = c.req.param("bucket");
    const key = c.req.param("key");

    const bucket = aws().s3Buckets.findOneBy("bucket_name", bucketName);
    if (!bucket) {
      return awsErrorXml(c, "NoSuchBucket", "The specified bucket does not exist.", 404);
    }

    // Handle CopyObject via x-amz-copy-source header
    const copySource = c.req.header("x-amz-copy-source");
    if (copySource) {
      // copySource format: /bucket/key or bucket/key
      const normalized = copySource.startsWith("/") ? copySource.slice(1) : copySource;
      const slashIndex = normalized.indexOf("/");
      if (slashIndex < 0) {
        return awsErrorXml(c, "InvalidArgument", "Invalid copy source.", 400);
      }
      const srcBucket = normalized.slice(0, slashIndex);
      const srcKey = normalized.slice(slashIndex + 1);

      const srcObj = aws()
        .s3Objects.findBy("bucket_name", srcBucket)
        .find((o) => o.key === srcKey);
      if (!srcObj) {
        return awsErrorXml(c, "NoSuchKey", "The specified source key does not exist.", 404);
      }

      const etag = srcObj.etag;
      const now = new Date().toISOString();

      const existing = aws()
        .s3Objects.findBy("bucket_name", bucketName)
        .find((o) => o.key === key);

      if (existing) {
        aws().s3Objects.update(existing.id, {
          body: srcObj.body,
          content_type: srcObj.content_type,
          content_length: srcObj.content_length,
          etag,
          last_modified: now,
          metadata: { ...srcObj.metadata },
        });
      } else {
        aws().s3Objects.insert({
          bucket_name: bucketName,
          key,
          body: srcObj.body,
          content_type: srcObj.content_type,
          content_length: srcObj.content_length,
          etag,
          last_modified: now,
          metadata: { ...srcObj.metadata },
        });
      }

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CopyObjectResult>
  <ETag>"${etag}"</ETag>
  <LastModified>${now}</LastModified>
</CopyObjectResult>`;
      return awsXmlResponse(c, xml);
    }

    const body = await c.req.text();
    const contentType = c.req.header("Content-Type") ?? "application/octet-stream";
    const etag = md5(body);

    // Extract user metadata (x-amz-meta-*)
    const metadata: Record<string, string> = {};
    for (const [headerName, headerValue] of Object.entries(c.req.header())) {
      if (typeof headerValue === "string" && headerName.toLowerCase().startsWith("x-amz-meta-")) {
        metadata[headerName.slice("x-amz-meta-".length)] = headerValue;
      }
    }

    const existing = aws()
      .s3Objects.findBy("bucket_name", bucketName)
      .find((o) => o.key === key);

    if (existing) {
      aws().s3Objects.update(existing.id, {
        body,
        content_type: contentType,
        content_length: new TextEncoder().encode(body).byteLength,
        etag,
        last_modified: new Date().toISOString(),
        metadata,
      });
    } else {
      aws().s3Objects.insert({
        bucket_name: bucketName,
        key,
        body,
        content_type: contentType,
        content_length: new TextEncoder().encode(body).byteLength,
        etag,
        last_modified: new Date().toISOString(),
        metadata,
      });
    }

    return c.text("", 200, { ETag: `"${etag}"` });
  });

  // GetObject - GET /s3/:bucket/:key{.+}
  app.get("/s3/:bucket/:key{.+}", (c) => {
    const bucketName = c.req.param("bucket");
    const key = c.req.param("key");

    const bucket = aws().s3Buckets.findOneBy("bucket_name", bucketName);
    if (!bucket) {
      return awsErrorXml(c, "NoSuchBucket", "The specified bucket does not exist.", 404);
    }

    const obj = aws()
      .s3Objects.findBy("bucket_name", bucketName)
      .find((o) => o.key === key);

    if (!obj) {
      return awsErrorXml(c, "NoSuchKey", "The specified key does not exist.", 404);
    }

    const headers: Record<string, string> = {
      "Content-Type": obj.content_type,
      "Content-Length": String(obj.content_length),
      ETag: `"${obj.etag}"`,
      "Last-Modified": obj.last_modified,
    };
    for (const [k, v] of Object.entries(obj.metadata)) {
      headers[`x-amz-meta-${k}`] = v;
    }

    return c.text(obj.body, 200, headers);
  });

  // HeadObject - HEAD /s3/:bucket/:key{.+}
  app.on("HEAD", "/s3/:bucket/:key{.+}", (c) => {
    const bucketName = c.req.param("bucket");
    const key = c.req.param("key");

    const obj = aws()
      .s3Objects.findBy("bucket_name", bucketName)
      .find((o) => o.key === key);

    if (!obj) {
      return c.text("", 404);
    }

    return c.text("", 200, {
      "Content-Type": obj.content_type,
      "Content-Length": String(obj.content_length),
      ETag: `"${obj.etag}"`,
      "Last-Modified": obj.last_modified,
    });
  });

  // DeleteObject - DELETE /s3/:bucket/:key{.+}
  app.delete("/s3/:bucket/:key{.+}", (c) => {
    const bucketName = c.req.param("bucket");
    const key = c.req.param("key");

    const obj = aws()
      .s3Objects.findBy("bucket_name", bucketName)
      .find((o) => o.key === key);

    if (obj) {
      aws().s3Objects.delete(obj.id);
    }

    // S3 returns 204 even if the key doesn't exist
    return c.body(null, 204);
  });

}

