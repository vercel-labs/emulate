import type { Hono } from "@emulators/core";
import type { AppEnv, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { seedDefaults } from "./seed.js";

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
  register(
    _app: Hono<AppEnv>,
    _store: Store,
    _webhooks: WebhookDispatcher,
    _baseUrl: string,
    _tokenMap?: TokenMap,
  ): void {
    // HTTP routes are wired in a subsequent commit.
  },
  seed(store: Store): void {
    seedDefaults(store);
  },
};

export default airtablePlugin;
