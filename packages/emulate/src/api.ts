import { createServer, type AppKeyResolver, type Store } from "@emulators/core";
import { SERVICE_REGISTRY } from "./registry.js";
export type { ServiceName } from "./registry.js";
import type { ServiceName } from "./registry.js";
import { serve } from "@hono/node-server";

export interface SeedConfig {
  tokens?: Record<string, { login: string; scopes?: string[] }>;
  [service: string]: unknown;
}

export interface EmulatorOptions {
  service: ServiceName;
  port?: number;
  seed?: SeedConfig;
}

export interface Emulator {
  url: string;
  reset(): void;
  close(): Promise<void>;
}

export async function createEmulator(options: EmulatorOptions): Promise<Emulator> {
  const { service, port = 4000, seed: seedConfig } = options;

  const entry = SERVICE_REGISTRY[service];
  if (!entry) {
    throw new Error(`Unknown service: ${service}`);
  }

  const loaded = await entry.load();

  const tokens: Record<string, { login: string; id: number; scopes?: string[] }> = {};
  if (seedConfig?.tokens) {
    let tokenId = 100;
    for (const [token, user] of Object.entries(seedConfig.tokens)) {
      tokens[token] = { login: user.login, id: tokenId++, scopes: user.scopes };
    }
  } else {
    tokens["test_token_admin"] = { login: "admin", id: 2, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] };
  }

  const baseUrl = `http://localhost:${port}`;

  let cachedResolver: AppKeyResolver | undefined;
  const appKeyResolver: AppKeyResolver | undefined = loaded.createAppKeyResolver
    ? (appId) => cachedResolver!(appId)
    : undefined;

  const svcSeedConfig = seedConfig?.[service] as Record<string, unknown> | undefined;
  const fallbackUser = entry.defaultFallback(svcSeedConfig);

  const { app, store } = createServer(loaded.plugin, { port, baseUrl, tokens, appKeyResolver, fallbackUser });
  cachedResolver = loaded.createAppKeyResolver?.(store);

  const seed = () => {
    loaded.plugin.seed?.(store, baseUrl);
    if (svcSeedConfig && loaded.seedFromConfig) {
      loaded.seedFromConfig(store, baseUrl, svcSeedConfig);
    }
  };
  seed();

  const httpServer = serve({ fetch: app.fetch, port });

  return {
    url: baseUrl,
    reset() {
      store.reset();
      seed();
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
