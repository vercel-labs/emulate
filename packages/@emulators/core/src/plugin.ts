import type { Context, Hono } from "./http.js";
import type { Store } from "./store.js";
import type { WebhookDispatcher } from "./webhooks.js";
import type { TokenMap, AppEnv } from "./middleware/auth.js";

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
  /** Renders thrown errors and unmatched routes in the service's native error format instead of the default GitHub-shaped body. */
  formatError?(error: unknown, c: Context<AppEnv>, status: number): Response;
  /** Set to false to skip the shared GitHub-style rate limiter and its X-RateLimit headers. */
  rateLimit?: false;
  /** Set to true so serve() aborts the request signal and stops writing when a client closes a response early. */
  abortOnClose?: boolean;
}
