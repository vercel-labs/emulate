import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  DEFAULT_TENANT_ID,
  graphPlugin,
  seedFromConfig,
  type GraphSeedConfig,
} from "../index.js";

export const graphTestBaseUrl = "http://localhost:4321";

export interface GraphTestApp {
  app: Hono<AppEnv>;
  store: Store;
}

export function createGraphTestApp(seed?: GraphSeedConfig, withDefaults = true): GraphTestApp {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  graphPlugin.register(app, store, webhooks, graphTestBaseUrl);
  if (withDefaults) graphPlugin.seed?.(store, graphTestBaseUrl);
  if (seed) seedFromConfig(store, graphTestBaseUrl, seed, webhooks);
  return { app, store };
}

export interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
}

async function parse(response: Response): Promise<ApiResponse> {
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

export async function requestToken(
  app: Hono<AppEnv>,
  tenantId: string = DEFAULT_TENANT_ID,
  clientId: string = DEFAULT_CLIENT_ID,
  clientSecret: string = DEFAULT_CLIENT_SECRET,
): Promise<ApiResponse> {
  return parse(
    await app.request(`${graphTestBaseUrl}/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    }),
  );
}

export async function accessToken(
  app: Hono<AppEnv>,
  tenantId: string = DEFAULT_TENANT_ID,
  clientId?: string,
  clientSecret?: string,
): Promise<string> {
  const response = await requestToken(app, tenantId, clientId, clientSecret);
  if (response.status !== 200) throw new Error(`Token request failed: ${JSON.stringify(response.body)}`);
  return response.body.access_token as string;
}

export async function api(
  app: Hono<AppEnv>,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  data?: unknown,
  token?: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: RequestInit["body"];
  if (data !== undefined) {
    body = JSON.stringify(data);
    headers["Content-Type"] = "application/json";
  }
  return parse(await app.request(`${graphTestBaseUrl}/v1.0${path}`, { method, headers, body }));
}
