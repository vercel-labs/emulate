import type { Context } from "@emulators/core";
import type { AppEnv, RouteContext } from "@emulators/core";
import type { S3Object } from "../entities.js";
import { getAwsStore } from "../store.js";
import { awsXmlResponse, awsErrorXml, decodeS3ObjectBody, md5, escapeXml, unescapeXml } from "../helpers.js";

// Handlers are reused across multiple routes (root paths + legacy `/s3/` aliases,
// with and without trailing slashes). Parameterizing on the bucket/key path pattern
// lets c.req.param("bucket") / c.req.param("key") resolve to `string` instead of
// `string | undefined`, since those segments are always present for these routes.
type S3BucketContext = Context<AppEnv, "/:bucket">;
type S3ObjectContext = Context<AppEnv, "/:bucket/:key">;

function compareKeys(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function parseETagList(header: string): string[] {
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, "").replace(/^"|"$/g, ""))
    .filter((tag) => tag.length > 0);
}

function etagListMatches(header: string, etag: string): boolean {
  const tags = parseETagList(header);
  return tags.includes("*") || tags.includes(etag);
}

const PRECONDITION_FAILED = "At least one of the pre-conditions you specified did not hold";

function failedWritePrecondition(c: Context<AppEnv>, existing: S3Object | undefined): Response | undefined {
  const ifNoneMatch = c.req.header("If-None-Match");
  const ifMatch = c.req.header("If-Match");
  if (ifNoneMatch !== undefined && existing && etagListMatches(ifNoneMatch, existing.etag)) {
    return awsErrorXml(c, "PreconditionFailed", PRECONDITION_FAILED, 412);
  }
  if (ifMatch !== undefined) {
    if (!existing) {
      return awsErrorXml(c, "NoSuchKey", "The specified key does not exist.", 404);
    }
    if (!etagListMatches(ifMatch, existing.etag)) {
      return awsErrorXml(c, "PreconditionFailed", PRECONDITION_FAILED, 412);
    }
  }
  return undefined;
}

type ReadCondition = "pass" | "not-modified" | "failed";

function parseHttpDate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function evaluateReadConditions(c: Context<AppEnv>, obj: S3Object, prefix: string): ReadCondition {
  const header = (name: string) => c.req.header(prefix + name);
  const modified = Math.floor(Date.parse(obj.last_modified) / 1000) * 1000;

  const ifMatch = header("if-match");
  if (ifMatch !== undefined) {
    if (!etagListMatches(ifMatch, obj.etag)) return "failed";
  } else {
    const unmodifiedSince = parseHttpDate(header("if-unmodified-since"));
    if (unmodifiedSince !== undefined && modified > unmodifiedSince) return "failed";
  }

  const ifNoneMatch = header("if-none-match");
  if (ifNoneMatch !== undefined) {
    return etagListMatches(ifNoneMatch, obj.etag) ? "not-modified" : "pass";
  }
  const modifiedSince = parseHttpDate(header("if-modified-since"));
  if (modifiedSince !== undefined && modified <= modifiedSince) return "not-modified";
  return "pass";
}

type ByteRange = { start: number; end: number };

function parseRange(header: string | undefined, total: number): ByteRange | "unsatisfiable" | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return undefined;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0 || total === 0) return "unsatisfiable";
    return { start: Math.max(total - suffix, 0), end: total - 1 };
  }
  const start = Number(match[1]);
  if (match[2] !== "" && Number(match[2]) < start) return undefined;
  if (start >= total) return "unsatisfiable";
  return { start, end: match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1) };
}

function writeObjectBody(body: Uint8Array): Pick<S3Object, "body_base64" | "body"> {
  return { body_base64: Buffer.from(body).toString("base64"), body: undefined };
}

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

    objects.sort((a, b) => compareKeys(a.key, b.key));

    // Apply continuation-token or start-after
    const marker = continuationToken ?? startAfter;
    if (marker) {
      const startIndex = objects.findIndex((o) => compareKeys(o.key, marker) > 0);
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
      commonPrefixes.push(...Array.from(prefixSet).sort(compareKeys));
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

  const handleDeleteObjects = async (c: S3BucketContext, bucketName: string) => {
    const xml = await c.req.text();
    const entries = [...xml.matchAll(/<Object>([\s\S]*?)<\/Object>/g)].map((m) => {
      const etag = /<ETag\s*\/>|<ETag>([\s\S]*?)<\/ETag>/.exec(m[1]);
      return {
        key: unescapeXml(/<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1] ?? ""),
        etag: etag ? unescapeXml(etag[1] ?? "") : undefined,
      };
    });
    const quiet = /<Quiet>\s*true\s*<\/Quiet>/i.test(xml);
    const objects = aws().s3Objects.findBy("bucket_name", bucketName);
    const results: string[] = [];
    for (const { key, etag } of entries) {
      const obj = objects.find((o) => o.key === key);
      let error: [string, string] | undefined;
      if (etag !== undefined && !obj) {
        error = ["NoSuchKey", "The specified key does not exist."];
      } else if (etag !== undefined && obj && !etagListMatches(etag, obj.etag)) {
        error = ["PreconditionFailed", PRECONDITION_FAILED];
      }
      if (error) {
        results.push(
          `  <Error><Key>${escapeXml(key)}</Key><Code>${error[0]}</Code><Message>${escapeXml(error[1])}</Message></Error>`,
        );
        continue;
      }
      if (obj) aws().s3Objects.delete(obj.id);
      if (!quiet) results.push(`  <Deleted><Key>${escapeXml(key)}</Key></Deleted>`);
    }
    return awsXmlResponse(
      c,
      `<?xml version="1.0" encoding="UTF-8"?>
<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
${results.join("\n")}
</DeleteResult>`,
    );
  };

  const handlePresignedPost = async (c: S3BucketContext) => {
    const bucketName = c.req.param("bucket");
    const bucket = aws().s3Buckets.findOneBy("bucket_name", bucketName);
    if (!bucket) {
      return awsErrorXml(c, "NoSuchBucket", "The specified bucket does not exist.", 404);
    }

    if (new URL(c.req.url).searchParams.has("delete")) {
      return handleDeleteObjects(c, bucketName);
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
    const fileContent = Buffer.from(await file.arrayBuffer());
    const contentType = (body["Content-Type"] as string) ?? file.type ?? "application/octet-stream";
    const etag = md5(fileContent);
    const contentLength = fileContent.byteLength;
    const bodyFields = writeObjectBody(fileContent);

    const existing = aws()
      .s3Objects.findBy("bucket_name", bucketName)
      .find((o) => o.key === key);

    if (existing) {
      aws().s3Objects.update(existing.id, {
        ...bodyFields,
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
        ...bodyFields,
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
      let normalized: string;
      try {
        normalized = decodeURIComponent(copySource.split("?")[0].replace(/^\//, ""));
      } catch {
        return awsErrorXml(c, "InvalidArgument", "Invalid copy source.", 400);
      }
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
      if (evaluateReadConditions(c, srcObj, "x-amz-copy-source-") !== "pass") {
        return awsErrorXml(c, "PreconditionFailed", PRECONDITION_FAILED, 412);
      }

      const etag = srcObj.etag;
      const now = new Date().toISOString();
      const bodyFields = writeObjectBody(decodeS3ObjectBody(srcObj));

      const existing = aws()
        .s3Objects.findBy("bucket_name", bucketName)
        .find((o) => o.key === key);
      const failed = failedWritePrecondition(c, existing);
      if (failed) return failed;

      if (existing) {
        aws().s3Objects.update(existing.id, {
          ...bodyFields,
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
          ...bodyFields,
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

    const body = Buffer.from(await c.req.arrayBuffer());
    const contentType = c.req.header("Content-Type") ?? "application/octet-stream";
    const etag = md5(body);
    const bodyFields = writeObjectBody(body);

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
    const failed = failedWritePrecondition(c, existing);
    if (failed) return failed;

    if (existing) {
      aws().s3Objects.update(existing.id, {
        ...bodyFields,
        content_type: contentType,
        content_length: body.byteLength,
        etag,
        last_modified: new Date().toISOString(),
        metadata,
      });
    } else {
      aws().s3Objects.insert({
        bucket_name: bucketName,
        key,
        ...bodyFields,
        content_type: contentType,
        content_length: body.byteLength,
        etag,
        last_modified: new Date().toISOString(),
        metadata,
      });
    }

    return c.text("", 200, { ETag: `"${etag}"` });
  };

  const respondWithObject = (c: S3ObjectContext, obj: S3Object, head: boolean) => {
    const validators = {
      ETag: `"${obj.etag}"`,
      "Last-Modified": new Date(obj.last_modified).toUTCString(),
    };
    const condition = evaluateReadConditions(c, obj, "");
    if (condition === "not-modified") {
      return c.body(null, 304, validators);
    }
    if (condition === "failed") {
      return head ? c.text("", 412) : awsErrorXml(c, "PreconditionFailed", PRECONDITION_FAILED, 412);
    }

    const range = parseRange(c.req.header("Range"), obj.content_length);
    if (range === "unsatisfiable") {
      return head ? c.text("", 416) : awsErrorXml(c, "InvalidRange", "The requested range is not satisfiable", 416);
    }

    const headers: Record<string, string> = {
      ...validators,
      "Content-Type": obj.content_type,
      "Content-Length": String(obj.content_length),
      "Accept-Ranges": "bytes",
    };
    for (const [k, v] of Object.entries(obj.metadata)) {
      headers[`x-amz-meta-${k}`] = v;
    }
    const status = range ? 206 : 200;
    if (range) {
      headers["Content-Length"] = String(range.end - range.start + 1);
      headers["Content-Range"] = `bytes ${range.start}-${range.end}/${obj.content_length}`;
    }
    if (head) {
      return c.text("", status, headers);
    }
    const body = decodeS3ObjectBody(obj);
    return c.body(range ? body.subarray(range.start, range.end + 1) : body, status, headers);
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

    return respondWithObject(c, obj, false);
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

    return respondWithObject(c, obj, true);
  };

  const handleDeleteObject = (c: S3ObjectContext) => {
    const bucketName = c.req.param("bucket");
    const key = c.req.param("key");

    const obj = aws()
      .s3Objects.findBy("bucket_name", bucketName)
      .find((o) => o.key === key);

    if (c.req.header("If-Match") !== undefined) {
      const failed = failedWritePrecondition(c, obj);
      if (failed) return failed;
    }

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
  // when the key is empty, and the route matcher treats `/:bucket` and `/:bucket/` as distinct.
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
