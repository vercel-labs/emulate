import {
  createCustomRuntime,
  serve,
  filePersistence,
  type CustomRuntime,
  type PersistenceAdapter,
} from "@emulators/core";
import type { Server } from "node:http";
import { loadConfig, type LoadedConfig } from "./config-loader.js";
import {
  prepareStartServices,
  createPreparedServiceServer,
  seedPreparedService,
  type StartOptions,
} from "./commands/start.js";
import { closeHttpServer, waitForListening } from "./api.js";
import { resolveBaseUrl } from "./base-url.js";
import { portlessBaseUrl, type PortlessAlias } from "./portless.js";
import type { GeneratedSecretRecord } from "./generated-secrets-file.js";

export interface ProjectOptions extends StartOptions {
  config?: string;
  watch?: boolean;
}
export interface RetainedSeed {
  emulator: string;
  input: string;
  config: Record<string, unknown>;
  secrets: GeneratedSecretRecord[];
}
export interface RunMetadata {
  services: Array<{ name: string; url: string; port: number; source: string; inspectorUrl?: string }>;
  dependencies: string[];
  directory: string;
  watch: string[];
  aliases: PortlessAlias[];
  secrets: GeneratedSecretRecord[];
  retained: Record<string, RetainedSeed>;
}

export async function prepareProject(
  options: ProjectOptions,
  retained: Record<string, RetainedSeed> = {},
  reload = false,
  onDependenciesChange?: (files: string[]) => void,
  signal?: AbortSignal,
) {
  if (options.portless && options.baseUrl) throw new Error("--portless and --base-url are mutually exclusive");
  signal?.throwIfAborted();
  const config = await abortable(loadConfig(options, onDependenciesChange), signal, (config) => config.loader.close());
  const servers: Server[] = [];
  const cleanups: Array<() => void | Promise<void>> = [];
  const prepared: Array<{ fetch: (req: Request) => Response | Promise<Response>; port: number }> = [];
  const activations: Array<() => Promise<void>> = [];
  const metadata: RunMetadata = {
    services: [],
    dependencies: [],
    directory: config.directory,
    watch: config.watch,
    aliases: [],
    secrets: [],
    retained: {},
  };
  let closed = false;
  let closing: Promise<void> | undefined;
  let accepting = false;
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    accepting = false;
    return (closing = (async () => {
      const results = await Promise.allSettled([
        ...servers.map(closeHttpServer),
        ...cleanups.reverse().map((fn) => Promise.resolve().then(fn)),
      ]);
      config.loader.close();
      const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (errors.length)
        throw new AggregateError(
          errors.map((r) => r.reason),
          "Failed to shut down project",
        );
    })());
  }
  try {
    signal?.throwIfAborted();
    const ports = new Set<number>();
    for (const [index, service] of config.services.entries()) {
      const port = service.port ?? options.port + index;
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error(`Invalid port for ${service.name}: ${port}`);
      if (ports.has(port)) throw new Error(`Duplicate port ${port} for ${service.name}`);
      ports.add(port);
    }
    for (const [index, service] of config.services.entries()) {
      signal?.throwIfAborted();
      const port = service.port ?? options.port + index;
      const baseUrl = resolveBaseUrl({
        service: service.name,
        port,
        baseUrl: options.portless ? portlessBaseUrl(service.name) : options.baseUrl,
        seedBaseUrl: service.baseUrl,
      });
      if (options.portless) metadata.aliases.push({ name: `${service.name}.emulate`, port });
      if (typeof service.emulator === "string") {
        const input = JSON.stringify(service.seed ?? {});
        const existing = retained[service.name];
        if (existing && (existing.input !== input || existing.emulator !== service.emulator))
          throw new Error(
            `Seed for ${service.name} changed while generated secrets are in use. Restart with a new --generated-secrets-file path to apply the change.`,
          );
        const result = await abortable(
          prepareStartServices(
            [service.emulator],
            { [service.emulator]: existing?.config ?? service.seed },
            { port, baseUrl },
            Boolean(options.generatedSecretsFile) && !existing,
          ),
          signal,
        );
        signal?.throwIfAborted();
        const item = result.prepared[0];
        item.baseUrl = baseUrl;
        item.port = port;
        const tokens = toTokens(config);
        const runtime = createPreparedServiceServer(item, tokens);
        cleanups.push(() => {
          runtime.webhooks.clear();
          runtime.store.reset();
        });
        seedPreparedService(item, runtime.store, runtime.webhooks);
        const secrets = existing?.secrets ?? result.generatedSecrets;
        if (secrets.length)
          metadata.retained[service.name] = { emulator: service.emulator, input, config: item.svcSeedConfig!, secrets };
        metadata.secrets.push(...secrets);
        prepared.push({ fetch: runtime.app.fetch, port });
        metadata.services.push({ name: service.name, port, url: baseUrl, source: service.source });
      } else {
        const persistence =
          typeof service.persistence === "string" ? filePersistence(service.persistence) : service.persistence;
        let active = false;
        let pending: string | undefined;
        const buffered: PersistenceAdapter | undefined = persistence && {
          async load() {
            signal?.throwIfAborted();
            const data = await abortable(persistence.load(), signal);
            signal?.throwIfAborted();
            return data;
          },
          async save(data) {
            pending = data;
            if (active) await persistence.save(data);
          },
        };
        const runtime: CustomRuntime = await createCustomRuntime(service.emulator, {
          seed: service.seed,
          baseUrl,
          inspector: service.inspector ?? true,
          persistence: buffered,
          resetPersistence: reload,
        });
        cleanups.push(() => runtime.close());
        signal?.throwIfAborted();
        activations.push(async () => {
          if (persistence && pending !== undefined) await abortable(persistence.save(pending), signal);
          if (!closed) active = true;
        });
        prepared.push({ fetch: runtime.fetch, port });
        metadata.services.push({
          name: service.name,
          port,
          url: baseUrl,
          source: service.source,
          inspectorUrl: runtime.inspectorUrl,
        });
      }
    }
    signal?.throwIfAborted();
    metadata.dependencies = [...config.loader.dependencies];
    return {
      metadata,
      close,
      watchDependencies(listener: (files: string[]) => void) {
        config.loader.onDependenciesChange = listener;
      },
      async start() {
        try {
          for (const item of prepared) {
            if (closed) throw new Error("Project closed during startup");
            const server = serve({
              ...item,
              hostname: options.host,
              fetch: (request) =>
                accepting ? item.fetch(request) : Response.json({ error: "Starting" }, { status: 503 }),
            });
            servers.push(server);
            try {
              await waitForListening(server);
            } catch (error) {
              const service = metadata.services.find((service) => service.port === item.port)!;
              throw new Error(
                `Cannot listen for ${service.name} on port ${item.port}: ${error instanceof Error ? error.message : error}`,
                { cause: error },
              );
            }
          }
          for (const activate of activations) {
            if (closed) throw new Error("Project closed during startup");
            await activate();
          }
          if (closed) throw new Error("Project closed during startup");
          accepting = true;
        } catch (error) {
          await close().catch((cleanup) => console.error(cleanup));
          throw error;
        }
      },
    };
  } catch (error) {
    await close().catch((cleanup) => {
      throw new AggregateError([error, cleanup], `${error instanceof Error ? error.message : error}; cleanup failed`);
    });
    throw error;
  }
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal, cleanup?: (value: T) => void): Promise<T> {
  if (!signal) return promise;
  let abort!: () => void;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } catch (error) {
    if (signal.aborted && cleanup) void promise.then(cleanup, () => {}).catch((error) => console.error(error));
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function toTokens(config: LoadedConfig): Record<string, { login: string; id: number; scopes?: string[] }> {
  if (!config.tokens)
    return { test_token_admin: { login: "admin", id: 2, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] } };
  return Object.fromEntries(
    Object.entries(config.tokens).map(([token, user], index) => [token, { ...user, id: index + 100 }]),
  );
}
