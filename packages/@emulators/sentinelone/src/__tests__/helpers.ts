import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { DEFAULT_API_TOKEN, sentinelonePlugin, seedFromConfig, type SentinelOneSeedConfig } from "../index.js";

export const s1TestBaseUrl = "http://localhost:4320";
export const API_PREFIX = "/web/api/v2.1";

export interface S1TestApp {
  app: Hono<AppEnv>;
  store: Store;
}

export function createS1TestApp(seed?: SentinelOneSeedConfig, withDefaults = true): S1TestApp {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  sentinelonePlugin.register(app, store, webhooks, s1TestBaseUrl);
  if (withDefaults) sentinelonePlugin.seed?.(store, s1TestBaseUrl);
  if (seed) seedFromConfig(store, s1TestBaseUrl, seed, webhooks);
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
  const headers: Record<string, string> = { ...extraHeaders };
  if (token) headers.Authorization = `ApiToken ${token}`;
  let body: RequestInit["body"];
  if (data !== undefined) {
    body = JSON.stringify(data);
    headers["Content-Type"] = "application/json";
  }
  const response = await app.request(`${s1TestBaseUrl}${API_PREFIX}${path}`, { method, headers, body });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

export function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  return search.toString();
}
