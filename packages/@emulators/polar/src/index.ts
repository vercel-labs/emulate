import type { Hono } from "@emulators/core";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getPolarStore } from "./store.js";
import { polarId } from "./helpers.js";
import { checkoutRoutes } from "./routes/checkouts.js";
import { productRoutes } from "./routes/products.js";
import { organizationRoutes } from "./routes/organizations.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";

export { getPolarStore, type PolarStore } from "./store.js";
export * from "./entities.js";

export interface PolarSeedConfig {
  organizations?: Array<{
    id?: string;
    name: string;
    slug: string;
  }>;
  products?: Array<{
    id?: string;
    name: string;
    description?: string;
    organization_slug: string;
    prices: Array<{
      id?: string;
      amount: number;
      currency?: string;
    }>;
  }>;
}

function seedDefaults(store: Store): void {
  const ps = getPolarStore(store);

  const org = ps.organizations.insert({
    polar_id: polarId("org"),
    name: "Test Organization",
    slug: "test-org",
    avatar_url: null,
  });

  ps.products.insert({
    polar_id: polarId("prod"),
    name: "Test Product",
    description: "A test product for emulation",
    organization_id: org.polar_id,
    is_recurring: false,
    is_archived: false,
  });
}

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: PolarSeedConfig,
): void {
  const ps = getPolarStore(store);

  if (config.organizations) {
    for (const o of config.organizations) {
      ps.organizations.insert({
        polar_id: o.id ?? polarId("org"),
        name: o.name,
        slug: o.slug,
        avatar_url: null,
      });
    }
  }

  if (config.products) {
    for (const p of config.products) {
      const org = ps.organizations.findOneBy("slug", p.organization_slug);
      if (!org) continue;

      const product = ps.products.insert({
        polar_id: p.id ?? polarId("prod"),
        name: p.name,
        description: p.description ?? null,
        organization_id: org.polar_id,
        is_recurring: p.prices.some(pr => pr.amount > 0), // Simple heuristic
        is_archived: false,
      });

      for (const pr of p.prices) {
        ps.prices.insert({
          polar_id: pr.id ?? polarId("price"),
          product_id: product.polar_id,
          amount_type: "fixed",
          price_currency: pr.currency ?? "usd",
          price_amount: pr.amount,
          recurring_interval: null,
        });
      }
    }
  }
}

export const polarPlugin: ServicePlugin = {
  name: "polar",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    checkoutRoutes(ctx);
    productRoutes(ctx);
    organizationRoutes(ctx);
    subscriptionRoutes(ctx);
  },
  seed(store: Store): void {
    seedDefaults(store);
  },
};

export default polarPlugin;
