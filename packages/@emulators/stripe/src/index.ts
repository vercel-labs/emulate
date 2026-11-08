import { createHmac } from "crypto";
import type { Hono } from "@emulators/core";
import type {
  ServicePlugin,
  Store,
  WebhookDispatcher,
  WebhookHeaderContext,
  TokenMap,
  AppEnv,
  RouteContext,
} from "@emulators/core";
import { getStripeStore } from "./store.js";
import { stripeId } from "./helpers.js";
import { customerRoutes } from "./routes/customers.js";
import { paymentIntentRoutes } from "./routes/payment-intents.js";
import { setupIntentRoutes } from "./routes/setup-intents.js";
import { paymentMethodRoutes } from "./routes/payment-methods.js";
import { chargeRoutes } from "./routes/charges.js";
import { productRoutes } from "./routes/products.js";
import { priceRoutes } from "./routes/prices.js";
import { checkoutSessionRoutes } from "./routes/checkout-sessions.js";
import { customerSessionRoutes } from "./routes/customer-sessions.js";
import { eventRoutes } from "./routes/events.js";
import { webhookEndpointRoutes } from "./routes/webhook-endpoints.js";
import { controlRoutes } from "./routes/control.js";
import { requestIdMiddleware, setStripeApiVersion, syncWebhookEndpoints } from "./events.js";
import { parseChaosConfig, setWebhookChaos, type WebhookChaosInput } from "./chaos.js";

export { getStripeStore, type StripeStore } from "./store.js";
export * from "./entities.js";
export { STRIPE_API_VERSION } from "./events.js";
export type { WebhookChaosInput, ReorderMode } from "./chaos.js";

export interface StripeSeedConfig {
  port?: number;
  /** API version stamped on events. Defaults to STRIPE_API_VERSION. */
  api_version?: string;
  customers?: Array<{
    id?: string;
    email?: string;
    name?: string;
    description?: string;
  }>;
  products?: Array<{
    id?: string;
    name: string;
    description?: string;
  }>;
  prices?: Array<{
    id?: string;
    product_name: string;
    currency: string;
    unit_amount: number;
  }>;
  /** Webhook endpoints. Each one is also listed by GET /v1/webhook_endpoints. */
  webhooks?: Array<{
    id?: string;
    url: string;
    events: string[];
    secret?: string;
  }>;
  /** Delivery faults applied from the start. See README "Webhook delivery model and chaos". */
  webhook_chaos?: WebhookChaosInput;
}

function stripeWebhookHeaders({ body, subscription }: WebhookHeaderContext): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (subscription.secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", subscription.secret).update(`${timestamp}.${body}`).digest("hex");
    headers["Stripe-Signature"] = `t=${timestamp},v1=${signature}`;
  }

  return headers;
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

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: StripeSeedConfig,
  webhooks?: WebhookDispatcher,
): void {
  const ss = getStripeStore(store);

  if (config.api_version) {
    setStripeApiVersion(store, config.api_version);
  }

  if (config.customers) {
    for (const c of config.customers) {
      if (c.email) {
        const existing = ss.customers.findOneBy("email", c.email);
        if (existing) continue;
      }
      ss.customers.insert({
        stripe_id: c.id ?? stripeId("cus"),
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
        stripe_id: p.id ?? stripeId("prod"),
        name: p.name,
        description: p.description ?? null,
        active: true,
        metadata: {},
      });

      const matchingPrices = config.prices?.filter((pr) => pr.product_name === p.name) ?? [];
      for (const pr of matchingPrices) {
        ss.prices.insert({
          stripe_id: pr.id ?? stripeId("price"),
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

  if (config.webhook_chaos) {
    const parsed = parseChaosConfig(config.webhook_chaos);
    if (parsed.error) throw new Error(`Invalid stripe webhook_chaos: ${parsed.error.message}`);
    setWebhookChaos(store, parsed.config);
  }

  if (config.webhooks) {
    for (const wh of config.webhooks) {
      const duplicate = ss.webhookEndpoints
        .findBy("url", wh.url)
        .some((ep) => ep.secret === wh.secret && ep.enabled_events.join(",") === wh.events.join(","));
      if (duplicate) continue;
      ss.webhookEndpoints.insert({
        stripe_id: wh.id ?? stripeId("we"),
        url: wh.url,
        enabled_events: [...wh.events],
        status: "enabled",
        metadata: {},
        secret: wh.secret,
        created: Math.floor(Date.now() / 1000),
      });
    }
  }

  if (webhooks) {
    webhooks.setHeaderFactory(stripeWebhookHeaders);
    syncWebhookEndpoints(store, webhooks);
  }
}

export const stripePlugin: ServicePlugin = {
  name: "stripe",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    webhooks.setHeaderFactory(stripeWebhookHeaders);

    app.use("*", requestIdMiddleware());

    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    eventRoutes(ctx);
    webhookEndpointRoutes(ctx);
    controlRoutes(ctx);
    customerRoutes(ctx);
    paymentMethodRoutes(ctx);
    paymentIntentRoutes(ctx);
    setupIntentRoutes(ctx);
    chargeRoutes(ctx);
    productRoutes(ctx);
    priceRoutes(ctx);
    checkoutSessionRoutes(ctx);
    customerSessionRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default stripePlugin;
