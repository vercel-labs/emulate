import { Hono } from "hono";
import { cors } from "hono/cors";
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

export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  timestamp: string;
}

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

  const MAX_LOG_ENTRIES = 1000;
  const requestLog: RequestLogEntry[] = [];

  app.get("/_emulate/requests", (c) => {
    const limit = Number(c.req.query("limit")) || requestLog.length;
    return c.json(requestLog.slice(-limit));
  });

  app.delete("/_emulate/requests", (c) => {
    requestLog.length = 0;
    return c.json({ ok: true });
  });

  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/_emulate/")) {
      await next();
      return;
    }
    const start = Date.now();
    await next();
    const entry: RequestLogEntry = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - start,
      timestamp: new Date().toISOString(),
    };
    requestLog.push(entry);
    if (requestLog.length > MAX_LOG_ENTRIES) {
      requestLog.splice(0, requestLog.length - MAX_LOG_ENTRIES);
    }
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

  return { app, store, webhooks, port, baseUrl, tokenMap, requestLog };
}
