import { describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
} from "@emulators/core";
import type { TokenMap } from "@emulators/core";
import { seedFromConfig, stripePlugin } from "../index.js";

const base = "http://localhost:4000";
const key = "sk_test_emulated_secret_key_0001";

function createTestApp(strict: boolean, fallback = true) {
  const tokenMap: TokenMap = new Map([[key, { login: "stripe", id: 1, scopes: [] }]]);
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap, undefined, fallback ? { login: "stripe", id: 1, scopes: [] } : undefined));
  const store = new Store();
  stripePlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  stripePlugin.seed?.(store, base);
  seedFromConfig(store, base, { strict_scopes: strict });
  return app;
}

async function listCustomers(app: Hono<any>, authorization?: string) {
  const response = await app.request(`${base}/v1/customers`, {
    headers: authorization ? { Authorization: authorization } : {},
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as { error?: { type: string; message: string } },
  };
}

describe("Stripe strict mode API keys", () => {
  it("accepts a known key as a bearer token or as the HTTP Basic username", async () => {
    const app = createTestApp(true);
    expect((await listCustomers(app, `Bearer ${key}`)).status).toBe(200);
    expect((await listCustomers(app, `Basic ${Buffer.from(`${key}:`).toString("base64")}`)).status).toBe(200);
  });

  it("rejects a request without a key", async () => {
    const res = await listCustomers(createTestApp(true));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Stripe"');
    expect(res.body.error?.type).toBe("invalid_request_error");
    expect(res.body.error?.message).toMatch(/^You did not provide an API key\./);
  });

  it("rejects an unknown key and masks it in the message", async () => {
    const app = createTestApp(true);
    const long = await listCustomers(app, "Bearer sk_test_51HqLyjWDarjtT1zdp7dc");
    expect(long.status).toBe(401);
    expect(long.body.error).toEqual({
      type: "invalid_request_error",
      message: `Invalid API Key provided: sk_test${"*".repeat(19)}7dc`,
    });
    expect((await listCustomers(app, "Bearer sk_test_fake")).body.error?.message).toBe(
      "Invalid API Key provided: sk_test_fake",
    );
  });

  it("keeps hosted checkout pages public", async () => {
    const app = createTestApp(true);
    expect((await app.request(`${base}/checkout/missing-session`)).status).not.toBe(401);
  });

  it("accepts any key, and no key, by default", async () => {
    expect((await listCustomers(createTestApp(false), "Bearer sk_test_anything")).status).toBe(200);
    expect((await listCustomers(createTestApp(false))).status).toBe(200);
  });
});
