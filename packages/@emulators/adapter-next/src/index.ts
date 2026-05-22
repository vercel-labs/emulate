import { createServer as createTcpServer } from "node:net";
import type { Emulator, SeedConfig, ServiceName } from "emulate";

export interface PersistenceAdapter {
  load(): string | null | Promise<string | null>;
  save(data: string): void | Promise<void>;
}

export interface EmulatorModule {
  serviceName?: string;
  name?: string;
  service?: {
    name?: string;
    runtime?: string;
  };
  plugin?: {
    name?: string;
    runtime?: string;
  };
  default?: {
    name?: string;
    runtime?: string;
  };
  [key: string]: unknown;
}

interface EmulatorEntry {
  emulator: EmulatorModule;
  seed?: Record<string, unknown>;
}

export interface EmulateHandlerConfig {
  services: Record<string, EmulatorEntry>;
  persistence?: PersistenceAdapter;
}

export type ProxyHeaders = Headers | Array<[string, string]> | Record<string, string>;

export type ProxyHeaderFactory = (
  request: Request,
  context: EmulateProxyContext,
) => ProxyHeaders | Promise<ProxyHeaders>;

export interface EmulateProxyTargetConfig {
  target: string | URL;
  pathPrefix?: string;
  stripServicePrefix?: boolean;
  headers?: ProxyHeaders | ProxyHeaderFactory;
}

export interface EmulateProxyConfig {
  target?: string | URL | EmulateProxyTargetConfig;
  targets?: Record<string, string | URL | EmulateProxyTargetConfig>;
  routePrefix?: string;
  headers?: ProxyHeaders | ProxyHeaderFactory;
}

export interface EmulateProxyContext {
  service?: string;
  mountPath: string;
  publicPrefix: string;
  target: URL;
  pathSegments: string[];
  forwardedPathSegments: string[];
}

type NextRequest = Request;
type NextResponse = Response;
type RouteHandler = (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<NextResponse>;

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface ResponseRewriteOptions {
  publicPrefix: string;
  upstreamPrefix?: string;
}

interface NativeHandlerRuntime {
  emulator?: Emulator;
  target: string;
}

const NATIVE_SERVICE_NAMES = [
  "vercel",
  "github",
  "google",
  "slack",
  "apple",
  "microsoft",
  "okta",
  "aws",
  "resend",
  "stripe",
  "mongoatlas",
  "clerk",
] as const satisfies readonly ServiceName[];

const nativeServiceSet = new Set<string>(NATIVE_SERVICE_NAMES);

export function createEmulateHandler(config: EmulateHandlerConfig) {
  if (config.persistence) {
    throw new Error(
      "createEmulateHandler persistence is not supported by the native compatibility facade. Use createEmulateProxy with a persistent native runtime instead.",
    );
  }

  const runtimes = new Map<string, Promise<NativeHandlerRuntime>>();

  async function ensureRuntime(
    serviceKey: string,
    entry: EmulatorEntry,
    publicBaseUrl: string,
  ): Promise<NativeHandlerRuntime> {
    const service = resolveNativeServiceName(serviceKey, entry.emulator);
    const externalTarget = configuredHandlerTarget(service, serviceKey);
    if (externalTarget) {
      return { target: externalTarget };
    }

    const existing = runtimes.get(serviceKey);
    if (existing) return existing;

    const created = startNativeHandlerRuntime(service, serviceKey, entry.seed, publicBaseUrl);
    runtimes.set(serviceKey, created);
    return created;
  }

  async function handleRequest(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
    const { path: pathSegments } = await ctx.params;
    if (pathSegments.length === 0) {
      return new Response("Not found", { status: 404 });
    }

    const serviceKey = pathSegments[0];
    const entry = config.services[serviceKey];
    if (!entry) {
      return new Response(`Unknown service: ${serviceKey}`, { status: 404 });
    }

    const requestUrl = new URL(req.url);
    const mountPath = detectPrefix(req.url, pathSegments);
    const publicPrefix = appendPath(mountPath, serviceKey);
    const publicBaseUrl = `${requestUrl.origin}${publicPrefix}`;
    const runtime = await ensureRuntime(serviceKey, entry, publicBaseUrl);
    const targetConfig: EmulateProxyTargetConfig = { target: runtime.target };
    const forwardedPathSegments = pathSegments.slice(1);
    const targetUrl = buildProxyUrl(targetConfig, forwardedPathSegments, requestUrl.search);
    const upstreamPrefix = buildProxyUpstreamPrefix(targetConfig);
    const context: EmulateProxyContext = {
      service: serviceKey,
      mountPath,
      publicPrefix,
      target: targetUrl,
      pathSegments,
      forwardedPathSegments,
    };
    const headers = await buildProxyHeaders(req, context, undefined, undefined);
    const proxyRequest = buildProxyRequest(req, targetUrl, headers);
    const response = await fetch(proxyRequest);
    return rewriteResponse(response, { publicPrefix, upstreamPrefix });
  }

  const handler: RouteHandler = handleRequest;

  return {
    GET: handler,
    HEAD: handler,
    POST: handler,
    PUT: handler,
    PATCH: handler,
    DELETE: handler,
    OPTIONS: handler,
  };
}

function resolveNativeServiceName(serviceKey: string, mod: EmulatorModule): ServiceName {
  const candidates = [mod.serviceName, mod.service?.name, mod.plugin?.name, mod.default?.name, mod.name, serviceKey];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && nativeServiceSet.has(candidate)) {
      return candidate as ServiceName;
    }
  }
  throw new Error(`Unsupported native emulator service: ${serviceKey}`);
}

function configuredHandlerTarget(service: ServiceName, serviceKey: string): string | undefined {
  const names = new Set([service, serviceKey]);
  for (const name of names) {
    const envKey = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const value = process.env[`EMULATE_${envKey}_URL`] ?? process.env[`EMULATE_${envKey}_TARGET_URL`];
    if (value) return value;
  }
  return process.env.EMULATE_TARGET_URL ?? process.env.EMULATE_URL;
}

function configuredHandlerPort(service: ServiceName, serviceKey: string): number | undefined {
  const names = new Set([service, serviceKey]);
  for (const name of names) {
    const envKey = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const value = process.env[`EMULATE_${envKey}_PORT`];
    if (value) return Number(value);
  }
  return process.env.EMULATE_PORT ? Number(process.env.EMULATE_PORT) : undefined;
}

async function startNativeHandlerRuntime(
  service: ServiceName,
  serviceKey: string,
  serviceSeed: Record<string, unknown> | undefined,
  publicBaseUrl: string,
): Promise<NativeHandlerRuntime> {
  const port = configuredHandlerPort(service, serviceKey) ?? (await allocatePort());
  const { createEmulator } = await loadEmulateApi();
  const seed = serviceSeed ? ({ [service]: serviceSeed } as SeedConfig) : undefined;
  const emulator = await createEmulator({
    service,
    port,
    seed,
    baseUrl: publicBaseUrl,
  });
  return {
    emulator,
    target: `http://127.0.0.1:${port}`,
  };
}

async function loadEmulateApi(): Promise<typeof import("emulate")> {
  const globalLoader = (globalThis as { __emulateCompatLoadEmulateApi?: () => Promise<typeof import("emulate")> })
    .__emulateCompatLoadEmulateApi;
  if (globalLoader) return globalLoader();
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<typeof import("emulate")>;
  return dynamicImport("emulate");
}

async function allocatePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Port allocation did not return a TCP address"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function detectPrefix(url: string, pathSegments: string[]): string {
  const parsed = new URL(url);
  const fullPath = parsed.pathname;
  const restPaths = ["/" + encodePathSegments(pathSegments).join("/"), "/" + pathSegments.join("/")];

  for (const restPath of new Set(restPaths)) {
    if (fullPath === restPath) {
      return "";
    }
    if (fullPath.endsWith(restPath)) {
      return fullPath.slice(0, fullPath.length - restPath.length);
    }
  }

  throw new Error(`Could not detect mount path from URL: ${url}`);
}

function detectProxyPrefix(url: string, pathSegments: string[]): string {
  if (pathSegments.length === 0) {
    return normalizeMountPath(new URL(url).pathname);
  }
  return detectPrefix(url, pathSegments);
}

function normalizeMountPath(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "";
}

function appendPath(prefix: string, segment: string): string {
  const mountPath = normalizeMountPath(prefix);
  const cleanedSegment = segment.replace(/^\/+|\/+$/g, "");
  if (!cleanedSegment) return mountPath || "/";
  return `${mountPath}/${cleanedSegment}`;
}

function splitPath(path: string | undefined): string[] {
  return path ? path.split("/").filter(Boolean) : [];
}

function encodePathSegments(pathSegments: string[]): string[] {
  return pathSegments.map((segment) => encodeURIComponent(segment));
}

function normalizeProxyTarget(input: string | URL | EmulateProxyTargetConfig): EmulateProxyTargetConfig {
  if (typeof input === "string" || input instanceof URL) {
    return { target: input };
  }
  return input;
}

function buildProxyUrl(targetConfig: EmulateProxyTargetConfig, forwardedPathSegments: string[], search: string): URL {
  const target = new URL(targetConfig.target.toString());
  const parts = [
    ...splitPath(target.pathname),
    ...splitPath(targetConfig.pathPrefix),
    ...encodePathSegments(forwardedPathSegments),
  ];
  target.pathname = parts.length > 0 ? `/${parts.join("/")}` : "/";
  target.search = search;
  return target;
}

function buildProxyUpstreamPrefix(targetConfig: EmulateProxyTargetConfig): string {
  const target = new URL(targetConfig.target.toString());
  const parts = [...splitPath(target.pathname), ...splitPath(targetConfig.pathPrefix)];
  if (parts.length === 0) return "";
  target.pathname = `/${parts.join("/")}`;
  return normalizeMountPath(target.pathname);
}

function copyForwardHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  const connection = headers.get("connection");
  if (connection) {
    for (const token of connection.split(",")) {
      headers.delete(token.trim());
    }
  }
  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }
  headers.set("accept-encoding", "identity");
  return headers;
}

function getForwardedPort(url: URL, request: Request): string | null {
  const existing = request.headers.get("x-forwarded-port");
  if (existing) return existing;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const portMatch = host.match(/:(\d+)$/);
  return portMatch?.[1] ?? (url.port || null);
}

async function applyProxyHeaders(
  headers: Headers,
  input: ProxyHeaders | ProxyHeaderFactory | undefined,
  request: Request,
  context: EmulateProxyContext,
): Promise<void> {
  if (!input) return;
  const resolved = typeof input === "function" ? await input(request, context) : input;
  new Headers(resolved).forEach((value, key) => headers.set(key, value));
}

async function buildProxyHeaders(
  request: Request,
  context: EmulateProxyContext,
  configHeaders: ProxyHeaders | ProxyHeaderFactory | undefined,
  targetHeaders: ProxyHeaders | ProxyHeaderFactory | undefined,
): Promise<Headers> {
  const headers = copyForwardHeaders(request);
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  const forwardedPort = getForwardedPort(url, request);

  headers.set("x-forwarded-host", forwardedHost);
  headers.set("x-forwarded-proto", forwardedProto);
  headers.set("x-forwarded-prefix", context.publicPrefix);
  headers.set("x-emulate-proxy", "next");
  headers.set("x-emulate-original-path", url.pathname);
  if (forwardedPort) {
    headers.set("x-forwarded-port", forwardedPort);
  }
  if (context.service) {
    headers.set("x-emulate-service", context.service);
  }

  await applyProxyHeaders(headers, configHeaders, request, context);
  await applyProxyHeaders(headers, targetHeaders, request, context);
  return headers;
}

function buildProxyRequest(request: Request, target: URL, headers: Headers): Request {
  const init: RequestInit & { duplex?: string } = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (!BODYLESS_METHODS.has(request.method)) {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(target.toString(), init);
}

function hasPathPrefix(path: string, prefix: string): boolean {
  return (
    path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`) || path.startsWith(`${prefix}#`)
  );
}

function prefixRootPath(prefix: string, path: string): string {
  const normalizedPrefix = normalizeMountPath(prefix);
  if (!normalizedPrefix) return path || "/";
  if (!path || path === "/") return normalizedPrefix;
  if (path.startsWith("?") || path.startsWith("#")) return `${normalizedPrefix}${path}`;
  return `${normalizedPrefix}${path.startsWith("/") ? path : `/${path}`}`;
}

function rewriteRootPath(path: string, options: ResponseRewriteOptions): string {
  const publicPrefix = normalizeMountPath(options.publicPrefix);
  const upstreamPrefix = normalizeMountPath(options.upstreamPrefix ?? "");

  if (publicPrefix && hasPathPrefix(path, publicPrefix)) {
    return path;
  }

  if (upstreamPrefix && hasPathPrefix(path, upstreamPrefix)) {
    return prefixRootPath(publicPrefix, path.slice(upstreamPrefix.length));
  }

  return prefixRootPath(publicPrefix, path);
}

async function rewriteResponse(response: Response, options: ResponseRewriteOptions): Promise<Response> {
  const contentType = response.headers.get("Content-Type") ?? "";
  const location = response.headers.get("Location");
  const isHtml = contentType.includes("text/html");
  const locationChanged = location != null && location.startsWith("/");
  const rewrittenLocation = locationChanged ? rewriteRootPath(location, options) : location;

  if (!isHtml) {
    if (!locationChanged || rewrittenLocation === location) return response;
    const headers = new Headers(response.headers);
    headers.set("Location", rewrittenLocation!);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  let html = await response.text();

  html = html.replace(/(action|href)="(\/[^"]*?)"/g, (_match, attr, path) => {
    return `${attr}="${rewriteRootPath(path, options)}"`;
  });

  html = html.replace(/url\('(\/[^']*?)'\)/g, (_match, path) => {
    return `url('${rewriteRootPath(path, options)}')`;
  });

  const headers = new Headers(response.headers);
  if (locationChanged && rewrittenLocation !== location) {
    headers.set("Location", rewrittenLocation!);
  }
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createEmulateProxy(config: EmulateProxyConfig) {
  const singleTarget = config.target ? normalizeProxyTarget(config.target) : undefined;
  const serviceTargets = config.targets
    ? new Map(Object.entries(config.targets).map(([name, target]) => [name, normalizeProxyTarget(target)]))
    : undefined;

  if (singleTarget && serviceTargets) {
    throw new Error("createEmulateProxy accepts either `target` or `targets`, not both");
  }
  if (!singleTarget && !serviceTargets) {
    throw new Error("createEmulateProxy requires `target` or `targets`");
  }

  async function handleRequest(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
    const { path: pathSegments } = await ctx.params;
    const url = new URL(req.url);
    const mountPath =
      config.routePrefix != null ? normalizeMountPath(config.routePrefix) : detectProxyPrefix(req.url, pathSegments);

    let service: string | undefined;
    let targetConfig: EmulateProxyTargetConfig;
    let forwardedPathSegments: string[];
    let publicPrefix: string;

    if (singleTarget) {
      targetConfig = singleTarget;
      forwardedPathSegments = pathSegments;
      publicPrefix = mountPath;
    } else {
      if (pathSegments.length === 0) {
        return new Response("Not found", { status: 404 });
      }
      service = pathSegments[0];
      const target = serviceTargets!.get(service);
      if (!target) {
        return new Response(`Unknown service: ${service}`, { status: 404 });
      }
      targetConfig = target;
      const stripServicePrefix = targetConfig.stripServicePrefix ?? true;
      forwardedPathSegments = stripServicePrefix ? pathSegments.slice(1) : pathSegments;
      publicPrefix = stripServicePrefix ? appendPath(mountPath, service) : mountPath;
    }

    const targetUrl = buildProxyUrl(targetConfig, forwardedPathSegments, url.search);
    const upstreamPrefix = buildProxyUpstreamPrefix(targetConfig);
    const context: EmulateProxyContext = {
      service,
      mountPath,
      publicPrefix,
      target: targetUrl,
      pathSegments,
      forwardedPathSegments,
    };
    const headers = await buildProxyHeaders(req, context, config.headers, targetConfig.headers);
    const proxyRequest = buildProxyRequest(req, targetUrl, headers);
    const response = await fetch(proxyRequest);
    return rewriteResponse(response, { publicPrefix, upstreamPrefix });
  }

  const handler: RouteHandler = handleRequest;

  return {
    GET: handler,
    HEAD: handler,
    POST: handler,
    PUT: handler,
    PATCH: handler,
    DELETE: handler,
    OPTIONS: handler,
  };
}

export function withEmulate<T>(nextConfig: T, _options?: { routePrefix?: string }): T {
  return nextConfig;
}
