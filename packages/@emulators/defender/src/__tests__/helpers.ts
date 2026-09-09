import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  DEFAULT_TENANT_ID,
  defenderPlugin,
  seedFromConfig,
  type DefenderSeedConfig,
} from "../index.js";

export const defenderTestBaseUrl = "http://localhost:4318";

export interface DefenderTestApp {
  app: Hono<AppEnv>;
  store: Store;
}

export function createDefenderTestApp(seed?: DefenderSeedConfig, withDefaults = true): DefenderTestApp {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  defenderPlugin.register(app, store, webhooks, defenderTestBaseUrl);
  if (withDefaults) defenderPlugin.seed?.(store, defenderTestBaseUrl);
  if (seed) seedFromConfig(store, defenderTestBaseUrl, seed, webhooks);
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
  const response = await app.request(`${defenderTestBaseUrl}/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.securitycenter.microsoft.com/.default",
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  return parse(response);
}

export async function accessToken(app: Hono<AppEnv>, tenantId: string = DEFAULT_TENANT_ID): Promise<string> {
  const response = await requestToken(app, tenantId);
  if (response.status !== 200) throw new Error(`Token request failed: ${JSON.stringify(response.body)}`);
  return response.body.access_token as string;
}

export async function api(
  app: Hono<AppEnv>,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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
  return parse(await app.request(`${defenderTestBaseUrl}${path}`, { method, headers, body }));
}
