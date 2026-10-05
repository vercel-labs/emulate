import { http, type HttpHandler } from "msw";
import {
  createEmulator,
  findServiceHost,
  getServiceHosts,
  hostPatternSource,
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
  /** Request handlers to pass to `setupServer` or `server.use`. */
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
  const pattern = new RegExp(
    `^https?://(?:${hosts.map((entry) => hostPatternSource(entry.host)).join("|")})(?::\\d+)?(?:/|$)`,
    "i",
  );
  const origin = new URL(emulator.url).origin;

  return http.all(pattern, async ({ request }) => {
    const path = toEmulatorPath(hosts, new URL(request.url));
    if (path === undefined) return undefined;
    return withContentLength(await emulator.fetch(await toEmulatorRequest(request, new URL(path, origin))));
  });
}

/**
 * Buffers bodies that lack a Content-Length. Some Node HTTP clients, such as
 * axios over a keep-alive agent, never finish reading a mocked response
 * without one. Event streams stay streamed.
 */
async function withContentLength(response: Response): Promise<Response> {
  if (!response.body || response.headers.has("content-length")) return response;
  if (response.headers.get("content-type")?.includes("text/event-stream")) return response;
  const body = await response.arrayBuffer();
  const headers = new Headers(response.headers);
  headers.set("content-length", String(body.byteLength));
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
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
