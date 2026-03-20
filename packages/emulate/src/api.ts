import { createServer, type AppKeyResolver, type AuthFallback, type Store } from "@internal/core";
import { vercelPlugin, seedFromConfig as seedVercel, type VercelSeedConfig } from "@internal/vercel";
import { githubPlugin, seedFromConfig as seedGitHub, getGitHubStore, type GitHubSeedConfig } from "@internal/github";
import { googlePlugin, seedFromConfig as seedGoogle, type GoogleSeedConfig } from "@internal/google";
import { serve } from "@hono/node-server";

const SERVICE_PLUGINS = {
  vercel: vercelPlugin,
  github: githubPlugin,
  google: googlePlugin,
} as const;

const ALL_SERVICES = Object.keys(SERVICE_PLUGINS);

export interface SeedConfig {
  tokens?: Record<string, { login: string; scopes?: string[] }>;
  vercel?: VercelSeedConfig;
  github?: GitHubSeedConfig;
  google?: GoogleSeedConfig;
}

export interface EmulateOptions {
  port?: number;
  services?: string[];
  seed?: SeedConfig;
}

export interface EmulateInstance {
  urls: Record<string, string>;
  reset(): void;
  close(): Promise<void>;
}

export async function createEmulate(options: EmulateOptions = {}): Promise<EmulateInstance> {
  const { port: basePort = 4000, seed: seedConfig } = options;
  const services = options.services ?? ALL_SERVICES;

  const tokens: Record<string, { login: string; id: number; scopes?: string[] }> = {};
  if (seedConfig?.tokens) {
    let tokenId = 100;
    for (const [token, user] of Object.entries(seedConfig.tokens)) {
      tokens[token] = { login: user.login, id: tokenId++, scopes: user.scopes };
    }
  } else {
    tokens["gho_test_token_admin"] = { login: "admin", id: 2, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] };
  }

  const urls: Record<string, string> = {};
  const stores: Store[] = [];
  const seedFns: Array<() => void> = [];
  const httpServers: ReturnType<typeof serve>[] = [];

  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    const plugin = SERVICE_PLUGINS[svc as keyof typeof SERVICE_PLUGINS];
    if (!plugin) {
      throw new Error(`Unknown service: ${svc}`);
    }

    const port = basePort + i;
    const baseUrl = `http://localhost:${port}`;
    urls[svc] = baseUrl;

    let serverStore: Store | undefined;
    const appKeyResolver: AppKeyResolver | undefined =
      svc === "github"
        ? (appId: number) => {
            try {
              const gh = getGitHubStore(serverStore!);
              const ghApp = gh.apps.all().find((a) => a.app_id === appId);
              if (!ghApp) return null;
              return { privateKey: ghApp.private_key, slug: ghApp.slug, name: ghApp.name };
            } catch {
              return null;
            }
          }
        : undefined;

    let fallbackUser: AuthFallback | undefined;
    if (svc === "vercel") {
      const firstLogin = seedConfig?.vercel?.users?.[0]?.username ?? "admin";
      fallbackUser = { login: firstLogin, id: 1, scopes: [] };
    } else if (svc === "github") {
      const firstLogin = seedConfig?.github?.users?.[0]?.login ?? "admin";
      fallbackUser = { login: firstLogin, id: 1, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] };
    } else if (svc === "google") {
      const firstEmail = seedConfig?.google?.users?.[0]?.email ?? "testuser@gmail.com";
      fallbackUser = { login: firstEmail, id: 1, scopes: ["openid", "email", "profile"] };
    }

    const { app, store } = createServer(plugin, { port, baseUrl, tokens, appKeyResolver, fallbackUser });
    serverStore = store;
    stores.push(store);

    const svcSeed = () => {
      plugin.seed?.(store, baseUrl);
      if (svc === "vercel" && seedConfig?.vercel) seedVercel(store, baseUrl, seedConfig.vercel);
      if (svc === "github" && seedConfig?.github) seedGitHub(store, baseUrl, seedConfig.github);
      if (svc === "google" && seedConfig?.google) seedGoogle(store, baseUrl, seedConfig.google);
    };
    svcSeed();
    seedFns.push(svcSeed);

    const httpServer = serve({ fetch: app.fetch, port });
    httpServers.push(httpServer);
  }

  return {
    urls,
    reset() {
      for (let i = 0; i < stores.length; i++) {
        stores[i].reset();
        seedFns[i]();
      }
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        let remaining = httpServers.length;
        if (remaining === 0) {
          resolve();
          return;
        }
        for (const srv of httpServers) {
          srv.close(() => {
            remaining--;
            if (remaining === 0) resolve();
          });
        }
      });
    },
  };
}
