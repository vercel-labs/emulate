import type { AddressInfo } from "node:net";
import { Hono, serve } from "@emulators/core";
import {
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type AppEnv,
  type TokenMap,
} from "@emulators/core";
import { awsPlugin } from "../index.js";

export const testBaseUrl = "http://localhost:4000";

export function createTestApp(baseUrl: string = testBaseUrl) {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-aws-token", {
    login: "admin",
    id: 1,
    scopes: ["s3:*", "sqs:*", "iam:*", "sts:*"],
  });

  const app = new Hono<AppEnv>();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  awsPlugin.register(app, store, webhooks, baseUrl, tokenMap);
  awsPlugin.seed!(store, baseUrl);

  return { app, store, webhooks, tokenMap };
}

export function testAuthHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-aws-token" };
}

/**
 * Set AWS_EMULATOR_E2E_URL to run the SDK e2e suites against an external
 * AWS-compatible endpoint instead of an in-process emulator. Set
 * AWS_EMULATOR_E2E_LAYOUT=root when that endpoint serves every service at its
 * root rather than under emulate's per-service path prefixes.
 */
export const externalTarget = Boolean(process.env.AWS_EMULATOR_E2E_URL);

export type AwsService = "s3" | "sqs" | "kms" | "sts";

export interface AwsTarget {
  baseUrl: string;
  external: boolean;
  endpoint(service: AwsService): string;
  close(): Promise<void>;
}

export async function startAwsTarget(
  setup?: (app: ReturnType<typeof createTestApp>, baseUrl: string) => void,
): Promise<AwsTarget> {
  const override = process.env.AWS_EMULATOR_E2E_URL;
  if (override) {
    const baseUrl = override.replace(/\/+$/, "");
    const root = process.env.AWS_EMULATOR_E2E_LAYOUT === "root";
    return {
      baseUrl,
      external: true,
      endpoint: (service) => (service === "s3" || root ? baseUrl : `${baseUrl}/${service}`),
      close: async () => {},
    };
  }

  const holder: { active?: ReturnType<typeof createTestApp> } = {};
  const server = serve({ fetch: (request) => holder.active!.app.fetch(request), port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  holder.active = createTestApp(baseUrl);
  setup?.(holder.active, baseUrl);
  return {
    baseUrl,
    external: false,
    endpoint: (service) => (service === "s3" ? baseUrl : `${baseUrl}/${service}`),
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
