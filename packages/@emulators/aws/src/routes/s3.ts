import type { Context } from "hono";
import type { AppEnv, RouteContext } from "@emulators/core";
import { getAwsStore } from "../store.js";
import { awsXmlResponse, awsErrorXml, md5, escapeXml } from "../helpers.js";

// Handlers are reused across multiple routes (root paths + legacy `/s3/` aliases,
// with and without trailing slashes). Parameterizing on the bucket/key path pattern
// lets c.req.param("bucket") / c.req.param("key") resolve to `string` instead of
// `string | undefined`, since those segments are always present for these routes.
type S3BucketContext = Context<AppEnv, "/:bucket">;
type S3ObjectContext = Context<AppEnv, "/:bucket/:key">;

export function s3Routes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const aws = () => getAwsStore(store);

  // --- Handler functions (shared between root and /s3/ paths) ---

  const handleListBuckets = (c: Context<AppEnv>) => {
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
  };

  const handleCreateBucket = (c: S3BucketContext) => {
    const bucketName = c.req.param("bucket");
    const existing = aws().s3Buckets.findOneBy("bucket_name", bucketName);
    if (existing) {
      return awsErrorXml(
        c,
        "BucketAlreadyOwnedByYou",
        "Your previous request to create the named bucket succeeded and you already own it.",
        409,
      );
    }

    aws().s3Buckets.insert({
      bucket_name: bucketName,
      region: "us-east-1",
      creation_date: new Date().toISOString(),
      acl: "private",
      versioning_enabled: false,
    });

    return c.text("", 200, { Location: `/${bucketName}` });
  };

  const handleDeleteBucket = (c: S3BucketContext) => {
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
  };

  const handleHeadBucket = (c: S3BucketContext) => {
    const bucketName = c.req.param("bucket");
    const bucket = aws().s3Buckets.findOneBy("bucket_name", bucketName);
    if (!bucket) {
      return c.text("", 404);
    }
    return c.text("", 200, { "x-amz-bucket-region": bucket.region });
  };

  const handleListObjects = (c: S3BucketContext) => {
    const bucketName = c.req.param("bucket");
    const bucket = aws().s3Buckets.findOneBy("bucket_name", bucketName);
    if (!bucket) {
      return awsErrorXml(c, "NoSuchBucket", "The specified bucket does not exist.", 404);
    }

    const prefix = c.req.query("prefix") ?? "";
    const delimiter = c.req.query("delimiter") ?? "";
    const maxKeys = Math.min(parseInt(c.req.query("max-keys") ?? "1000", 10), 1000);
    const continuationToken = c.req.query("continuation-token");
    const startAfter = c.req.query("start-after");

    let objects = aws().s3Objects.findBy("bucket_name", bucketName);
    if (prefix) {
      objects = objects.filter((o) => o.key.startsWith(prefix));
    }

    // Sort by key for stable pagination
    objects.sort((a, b) => a.key.localeCompare(b.key));

    // Apply continuation-token or start-after
    const marker = continuationToken ?? startAfter;
    if (marker) {
      const startIndex = objects.findIndex((o) => o.key > marker);
      objects = startIndex >= 0 ? objects.slice(startIndex) : [];
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
    const nextToken = truncated ? page[page.length - 1].key : undefined;

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
  <KeyCount>${page.length}</KeyCount>${continuationToken ? `\n  <ContinuationToken>${escapeXml(continuationToken)}</ContinuationToken>` : ""}${nextToken ? `\n  <NextContinuationToken>${escapeXml(nextToken)}</NextContinuationToken>` : ""}${startAfter ? `\n  <StartAfter>${escapeXml(startAfter)}</StartAfter>` : ""}
${contentsXml}
${prefixesXml}
</ListBucketResult>`;
    return awsXmlResponse(c, xml);
  };

  const handlePresignedPost = async (c: S3BucketContext) => {
    const bucketName = c.req.param("bucket");
    const bucket = aws().s3Buckets.findOneBy("bucket_name", bucketName);
    if (!bucket) {
      return awsErrorXml(c, "NoSuchBucket", "The specified bucket does not exist.", 404);
    }

    const body = await c.req.parseBody();

    const key = body["key"] as string;
    if (!key) {
      return awsErrorXml(c, "InvalidArgument", "Bucket POST must contain a field named 'key'.", 400);
    }

    const file = body["file"];
    if (!file || !(file instanceof File)) {
      return awsErrorXml(c, "InvalidArgument", "Bucket POST must contain a file field.", 400);
    }

    // Policy validation
    const policyB64 = body["Policy"] as string;
    if (policyB64) {
      let policy: { expiration?: string; conditions?: unknown[] };
      try {
        policy = JSON.parse(Buffer.from(policyB64, "base64").toString());
      } catch {
        return awsErrorXml(c, "InvalidPolicyDocument", "Invalid Policy: Invalid JSON.", 400);
      }

      // Check expiration
      if (policy.expiration) {
        const expDate = new Date(policy.expiration);
        if (expDate.getTime() < Date.now()) {
          return awsErrorXml(c, "AccessDenied", "Invalid according to Policy: Policy expired.", 403);
        }
      }

      // Enforce conditions
      if (Array.isArray(policy.conditions)) {
        for (const condition of policy.conditions) {
          if (!Array.isArray(condition)) continue;

          if (condition[0] === "content-length-range") {
            const min = condition[1] as number;
            const max = condition[2] as number;
            if (file.size < min || file.size > max) {
              return awsErrorXml(c, "EntityTooLarge", "Your proposed upload exceeds the maximum allowed size.", 400);
            }
          } else if (condition[0] === "starts-with") {
            const field = (condition[1] as string).replace(/^\$/, "");
            const prefix = condition[2] as string;
            const value = (body[field] as string) ?? "";
            if (!value.startsWith(prefix)) {
              return awsErrorXml(
                c,
                "AccessDenied",
                `Invalid according to Policy: Policy Condition failed: ["starts-with", "$${field}", "${prefix}"]`,
                403,
              );
            }
          }
        }
      }
    }

    // Store the object
    const fileContent = await file.text();
    const contentType = (body["Content-Type"] as string) ?? file.type ?? "application/octet-stream";
    const etag = md5(fileContent);
    const contentLength = new TextEncoder().encode(fileContent).byteLength;

    const existing = aws()
      .s3Objects.findBy("bucket_name", bucketName)
      .find((o) => o.key === key);

    if (existing) {
      aws().s3Objects.update(existing.id, {
        body: fileContent,
        content_type: contentType,
        content_length: contentLength,
        etag,
        last_modified: new Date().toISOString(),
        metadata: {},
      });
    } else {
      aws().s3Objects.insert({
        bucket_name: bucketName,
        key,
        body: fileContent,
        content_type: contentType,
        content_length: contentLength,
        etag,
        last_modified: new Date().toISOString(),
        metadata: {},
      });
    }

    // Check success_action_status
    const successStatus = parseInt(body["success_action_status"] as string, 10);
    if (successStatus === 201) {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PostResponse>
  <Location>${escapeXml(baseUrl)}/${escapeXml(bucketName)}/${escapeXml(key)}</Location>
  <Bucket>${escapeXml(bucketName)}</Bucket>
  <Key>${escapeXml(key)}</Key>
  <ETag>"${etag}"</ETag>
</PostResponse>`;
      return awsXmlResponse(c, xml, 201);
    }

    return c.body(null, 204);
  };

  const handlePutObject = async (c: S3ObjectContext) => {
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
      return c.text(xml, 200, {
        "Content-Type": "application/xml",
        "Last-Modified": new Date(now).toUTCString(),
      });
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
  };

  const handleGetObject = (c: S3ObjectContext) => {
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
      "Last-Modified": new Date(obj.last_modified).toUTCString(),
    };
    for (const [k, v] of Object.entries(obj.metadata)) {
      headers[`x-amz-meta-${k}`] = v;
    }

    return c.text(obj.body, 200, headers);
  };

  const handleHeadObject = (c: S3ObjectContext) => {
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
      "Last-Modified": new Date(obj.last_modified).toUTCString(),
    });
  };

  const handleDeleteObject = (c: S3ObjectContext) => {
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
  };

  // --- Backward-compat aliases (legacy /s3/ prefix, registered first so
  //     the static /s3 segment is not shadowed by /:bucket wildcards) ---
  app.get("/s3/", handleListBuckets);
  app.put("/s3/:bucket", handleCreateBucket);
  app.delete("/s3/:bucket", handleDeleteBucket);
  app.on("HEAD", "/s3/:bucket", handleHeadBucket);
  app.get("/s3/:bucket", handleListObjects);
  app.post("/s3/:bucket", handlePresignedPost);
  app.put("/s3/:bucket/:key{.+}", handlePutObject);
  app.get("/s3/:bucket/:key{.+}", handleGetObject);
  app.on("HEAD", "/s3/:bucket/:key{.+}", handleHeadObject);
  app.delete("/s3/:bucket/:key{.+}", handleDeleteObject);

  // --- Primary routes (AWS SDK-compatible, root paths) ---
  // Bucket-level routes register both no-slash and trailing-slash variants because
  // the AWS SDK sends e.g. `HEAD /bucket/`, `PUT /bucket/`, `GET /bucket/?list-type=2`
  // when the key is empty, and Hono treats `/:bucket` and `/:bucket/` as distinct.
  app.get("/", handleListBuckets);
  app.put("/:bucket", handleCreateBucket);
  app.put("/:bucket/", handleCreateBucket);
  app.delete("/:bucket", handleDeleteBucket);
  app.delete("/:bucket/", handleDeleteBucket);
  app.on("HEAD", "/:bucket", handleHeadBucket);
  app.on("HEAD", "/:bucket/", handleHeadBucket);
  app.get("/:bucket", handleListObjects);
  app.get("/:bucket/", handleListObjects);
  app.post("/:bucket", handlePresignedPost);
  app.post("/:bucket/", handlePresignedPost);
  app.put("/:bucket/:key{.+}", handlePutObject);
  app.get("/:bucket/:key{.+}", handleGetObject);
  app.on("HEAD", "/:bucket/:key{.+}", handleHeadObject);
  app.delete("/:bucket/:key{.+}", handleDeleteObject);
}
