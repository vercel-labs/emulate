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
import { polarPlugin, seedFromConfig, getPolarStore } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("polar_test_token", {
    login: "testuser@example.com",
    id: 1,
    scopes: [],
  });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  polarPlugin.register(app as any, store, webhooks, base, tokenMap);

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer polar_test_token", "Content-Type": "application/json" };
}

describe("Polar plugin", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const testApp = createTestApp();
    app = testApp.app;
    store = testApp.store;
  });

  it("seeds and lists organizations and products", async () => {
    seedFromConfig(store, base, {
      organizations: [{ name: "My Org", slug: "my-org" }],
      products: [{ name: "Pro Plan", price: 2000, organization_slug: "my-org" }],
    });

    const resOrgs = await app.request(`${base}/v1/organizations`, { headers: authHeaders() });
    expect(resOrgs.status).toBe(200);
    const orgsBody = (await resOrgs.json()) as any;
    expect(orgsBody.items.length).toBe(1);
    expect(orgsBody.items[0].slug).toBe("my-org");

    const resProds = await app.request(`${base}/v1/products`, { headers: authHeaders() });
    expect(resProds.status).toBe(200);
    const prodsBody = (await resProds.json()) as any;
    expect(prodsBody.items.length).toBe(1);
    expect(prodsBody.items[0].name).toBe("Pro Plan");
    expect(prodsBody.items[0].price).toBe(2000);
  });

  it("creates and retrieves custom checkout", async () => {
    const ps = getPolarStore(store);
    
    // Seed a product first
    const prod = ps.products.insert({
      polar_id: "prod_123",
      name: "Standard Plan",
      price: 1000,
      organization_id: "org_123",
    });

    const resCreate = await app.request(`${base}/v1/checkouts/custom`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        product_id: "prod_123",
        customer_email: "user@example.com",
      }),
    });
    expect(resCreate.status).toBe(201);
    const created = (await resCreate.json()) as any;
    expect(created.id).toBeDefined();
    expect(created.product_id).toBe("prod_123");

    const resGet = await app.request(`${base}/v1/checkouts/custom/${created.id}`, { headers: authHeaders() });
    expect(resGet.status).toBe(200);
    const retrieved = (await resGet.json()) as any;
    expect(retrieved.id).toBe(created.id);
  });
});
