import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getAwsStore } from "./store.js";
import { getAccountId, getDefaultRegion, generateAwsId } from "./helpers.js";
import { s3Routes } from "./routes/s3.js";
import { sqsRoutes } from "./routes/sqs.js";
import { iamRoutes } from "./routes/iam.js";
import { inspectorRoutes } from "./routes/inspector.js";

export { getAwsStore, type AwsStore } from "./store.js";
export * from "./entities.js";

export interface AwsSeedConfig {
  port?: number;
  region?: string;
  account_id?: string;
  s3?: {
    buckets?: Array<{
      name: string;
      region?: string;
    }>;
  };
  sqs?: {
    queues?: Array<{
      name: string;
      fifo?: boolean;
      visibility_timeout?: number;
    }>;
  };
  iam?: {
    users?: Array<{
      user_name: string;
      path?: string;
      create_access_key?: boolean;
    }>;
    roles?: Array<{
      role_name: string;
      path?: string;
      description?: string;
      assume_role_policy?: string;
    }>;
  };
}

function seedDefaults(store: Store, baseUrl: string): void {
  const aws = getAwsStore(store);
  const accountId = getAccountId();
  const region = getDefaultRegion();

  // Create a default S3 bucket
  aws.s3Buckets.insert({
    bucket_name: "emulate-default",
    region,
    creation_date: new Date().toISOString(),
    acl: "private",
    versioning_enabled: false,
  });

  // Create a default SQS queue
  const queueName = "emulate-default-queue";
  aws.sqsQueues.insert({
    queue_name: queueName,
    queue_url: `${baseUrl}/sqs/${accountId}/${queueName}`,
    arn: `arn:aws:sqs:${region}:${accountId}:${queueName}`,
    visibility_timeout: 30,
    delay_seconds: 0,
    max_message_size: 262144,
    message_retention_period: 345600,
    receive_message_wait_time: 0,
    fifo: false,
  });

  // Create a default IAM user
  const userId = generateAwsId("AIDA");
  aws.iamUsers.insert({
    user_name: "admin",
    user_id: userId,
    arn: `arn:aws:iam::${accountId}:user/admin`,
    path: "/",
    access_keys: [
      {
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        status: "Active",
      },
    ],
  });
}

export function seedFromConfig(store: Store, baseUrl: string, config: AwsSeedConfig): void {
  const aws = getAwsStore(store);
  const accountId = getAccountId();
  const region = config.region ?? getDefaultRegion();

  if (config.s3?.buckets) {
    for (const b of config.s3.buckets) {
      const existing = aws.s3Buckets.findOneBy("bucket_name", b.name);
      if (existing) continue;

      aws.s3Buckets.insert({
        bucket_name: b.name,
        region: b.region ?? region,
        creation_date: new Date().toISOString(),
        acl: "private",
        versioning_enabled: false,
      });
    }
  }

  if (config.sqs?.queues) {
    for (const q of config.sqs.queues) {
      const existing = aws.sqsQueues.findOneBy("queue_name", q.name);
      if (existing) continue;

      const fifo = q.fifo ?? q.name.endsWith(".fifo");
      aws.sqsQueues.insert({
        queue_name: q.name,
        queue_url: `${baseUrl}/sqs/${accountId}/${q.name}`,
        arn: `arn:aws:sqs:${region}:${accountId}:${q.name}`,
        visibility_timeout: q.visibility_timeout ?? 30,
        delay_seconds: 0,
        max_message_size: 262144,
        message_retention_period: 345600,
        receive_message_wait_time: 0,
        fifo,
      });
    }
  }

  if (config.iam?.users) {
    for (const u of config.iam.users) {
      const existing = aws.iamUsers.findOneBy("user_name", u.user_name);
      if (existing) continue;

      const userId = generateAwsId("AIDA");
      const path = u.path ?? "/";
      const accessKeys = u.create_access_key
        ? [
            {
              access_key_id: "AKIA" + generateAwsId("").slice(0, 16),
              secret_access_key: generateAwsId("") + generateAwsId(""),
              status: "Active" as const,
            },
          ]
        : [];

      aws.iamUsers.insert({
        user_name: u.user_name,
        user_id: userId,
        arn: `arn:aws:iam::${accountId}:user${path}${u.user_name}`,
        path,
        access_keys: accessKeys,
      });
    }
  }

  if (config.iam?.roles) {
    for (const r of config.iam.roles) {
      const existing = aws.iamRoles.findOneBy("role_name", r.role_name);
      if (existing) continue;

      const roleId = generateAwsId("AROA");
      const path = r.path ?? "/";

      aws.iamRoles.insert({
        role_name: r.role_name,
        role_id: roleId,
        arn: `arn:aws:iam::${accountId}:role${path}${r.role_name}`,
        path,
        assume_role_policy_document: r.assume_role_policy ?? "{}",
        description: r.description ?? "",
      });
    }
  }
}

export const awsPlugin: ServicePlugin = {
  name: "aws",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    s3Routes(ctx);
    sqsRoutes(ctx);
    iamRoutes(ctx);
    inspectorRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default awsPlugin;
