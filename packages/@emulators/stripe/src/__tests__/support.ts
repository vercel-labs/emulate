import { vi } from "vitest";
import Stripe from "stripe";
import { Hono } from "@emulators/core";
import {
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { stripePlugin, seedFromConfig, type StripeSeedConfig } from "../index.js";

export const base = "http://localhost:14000";
export const API_KEY = "sk_test_abc123";
export const WEBHOOK_SECRET = "whsec_test_support";
export const WEBHOOK_URL = "https://hooks.example/stripe";

export interface TestApp {
  app: Hono;
  store: Store;
  webhooks: WebhookDispatcher;
  tokenMap: TokenMap;
}

/**
 * Build the emulator the way the server does. Passing `seed` runs seedFromConfig, which also
 * registers its webhook endpoints. `webhook: true` registers one endpoint for every event.
 */
export function createTestApp(options: { seed?: StripeSeedConfig; webhook?: boolean } = {}): TestApp {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set(API_KEY, { login: "test-account", id: 1, scopes: [] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  stripePlugin.register(app as never, store, webhooks, base, tokenMap);
  stripePlugin.seed?.(store, base);

  const seed: StripeSeedConfig = { ...options.seed };
  if (options.webhook) {
    seed.webhooks = [...(seed.webhooks ?? []), { url: WEBHOOK_URL, events: ["*"], secret: WEBHOOK_SECRET }];
  }
  seedFromConfig(store, base, seed, webhooks);

  return { app, store, webhooks, tokenMap };
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", ...extra };
}

export async function api<T = Record<string, unknown>>(
  app: Hono,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; body: T }> {
  const res = await app.request(`${base}${path}`, {
    method,
    headers: authHeaders(headers),
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as T };
}

export interface CapturedDelivery {
  url: string;
  body: string;
  headers: Record<string, string>;
  event: Stripe.Event;
}

/**
 * Stub global fetch so webhook deliveries are recorded instead of sent. `status` decides the
 * response code of each delivery (200 by default).
 */
export function captureWebhooks(status: number | ((event: Stripe.Event) => number) = 200) {
  const deliveries: CapturedDelivery[] = [];
  const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body as string;
    const event = JSON.parse(body) as Stripe.Event;
    deliveries.push({ url, body, headers: init.headers as Record<string, string>, event });
    const code = typeof status === "function" ? status(event) : status;
    return { ok: code >= 200 && code < 300, status: code };
  });
  vi.stubGlobal("fetch", fetchStub);
  return {
    deliveries,
    get events(): Stripe.Event[] {
      return deliveries.map((d) => d.event);
    },
    ofType(type: string): Stripe.Event[] {
      return deliveries.filter((d) => d.event.type === type).map((d) => d.event);
    },
  };
}

const verifier = new Stripe(API_KEY);

/** Verify a delivered body with the real stripe-node signature check. */
export function verify(body: string, header: string, secret: string = WEBHOOK_SECRET): Stripe.Event {
  return verifier.webhooks.constructEvent(body, header, secret);
}

/** A stripe-node client whose HTTP calls go straight into the Hono app. */
export function sdk(app: Hono): Stripe {
  return new Stripe(API_KEY, {
    host: "localhost",
    port: 14000,
    protocol: "http",
    maxNetworkRetries: 0,
    telemetry: false,
    httpClient: Stripe.createFetchHttpClient(((input: string | URL | Request, init?: RequestInit) =>
      app.request(input instanceof URL ? input.toString() : input, init)) as typeof fetch),
  });
}
