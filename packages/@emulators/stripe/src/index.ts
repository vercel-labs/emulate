import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getStripeStore } from "./store.js";
import { stripeId } from "./helpers.js";
import { customerRoutes } from "./routes/customers.js";
import { paymentIntentRoutes } from "./routes/payment-intents.js";
import { chargeRoutes } from "./routes/charges.js";
import { productRoutes } from "./routes/products.js";
import { priceRoutes } from "./routes/prices.js";
import { checkoutSessionRoutes } from "./routes/checkout-sessions.js";

export { getStripeStore, type StripeStore } from "./store.js";
export * from "./entities.js";

export interface StripeSeedConfig {
  port?: number;
  customers?: Array<{
    email?: string;
    name?: string;
    description?: string;
  }>;
  products?: Array<{
    name: string;
    description?: string;
  }>;
  prices?: Array<{
    product_name: string;
    currency: string;
    unit_amount: number;
  }>;
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const ss = getStripeStore(store);

  ss.customers.insert({
    stripe_id: stripeId("cus"),
    email: "test@example.com",
    name: "Test Customer",
    description: null,
    metadata: {},
  });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: StripeSeedConfig): void {
  const ss = getStripeStore(store);

  if (config.customers) {
    for (const c of config.customers) {
      if (c.email) {
        const existing = ss.customers.findOneBy("email", c.email);
        if (existing) continue;
      }
      ss.customers.insert({
        stripe_id: stripeId("cus"),
        email: c.email ?? null,
        name: c.name ?? null,
        description: c.description ?? null,
        metadata: {},
      });
    }
  }

  if (config.products) {
    for (const p of config.products) {
      const product = ss.products.insert({
        stripe_id: stripeId("prod"),
        name: p.name,
        description: p.description ?? null,
        active: true,
        metadata: {},
      });

      const matchingPrices = config.prices?.filter((pr) => pr.product_name === p.name) ?? [];
      for (const pr of matchingPrices) {
        ss.prices.insert({
          stripe_id: stripeId("price"),
          product_id: product.stripe_id,
          currency: pr.currency.toLowerCase(),
          unit_amount: pr.unit_amount,
          type: "one_time",
          active: true,
          metadata: {},
        });
      }
    }
  }
}

export const stripePlugin: ServicePlugin = {
  name: "stripe",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    customerRoutes(ctx);
    paymentIntentRoutes(ctx);
    chargeRoutes(ctx);
    productRoutes(ctx);
    priceRoutes(ctx);
    checkoutSessionRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default stripePlugin;
