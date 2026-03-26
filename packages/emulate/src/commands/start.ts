import { createServer, type Store } from "@internal/core";
import { SERVICE_REGISTRY, SERVICE_NAMES } from "../registry.js";
import { serve } from "@hono/node-server";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import { createRequire } from "module";
import pc from "picocolors";
import type { VercelSeedConfig } from "@emulators/vercel";
import type { GitHubSeedConfig } from "@emulators/github";
import type { GoogleSeedConfig } from "@emulators/google";
import type { SlackSeedConfig } from "@emulators/slack";
import type { AppleSeedConfig } from "@emulators/apple";
import type { MicrosoftSeedConfig } from "@emulators/microsoft";
import type { AwsSeedConfig } from "@emulators/aws";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

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
  apple?: AppleSeedConfig;
  microsoft?: MicrosoftSeedConfig;
  aws?: AwsSeedConfig;
  [service: string]: unknown;
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

function inferServicesFromConfig(config: SeedConfig): string[] | null {
  const found = SERVICE_NAMES.filter((k) => k in config);
  return found.length > 0 ? found : null;
}

export async function startCommand(options: StartOptions): Promise<void> {
  const { port: basePort } = options;

  const loaded = loadSeedConfig(options.seed);
  const seedConfig = loaded?.config ?? null;
  const configSource = loaded?.source ?? null;

  let services: string[];
  if (options.service) {
    services = options.service.split(",").map((s) => s.trim());
  } else if (seedConfig) {
    services = inferServicesFromConfig(seedConfig) ?? SERVICE_NAMES;
  } else {
    services = SERVICE_NAMES;
  }

  for (const svc of services) {
    if (!SERVICE_REGISTRY[svc]) {
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
    tokens["test_token_admin"] = { login: "admin", id: 2, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] };
  }

  const serviceUrls: Array<{ name: string; url: string }> = [];
  const stores: Store[] = [];
  const httpServers: ReturnType<typeof serve>[] = [];

  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    const entry = SERVICE_REGISTRY[svc];
    const loadedSvc = await entry.load();

    const svcSeedConfig = seedConfig?.[svc] as Record<string, unknown> | undefined;
    const port = (svcSeedConfig?.port as number | undefined) ?? basePort + i;
    const baseUrl = `http://localhost:${port}`;
    serviceUrls.push({ name: svc, url: baseUrl });

    let serverStore: Store | undefined;
    const appKeyResolver = loadedSvc.createAppKeyResolver
      ? (appId: number) => loadedSvc.createAppKeyResolver!(serverStore!)(appId)
      : undefined;

    const fallbackUser = entry.defaultFallback(svcSeedConfig);

    const { app, store } = createServer(loadedSvc.plugin, { port, baseUrl, tokens, appKeyResolver, fallbackUser });
    serverStore = store;
    stores.push(store);

    loadedSvc.plugin.seed?.(store, baseUrl);

    if (svcSeedConfig && loadedSvc.seedFromConfig) {
      loadedSvc.seedFromConfig(store, baseUrl, svcSeedConfig);
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
