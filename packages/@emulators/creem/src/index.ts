import type { AppEnv, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { creemRoutes } from "./routes.js";
import { getCreemStore } from "./store.js";

export { getCreemStore, type CreemStore } from "./store.js";
export * from "./entities.js";

export interface CreemSeedConfig {
  port?: number;
  products?: Array<{
    id?: string;
    name: string;
    description?: string;
    amount: number;
    currency?: string;
    return_url?: string;
  }>;
  webhooks?: Array<{
    url: string;
    events: string[];
    secret?: string;
  }>;
}

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: CreemSeedConfig,
  webhooks?: WebhookDispatcher,
): void {
  const cs = getCreemStore(store);
  for (const product of config.products ?? []) {
    if (product.id && cs.products.findOneBy("creem_id", product.id)) continue;
    cs.products.insert({
      creem_id: product.id ?? `prod_${String(cs.products.all().length + 1).padStart(4, "0")}`,
      name: product.name,
      description: product.description ?? null,
      amount: product.amount,
      currency: (product.currency ?? "USD").toUpperCase(),
      return_url: product.return_url ?? null,
    });
  }
  for (const webhook of config.webhooks ?? []) {
    webhooks?.register({
      url: webhook.url,
      events: webhook.events,
      active: true,
      secret: webhook.secret,
      owner: "creem",
    });
  }
}

export const creemPlugin: ServicePlugin = {
  name: "creem",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    creemRoutes({ app, store, webhooks, baseUrl, tokenMap });
  },
};

export default creemPlugin;
