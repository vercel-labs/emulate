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
} from "@emulators/core";

export type { PersistenceAdapter } from "@emulators/core";

export interface EmulatorModule {
  plugin?: ServicePlugin;
  default?: ServicePlugin;
  seedFromConfig?(store: Store, baseUrl: string, config: unknown): void;
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

interface Fetchable {
  fetch(request: Request, ...rest: unknown[]): Response | Promise<Response>;
}

interface ServiceApp {
  hono: Fetchable;
  store: Store;
  tokenMap: TokenMap;
  plugin: ServicePlugin;
}

interface FullSnapshot {
  store: StoreSnapshot;
  tokens: Record<string, TokenEntry[]>;
}

type NextRequest = Request;
type NextResponse = Response;
type RouteHandler = (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<NextResponse>;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

async function rewriteResponse(response: Response, servicePrefix: string): Promise<Response> {
  const contentType = response.headers.get("Content-Type") ?? "";
  const location = response.headers.get("Location");
  const isHtml = contentType.includes("text/html");
  const locationChanged = location != null && location.startsWith("/");

  if (!isHtml) {
    if (!locationChanged) return response;
    const headers = new Headers(response.headers);
    headers.set("Location", servicePrefix + location);
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
  if (locationChanged) {
    headers.set("Location", servicePrefix + location);
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
      const { app, store, tokenMap } = createServer(plugin, {
        baseUrl,
        appKeyResolver: entry.emulator.createAppKeyResolver ? (appId) => appKeyResolver!(appId) : undefined,
      });

      if (entry.emulator.createAppKeyResolver) {
        appKeyResolver = entry.emulator.createAppKeyResolver(store);
      }

      serviceApps.set(name, { hono: app, store, tokenMap, plugin });
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
          entry.emulator.seedFromConfig(sa.store, baseUrl, entry.seed);
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

    let response = await sa.hono.fetch(strippedReq);

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
