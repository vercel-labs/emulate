import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@emulators/core";
import { seedFromConfig, type AwsSeedConfig } from "../index.js";
import { createTestApp } from "./helpers.js";

interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

let upstream: Server;
let upstreamUrl: string;
let recorded: Recorded[] = [];
let respond: (request: Recorded) => {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
} = () => ({});

beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request = { method: req.method!, path: req.url!, headers: req.headers, body: Buffer.concat(chunks) };
    recorded.push(request);
    const reply = respond(request);
    const body = reply.body ?? "";
    res.writeHead(reply.status ?? 200, { "content-length": String(Buffer.byteLength(body)), ...reply.headers });
    res.end(body);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

afterEach(() => {
  recorded = [];
  respond = () => ({});
});

function backendApp(config: Omit<AwsSeedConfig, "backend"> = {}, url = upstreamUrl) {
  const test = createTestApp();
  seedFromConfig(test.store, "http://localhost:4000", { ...config, backend: { url } });
  return test;
}

/** Serves the app on a real socket, so requests go through node's HTTP parser like SDK traffic does. */
async function listen(app: ReturnType<typeof createTestApp>["app"]) {
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const send = (path: string, options: { method?: string; headers?: Record<string, string>; chunks?: Buffer[] }) =>
    new Promise<{ status: number; headers: IncomingMessage["headers"]; body: Buffer }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers });
      req.once("error", reject);
      req.once("response", async (res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of res) chunks.push(chunk as Buffer);
        resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) });
      });
      for (const chunk of options.chunks ?? []) req.write(chunk);
      req.end();
    });
  return { send, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const scope = (request: Recorded) =>
  /Credential=[^/]+\/\d{8}\/[a-z0-9-]+\/([a-z0-9-]+)\//.exec(String(request.headers.authorization))?.[1];
const regionOf = (request: Recorded) =>
  /Credential=[^/]+\/\d{8}\/([a-z0-9-]+)\//.exec(String(request.headers.authorization))?.[1];

describe("aws.backend proxy", () => {
  it("forwards path-style S3 requests byte for byte with an s3 credential scope", async () => {
    respond = () => ({ headers: { "content-type": "application/octet-stream" }, body: Buffer.from([0, 255, 1]) });
    const { app } = backendApp();
    const payload = new Uint8Array([0, 128, 255, 10]);

    const res = await app.request("/bucket/a%20key.bin?x-id=PutObject", { method: "PUT", body: payload });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("3");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([0, 255, 1]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ method: "PUT", path: "/bucket/a%20key.bin?x-id=PutObject" });
    expect(Array.from(recorded[0].body)).toEqual(Array.from(payload));
    expect(scope(recorded[0])).toBe("s3");
  });

  it("strips emulate's service prefixes and rewrites SQS queue URLs to this emulator", async () => {
    respond = () => ({
      headers: { "content-type": "application/x-amz-json-1.0" },
      body: JSON.stringify({ QueueUrl: "https://sqs.us-east-1.amazonaws.com/000000000000/jobs" }),
    });
    const { app } = backendApp();

    const res = await app.request("/sqs/", {
      method: "POST",
      headers: { "x-amz-target": "AmazonSQS.CreateQueue", "content-type": "application/x-amz-json-1.0" },
      body: JSON.stringify({ QueueName: "jobs" }),
    });

    expect(await res.json()).toEqual({ QueueUrl: "http://localhost:4000/sqs/000000000000/jobs" });
    expect(recorded[0]).toMatchObject({ path: "/" });
    expect(recorded[0].headers["x-amz-target"]).toBe("AmazonSQS.CreateQueue");
    expect(scope(recorded[0])).toBe("sqs");

    for (const service of ["iam", "sts", "kms"]) {
      await app.request(`/${service}/`, { method: "POST", body: "{}" });
      expect(scope(recorded.at(-1)!)).toBe(service);
      expect(recorded.at(-1)!.path).toBe("/");
    }
    await app.request("/s3/bucket/key");
    expect(recorded.at(-1)).toMatchObject({ path: "/bucket/key" });
  });

  it("keeps the caller's own Authorization header", async () => {
    const { app } = backendApp();
    const authorization =
      "AWS4-HMAC-SHA256 Credential=AKIA/20260101/us-east-1/kms/aws4_request, SignedHeaders=host, Signature=abc";

    await app.request("/kms", { method: "POST", headers: { authorization }, body: "{}" });

    expect(recorded[0].headers.authorization).toBe(authorization);
  });

  it("serves Cognito and the inspector natively", async () => {
    const { app } = backendApp();

    const discovery = await app.request("/cognito-idp/us-east-1_emulate/.well-known/openid-configuration");
    const inspector = await app.request("/_inspector?tab=sqs");

    expect(discovery.status).toBe(200);
    expect(await inspector.text()).toContain(`<code>${upstreamUrl}</code>`);
    expect(recorded).toHaveLength(0);
  });

  it("seeds the backend through its API before the first proxied request", async () => {
    respond = (request) =>
      String(request.headers["x-amz-target"]).endsWith("DescribeKey")
        ? { status: 400, body: JSON.stringify({ __type: "NotFoundException" }) }
        : String(request.headers["x-amz-target"]).endsWith("CreateKey")
          ? { body: JSON.stringify({ KeyMetadata: { KeyId: "key-1" } }) }
          : {};
    const { app } = backendApp({
      s3: { buckets: [{ name: "uploads" }] },
      sqs: { queues: [{ name: "events.fifo", visibility_timeout: 5 }] },
      iam: { users: [{ user_name: "dev", create_access_key: true }], roles: [{ role_name: "ci" }] },
      kms: { keys: [{ description: "app", aliases: ["alias/app"] }] },
    });

    await app.request("/");

    const calls = recorded.map((r) => `${scope(r)} ${r.headers["x-amz-target"] ?? r.method} ${r.path}`);
    expect(calls).toEqual([
      "s3 PUT /uploads",
      "sqs AmazonSQS.CreateQueue /",
      "iam POST /",
      "iam POST /",
      "iam POST /",
      "kms TrentService.DescribeKey /",
      "kms TrentService.CreateKey /",
      "kms TrentService.CreateAlias /",
      "s3 GET /",
    ]);
    expect(JSON.parse(recorded[1].body.toString())).toEqual({
      QueueName: "events.fifo",
      Attributes: { FifoQueue: "true", VisibilityTimeout: "5" },
    });
    expect(recorded.slice(2, 5).map((r) => new URLSearchParams(r.body.toString()).get("Action"))).toEqual([
      "CreateUser",
      "CreateAccessKey",
      "CreateRole",
    ]);
    expect(JSON.parse(recorded[7].body.toString())).toEqual({ AliasName: "alias/app", TargetKeyId: "key-1" });
  });

  it("reports seed failures on proxied requests", async () => {
    respond = (request) => (request.method === "PUT" ? { status: 400, body: "<Code>InvalidBucketName</Code>" } : {});
    const { app } = backendApp({ s3: { buckets: [{ name: "Bad_Name" }] } });

    const res = await app.request("/");

    expect(res.status).toBe(502);
    expect(((await res.json()) as { message: string }).message).toContain("InvalidBucketName");
  });

  it("retries a failed seed instead of keeping the rejection", async () => {
    respond = (request) => (request.method === "PUT" ? { status: 500, body: "boom" } : {});
    const config = { backend: { url: upstreamUrl }, s3: { buckets: [{ name: "uploads" }] } };
    const { app, store } = createTestApp();
    seedFromConfig(store, "http://localhost:4000", config);
    expect((await app.request("/")).status).toBe(502);

    respond = () => ({});
    seedFromConfig(store, "http://localhost:4000", config);

    expect((await app.request("/")).status).toBe(200);
    expect(recorded.map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /uploads", "PUT /uploads", "GET /"]);
  });

  it("returns 502 when the backend is unreachable", async () => {
    const { app } = backendApp({}, "http://127.0.0.1:1");

    const res = await app.request("/");

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ __type: "BackendUnavailable" });
  });

  it("rejects seed settings the backend cannot honor", () => {
    const { store } = createTestApp();
    const seed = (config: AwsSeedConfig) => () => seedFromConfig(store, "http://localhost:4000", config);

    expect(seed({ backend: { url: "not a url" } })).toThrow("aws.backend.url must be an absolute URL");
    expect(seed({ backend: { url: "localhost:4566" } })).toThrow("aws.backend.url must use http or https");
    expect(seed({ backend: { url: "ftp://127.0.0.1:4566" } })).toThrow("aws.backend.url must use http or https");
    expect(seed({ backend: { url: upstreamUrl }, account_id: "111111111111" })).toThrow("aws.account_id");
    expect(seed({ backend: { url: upstreamUrl }, kms: { keys: [{ key_id: "fixed" }] } })).toThrow(
      "aws.kms.keys[].key_id",
    );
  });

  it("forwards uploads that use Expect: 100-continue or chunked transfer encoding", async () => {
    const { app } = backendApp();
    const server = await listen(app);
    const large = Buffer.alloc(3 * 1024 * 1024, 7);
    try {
      const expectContinue = await server.send("/bucket/large.bin", {
        method: "PUT",
        headers: { expect: "100-continue", "content-length": String(large.length) },
        chunks: [large],
      });
      const chunked = await server.send("/bucket/chunked.bin", {
        method: "PUT",
        headers: { "transfer-encoding": "chunked" },
        chunks: [Buffer.from("ab"), Buffer.from("cd")],
      });

      expect([expectContinue.status, chunked.status]).toEqual([200, 200]);
      expect(recorded[0].body.equals(large)).toBe(true);
      expect(recorded[0].headers.expect).toBeUndefined();
      expect(recorded[1].body.toString()).toBe("abcd");
      expect(recorded[1].headers["transfer-encoding"]).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("passes encoded bodies and HEAD metadata through unchanged", async () => {
    const gzipped = gzipSync("hello, compressed world");
    respond = (req): ReturnType<typeof respond> =>
      req.method === "HEAD"
        ? { headers: { "content-length": "42", etag: '"abc"' } }
        : { headers: { "content-encoding": "gzip" }, body: gzipped };
    const { app } = backendApp();
    const server = await listen(app);
    try {
      const get = await server.send("/bucket/file.txt", { headers: { "accept-encoding": "gzip" } });
      const head = await server.send("/bucket/file.txt", { method: "HEAD" });

      expect(get.headers["content-encoding"]).toBe("gzip");
      expect(get.headers["content-length"]).toBe(String(gzipped.length));
      expect(get.body.equals(gzipped)).toBe(true);
      expect(recorded[0].headers["accept-encoding"]).toBe("gzip");
      expect(head).toMatchObject({ status: 200, headers: { "content-length": "42", etag: '"abc"' } });
      expect(head.body.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("rewrites queue URL fields without touching message bodies", async () => {
    const remote = "https://sqs.us-east-1.amazonaws.com/000000000000/jobs";
    respond = (req) =>
      req.headers["x-amz-target"] === "AmazonSQS.ReceiveMessage"
        ? { body: JSON.stringify({ Messages: [{ Body: `see ${remote}` }] }) }
        : req.headers["x-amz-target"] === "AmazonSQS.ListQueues"
          ? { body: JSON.stringify({ QueueUrls: [remote] }) }
          : {
              body: `<GetQueueUrlResponse><GetQueueUrlResult><QueueUrl>${remote}</QueueUrl></GetQueueUrlResult></GetQueueUrlResponse>`,
            };
    const { app } = backendApp();
    const call = (target?: string) =>
      app.request("/sqs/", { method: "POST", headers: target ? { "x-amz-target": target } : {}, body: "{}" });

    expect(await (await call("AmazonSQS.ReceiveMessage")).json()).toEqual({ Messages: [{ Body: `see ${remote}` }] });
    expect(await (await call("AmazonSQS.ListQueues")).json()).toEqual({
      QueueUrls: ["http://localhost:4000/sqs/000000000000/jobs"],
    });
    expect(await (await call()).text()).toContain("<QueueUrl>http://localhost:4000/sqs/000000000000/jobs</QueueUrl>");
  });

  it("keeps emulate's own routes local and points backend redirects at the emulator", async () => {
    respond = () => ({ status: 307, headers: { location: `${upstreamUrl}/bucket/moved` } });
    const { app } = backendApp();

    const font = await app.request("/_emulate/favicon.ico");
    const redirect = await app.request("/bucket/old");

    expect(recorded.map((r) => r.path)).toEqual(["/bucket/old"]);
    expect(font.status).not.toBe(307);
    expect(redirect.headers.get("location")).toBe("http://localhost:4000/bucket/moved");
  });

  it("leaves presigned requests unsigned by the emulator", async () => {
    const { app } = backendApp();

    await app.request("/bucket/key?X-Amz-Credential=AKIA%2F20260101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=x");

    expect(recorded[0].headers.authorization).toBeUndefined();
  });

  it("does not seed the backend again on reset", async () => {
    const config = { backend: { url: upstreamUrl }, s3: { buckets: [{ name: "uploads" }] } };
    const { app, store } = createTestApp();
    seedFromConfig(store, "http://localhost:4000", config);
    await app.request("/");
    store.reset();
    seedFromConfig(store, "http://localhost:4000", config);
    await app.request("/");

    expect(recorded.map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /uploads", "GET /", "GET /"]);
  });

  it("tolerates resources left by an earlier start", async () => {
    respond = (req) => {
      const action = new URLSearchParams(req.body.toString()).get("Action");
      if (req.method === "PUT") return { status: 409, body: "<Code>BucketAlreadyOwnedByYou</Code>" };
      if (req.headers["x-amz-target"] === "AmazonSQS.CreateQueue")
        return { status: 400, body: JSON.stringify({ __type: "QueueNameExists" }) };
      if (action === "CreateUser" || action === "CreateRole")
        return { status: 409, body: "<Code>EntityAlreadyExists</Code>" };
      if (req.headers["x-amz-target"] === "TrentService.DescribeKey") return { body: "{}" };
      return {};
    };
    const { app } = backendApp({
      s3: { buckets: [{ name: "uploads" }] },
      sqs: { queues: [{ name: "events" }] },
      iam: { users: [{ user_name: "dev", create_access_key: true }], roles: [{ role_name: "ci" }] },
      kms: { keys: [{ aliases: ["alias/app"] }] },
    });

    const res = await app.request("/");

    expect(res.status).toBe(200);
    const actions = recorded.map(
      (r) => r.headers["x-amz-target"] ?? new URLSearchParams(r.body.toString()).get("Action") ?? r.method,
    );
    expect(actions).toEqual([
      "PUT",
      "AmazonSQS.CreateQueue",
      "CreateUser",
      "CreateRole",
      "TrentService.DescribeKey",
      "GET",
    ]);
  });

  it("serves rewritten SQS bodies and empty 204 responses over a real socket", async () => {
    respond = (req) =>
      req.method === "DELETE"
        ? { status: 204 }
        : { body: JSON.stringify({ QueueUrl: "https://sqs.us-east-1.amazonaws.com/000000000000/q" }) };
    const { app } = backendApp();
    const server = await listen(app);
    try {
      const sqs = await server.send("/sqs/", { method: "POST", chunks: [Buffer.from("{}")] });
      const deleted = await server.send("/bucket/key", { method: "DELETE" });

      expect(JSON.parse(sqs.body.toString())).toEqual({ QueueUrl: "http://localhost:4000/sqs/000000000000/q" });
      expect(Number(sqs.headers["content-length"] ?? sqs.body.length)).toBe(sqs.body.length);
      expect(deleted.status).toBe(204);
    } finally {
      await server.close();
    }
  });

  it("seeds and signs for the configured region", async () => {
    const { app } = backendApp({
      region: "eu-west-1",
      s3: { buckets: [{ name: "west" }, { name: "east", region: "us-east-1" }] },
      sqs: { queues: [{ name: "jobs" }] },
    });

    await app.request("/sqs/", { method: "POST", body: "{}" });

    expect(recorded.map((r) => `${r.method} ${r.path} ${regionOf(r)}`)).toEqual([
      "PUT /west eu-west-1",
      "PUT /east us-east-1",
      "POST / eu-west-1",
      "POST / eu-west-1",
    ]);
    expect(recorded[0].body.toString()).toContain("<LocationConstraint>eu-west-1</LocationConstraint>");
    expect(recorded[1].body.length).toBe(0);
  });

  it("rewrites queue URLs on the backend's own host and leaves compressed SQS bodies alone", async () => {
    const gzipped = gzipSync(JSON.stringify({ QueueUrl: "https://sqs.us-east-1.amazonaws.com/000000000000/q" }));
    respond = (req): ReturnType<typeof respond> =>
      req.headers["x-amz-target"] === "AmazonSQS.GetQueueUrl"
        ? { headers: { "content-encoding": "gzip" }, body: gzipped }
        : { body: JSON.stringify({ QueueUrl: `${upstreamUrl}/000000000000/q` }) };
    const { app } = backendApp();
    const call = (target: string) =>
      app.request("/sqs/", {
        method: "POST",
        headers: { "x-amz-target": target, "accept-encoding": "gzip" },
        body: "{}",
      });

    expect(await (await call("AmazonSQS.CreateQueue")).json()).toEqual({
      QueueUrl: "http://localhost:4000/sqs/000000000000/q",
    });
    expect(recorded[0].headers["accept-encoding"]).toBe("identity");
    const compressed = await call("AmazonSQS.GetQueueUrl");
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(Buffer.from(await compressed.arrayBuffer()).equals(gzipped)).toBe(true);
  });

  it("keeps the service prefix when rewriting redirects", async () => {
    respond = () => ({ status: 307, headers: { location: `${upstreamUrl}/elsewhere` } });
    const { app } = backendApp();

    const res = await app.request("/kms/", { method: "POST", body: "{}" });

    expect(res.headers.get("location")).toBe("http://localhost:4000/kms/elsewhere");
  });

  it("rewrites dead-letter source queue URLs, multipart upload locations, and relative redirects", async () => {
    respond = (req): ReturnType<typeof respond> => {
      if (req.headers["x-amz-target"] === "AmazonSQS.ListDeadLetterSourceQueues")
        return { body: JSON.stringify({ queueUrls: ["https://sqs.eu-west-1.amazonaws.com/000000000000/src"] }) };
      if (req.method === "POST" && req.path.includes("uploadId"))
        return {
          headers: { "content-type": "application/xml" },
          body: `<CompleteMultipartUploadResult><Location>${upstreamUrl}/bucket/obj</Location></CompleteMultipartUploadResult>`,
        };
      return { status: 307, headers: { location: "/moved" } };
    };
    const { app } = backendApp();

    const dlq = await app.request("/sqs/", {
      method: "POST",
      headers: { "x-amz-target": "AmazonSQS.ListDeadLetterSourceQueues" },
      body: "{}",
    });
    const multipart = await app.request("/bucket/obj?uploadId=1", { method: "POST", body: "<x/>" });
    const redirect = await app.request("/kms/", { method: "POST", body: "{}" });

    expect(await dlq.json()).toEqual({ queueUrls: ["http://localhost:4000/sqs/000000000000/src"] });
    expect(await multipart.text()).toContain("<Location>http://localhost:4000/bucket/obj</Location>");
    expect(redirect.headers.get("location")).toBe("/kms/moved");
  });

  it("rejects regions that are not region names", () => {
    const { store } = createTestApp();

    expect(() =>
      seedFromConfig(store, "http://localhost:4000", { backend: { url: upstreamUrl }, region: "eu</x>" }),
    ).toThrow("aws.region must look like us-east-1");
  });
});
