import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_API_TOKEN,
  seedFromConfig,
  zendeskPlugin,
  type ZendeskSeedConfig,
} from "../index.js";

export const zendeskTestBaseUrl = "http://localhost:4315";

export interface ZendeskTestApp {
  app: Hono<AppEnv>;
  store: Store;
  webhooks: WebhookDispatcher;
}

export function createZendeskTestApp(seed?: ZendeskSeedConfig): ZendeskTestApp {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  zendeskPlugin.register(app, store, webhooks, zendeskTestBaseUrl);
  zendeskPlugin.seed?.(store, zendeskTestBaseUrl);
  if (seed) seedFromConfig(store, zendeskTestBaseUrl, seed, webhooks);
  return { app, store, webhooks };
}

export function tokenAuth(email: string = DEFAULT_ADMIN_EMAIL, token: string = DEFAULT_API_TOKEN): string {
  return `Basic ${Buffer.from(`${email}/token:${token}`).toString("base64")}`;
}

export function passwordAuth(email: string, password: string): string {
  return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
}

export interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
}

export async function api(
  app: Hono<AppEnv>,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  data?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const response = await app.request(`${zendeskTestBaseUrl}/api/v2${path}`, {
    method,
    headers: {
      Authorization: tokenAuth(),
      Accept: "application/json",
      ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}
