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

/** Facts about the registration that a plugin may need beyond the base URL. */
export interface RegisterOptions {
  /** True when the base URL was taken from an incoming request's Host rather than stated by the operator. */
  baseUrlDerived?: boolean;
}

export interface ServicePlugin {
  name: string;
  register(
    app: Hono<AppEnv>,
    store: Store,
    webhooks: WebhookDispatcher,
    baseUrl: string,
    tokenMap?: TokenMap,
    options?: RegisterOptions,
  ): void;
  seed?(store: Store, baseUrl: string): void;
  /** Renders every error core produces for the service (thrown errors, unmatched routes, rate limit and auth rejections) in the service's native format instead of the default GitHub-shaped body. */
  formatError?(error: unknown, c: Context<AppEnv>, status: number): Response;
  /** Set to false to skip the shared GitHub-style rate limiter and its X-RateLimit headers. */
  rateLimit?: false;
  /** Set to true so serve() aborts the request signal and stops writing when a client closes a response early. */
  abortOnClose?: boolean;
}
