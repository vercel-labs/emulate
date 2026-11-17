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
import { MISSING_API_KEY_MESSAGE, maskStripeKey, stripeError, stripeId, stripeRequestKey } from "./helpers.js";
import { customerRoutes } from "./routes/customers.js";
import { paymentIntentRoutes } from "./routes/payment-intents.js";
import { paymentMethodRoutes } from "./routes/payment-methods.js";
import { chargeRoutes } from "./routes/charges.js";
import { productRoutes } from "./routes/products.js";
import { priceRoutes } from "./routes/prices.js";
import { checkoutSessionRoutes } from "./routes/checkout-sessions.js";
import { customerSessionRoutes } from "./routes/customer-sessions.js";

export { getStripeStore, type StripeStore } from "./store.js";
export * from "./entities.js";

export interface StripeSeedConfig {
  port?: number;
  strict_scopes?: boolean;
  /** Secret keys accepted in strict mode, in addition to the top-level `tokens` config. The next and nuxt adapters
   * don't read top-level `tokens`, so strict mode there accepts only these. */
  api_keys?: string[];
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
  webhooks?: Array<{
    url: string;
    events: string[];
    secret?: string;
  }>;
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

  if (config.strict_scopes !== undefined) {
    store.setData("stripe.strict_scopes", config.strict_scopes);
  }

  if (config.api_keys) {
    store.setData("stripe.api_keys", [...config.api_keys]);
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

  if (config.webhooks && webhooks) {
    webhooks.setHeaderFactory(stripeWebhookHeaders);
    for (const wh of config.webhooks) {
      webhooks.register({
        url: wh.url,
        events: wh.events,
        active: true,
        secret: wh.secret,
        owner: "stripe",
      });
    }
  }
}

export const stripePlugin: ServicePlugin = {
  name: "stripe",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    webhooks.setHeaderFactory(stripeWebhookHeaders);

    // API keys are unchecked by default so local clients can use any placeholder.
    // Strict mode requires a known key on API routes, as Stripe does: one from the top-level tokens config or stripe.api_keys.
    app.use("*", async (c, next) => {
      if (store.getData<boolean>("stripe.strict_scopes") !== true) return next();
      if (!c.req.path.startsWith("/v1/")) return next();

      const key = stripeRequestKey(c.req.header("Authorization"));
      if (!key) {
        c.header("WWW-Authenticate", 'Basic realm="Stripe"');
        return stripeError(c, 401, "invalid_request_error", MISSING_API_KEY_MESSAGE);
      }
      if (!tokenMap?.has(key) && !(store.getData<string[]>("stripe.api_keys") ?? []).includes(key)) {
        c.header("WWW-Authenticate", 'Basic realm="Stripe"');
        return stripeError(c, 401, "invalid_request_error", `Invalid API Key provided: ${maskStripeKey(key)}`);
      }
      return next();
    });

    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    customerRoutes(ctx);
    paymentMethodRoutes(ctx);
    paymentIntentRoutes(ctx);
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
