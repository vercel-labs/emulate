import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { twilioPlugin, DEFAULT_ACCOUNT_SID, DEFAULT_AUTH_TOKEN } from "../index.js";

export const twilioTestBaseUrl = "http://localhost:4301";

export interface TwilioTestApp {
  app: Hono<AppEnv>;
  store: Store;
  webhooks: WebhookDispatcher;
}

export function createTwilioTestApp(): TwilioTestApp {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  twilioPlugin.register(app, store, webhooks, twilioTestBaseUrl);
  twilioPlugin.seed?.(store, twilioTestBaseUrl);
  return { app, store, webhooks };
}

export function basicAuth(username = DEFAULT_ACCOUNT_SID, password = DEFAULT_AUTH_TOKEN): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export function formBody(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

export function formHeaders(username = DEFAULT_ACCOUNT_SID, password = DEFAULT_AUTH_TOKEN): Record<string, string> {
  return {
    Authorization: basicAuth(username, password),
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

export class LocalTwilioRequestClient {
  lastResponse?: { statusCode: number; body: unknown; headers: Record<string, string> };

  constructor(private app: Hono<AppEnv>) {}

  async request(opts: {
    method: string;
    uri: string;
    username?: string;
    password?: string;
    headers?: Record<string, string>;
    params?: Record<string, string | number>;
    data?: Record<string, unknown>;
  }) {
    const url = new URL(opts.uri);
    for (const [key, value] of Object.entries(opts.params ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const prefix =
      url.hostname === "messaging.twilio.com"
        ? "/messaging"
        : url.hostname === "verify.twilio.com"
          ? "/verify"
          : url.hostname === "conversations.twilio.com"
            ? "/conversations"
            : "";
    const localUrl = `${twilioTestBaseUrl}${prefix}${url.pathname}${url.search}`;
    const headers = { ...(opts.headers ?? {}) };
    if (opts.username && opts.password) {
      headers.Authorization = basicAuth(opts.username, opts.password);
    }
    let body: string | undefined;
    if (opts.data) {
      body = new URLSearchParams(
        Object.entries(opts.data).flatMap(([key, value]) => {
          if (Array.isArray(value)) return value.map((item) => [key, String(item)] as [string, string]);
          if (value === undefined || value === null) return [];
          return [[key, String(value)] as [string, string]];
        }),
      ).toString();
      headers["Content-Type"] = headers["Content-Type"] ?? "application/x-www-form-urlencoded";
    }
    const response = await this.app.request(localUrl, {
      method: opts.method.toUpperCase(),
      headers,
      body,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : "";
    const result = {
      statusCode: response.status,
      body: parsed,
      headers: Object.fromEntries(response.headers.entries()),
    };
    this.lastResponse = result;
    return result;
  }
}
