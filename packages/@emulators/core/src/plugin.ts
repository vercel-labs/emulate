import type { Context, Hono } from "./http.js";
import type { Store } from "./store.js";
import type { WebhookDispatcher } from "./webhooks.js";
import type { TokenMap, AppEnv, BasicAuthToken } from "./middleware/auth.js";

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
  /** True when the plugin's route charges this request against the rate limiter itself. */
  chargesOwnRateLimit?(request: Request): boolean;
  /** Answers a request whose bearer token the emulator does not know instead of falling back to a user; undefined lets it through as anonymous. */
  rejectUnknownToken?(c: Context<AppEnv>): Response | undefined;
  /** With rejectUnknownToken: the token Basic credentials carry, which is then accepted or rejected like a bearer token. */
  basicAuthToken?: BasicAuthToken;
}
