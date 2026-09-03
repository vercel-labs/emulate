import type { Hono } from "@emulators/core";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getPolarStore } from "./store.js";
import { generateUuid } from "./helpers.js";
import { organizationRoutes } from "./routes/organizations.js";
import { productRoutes } from "./routes/products.js";
import { checkoutRoutes } from "./routes/checkouts.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";

export { getPolarStore, type PolarStore } from "./store.js";
export * from "./entities.js";

export interface PolarSeedConfig {
  organizations?: Array<{
    name: string;
    slug: string;
  }>;
  products?: Array<{
    name: string;
    description?: string;
    price: number;
    organization_slug?: string;
  }>;
}

export function seedFromConfig(store: Store, _baseUrl: string, config: PolarSeedConfig): void {
  const ps = getPolarStore(store);

  if (config.organizations) {
    for (const o of config.organizations) {
      if (ps.organizations.findOneBy("slug", o.slug)) continue;
      ps.organizations.insert({
        polar_id: generateUuid(),
        name: o.name,
        slug: o.slug,
      });
    }
  }

  if (config.products) {
    for (const p of config.products) {
      let orgId = "default_org";
      if (p.organization_slug) {
        const org = ps.organizations.findOneBy("slug", p.organization_slug);
        if (org) {
          orgId = org.polar_id;
        }
      }
      ps.products.insert({
        polar_id: generateUuid(),
        name: p.name,
        description: p.description,
        price: p.price,
        organization_id: orgId,
      });
    }
  }
}

export const polarPlugin: ServicePlugin = {
  name: "polar",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    organizationRoutes(ctx);
    productRoutes(ctx);
    checkoutRoutes(ctx);
    subscriptionRoutes(ctx);
  },
  seed(_store: Store, _baseUrl: string): void {
    // Empty default seed
  },
};

export default polarPlugin;
