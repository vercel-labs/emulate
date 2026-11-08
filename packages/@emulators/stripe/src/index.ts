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
import { getStripeStore, type StripeStore } from "./store.js";
import { stripeId } from "./helpers.js";
import { readPriceParams } from "./pricing.js";
import { customerRoutes } from "./routes/customers.js";
import { paymentIntentRoutes } from "./routes/payment-intents.js";
import { setupIntentRoutes } from "./routes/setup-intents.js";
import { paymentMethodRoutes } from "./routes/payment-methods.js";
import { chargeRoutes } from "./routes/charges.js";
import { productRoutes } from "./routes/products.js";
import { priceRoutes } from "./routes/prices.js";
import { checkoutSessionRoutes } from "./routes/checkout-sessions.js";
import { customerSessionRoutes } from "./routes/customer-sessions.js";
import { invoiceRoutes } from "./routes/invoices.js";
import { invoiceItemRoutes } from "./routes/invoice-items.js";
import { invoicePaymentRoutes } from "./routes/invoice-payments.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";
import { subscriptionItemRoutes } from "./routes/subscription-items.js";
import { testClockRoutes } from "./routes/test-clocks.js";
import { eventRoutes } from "./routes/events.js";
import { webhookEndpointRoutes } from "./routes/webhook-endpoints.js";
import { controlRoutes } from "./routes/control.js";
import { requestIdMiddleware, setStripeApiVersion, syncWebhookEndpoints } from "./events.js";
import { parseChaosConfig, setWebhookChaos, type WebhookChaosInput } from "./chaos.js";

export { getStripeStore, type StripeStore } from "./store.js";
export * from "./entities.js";
export { STRIPE_API_VERSION } from "./events.js";
export type { WebhookChaosInput, ReorderMode } from "./chaos.js";

export interface StripeSeedPrice {
  id?: string;
  /** The product's name or id. */
  product?: string;
  /** The product's name. Kept for older configs; `product` takes precedence. */
  product_name?: string;
  currency: string;
  unit_amount?: number;
  unit_amount_decimal?: string;
  active?: boolean;
  billing_scheme?: "per_unit" | "tiered";
  recurring?: {
    interval: "day" | "week" | "month" | "year";
    interval_count?: number;
    usage_type?: "licensed" | "metered";
    meter?: string;
  };
  tiers?: Array<{
    up_to: number | "inf";
    unit_amount?: number;
    unit_amount_decimal?: string;
    flat_amount?: number;
    flat_amount_decimal?: string;
  }>;
  tiers_mode?: "graduated" | "volume";
  transform_quantity?: { divide_by: number; round: "up" | "down" };
  lookup_key?: string;
  nickname?: string;
  tax_behavior?: "exclusive" | "inclusive" | "unspecified";
  metadata?: Record<string, string>;
}

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
  /**
   * Prices take the params of `POST /v1/prices`. `product` (or the older `product_name`) names
   * a seeded product by name or id. `tiers` without `billing_scheme` makes a tiered price.
   */
  prices?: Array<StripeSeedPrice>;
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

/**
 * Insert a seeded price after the same validation `POST /v1/prices` applies. A seeded
 * lookup key takes over from any price already holding it, as with `transfer_lookup_key`.
 */
function seedPrice(ss: StripeStore, productId: string, pr: StripeSeedPrice): void {
  if (pr.id && ss.prices.findOneBy("stripe_id", pr.id)) return;
  const input: Record<string, unknown> = { ...pr };
  if (pr.tiers && pr.billing_scheme === undefined) input.billing_scheme = "tiered";
  const parsed = readPriceParams(input);
  if (parsed.error) {
    throw new Error(`Invalid stripe price for product ${productId}: ${parsed.error.message} (${parsed.error.param})`);
  }
  const definition = parsed.price!;
  if (definition.lookup_key) {
    for (const holder of ss.prices.all().filter((p) => p.lookup_key === definition.lookup_key)) {
      ss.prices.update(holder.id, { lookup_key: undefined });
    }
  }
  ss.prices.insert({ stripe_id: pr.id ?? stripeId("price"), product_id: productId, ...definition });
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

      const matchingPrices =
        config.prices?.filter((pr) => {
          const ref = pr.product ?? pr.product_name;
          return ref === p.name || ref === product.stripe_id;
        }) ?? [];
      for (const pr of matchingPrices) seedPrice(ss, product.stripe_id, pr);
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
    invoiceRoutes(ctx);
    invoiceItemRoutes(ctx);
    invoicePaymentRoutes(ctx);
    subscriptionRoutes(ctx);
    subscriptionItemRoutes(ctx);
    testClockRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default stripePlugin;
