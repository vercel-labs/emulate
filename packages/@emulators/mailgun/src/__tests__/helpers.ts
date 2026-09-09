import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { DEFAULT_API_KEY, mailgunPlugin, seedFromConfig, type MailgunSeedConfig } from "../index.js";

export const mailgunTestBaseUrl = "http://localhost:4316";

export interface MailgunTestApp {
  app: Hono<AppEnv>;
  store: Store;
  webhooks: WebhookDispatcher;
}

export function createMailgunTestApp(seed?: MailgunSeedConfig): MailgunTestApp {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  mailgunPlugin.register(app, store, webhooks, mailgunTestBaseUrl);
  mailgunPlugin.seed?.(store, mailgunTestBaseUrl);
  if (seed) seedFromConfig(store, mailgunTestBaseUrl, seed, webhooks);
  return { app, store, webhooks };
}

export function basicAuth(key: string = DEFAULT_API_KEY): string {
  return `Basic ${Buffer.from(`api:${key}`).toString("base64")}`;
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
  data?: Record<string, string | string[]> | FormData | string,
  key: string = DEFAULT_API_KEY,
  extraHeaders: Record<string, string> = {},
): Promise<ApiResponse> {
  let body: RequestInit["body"];
  const headers: Record<string, string> = { Authorization: basicAuth(key), ...extraHeaders };
  if (data instanceof FormData) {
    body = data;
  } else if (typeof data === "string") {
    body = data;
    headers["Content-Type"] ??= "application/json";
  } else if (data) {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(data)) {
      if (Array.isArray(value)) value.forEach((item) => params.append(name, item));
      else params.append(name, value);
    }
    body = params.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const response = await app.request(`${mailgunTestBaseUrl}${path}`, { method, headers, body });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}
