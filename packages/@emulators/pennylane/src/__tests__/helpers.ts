import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { DEFAULT_API_KEY, pennylanePlugin, seedFromConfig, type PennylaneSeedConfig } from "../index.js";

export const pennylaneTestBaseUrl = "http://localhost:4319";
export const API_PREFIX = "/api/external/v2";

export interface PennylaneTestApp {
  app: Hono<AppEnv>;
  store: Store;
}

export function createPennylaneTestApp(seed?: PennylaneSeedConfig, withDefaults = true): PennylaneTestApp {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  pennylanePlugin.register(app, store, webhooks, pennylaneTestBaseUrl);
  if (withDefaults) pennylanePlugin.seed?.(store, pennylaneTestBaseUrl);
  if (seed) seedFromConfig(store, pennylaneTestBaseUrl, seed, webhooks);
  return { app, store };
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
  token: string | null = DEFAULT_API_KEY,
  extraHeaders: Record<string, string> = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { Accept: "application/json", ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: RequestInit["body"];
  if (data instanceof FormData) {
    body = data;
  } else if (data !== undefined) {
    body = JSON.stringify(data);
    headers["Content-Type"] = "application/json";
  }
  const response = await app.request(`${pennylaneTestBaseUrl}${API_PREFIX}${path}`, { method, headers, body });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

export function filterQuery(filters: Array<{ field: string; operator: string; value: unknown }>): string {
  return `filter=${encodeURIComponent(JSON.stringify(filters))}`;
}
