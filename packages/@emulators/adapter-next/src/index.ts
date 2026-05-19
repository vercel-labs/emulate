import {
  createServer,
  debug,
  serializeTokenMap,
  restoreTokenMap,
  type ServicePlugin,
  type Store,
  type TokenMap,
  type TokenEntry,
  type StoreSnapshot,
  type PersistenceAdapter,
  type AppKeyResolver,
  type WebhookDispatcher,
} from "@emulators/core";

export type { PersistenceAdapter } from "@emulators/core";

export interface EmulatorModule {
  plugin?: ServicePlugin;
  default?: ServicePlugin;
  seedFromConfig?(store: Store, baseUrl: string, config: unknown, webhooks?: WebhookDispatcher): void;
  createAppKeyResolver?(store: Store): AppKeyResolver;
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

interface Fetchable {
  fetch(request: Request, ...rest: unknown[]): Response | Promise<Response>;
}

interface ServiceApp {
  app: Fetchable;
  store: Store;
  tokenMap: TokenMap;
  plugin: ServicePlugin;
  webhooks: WebhookDispatcher;
}

interface FullSnapshot {
  store: StoreSnapshot;
  tokens: Record<string, TokenEntry[]>;
}

type NextRequest = Request;
type NextResponse = Response;
type RouteHandler = (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<NextResponse>;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
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

function resolvePlugin(mod: EmulatorModule): ServicePlugin {
  const plugin = mod.plugin ?? mod.default;
  if (!plugin) {
    throw new Error("Emulator module must export `plugin` or a default export implementing ServicePlugin");
  }
  return plugin;
}

function takeSnapshot(apps: Map<string, ServiceApp>): FullSnapshot {
  const mergedStore: StoreSnapshot = { collections: {}, data: {} };
  const tokens: Record<string, TokenEntry[]> = {};

  for (const [name, sa] of apps) {
    const snap = sa.store.snapshot();
    for (const [colName, colSnap] of Object.entries(snap.collections)) {
      mergedStore.collections[`${name}:${colName}`] = colSnap;
    }
    for (const [key, val] of Object.entries(snap.data)) {
      mergedStore.data[`${name}:${key}`] = val;
    }
    tokens[name] = serializeTokenMap(sa.tokenMap);
  }

  return { store: mergedStore, tokens };
}

function restoreFromSnapshot(apps: Map<string, ServiceApp>, snapshot: FullSnapshot): void {
  const storesByName = new Map<string, StoreSnapshot>();
  for (const [qualifiedName, colSnap] of Object.entries(snapshot.store.collections)) {
    const sepIdx = qualifiedName.indexOf(":");
    const name = qualifiedName.slice(0, sepIdx);
    const colName = qualifiedName.slice(sepIdx + 1);
    if (!storesByName.has(name)) {
      storesByName.set(name, { collections: {}, data: {} });
    }
    storesByName.get(name)!.collections[colName] = colSnap;
  }
  for (const [qualifiedKey, val] of Object.entries(snapshot.store.data)) {
    const sepIdx = qualifiedKey.indexOf(":");
    const name = qualifiedKey.slice(0, sepIdx);
    const dataKey = qualifiedKey.slice(sepIdx + 1);
    if (!storesByName.has(name)) {
      storesByName.set(name, { collections: {}, data: {} });
    }
    storesByName.get(name)!.data[dataKey] = val;
  }

  for (const [name, sa] of apps) {
    const snap = storesByName.get(name);
    if (snap) {
      sa.store.restore(snap);
    }
    restoreTokenMap(sa.tokenMap, snapshot.tokens[name] ?? []);
  }
}

function detectPrefix(url: string, pathSegments: string[]): string {
  const parsed = new URL(url);
  const fullPath = parsed.pathname;
  const restPath = "/" + pathSegments.join("/");
  const idx = fullPath.lastIndexOf(restPath);
  if (idx > 0) {
    return fullPath.slice(0, idx);
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

async function rewriteResponse(response: Response, servicePrefix: string): Promise<Response> {
  const contentType = response.headers.get("Content-Type") ?? "";
  const location = response.headers.get("Location");
  const isHtml = contentType.includes("text/html");
  const locationChanged = location != null && location.startsWith("/");
  const rewrittenLocation =
    locationChanged && !location.startsWith(servicePrefix) ? servicePrefix + location : location;

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

  // Skip paths already carrying the service prefix to avoid double-prefixing
  // (e.g., redirects that already went through rewriting).
  html = html.replace(/(action|href)="(\/[^"]*?)"/g, (_match, attr, path) => {
    if (path.startsWith(servicePrefix)) return `${attr}="${path}"`;
    return `${attr}="${servicePrefix}${path}"`;
  });

  html = html.replace(/url\('(\/[^']*?)'\)/g, (_match, path) => {
    if (path.startsWith(servicePrefix)) return `url('${path}')`;
    return `url('${servicePrefix}${path}')`;
  });

  const headers = new Headers(response.headers);
  if (locationChanged && rewrittenLocation !== location) {
    headers.set("Location", rewrittenLocation!);
  }
  headers.delete("Content-Length");

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createEmulateHandler(config: EmulateHandlerConfig) {
  const { services: serviceEntries, persistence } = config;

  let apps: Map<string, ServiceApp> | null = null;
  let mountPath: string | null = null;
  let initPromise: Promise<void> | null = null;
  let pendingSave: Promise<void> = Promise.resolve();

  function enqueueSave(): void {
    if (!persistence || !apps) return;
    pendingSave = pendingSave.then(async () => {
      if (!apps) return;
      const snapshot = takeSnapshot(apps);
      const json = JSON.stringify(snapshot);
      try {
        await persistence.save(json);
      } catch (err) {
        debug("persistence", "save failed: %o", err);
      }
    });
  }

  async function initApps(origin: string, mountPath: string): Promise<Map<string, ServiceApp>> {
    const serviceApps = new Map<string, ServiceApp>();

    for (const [name, entry] of Object.entries(serviceEntries)) {
      const plugin = resolvePlugin(entry.emulator);
      const servicePrefix = `${mountPath}/${name}`;
      const baseUrl = `${origin}${servicePrefix}`;

      let appKeyResolver: AppKeyResolver | undefined;
      const { app, store, tokenMap, webhooks } = createServer(plugin, {
        baseUrl,
        appKeyResolver: entry.emulator.createAppKeyResolver ? (appId) => appKeyResolver!(appId) : undefined,
      });

      if (entry.emulator.createAppKeyResolver) {
        appKeyResolver = entry.emulator.createAppKeyResolver(store);
      }

      serviceApps.set(name, { app, store, tokenMap, plugin, webhooks });
    }

    let restored = false;
    if (persistence) {
      const raw = await persistence.load();
      if (raw) {
        try {
          const snapshot = JSON.parse(raw) as FullSnapshot;
          restoreFromSnapshot(serviceApps, snapshot);
          restored = true;
        } catch {
          // Corrupted data, fall through to seeding
        }
      }
    }

    if (!restored) {
      for (const [name, entry] of Object.entries(serviceEntries)) {
        const sa = serviceApps.get(name)!;
        const servicePrefix = `${mountPath}/${name}`;
        const baseUrl = `${origin}${servicePrefix}`;
        sa.plugin.seed?.(sa.store, baseUrl);
        if (entry.seed && entry.emulator.seedFromConfig) {
          entry.emulator.seedFromConfig(sa.store, baseUrl, entry.seed, sa.webhooks);
        }
      }
      if (persistence) {
        enqueueSave();
      }
    }

    return serviceApps;
  }

  async function ensureInit(req: Request, pathSegments: string[]): Promise<Map<string, ServiceApp>> {
    if (apps) return apps;
    if (!initPromise) {
      const url = new URL(req.url);
      const origin = url.origin;
      mountPath = detectPrefix(req.url, pathSegments);
      initPromise = initApps(origin, mountPath).then((result) => {
        apps = result;
      });
    }
    await initPromise;
    return apps!;
  }

  async function handleRequest(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
    const { path: pathSegments } = await ctx.params;
    const serviceApps = await ensureInit(req, pathSegments);

    if (pathSegments.length === 0) {
      return new Response("Not found", { status: 404 });
    }

    const serviceName = pathSegments[0];
    const sa = serviceApps.get(serviceName);
    if (!sa) {
      return new Response(`Unknown service: ${serviceName}`, { status: 404 });
    }

    const restPath = "/" + pathSegments.slice(1).join("/");
    const url = new URL(req.url);
    const strippedUrl = new URL(restPath + url.search, url.origin);

    const strippedReq = new Request(strippedUrl.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.body,
      duplex: "half",
    } as RequestInit & { duplex: string });

    let response = await sa.app.fetch(strippedReq);

    const servicePrefix = `${mountPath!}/${serviceName}`;
    response = await rewriteResponse(response, servicePrefix);

    if (persistence && MUTATING_METHODS.has(req.method)) {
      enqueueSave();
    }

    return response;
  }

  const handler: RouteHandler = handleRequest;

  return {
    GET: handler,
    POST: handler,
    PUT: handler,
    PATCH: handler,
    DELETE: handler,
  };
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
    return rewriteResponse(response, publicPrefix);
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

export function withEmulate<T>(nextConfig: T, options?: { routePrefix?: string }): T {
  const config = nextConfig as Record<string, unknown>;
  const prefix = options?.routePrefix ?? "/emulate";
  const routePattern = `${prefix}/**`;
  const fontGlob = "./node_modules/@emulators/core/dist/fonts/**";

  const topLevel = { ...((config.outputFileTracingIncludes as Record<string, string[]> | undefined) ?? {}) };
  const existing = topLevel[routePattern] ?? [];
  if (!existing.includes(fontGlob)) {
    topLevel[routePattern] = [...existing, fontGlob];
  }

  return { ...config, outputFileTracingIncludes: topLevel } as T;
}
