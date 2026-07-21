import type { Hono } from "@emulators/core";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { seedDefaults } from "./seed.js";
import { metaRoutes } from "./routes/meta.js";
import { recordRoutes } from "./routes/records.js";
import { commentRoutes } from "./routes/comments.js";

export { getAirtableStore, type AirtableStore } from "./store.js";
export * from "./entities.js";
export {
  seedFromConfig,
  type AirtableSeedConfig,
  type AirtableSeedBase,
  type AirtableSeedTable,
  type AirtableSeedField,
  type AirtableSeedView,
} from "./seed.js";

export const airtablePlugin: ServicePlugin = {
  name: "airtable",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    metaRoutes(ctx);
    recordRoutes(ctx);
    commentRoutes(ctx);
  },
  seed(store: Store): void {
    seedDefaults(store);
  },
};

export default airtablePlugin;
