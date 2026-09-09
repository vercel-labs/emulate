import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { DEFAULT_API_TOKEN, document360Plugin, seedFromConfig, type Document360SeedConfig } from "../index.js";

export const d360TestBaseUrl = "http://localhost:4317";

export interface D360TestApp {
  app: Hono<AppEnv>;
  store: Store;
}

export function createD360TestApp(seed?: Document360SeedConfig, withDefaults = true): D360TestApp {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  document360Plugin.register(app, store, webhooks, d360TestBaseUrl);
  if (withDefaults) document360Plugin.seed?.(store, d360TestBaseUrl);
  if (seed) seedFromConfig(store, d360TestBaseUrl, seed, webhooks);
  return { app, store };
}

export interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
}

export async function api(
  app: Hono<AppEnv>,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  data?: unknown,
  token: string | null = DEFAULT_API_TOKEN,
  extraHeaders: Record<string, string> = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { Accept: "*/*", ...extraHeaders };
  if (token) headers.api_token = token;
  let body: RequestInit["body"];
  if (data instanceof FormData) {
    body = data;
  } else if (data !== undefined) {
    body = JSON.stringify(data);
    headers["Content-Type"] = "application/json";
  }
  const response = await app.request(`${d360TestBaseUrl}${path}`, { method, headers, body });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}
