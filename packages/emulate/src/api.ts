import {
  createServer,
  serve,
  createCustomRuntime,
  type AppKeyResolver,
  type EmulatorDefinition,
  type CustomRuntime,
  type CustomRuntimeOptions,
} from "@emulators/core";
import type { Server } from "node:http";
export {
  defineEmulator,
  type EmulatorDefinition,
  type EmulatorContext,
  type EmulatorSnapshot,
  type InspectorOptions,
  filePersistence,
  type PersistenceAdapter,
} from "@emulators/core";
export { defineConfig, type EmulateConfig, type ServiceConfig } from "./config.js";
import { SERVICE_REGISTRY } from "./registry.js";
export type { ServiceName } from "./registry.js";
import type { ServiceName } from "./registry.js";
import { resolveBaseUrl } from "./base-url.js";

export interface SeedConfig {
  tokens?: Record<string, { login: string; scopes?: string[] }>;
  [service: string]: unknown;
}

export interface EmulatorOptions {
  service: ServiceName;
  port?: number;
  seed?: SeedConfig;
  baseUrl?: string;
}

export interface GeneratedSecret {
  readonly service: ServiceName;
  readonly kind: string;
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface Emulator {
  url: string;
  readonly generatedSecrets: readonly GeneratedSecret[];
  reset(): void;
  close(): Promise<void>;
}

export interface CustomEmulatorOptions<State extends object> extends CustomRuntimeOptions<NoInfer<State>> {
  service: EmulatorDefinition<State>;
  port?: number;
  listen?: boolean;
}

export type CustomEmulator<State extends object> = CustomRuntime<State> & {
  readonly generatedSecrets: readonly GeneratedSecret[];
};

export function createEmulator(options: EmulatorOptions): Promise<Emulator>;
export function createEmulator<State extends object>(
  options: CustomEmulatorOptions<State> & { listen: false },
): Promise<CustomEmulator<State>>;
export function createEmulator<State extends object>(
  options: CustomEmulatorOptions<State> & { listen?: true },
): Promise<CustomEmulator<State> & { url: string }>;
export async function createEmulator(
  options: EmulatorOptions | CustomEmulatorOptions<any>,
): Promise<Emulator | CustomEmulator<any>> {
  if (typeof options.service === "string") return createBuiltinEmulator(options as EmulatorOptions);
  const opts = options as CustomEmulatorOptions<any>;
  if (opts.listen === false)
    return { ...(await createCustomRuntime(opts.service, opts)), generatedSecrets: Object.freeze([]) };
  let runtime: CustomRuntime | undefined;
  const server = serve({
    fetch: (request) => (runtime ? runtime.fetch(request) : Response.json({ error: "Starting" }, { status: 503 })),
    port: opts.port ?? 4000,
  });
  try {
    await waitForListening(server);
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : (opts.port ?? 4000);
    const baseUrl = resolveBaseUrl({ service: opts.service.name, port, baseUrl: opts.baseUrl });
    runtime = await createCustomRuntime(opts.service, { ...opts, baseUrl });
    let closing: Promise<void> | undefined;
    return {
      ...runtime,
      url: baseUrl,
      generatedSecrets: Object.freeze([]),
      close() {
        return (closing ??= (async () => {
          const stopping = closeHttpServer(server);
          const results = await Promise.allSettled([runtime!.close(), stopping]);
          const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
          if (failures.length)
            throw new AggregateError(
              failures.map((r) => r.reason),
              "Could not close emulator",
            );
        })());
      },
    };
  } catch (error) {
    await closeHttpServer(server);
    throw error;
  }
}

export function waitForListening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ready = () => {
      server.off("error", fail);
      resolve();
    };
    const fail = (error: Error) => {
      server.off("listening", ready);
      reject(error);
    };
    server.once("listening", ready);
    server.once("error", fail);
  });
}

export function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}

async function createBuiltinEmulator(options: EmulatorOptions): Promise<Emulator> {
  const { service, port = 4000, seed: seedConfig } = options;

  const entry = SERVICE_REGISTRY[service];
  if (!entry) {
    throw new Error(`Unknown service: ${service}`);
  }

  const loaded = await entry.load();

  let handler: ((request: Request) => Response | Promise<Response>) | undefined;
  const httpServer = serve({
    fetch: (request) => (handler ? handler(request) : new Response("Starting", { status: 503 })),
    port,
  });
  try {
    await waitForListening(httpServer);
    const address = httpServer.address();
    const actualPort = address && typeof address === "object" ? address.port : port;

    const tokens: Record<string, { login: string; id: number; scopes?: string[] }> = {};
    if (seedConfig?.tokens) {
      let tokenId = 100;
      for (const [token, user] of Object.entries(seedConfig.tokens)) {
        tokens[token] = { login: user.login, id: tokenId++, scopes: user.scopes };
      }
    } else {
      tokens["test_token_admin"] = { login: "admin", id: 2, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] };
    }

    const inputSvcSeedConfig = seedConfig?.[service] as Record<string, unknown> | undefined;
    const preparedSeed =
      inputSvcSeedConfig && loaded.prepareSeed ? await loaded.prepareSeed(inputSvcSeedConfig) : undefined;
    const svcSeedConfig = preparedSeed?.config ?? inputSvcSeedConfig;
    const generatedSecrets: readonly GeneratedSecret[] = Object.freeze(
      (preparedSeed?.generatedSecrets ?? []).map((secret) => Object.freeze({ service, ...secret })),
    );
    const seedBaseUrl =
      typeof svcSeedConfig?.baseUrl === "string" && svcSeedConfig.baseUrl.length > 0
        ? svcSeedConfig.baseUrl
        : undefined;
    const baseUrl = resolveBaseUrl({ service, port: actualPort, baseUrl: options.baseUrl, seedBaseUrl });

    // eslint-disable-next-line prefer-const
    let cachedResolver: AppKeyResolver | undefined;
    const appKeyResolver: AppKeyResolver | undefined = loaded.createAppKeyResolver
      ? (appId) => cachedResolver!(appId)
      : undefined;

    const fallbackUser = entry.defaultFallback(svcSeedConfig);

    const { app, store, webhooks, tokenMap } = createServer(loaded.plugin, {
      port,
      baseUrl,
      tokens,
      appKeyResolver,
      fallbackUser,
    });
    cachedResolver = loaded.createAppKeyResolver?.(store);

    const seed = () => {
      loaded.plugin.seed?.(store, baseUrl);
      if (svcSeedConfig && loaded.seedFromConfig) {
        loaded.seedFromConfig(store, baseUrl, svcSeedConfig, webhooks);
      }
    };
    seed();

    handler = app.fetch;
    let closing: Promise<void> | undefined;

    return {
      url: baseUrl,
      generatedSecrets,
      reset() {
        for (const [token, user] of tokenMap) {
          if (user.installation) tokenMap.delete(token);
        }
        store.reset();
        webhooks.clear();
        seed();
      },
      close(): Promise<void> {
        return (closing ??= closeHttpServer(httpServer));
      },
    };
  } catch (error) {
    await closeHttpServer(httpServer);
    throw error;
  }
}
