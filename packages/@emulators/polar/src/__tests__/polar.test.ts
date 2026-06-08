import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import {
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { polarPlugin } from "../index.js";

const base = "http://localhost:15000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("polar_test_token", {
    login: "test-account",
    id: 1,
    scopes: [],
  });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  polarPlugin.register(app as any, store, webhooks, base, tokenMap);
  polarPlugin.seed?.(store, base);

  return { app, store, webhooks, tokenMap };
}

function auth(): Record<string, string> {
  return {
    Authorization: "Bearer polar_test_token",
    "Content-Type": "application/json",
  };
}

describe("Polar plugin", () => {
  let app: Hono;

  beforeEach(() => {
    const ctx = createTestApp();
    app = ctx.app;
  });

  describe("products", () => {
    it("lists seeded products", async () => {
      const res = await app.request(`${base}/v1/products`, { headers: auth() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items[0].name).toBe("Test Product");
    });
  });

  describe("organizations", () => {
    it("lists seeded organizations", async () => {
      const res = await app.request(`${base}/v1/organizations`, { headers: auth() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items[0].slug).toBe("test-org");
    });
  });

  describe("checkouts", () => {
    it("creates and retrieves a checkout session", async () => {
      // Get a product first
      const prodRes = await app.request(`${base}/v1/products`, { headers: auth() });
      const { items } = await prodRes.json();
      const productId = items[0].polar_id;

      const createRes = await app.request(`${base}/v1/checkouts`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ product_id: productId, success_url: "https://example.com/success" }),
      });
      expect(createRes.status).toBe(201);
      const checkout = await createRes.json();
      expect(checkout.polar_id).toMatch(/^ch_/);
      expect(checkout.product_id).toBe(productId);

      const getRes = await app.request(`${base}/v1/checkouts/${checkout.polar_id}`, { headers: auth() });
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();
      expect(fetched.polar_id).toBe(checkout.polar_id);
    });
  });
});
