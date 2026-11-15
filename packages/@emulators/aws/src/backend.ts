import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { AppEnv, Context, Hono, Store } from "@emulators/core";
import type { AwsSeedConfig } from "./index.js";

export interface AwsBackendConfig {
  url: string;
}

interface BackendState {
  url: string;
  region: string;
  ready: Promise<void>;
}

type ProxiedService = "s3" | "sqs" | "iam" | "sts" | "kms";

const STATE_KEY = "aws.backend";
const DEFAULT_REGION = "us-east-1";
const NATIVE_PREFIXES = ["/_emulate", "/_inspector", "/cognito-idp", "/cognito-identity"];
const SERVICE_PREFIXES: ProxiedService[] = ["sqs", "iam", "sts", "kms", "s3"];
const DEFAULT_TRUST_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
});
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
const DROPPED_REQUEST_HEADERS = [...HOP_BY_HOP_HEADERS, "host", "content-length", "expect"];
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
// Seeding runs once per emulator instance and backend; a successful seed survives resets.
const seeded = new WeakMap<Store, { url: string; ready: Promise<void> }>();

export function getAwsBackend(store: Store): BackendState | undefined {
  return store.getData<BackendState>(STATE_KEY);
}

/**
 * Validates `aws.backend` and stores it on the instance. Upstream seeding starts
 * right away; proxied requests wait for it to finish.
 */
export function configureAwsBackend(store: Store, config: AwsSeedConfig): void {
  const backend = config.backend!;
  let url: URL;
  try {
    url = new URL(backend.url);
  } catch {
    throw new Error(`aws.backend.url must be an absolute URL, got ${JSON.stringify(backend.url)}`);
  }
  if (config.account_id) {
    throw new Error("aws.account_id is not supported with aws.backend: the backend owns the account ID");
  }
  const pinnedKey = config.kms?.keys?.find((key) => key.key_id);
  if (pinnedKey) {
    throw new Error(
      `aws.kms.keys[].key_id is not supported with aws.backend: the backend generates key IDs (got ${pinnedKey.key_id})`,
    );
  }

  const upstream = url.toString().replace(/\/+$/, "");
  const region = config.region ?? DEFAULT_REGION;
  const badRegion = [region, ...(config.s3?.buckets ?? []).map((bucket) => bucket.region ?? region)].find(
    (value) => !/^[a-z0-9-]+$/.test(value),
  );
  if (badRegion !== undefined) throw new Error(`aws.region must look like us-east-1, got ${JSON.stringify(badRegion)}`);
  let ready = seeded.get(store)?.url === upstream ? seeded.get(store)!.ready : undefined;
  if (!ready) {
    ready = seedUpstream(upstream, region, config);
    seeded.set(store, { url: upstream, ready });
    // Surface seed failures on the first proxied request rather than as an unhandled rejection.
    // A failed seed is not cached, so the next seed pass, such as a reset, tries again.
    ready.catch(() => {
      if (seeded.get(store)?.ready === ready) seeded.delete(store);
    });
  }
  store.setData<BackendState>(STATE_KEY, { url: upstream, region, ready });
}

/** Proxies every non-Cognito, non-inspector request to the configured backend. */
export function registerBackendProxy(app: Hono<AppEnv>, store: Store, baseUrl: string): void {
  app.use("*", async (c, next) => {
    const backend = getAwsBackend(store);
    const path = new URL(c.req.url).pathname;
    if (!backend || NATIVE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      await next();
      return;
    }
    return proxy(c, backend, baseUrl);
  });
}

async function proxy(c: Context<AppEnv>, backend: BackendState, baseUrl: string): Promise<Response> {
  try {
    await backend.ready;
  } catch (error) {
    return backendError(`Seeding the AWS backend at ${backend.url} failed: ${errorMessage(error)}`);
  }

  const incoming = new URL(c.req.url);
  const { service, path } = route(incoming.pathname);
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, name) => {
    if (!DROPPED_REQUEST_HEADERS.includes(name)) headers[name] = value;
  });
  if (!headers.authorization && !incoming.searchParams.has("X-Amz-Credential")) {
    // The backend picks the service from the SigV4 credential scope, even with authentication off.
    headers.authorization = syntheticAuthorization(service, backend.region);
  }
  // Queue URLs are rewritten in the body, which needs it uncompressed.
  if (service === "sqs") headers["accept-encoding"] = "identity";

  const method = c.req.raw.method;
  const body = method === "GET" || method === "HEAD" ? undefined : Buffer.from(await c.req.raw.arrayBuffer());
  if (body) headers["content-length"] = String(body.length);

  let upstream: IncomingMessage;
  try {
    upstream = await forward(new URL(`${backend.url}${path}${incoming.search}`), method, headers, body);
  } catch (error) {
    return backendError(`The AWS backend at ${backend.url} is unreachable: ${errorMessage(error)}`);
  }

  const status = upstream.statusCode ?? 502;
  const responseHeaders = toHeaders(upstream.headers);
  const location = responseHeaders.get("location");
  const prefix = service === "s3" ? "" : `/${service}`;
  if (location?.startsWith(backend.url)) {
    responseHeaders.set("location", `${baseUrl}${prefix}${location.slice(backend.url.length)}`);
  } else if (location?.startsWith("/") && !location.startsWith("//")) {
    responseHeaders.set("location", `${prefix}${location}`);
  }

  if (method === "HEAD" || NULL_BODY_STATUSES.has(status)) {
    upstream.resume();
    return new Response(null, { status, headers: responseHeaders });
  }

  const encoded = (responseHeaders.get("content-encoding") ?? "identity") !== "identity";
  if (service === "sqs" && !encoded) {
    const text = await readText(upstream);
    responseHeaders.delete("content-length");
    return new Response(rewriteQueueUrls(text, baseUrl, backend.url), { status, headers: responseHeaders });
  }

  if (service === "s3" && method === "POST" && !encoded && /xml/.test(responseHeaders.get("content-type") ?? "")) {
    // CompleteMultipartUpload and browser-form uploads report the object's URL in <Location>.
    const text = await readText(upstream);
    responseHeaders.delete("content-length");
    return new Response(text.replaceAll(`<Location>${backend.url}/`, `<Location>${baseUrl}/`), {
      status,
      headers: responseHeaders,
    });
  }

  return new Response(Readable.toWeb(upstream) as ReadableStream<Uint8Array>, { status, headers: responseHeaders });
}

async function readText(stream: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Sends the request as-is. Unlike fetch, node:http neither rejects Expect nor decodes Content-Encoding. */
function forward(url: URL, method: string, headers: Record<string, string>, body?: Buffer): Promise<IncomingMessage> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, { method, headers }, resolve);
    req.once("error", reject);
    req.end(body);
  });
}

function toHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.includes(name)) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

const AWS_QUEUE_URL = /^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\//;

/** Points QueueUrl fields back at this emulator, leaving message bodies untouched. */
function rewriteQueueUrls(text: string, baseUrl: string, backendUrl: string): string {
  const local = (url: string) =>
    url.startsWith(`${backendUrl}/`)
      ? `${baseUrl}/sqs${url.slice(backendUrl.length)}`
      : url.replace(AWS_QUEUE_URL, `${baseUrl}/sqs/`);
  if (text.trimStart().startsWith("<")) {
    return text.replace(/<QueueUrl>([^<]*)<\/QueueUrl>/g, (_, url: string) => `<QueueUrl>${local(url)}</QueueUrl>`);
  }
  try {
    const data = JSON.parse(text) as { QueueUrl?: unknown; QueueUrls?: unknown; queueUrls?: unknown };
    if (typeof data.QueueUrl === "string") data.QueueUrl = local(data.QueueUrl);
    if (Array.isArray(data.QueueUrls))
      data.QueueUrls = data.QueueUrls.map((url) => (typeof url === "string" ? local(url) : url));
    // ListDeadLetterSourceQueues names the field in lower camel case.
    if (Array.isArray(data.queueUrls))
      data.queueUrls = data.queueUrls.map((url) => (typeof url === "string" ? local(url) : url));
    return JSON.stringify(data);
  } catch {
    return text;
  }
}

function route(pathname: string): { service: ProxiedService; path: string } {
  for (const service of SERVICE_PREFIXES) {
    const prefix = `/${service}`;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return { service, path: pathname.slice(prefix.length) || "/" };
    }
  }
  return { service: "s3", path: pathname };
}

function syntheticAuthorization(service: ProxiedService, region: string): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `AWS4-HMAC-SHA256 Credential=AKIAEMULATE/${date}/${region}/${service}/aws4_request, SignedHeaders=host, Signature=0`;
}

function backendError(message: string): Response {
  return Response.json({ __type: "BackendUnavailable", message }, { status: 502 });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}

async function seedUpstream(upstream: string, region: string, config: AwsSeedConfig): Promise<void> {
  const send = async (
    service: ProxiedService,
    init: RequestInit & { path?: string; region?: string },
    tolerated: string[] = [],
  ) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", syntheticAuthorization(service, init.region ?? region));
    const response = await fetch(`${upstream}${init.path ?? "/"}`, { ...init, headers });
    if (response.ok) return response;
    const text = await response.text();
    if (tolerated.some((code) => text.includes(code))) return response;
    throw new Error(`${service} seed request failed with ${response.status}: ${text.slice(0, 300)}`);
  };
  const query = (service: "iam", params: Record<string, string>, tolerated: string[]) =>
    send(
      service,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ Version: "2010-05-08", ...params }).toString(),
      },
      tolerated,
    );
  const json = (service: "sqs" | "kms", target: string, payload: unknown, tolerated: string[] = []) =>
    send(
      service,
      {
        method: "POST",
        headers: {
          "content-type": service === "sqs" ? "application/x-amz-json-1.0" : "application/x-amz-json-1.1",
          "x-amz-target": target,
        },
        body: JSON.stringify(payload),
      },
      tolerated,
    );

  for (const bucket of config.s3?.buckets ?? []) {
    const bucketRegion = bucket.region ?? region;
    // us-east-1 is the one region where CreateBucket takes no location constraint.
    const body =
      bucketRegion === DEFAULT_REGION
        ? undefined
        : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${bucketRegion}</LocationConstraint></CreateBucketConfiguration>`;
    await send("s3", { method: "PUT", path: `/${encodeURIComponent(bucket.name)}`, region: bucketRegion, body }, [
      "BucketAlreadyOwnedByYou",
    ]);
  }

  for (const queue of config.sqs?.queues ?? []) {
    const attributes: Record<string, string> = {};
    if (queue.fifo ?? queue.name.endsWith(".fifo")) attributes.FifoQueue = "true";
    if (queue.visibility_timeout !== undefined) attributes.VisibilityTimeout = String(queue.visibility_timeout);
    // An existing queue whose attributes changed since the last start is left as it is.
    await json("sqs", "AmazonSQS.CreateQueue", { QueueName: queue.name, Attributes: attributes }, ["QueueNameExists"]);
  }

  for (const user of config.iam?.users ?? []) {
    const created = await query("iam", { Action: "CreateUser", UserName: user.user_name, Path: user.path ?? "/" }, [
      "EntityAlreadyExists",
    ]);
    // Only a new user gets a key, so restarting against a running backend stays under the per-user key limit.
    if (user.create_access_key && created.ok) {
      await query("iam", { Action: "CreateAccessKey", UserName: user.user_name }, []);
    }
  }

  for (const role of config.iam?.roles ?? []) {
    const params: Record<string, string> = {
      Action: "CreateRole",
      RoleName: role.role_name,
      Path: role.path ?? "/",
      AssumeRolePolicyDocument: role.assume_role_policy ?? DEFAULT_TRUST_POLICY,
    };
    if (role.description) params.Description = role.description;
    await query("iam", params, ["EntityAlreadyExists"]);
  }

  for (const key of config.kms?.keys ?? []) {
    const aliases = key.aliases ?? [];
    if (aliases.length > 0) {
      // A key whose alias already exists was seeded by an earlier start.
      const existing = await json("kms", "TrentService.DescribeKey", { KeyId: aliases[0] }, ["NotFoundException"]);
      if (existing.ok) continue;
    }
    const created = (await (
      await json("kms", "TrentService.CreateKey", { Description: key.description ?? "" })
    ).json()) as { KeyMetadata: { KeyId: string } };
    for (const alias of aliases) {
      await json("kms", "TrentService.CreateAlias", { AliasName: alias, TargetKeyId: created.KeyMetadata.KeyId }, [
        "AlreadyExistsException",
      ]);
    }
  }
}
