import type { Hono } from "./http.js";
import type { Store } from "./store.js";
import type { WebhookDispatcher } from "./webhooks.js";
import type { TokenMap, AppEnv, RequestTokenReader } from "./middleware/auth.js";

export interface RouteContext {
  app: Hono<AppEnv>;
  store: Store;
  webhooks: WebhookDispatcher;
  baseUrl: string;
  tokenMap?: TokenMap;
}

export interface ServicePlugin {
  name: string;
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void;
  seed?(store: Store, baseUrl: string): void;
  /** Where else this API accepts a token when the Authorization header is absent. */
  requestToken?: RequestTokenReader;
}
