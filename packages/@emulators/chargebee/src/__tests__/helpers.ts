import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { DEFAULT_API_KEY, chargebeePlugin, seedFromConfig, type ChargebeeSeedConfig } from "../index.js";

export const chargebeeTestBaseUrl = "http://localhost:4314";

export interface ChargebeeTestApp {
  app: Hono<AppEnv>;
  store: Store;
  webhooks: WebhookDispatcher;
}

export function createChargebeeTestApp(seed?: ChargebeeSeedConfig): ChargebeeTestApp {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  chargebeePlugin.register(app, store, webhooks, chargebeeTestBaseUrl);
  chargebeePlugin.seed?.(store, chargebeeTestBaseUrl);
  if (seed) seedFromConfig(store, chargebeeTestBaseUrl, seed, webhooks);
  return { app, store, webhooks };
}

export function basicAuth(key: string = DEFAULT_API_KEY): string {
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

export function form(data: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
}

export async function api(
  app: Hono<AppEnv>,
  method: "GET" | "POST",
  path: string,
  data?: Record<string, string | number | boolean | undefined>,
  key: string = DEFAULT_API_KEY,
): Promise<ApiResponse> {
  const response = await app.request(`${chargebeeTestBaseUrl}/api/v2${path}`, {
    method,
    headers: {
      Authorization: basicAuth(key),
      Accept: "application/json",
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" } : {}),
    },
    body: method === "POST" ? form(data ?? {}) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

export function eventTypes(events: Array<{ event: { event_type: string } }>): string[] {
  return events.map((entry) => entry.event.event_type);
}
