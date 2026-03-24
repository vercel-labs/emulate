import { createServer, type AppKeyResolver, type AuthFallback, type Store } from "@internal/core";
import { vercelPlugin, seedFromConfig as seedVercel, type VercelSeedConfig } from "@internal/vercel";
import { githubPlugin, seedFromConfig as seedGitHub, getGitHubStore, type GitHubSeedConfig } from "@internal/github";
import { googlePlugin, seedFromConfig as seedGoogle, type GoogleSeedConfig } from "@internal/google";
import { idpPlugin, seedFromConfig as seedIdp, type IdpSeedConfig } from "@internal/idp";
import { serve } from "@hono/node-server";

const SERVICE_PLUGINS = {
  vercel: vercelPlugin,
  github: githubPlugin,
  google: googlePlugin,
  idp: idpPlugin,
} as const;

export type ServiceName = keyof typeof SERVICE_PLUGINS;

export interface SeedConfig {
  tokens?: Record<string, { login: string; scopes?: string[] }>;
  vercel?: VercelSeedConfig;
  github?: GitHubSeedConfig;
  google?: GoogleSeedConfig;
  idp?: IdpSeedConfig;
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

  const plugin = SERVICE_PLUGINS[service];
  if (!plugin) {
    throw new Error(`Unknown service: ${service}`);
  }

  const tokens: Record<string, { login: string; id: number; scopes?: string[] }> = {};
  if (seedConfig?.tokens) {
    let tokenId = 100;
    for (const [token, user] of Object.entries(seedConfig.tokens)) {
      tokens[token] = { login: user.login, id: tokenId++, scopes: user.scopes };
    }
  } else {
    tokens["gho_test_token_admin"] = { login: "admin", id: 2, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] };
  }

  const baseUrl = `http://localhost:${port}`;

  let serverStore: Store | undefined;
  const appKeyResolver: AppKeyResolver | undefined =
    service === "github"
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
  if (service === "vercel") {
    const firstLogin = seedConfig?.vercel?.users?.[0]?.username ?? "admin";
    fallbackUser = { login: firstLogin, id: 1, scopes: [] };
  } else if (service === "github") {
    const firstLogin = seedConfig?.github?.users?.[0]?.login ?? "admin";
    fallbackUser = { login: firstLogin, id: 1, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] };
  } else if (service === "google") {
    const firstEmail = seedConfig?.google?.users?.[0]?.email ?? "testuser@gmail.com";
    fallbackUser = { login: firstEmail, id: 1, scopes: ["openid", "email", "profile"] };
  } else if (service === "idp") {
    const firstEmail = seedConfig?.idp?.users?.[0]?.email ?? "testuser@example.com";
    fallbackUser = { login: firstEmail, id: 1, scopes: ["openid", "email", "profile"] };
  }

  const { app, store } = createServer(plugin, { port, baseUrl, tokens, appKeyResolver, fallbackUser });
  serverStore = store;

  const seed = () => {
    plugin.seed?.(store, baseUrl);
    if (service === "vercel" && seedConfig?.vercel) seedVercel(store, baseUrl, seedConfig.vercel);
    if (service === "github" && seedConfig?.github) seedGitHub(store, baseUrl, seedConfig.github);
    if (service === "google" && seedConfig?.google) seedGoogle(store, baseUrl, seedConfig.google);
    if (service === "idp" && seedConfig?.idp) seedIdp(store, baseUrl, seedConfig.idp);
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
