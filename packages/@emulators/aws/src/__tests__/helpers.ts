import { Hono } from "hono";
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
