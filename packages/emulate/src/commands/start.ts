import { createServer, serve, type AppKeyResolver, type Store } from "@emulators/core";
import { SERVICE_REGISTRY, SERVICE_NAMES, type ServiceName } from "../registry.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import pc from "picocolors";
import {
  ensurePortless,
  registerAlias,
  registerAliases,
  removeAlias,
  removeAliases,
  portlessBaseUrl,
  type PortlessAlias,
} from "../portless.js";
import { resolveBaseUrl } from "../base-url.js";
import {
  preflightGeneratedSecretsFile,
  publishGeneratedSecretsFile,
  type GeneratedSecretRecord,
  type GeneratedSecretsFileTarget,
  type PublishedGeneratedSecretsFile,
} from "../generated-secrets-file.js";

declare const PKG_VERSION: string;
const pkg = { version: PKG_VERSION };

export interface StartOptions {
  port: number;
  service?: string;
  seed?: string;
  baseUrl?: string;
  portless?: boolean;
  generatedSecretsFile?: string;
}

interface SeedConfig {
  tokens?: Record<string, { login: string; scopes?: string[] }>;
  [service: string]: unknown;
}

interface LoadResult {
  config: SeedConfig;
  source: string;
}

interface PreparedService {
  svc: ServiceName;
  entry: (typeof SERVICE_REGISTRY)[ServiceName];
  loadedSvc: Awaited<ReturnType<(typeof SERVICE_REGISTRY)[ServiceName]["load"]>>;
  svcSeedConfig: Record<string, unknown> | undefined;
  port: number;
  baseUrl: string;
}

type Tokens = Record<string, { login: string; id: number; scopes?: string[] }>;

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

function inferServicesFromConfig(config: SeedConfig): ServiceName[] | null {
  const found = SERVICE_NAMES.filter((k) => k in config);
  return found.length > 0 ? [...found] : null;
}

export async function prepareStartServices(
  services: ServiceName[],
  seedConfig: SeedConfig | null,
  options: Pick<StartOptions, "port" | "baseUrl" | "portless">,
  materializeGeneratedSecrets: boolean,
): Promise<{
  prepared: PreparedService[];
  portlessAliases: PortlessAlias[];
  generatedSecrets: GeneratedSecretRecord[];
}> {
  const portlessAliases: PortlessAlias[] = [];
  const prepared: PreparedService[] = [];
  const generatedSecrets: GeneratedSecretRecord[] = [];

  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    const entry = SERVICE_REGISTRY[svc];
    const loadedSvc = await entry.load();

    const inputSvcSeedConfig = seedConfig?.[svc] as Record<string, unknown> | undefined;
    const preparedSeed =
      materializeGeneratedSecrets && inputSvcSeedConfig && loadedSvc.prepareSeed
        ? await loadedSvc.prepareSeed(inputSvcSeedConfig)
        : undefined;
    const svcSeedConfig = preparedSeed?.config ?? inputSvcSeedConfig;
    if (preparedSeed) {
      generatedSecrets.push(...preparedSeed.generatedSecrets.map((secret) => ({ service: svc, ...secret })));
    }
    const port = (svcSeedConfig?.port as number | undefined) ?? options.port + i;

    if (options.portless) {
      portlessAliases.push({ name: `${svc}.emulate`, port });
    }

    const seedBaseUrl =
      typeof svcSeedConfig?.baseUrl === "string" && svcSeedConfig.baseUrl.length > 0
        ? svcSeedConfig.baseUrl
        : undefined;
    const effectiveBaseUrl = options.portless ? portlessBaseUrl(svc) : options.baseUrl;
    const baseUrl = resolveBaseUrl({ service: svc, port, baseUrl: effectiveBaseUrl, seedBaseUrl });

    prepared.push({ svc, entry, loadedSvc, svcSeedConfig, port, baseUrl });
  }

  return { prepared, portlessAliases, generatedSecrets };
}

type HttpServer = ReturnType<typeof serve>;

function createPreparedServiceServer(preparedService: PreparedService, tokens: Tokens) {
  const { entry, loadedSvc, svcSeedConfig, port, baseUrl } = preparedService;
  let cachedResolver: AppKeyResolver | undefined = undefined;
  const appKeyResolver: AppKeyResolver | undefined = loadedSvc.createAppKeyResolver
    ? (appId) => cachedResolver!(appId)
    : undefined;
  const fallbackUser = entry.defaultFallback(svcSeedConfig);
  const server = createServer(loadedSvc.plugin, {
    port,
    baseUrl,
    tokens,
    appKeyResolver,
    fallbackUser,
  });
  cachedResolver = loadedSvc.createAppKeyResolver?.(server.store);
  return server;
}

function seedPreparedService(
  preparedService: PreparedService,
  store: Store,
  webhooks: ReturnType<typeof createServer>["webhooks"],
): void {
  const { loadedSvc, svcSeedConfig, baseUrl } = preparedService;
  loadedSvc.plugin.seed?.(store, baseUrl);
  if (svcSeedConfig && loadedSvc.seedFromConfig) {
    loadedSvc.seedFromConfig(store, baseUrl, svcSeedConfig, webhooks);
  }
}

function waitForServerListening(server: HttpServer): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }
      reject(error);
    });
    server.closeAllConnections();
  });
}

function reportCleanupError(stage: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Warning: startup cleanup failed for ${stage}: ${message}`);
}

async function rollbackStartup(
  httpServers: HttpServer[],
  stores: Store[],
  registeredAliases: PortlessAlias[],
  generatedSecretsFile: PublishedGeneratedSecretsFile,
): Promise<void> {
  for (const server of [...httpServers].reverse()) {
    try {
      await closeServer(server);
    } catch (error) {
      reportCleanupError("listener", error);
    }
  }
  for (const store of [...stores].reverse()) {
    try {
      store.reset();
    } catch (error) {
      reportCleanupError("store", error);
    }
  }
  for (const alias of [...registeredAliases].reverse()) {
    try {
      removeAlias(alias);
    } catch (error) {
      reportCleanupError("portless alias", error);
    }
  }
  try {
    await generatedSecretsFile.rollback();
  } catch (error) {
    reportCleanupError("generated secrets file", error);
  }
}

function installShutdown(portlessAliases: PortlessAlias[], stores: Store[], httpServers: HttpServer[]): void {
  const shutdown = () => {
    console.log(`\n${pc.dim("Shutting down...")}`);
    if (portlessAliases.length > 0) {
      removeAliases(portlessAliases);
    }
    for (const store of stores) {
      store.reset();
    }
    for (const server of httpServers) {
      server.close();
    }
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export async function startCommand(options: StartOptions): Promise<void> {
  const { port: basePort } = options;

  if (options.portless && options.baseUrl) {
    console.error("--portless and --base-url are mutually exclusive.");
    process.exit(1);
  }

  const loaded = loadSeedConfig(options.seed);
  const seedConfig = loaded?.config ?? null;
  const configSource = loaded?.source ?? null;

  let services: ServiceName[];
  if (options.service) {
    services = options.service.split(",").map((s) => s.trim()) as ServiceName[];
  } else if (seedConfig) {
    services = inferServicesFromConfig(seedConfig) ?? [...SERVICE_NAMES];
  } else {
    services = [...SERVICE_NAMES];
  }

  for (const svc of services) {
    if (!SERVICE_REGISTRY[svc]) {
      console.error(`Unknown service: ${svc}`);
      process.exit(1);
    }
  }

  const tokens: Tokens = {};
  if (seedConfig?.tokens) {
    let tokenId = 100;
    for (const [token, user] of Object.entries(seedConfig.tokens)) {
      tokens[token] = { login: user.login, id: tokenId++, scopes: user.scopes };
    }
  } else {
    tokens["test_token_admin"] = { login: "admin", id: 2, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] };
  }

  let generatedSecretsTarget: GeneratedSecretsFileTarget | undefined;
  if (options.generatedSecretsFile) {
    generatedSecretsTarget = await preflightGeneratedSecretsFile(options.generatedSecretsFile);
  }

  if (options.portless && !generatedSecretsTarget) {
    await ensurePortless();
  }

  const { prepared, portlessAliases, generatedSecrets } = await prepareStartServices(
    services,
    seedConfig,
    { port: basePort, baseUrl: options.baseUrl, portless: options.portless },
    Boolean(generatedSecretsTarget),
  );

  const serviceUrls: Array<{ name: string; url: string }> = [];
  const stores: Store[] = [];
  const httpServers: HttpServer[] = [];

  if (!generatedSecretsTarget) {
    if (portlessAliases.length > 0) {
      registerAliases(portlessAliases);
    }

    for (const preparedService of prepared) {
      const { svc, port, baseUrl } = preparedService;
      serviceUrls.push({ name: svc, url: baseUrl });
      const { app, store, webhooks } = createPreparedServiceServer(preparedService, tokens);
      stores.push(store);
      seedPreparedService(preparedService, store, webhooks);
      const httpServer = serve({ fetch: app.fetch, port });
      httpServers.push(httpServer);
    }

    printBanner(serviceUrls, tokens, configSource);
    installShutdown(portlessAliases, stores, httpServers);
    return;
  }

  const publishedSecretsFile = await publishGeneratedSecretsFile(generatedSecretsTarget, {
    schemaVersion: 1,
    generatedSecrets,
  });
  const registeredAliases: PortlessAlias[] = [];

  try {
    if (options.portless) {
      await ensurePortless({ throwOnFailure: true });
    }
    for (const alias of portlessAliases) {
      registerAlias(alias);
      registeredAliases.push(alias);
    }

    for (const preparedService of prepared) {
      const { svc, port, baseUrl } = preparedService;
      serviceUrls.push({ name: svc, url: baseUrl });
      const { app, store, webhooks } = createPreparedServiceServer(preparedService, tokens);
      stores.push(store);
      seedPreparedService(preparedService, store, webhooks);
      const httpServer = serve({ fetch: app.fetch, port });
      httpServers.push(httpServer);
      await waitForServerListening(httpServer);
    }

    printBanner(serviceUrls, tokens, configSource);
  } catch (error) {
    await rollbackStartup(httpServers, stores, registeredAliases, publishedSecretsFile);
    throw error;
  }

  installShutdown(registeredAliases, stores, httpServers);
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
    lines.push(`  ${pc.dim("Config:")} defaults ${pc.dim("(run")} npx emulate init ${pc.dim("to customize)")}`);
  }
  lines.push("");

  console.log(lines.join("\n"));
}
