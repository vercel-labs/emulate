import type { AnyHandler } from "msw";
import { http, type HttpHandler } from "msw/http";
import {
  defineNetwork,
  InterceptorSource,
  NetworkReadyState,
  type DefineNetworkOptions,
  type NetworkApi,
} from "msw/experimental";
import { HttpRequestInterceptor } from "@mswjs/interceptors/http";
import {
  createEmulator,
  findServiceHost,
  getServiceHosts,
  primaryHost,
  toEmulatorPath,
  type InProcessEmulator,
  type SeedConfig,
  type ServiceHost,
  type ServiceName,
} from "emulate";

export type { InProcessEmulator, ServiceHost, ServiceName } from "emulate";

export interface EmulatorServiceOptions {
  /** Seed data for this service, in the same shape as its section of `emulate.config.yaml`. */
  seed?: Record<string, unknown>;
  /**
   * Advertised base URL used in generated links, redirects, and issued URLs.
   * Defaults to the service's primary real host, such as `https://api.github.com`.
   * Must be a host the service serves without translation.
   */
  baseUrl?: string;
}

export interface EmulatorHandlersOptions<Name extends ServiceName> {
  /** Services to emulate. Pass `{}` or `true` to use defaults. */
  services: { [K in Name]: EmulatorServiceOptions | true };
  /** API tokens shared by every service, as in the `tokens` section of the seed config. */
  tokens?: SeedConfig["tokens"];
}

export interface EmulatorHandlers<Name extends ServiceName> {
  /** Request handlers to pass to `setupServer`, `defineNetwork`, or `server.use`. */
  readonly handlers: HttpHandler[];
  /** In-process emulators by service name, for direct requests and inspection. */
  readonly emulators: { readonly [K in Name]: InProcessEmulator };
  /** Reset every emulator to its seed. */
  reset(): void;
  /** Close every emulator. */
  close(): Promise<void>;
}

/**
 * Creates MSW request handlers that answer real provider URLs from stateful,
 * in-process emulators. Application code and SDKs keep their production URLs.
 *
 * @example
 * const emulators = await createEmulatorHandlers({ services: { github: {}, twilio: {} } });
 * const server = setupServer(...emulators.handlers);
 */
export async function createEmulatorHandlers<const Name extends ServiceName>(
  options: EmulatorHandlersOptions<Name>,
): Promise<EmulatorHandlers<Name>> {
  const names = Object.keys(options.services) as Name[];
  const created: Array<[Name, InProcessEmulator]> = [];
  const handlers: HttpHandler[] = [];
  try {
    for (const name of names) {
      const serviceOptions = options.services[name] === true ? {} : (options.services[name] as EmulatorServiceOptions);
      const emulator = await createServiceEmulator(name, serviceOptions, options.tokens);
      created.push([name, emulator]);
      handlers.push(createServiceHandler(name, emulator));
    }
  } catch (error) {
    await Promise.allSettled(created.map(([, emulator]) => emulator.close()));
    throw error;
  }

  const emulators = Object.freeze(Object.fromEntries(created)) as { readonly [K in Name]: InProcessEmulator };
  return {
    handlers,
    emulators,
    reset() {
      for (const [, emulator] of created) emulator.reset();
    },
    async close() {
      await Promise.all(created.map(([, emulator]) => emulator.close()));
    },
  };
}

type EmulatorNetworkApi = NetworkApi<[InterceptorSource]>;

export interface EmulatorNetworkOptions<Name extends ServiceName> extends EmulatorHandlersOptions<Name> {
  /** Handlers that run before the emulators, such as mocks for your own API. */
  handlers?: AnyHandler[];
  /** Strategy for requests that no handler or emulator serves. Defaults to `"warn"`, as in `setupServer`. */
  onUnhandledFrame?: DefineNetworkOptions<[InterceptorSource]>["onUnhandledFrame"];
}

export interface EmulatorNetwork<Name extends ServiceName> {
  /** The underlying MSW network, for events and advanced configuration. */
  readonly network: EmulatorNetworkApi;
  /** In-process emulators by service name, for direct requests and inspection. */
  readonly emulators: { readonly [K in Name]: InProcessEmulator };
  /** Start intercepting requests in this process. */
  enable(): Promise<void>;
  /** Prepend handlers, typically per-test failures layered over emulator state. */
  use(...handlers: AnyHandler[]): void;
  /** Remove handlers added with `use()` and reset every emulator to its seed. */
  reset(): void;
  /** Stop intercepting and close every emulator. */
  close(): Promise<void>;
}

/**
 * Creates an MSW network that intercepts every HTTP request in this process at
 * the socket level and answers real provider URLs from in-process emulators.
 * One object owns both lifecycles, so a single `reset()` clears per-test
 * overrides and emulator state.
 *
 * Built on MSW's experimental `defineNetwork` API, which may change in minor
 * MSW releases. Use `createEmulatorHandlers` with `setupServer` for the stable path.
 *
 * @experimental
 * @example
 * const emulate = await setupEmulatorNetwork({ services: { github: {}, twilio: {} } });
 * beforeAll(() => emulate.enable());
 * afterEach(() => emulate.reset());
 * afterAll(() => emulate.close());
 */
export async function setupEmulatorNetwork<const Name extends ServiceName>(
  options: EmulatorNetworkOptions<Name>,
): Promise<EmulatorNetwork<Name>> {
  const { handlers: ownHandlers = [], onUnhandledFrame = "warn", ...handlerOptions } = options;
  const emulators = await createEmulatorHandlers(handlerOptions);
  const network = defineNetwork({
    sources: [new InterceptorSource({ interceptors: [new HttpRequestInterceptor()] })],
    handlers: [...ownHandlers, ...emulators.handlers],
    onUnhandledFrame,
    context: { quiet: true },
  });

  return {
    network,
    emulators: emulators.emulators,
    async enable() {
      await network.enable();
    },
    use(...handlers) {
      network.use(...handlers);
    },
    reset() {
      network.resetHandlers();
      emulators.reset();
    },
    async close() {
      if (network.readyState === NetworkReadyState.ENABLED) await network.disable();
      await emulators.close();
    },
  };
}

async function createServiceEmulator(
  name: ServiceName,
  options: EmulatorServiceOptions,
  tokens: SeedConfig["tokens"],
): Promise<InProcessEmulator> {
  const primary = primaryHost(await getServiceHosts(name));
  const seed: SeedConfig = { ...(tokens ? { tokens } : {}), ...(options.seed ? { [name]: options.seed } : {}) };
  return createEmulator({
    service: name,
    listen: false,
    baseUrl: options.baseUrl ?? (primary ? `https://${primary}` : undefined),
    seed,
  });
}

/**
 * Returns the service's host table with its advertised origin mapped
 * unchanged, so URLs the emulator generates route back to the same paths.
 */
function routableHosts(name: ServiceName, emulator: InProcessEmulator): readonly ServiceHost[] {
  const advertised = new URL(emulator.url).hostname;
  const entry = findServiceHost(emulator.hosts, emulator.url);
  if (!entry) return [{ host: advertised }, ...emulator.hosts];
  if (entry.prefix || entry.toPath) {
    throw new Error(
      `The ${name} base URL ${emulator.url} is a translated host. Use a host the emulator serves unchanged, such as its primary host.`,
    );
  }
  return emulator.hosts;
}

function createServiceHandler(name: ServiceName, emulator: InProcessEmulator): HttpHandler {
  const hosts = routableHosts(name, emulator);
  const origin = new URL(emulator.url).origin;

  // The predicate translates the URL through the host table once and hands
  // the emulator path to the resolver, so unknown hosts never match.
  return http.all<{ path: string }>(
    ({ request }) => {
      const path = toEmulatorPath(hosts, request.url);
      return path === undefined ? false : { matches: true, params: { path } };
    },
    async ({ request, params }) => emulator.fetch(await toEmulatorRequest(request, new URL(params.path, origin))),
  );
}

async function toEmulatorRequest(request: Request, url: URL): Promise<Request> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: "manual",
    signal: request.signal,
  });
}
