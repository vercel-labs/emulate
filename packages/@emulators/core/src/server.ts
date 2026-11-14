import { Hono, cors, type Context } from "./http.js";
import { Store } from "./store.js";
import { WebhookDispatcher } from "./webhooks.js";
import {
  ApiError,
  createApiErrorHandler,
  createErrorHandler,
  errorStatus,
  notFound,
} from "./middleware/error-handler.js";
import {
  authMiddleware,
  type AuthFallback,
  type TokenMap,
  type AppKeyResolver,
  type AppEnv,
} from "./middleware/auth.js";
import type { ServicePlugin } from "./plugin.js";
import { registerFontRoutes } from "./fonts.js";

export interface ServerOptions {
  port?: number;
  baseUrl?: string;
  docsUrl?: string;
  tokens?: Record<string, { login: string; id: number; scopes?: string[] }>;
  appKeyResolver?: AppKeyResolver;
  fallbackUser?: AuthFallback;
}

export function createServer(plugin: ServicePlugin, options: ServerOptions = {}) {
  const port = options.port ?? 4000;
  const baseUrl = options.baseUrl ?? `http://localhost:${port}`;

  const app = new Hono<AppEnv>();
  const store = new Store();
  const webhooks = new WebhookDispatcher();

  const tokenMap: TokenMap = new Map();
  if (options.tokens) {
    for (const [token, user] of Object.entries(options.tokens)) {
      tokenMap.set(token, {
        login: user.login,
        id: user.id,
        scopes: user.scopes ?? ["repo", "user", "admin:org", "admin:repo_hook"],
      });
    }
  }

  const docsUrl = options.docsUrl ?? `https://emulate.dev/${plugin.name}`;

  registerFontRoutes(app);

  const defaultErrorHandler = createApiErrorHandler(docsUrl);
  const renderError = async (err: unknown, c: Context<AppEnv>) => {
    if (!plugin.formatError) return defaultErrorHandler(err, c);
    try {
      return await plugin.formatError(err, c, errorStatus(err));
    } catch {
      return defaultErrorHandler(err, c);
    }
  };
  app.onError(renderError);
  app.use("*", cors());
  app.use("*", createErrorHandler(docsUrl));
  app.use("*", authMiddleware(tokenMap, options.appKeyResolver, options.fallbackUser));

  if (plugin.rateLimit !== false) {
    const rateLimitCounters = new Map<string, { remaining: number; resetAt: number }>();
    let lastPruneAt = Math.floor(Date.now() / 1000);

    app.use("*", async (c, next) => {
      const token = c.get("authToken") ?? "__anonymous__";
      const now = Math.floor(Date.now() / 1000);

      if (now - lastPruneAt > 3600) {
        for (const [key, val] of rateLimitCounters) {
          if (val.resetAt <= now) rateLimitCounters.delete(key);
        }
        lastPruneAt = now;
      }

      let counter = rateLimitCounters.get(token);
      if (!counter || counter.resetAt <= now) {
        counter = { remaining: 5000, resetAt: now + 3600 };
        rateLimitCounters.set(token, counter);
      }

      counter.remaining = Math.max(0, counter.remaining - 1);

      c.header("X-RateLimit-Limit", "5000");
      c.header("X-RateLimit-Remaining", String(counter.remaining));
      c.header("X-RateLimit-Reset", String(counter.resetAt));
      c.header("X-RateLimit-Resource", "core");

      if (counter.remaining === 0) {
        return renderError(new ApiError(403, "API rate limit exceeded"), c);
      }

      await next();
    });
  }

  plugin.register(app, store, webhooks, baseUrl, tokenMap);

  app.notFound((c) => renderError(notFound(), c));

  return { app, store, webhooks, port, baseUrl, tokenMap };
}
