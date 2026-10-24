import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  cors,
  createApiErrorHandler,
  createErrorHandler,
  serve,
  type AppEnv,
} from "@emulators/core";
import { jiraPlugin, DEFAULT_ADMIN_EMAIL, DEFAULT_API_TOKEN } from "../index.js";

export const jiraTestBaseUrl = "http://localhost:4302";

export interface JiraTestApp {
  app: Hono<AppEnv>;
  store: Store;
  webhooks: WebhookDispatcher;
}

export function createJiraTestApp(): JiraTestApp {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  jiraPlugin.register(app, store, webhooks, jiraTestBaseUrl);
  jiraPlugin.seed?.(store, jiraTestBaseUrl);
  return { app, store, webhooks };
}

export interface JiraTestEmulator extends JiraTestApp {
  url: string;
  close: () => Promise<void>;
}

/**
 * Serves the emulator on a random local port behind the same core middleware as `createServer`,
 * so SDK tests exercise the full HTTP stack.
 */
export async function startJiraTestEmulator(): Promise<JiraTestEmulator> {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  app.onError(createApiErrorHandler());
  app.use("*", cors());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(new Map()));

  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  jiraPlugin.register(app, store, webhooks, url);
  jiraPlugin.seed?.(store, url);

  return {
    app,
    store,
    webhooks,
    url,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

export function basicAuth(email = DEFAULT_ADMIN_EMAIL, token = DEFAULT_API_TOKEN): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: string | null;
  headers?: Record<string, string>;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

export async function api(app: Hono<AppEnv>, path: string, opts: RequestOptions = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  const auth = opts.auth === undefined ? basicAuth() : opts.auth;
  if (auth) headers.Authorization = auth;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const res = await app.request(`${jiraTestBaseUrl}${path}`, { method: opts.method ?? "GET", headers, body });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

export function adf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}
