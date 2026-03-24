import { createServer, type AppKeyResolver, type AuthFallback, type ServicePlugin, type Store } from "@internal/core";
import { vercelPlugin, seedFromConfig as seedVercel, type VercelSeedConfig } from "@internal/vercel";
import { githubPlugin, seedFromConfig as seedGitHub, getGitHubStore, type GitHubSeedConfig } from "@internal/github";
import { googlePlugin, seedFromConfig as seedGoogle, type GoogleSeedConfig } from "@internal/google";
import { slackPlugin, seedFromConfig as seedSlack, type SlackSeedConfig } from "@internal/slack";
import { serve } from "@hono/node-server";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import { createRequire } from "module";
import pc from "picocolors";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export interface StartOptions {
  port: number;
  service?: string;
  seed?: string;
}

interface SeedConfig {
  tokens?: Record<string, { login: string; scopes?: string[] }>;
  vercel?: VercelSeedConfig;
  github?: GitHubSeedConfig;
  google?: GoogleSeedConfig;
  slack?: SlackSeedConfig;
}

interface LoadResult {
  config: SeedConfig;
  source: string;
}

function loadSeedConfig(seedPath?: string): LoadResult | null {
  if (seedPath) {
    const fullPath = resolve(seedPath);
    if (!existsSync(fullPath)) {
      console.error(`Seed file not found: ${fullPath}`);
      process.exit(1);
    }
    const content = readFileSync(fullPath, "utf-8");
    try {
      const config = fullPath.endsWith(".json") ? JSON.parse(content) : parseYaml(content);
      return { config, source: seedPath };
    } catch (err) {
      console.error(`Failed to parse ${seedPath}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  const autoFiles = [
    "emulate.config.yaml",
    "emulate.config.yml",
    "emulate.config.json",
    "service-emulator.config.yaml",
    "service-emulator.config.yml",
    "service-emulator.config.json",
  ];

  for (const file of autoFiles) {
    const fullPath = resolve(file);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, "utf-8");
      try {
        const config = fullPath.endsWith(".json") ? JSON.parse(content) : parseYaml(content);
        return { config, source: file };
      } catch (err) {
        console.error(`Failed to parse ${file}: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    }
  }

  return null;
}

const SERVICE_PLUGINS: Record<string, ServicePlugin> = {
  vercel: vercelPlugin,
  github: githubPlugin,
  google: googlePlugin,
  slack: slackPlugin,
};

const ALL_SERVICES = Object.keys(SERVICE_PLUGINS);

function inferServicesFromConfig(config: SeedConfig): string[] | null {
  const found = ALL_SERVICES.filter((k) => k in config);
  return found.length > 0 ? found : null;
}

export function startCommand(options: StartOptions): void {
  const { port: basePort } = options;

  const loaded = loadSeedConfig(options.seed);
  const seedConfig = loaded?.config ?? null;
  const configSource = loaded?.source ?? null;

  let services: string[];
  if (options.service) {
    services = options.service.split(",").map((s) => s.trim());
  } else if (seedConfig) {
    services = inferServicesFromConfig(seedConfig) ?? ALL_SERVICES;
  } else {
    services = ALL_SERVICES;
  }

  for (const svc of services) {
    if (!SERVICE_PLUGINS[svc]) {
      console.error(`Unknown service: ${svc}`);
      process.exit(1);
    }
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

  const serviceConfigPort = (svc: string): number | undefined => {
    if (svc === "vercel") return seedConfig?.vercel?.port;
    if (svc === "github") return seedConfig?.github?.port;
    if (svc === "google") return seedConfig?.google?.port;
    if (svc === "slack") return seedConfig?.slack?.port;
    return undefined;
  };

  const serviceUrls: Array<{ name: string; url: string }> = [];
  const stores: Store[] = [];
  const httpServers: ReturnType<typeof serve>[] = [];

  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    const plugin = SERVICE_PLUGINS[svc];
    const port = serviceConfigPort(svc) ?? basePort + i;
    const baseUrl = `http://localhost:${port}`;
    serviceUrls.push({ name: svc, url: baseUrl });

    let serverStore: Store | undefined;
    const appKeyResolver: AppKeyResolver | undefined = svc === "github"
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
    } else if (svc === "slack") {
      fallbackUser = { login: "U000000001", id: 1, scopes: ["chat:write", "channels:read", "users:read", "reactions:write"] };
    }

    const { app, store } = createServer(plugin, { port, baseUrl, tokens, appKeyResolver, fallbackUser });
    serverStore = store;
    stores.push(store);

    plugin.seed?.(store, baseUrl);

    if (svc === "vercel" && seedConfig?.vercel) {
      seedVercel(store, baseUrl, seedConfig.vercel);
    }
    if (svc === "github" && seedConfig?.github) {
      seedGitHub(store, baseUrl, seedConfig.github);
    }
    if (svc === "google" && seedConfig?.google) {
      seedGoogle(store, baseUrl, seedConfig.google);
    }
    if (svc === "slack" && seedConfig?.slack) {
      seedSlack(store, baseUrl, seedConfig.slack);
    }

    const httpServer = serve({ fetch: app.fetch, port });
    httpServers.push(httpServer);
  }

  printBanner(serviceUrls, tokens, configSource);

  const shutdown = () => {
    console.log(`\n${pc.dim("Shutting down...")}`);
    for (const store of stores) {
      store.reset();
    }
    for (const srv of httpServers) {
      srv.close();
    }
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function printBanner(
  services: Array<{ name: string; url: string }>,
  tokens: Record<string, { login: string; id: number; scopes?: string[] }>,
  configSource: string | null,
): void {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${pc.bold("emulate")} ${pc.dim(`v${pkg.version}`)}`);
  lines.push("");

  const maxNameLen = Math.max(...services.map((s) => s.name.length));
  for (const { name, url } of services) {
    lines.push(`  ${pc.cyan(name.padEnd(maxNameLen + 2))}${pc.bold(url)}`);
  }
  lines.push("");

  const tokenEntries = Object.entries(tokens);
  if (tokenEntries.length > 0) {
    lines.push(`  ${pc.dim("Tokens")}`);
    for (const [token, user] of tokenEntries) {
      lines.push(`  ${pc.dim(token)} ${pc.dim("->")} ${user.login}`);
    }
    lines.push("");
  }

  if (configSource) {
    lines.push(`  ${pc.dim("Config:")} ${configSource}`);
  } else {
    lines.push(`  ${pc.dim("Config:")} defaults ${pc.dim("(run")} emulate init ${pc.dim("to customize)")}`);
  }
  lines.push("");

  console.log(lines.join("\n"));
}
