import { Hono } from "hono";
import { Store, WebhookDispatcher, type TokenMap, type AppEnv, authMiddleware } from "@emulators/core";
import { telegramPlugin } from "../index.js";
import { getDispatcher } from "../dispatcher.js";

export interface TestApp {
  app: Hono<AppEnv>;
  store: Store;
  webhooks: WebhookDispatcher;
}

export function createTestApp(options?: { seed?: boolean; baseUrl?: string }): TestApp {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const app = new Hono<AppEnv>();
  app.use("*", authMiddleware(tokenMap));

  const baseUrl = options?.baseUrl ?? "http://localhost:4011";
  telegramPlugin.register(app, store, webhooks, baseUrl, tokenMap);
  if (options?.seed !== false) {
    telegramPlugin.seed!(store, baseUrl);
  }

  // Keep retries fast for tests
  getDispatcher(store).setRetryPolicy({ maxRetries: 2, backoffMs: [5, 10] });
  getDispatcher(store).setBackoffEnabled(false);

  return { app, store, webhooks };
}

export async function postJson(app: Hono<AppEnv>, path: string, body: unknown): Promise<Response> {
  return app.request(`http://localhost:4011${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function getJson(app: Hono<AppEnv>, path: string): Promise<Response> {
  return app.request(`http://localhost:4011${path}`);
}

export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
