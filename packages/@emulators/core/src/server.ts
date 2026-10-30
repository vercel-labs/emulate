import { Hono, cors } from "./http.js";
import { Store } from "./store.js";
import { WebhookDispatcher } from "./webhooks.js";
import { createApiErrorHandler, createErrorHandler } from "./middleware/error-handler.js";
import {
  authMiddleware,
  type AuthFallback,
  type TokenMap,
  type AppKeyResolver,
  type AppEnv,
} from "./middleware/auth.js";
import type { ServicePlugin } from "./plugin.js";
import { registerFontRoutes } from "./fonts.js";
import { RateLimiter, isInternalRequest, setRateLimitHeaders } from "./rate-limit.js";

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

  app.onError(createApiErrorHandler(docsUrl));
  app.use("*", cors());
  app.use("*", createErrorHandler(docsUrl));
  app.use("*", authMiddleware(tokenMap, options.appKeyResolver, options.fallbackUser));

  const rateLimiter = new RateLimiter();

  app.use("*", async (c, next) => {
    c.set("rateLimiter", rateLimiter);
    if (isInternalRequest(c.req.raw) || plugin.chargesOwnRateLimit?.(c.req.raw)) return next();

    const bucket = rateLimiter.bucket(c.get("authToken") ?? "__anonymous__", "core");
    const charged = rateLimiter.charge(bucket, 1);
    setRateLimitHeaders(c, bucket);
    if (!charged) {
      return c.json(
        {
          message: "API rate limit exceeded",
          documentation_url: docsUrl,
        },
        403,
      );
    }

    await next();
  });

  plugin.register(app, store, webhooks, baseUrl, tokenMap);

  app.notFound((c) =>
    c.json(
      {
        message: "Not Found",
        documentation_url: docsUrl,
      },
      404,
    ),
  );

  return { app, store, webhooks, port, baseUrl, tokenMap };
}
