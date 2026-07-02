import { createRequire } from "node:module";
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
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

export interface NuxtAdapterOptions {
  /**
   * Named catch-all route param from `server/routes/emulate/[...path].ts`.
   */
  param?: string;
  /**
   * Explicit mount path. Usually detected from the request URL.
   */
  routePrefix?: string;
}

type HeaderValue = string | string[] | number | undefined;

interface NodeRequestLike {
  method?: string;
  url?: string;
  headers?: Record<string, HeaderValue>;
}

export interface NuxtEventLike {
  req?: Request;
  node?: {
    req?: NodeRequestLike;
  };
  context?: {
    params?: Record<string, unknown>;
    path?: string;
  };
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

function normalizeRoutePrefix(prefix: string): string {
  const withLeadingSlash = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return withLeadingSlash.replace(/\/+$/, "") || "/";
}

function joinPath(base: string, segment: string): string {
  return base === "/" ? `/${segment}` : `${base}/${segment}`;
}

function detectPrefix(url: string, pathSegments: string[]): string {
  const parsed = new URL(url);
  const fullPath = parsed.pathname;
  const restPath = "/" + pathSegments.join("/");
  const idx = fullPath.lastIndexOf(restPath);
  if (idx >= 0) {
    return fullPath.slice(0, idx) || "/";
  }
  throw new Error(`Could not detect mount path from URL: ${url}`);
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function getPathSegments(event: NuxtEventLike, paramName: string, routePrefix?: string): string[] {
  const params = event.context?.params ?? {};
  const value = params[paramName] ?? params._ ?? params.path;

  if (Array.isArray(value)) {
    return value.flatMap((part) => splitPath(String(part)));
  }
  if (typeof value === "string" && value.length > 0) {
    return splitPath(value);
  }

  if (routePrefix && event.context?.path) {
    const prefix = normalizeRoutePrefix(routePrefix);
    const path = event.context.path.startsWith(prefix) ? event.context.path.slice(prefix.length) : event.context.path;
    return splitPath(path);
  }

  return [];
}

function firstHeader(value: HeaderValue): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  return String(raw).split(",")[0]?.trim();
}

function headersFromNode(headers: Record<string, HeaderValue> | undefined): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item);
      }
      continue;
    }
    result.set(key, String(value));
  }
  return result;
}

function isWebRequest(value: unknown): value is Request {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Request;
  return (
    typeof candidate.url === "string" &&
    typeof candidate.method === "string" &&
    typeof candidate.headers?.get === "function"
  );
}

function requestFromEvent(event: NuxtEventLike): Request {
  if (isWebRequest(event.req)) {
    return event.req;
  }

  const nodeReq = event.node?.req;
  if (!nodeReq) {
    throw new Error("Nuxt event must provide `req` or `node.req`");
  }

  const headers = nodeReq.headers ?? {};
  const proto = firstHeader(headers["x-forwarded-proto"]) ?? "http";
  const host = firstHeader(headers["x-forwarded-host"]) ?? firstHeader(headers.host) ?? "localhost";
  const url = new URL(nodeReq.url ?? "/", `${proto}://${host}`);
  const method = nodeReq.method ?? "GET";
  const init: RequestInit & { duplex?: string } = {
    method,
    headers: headersFromNode(headers),
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = nodeReq as unknown as RequestInit["body"];
    init.duplex = "half";
  }

  return new Request(url, init);
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

export function createEmulateHandler(config: EmulateHandlerConfig, options: NuxtAdapterOptions = {}) {
  const { services: serviceEntries, persistence } = config;
  const paramName = options.param ?? "path";
  const configuredMountPath = options.routePrefix ? normalizeRoutePrefix(options.routePrefix) : null;

  let apps: Map<string, ServiceApp> | null = null;
  let mountPath: string | null = configuredMountPath;
  let initPromise: Promise<void> | null = null;
  let pendingSave: Promise<void> = Promise.resolve();

  function enqueueSave(targetApps: Map<string, ServiceApp> | null = apps): void {
    if (!persistence || !targetApps) return;
    pendingSave = pendingSave.then(async () => {
      const snapshot = takeSnapshot(targetApps);
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
      const servicePrefix = joinPath(mountPath, name);
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
          // Corrupted data, fall through to seeding.
        }
      }
    }

    if (!restored) {
      for (const [name, entry] of Object.entries(serviceEntries)) {
        const sa = serviceApps.get(name)!;
        const servicePrefix = joinPath(mountPath, name);
        const baseUrl = `${origin}${servicePrefix}`;
        sa.plugin.seed?.(sa.store, baseUrl);
        if (entry.seed && entry.emulator.seedFromConfig) {
          entry.emulator.seedFromConfig(sa.store, baseUrl, entry.seed, sa.webhooks);
        }
      }
      if (persistence) {
        enqueueSave(serviceApps);
      }
    }

    return serviceApps;
  }

  async function ensureInit(req: Request, pathSegments: string[]): Promise<Map<string, ServiceApp>> {
    if (apps) return apps;
    if (!initPromise) {
      const url = new URL(req.url);
      const origin = url.origin;
      mountPath = configuredMountPath ?? detectPrefix(req.url, pathSegments);
      initPromise = initApps(origin, mountPath).then((result) => {
        apps = result;
      });
    }
    await initPromise;
    return apps!;
  }

  return async function emulateNuxtHandler(event: NuxtEventLike): Promise<Response> {
    const req = requestFromEvent(event);
    const pathSegments = getPathSegments(event, paramName, configuredMountPath ?? undefined);

    if (pathSegments.length === 0) {
      return new Response("Not found", { status: 404 });
    }

    const serviceApps = await ensureInit(req, pathSegments);

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

    const servicePrefix = joinPath(mountPath!, serviceName);
    response = await rewriteResponse(response, servicePrefix);

    if (persistence && MUTATING_METHODS.has(req.method)) {
      enqueueSave();
    }

    return response;
  };
}

interface NitroInstanceLike {
  options?: { output?: { serverDir?: string } };
}

/**
 * Copy the `@emulators/core` UI fonts into the built server output.
 *
 * The emulator UI reads its fonts with `readFileSync(join(__dirname, "fonts", …))`.
 * In a Nitro build `__dirname` resolves to the server output root, so the font
 * files must exist at `<serverDir>/fonts/`. Nitro's tracing does not place them
 * there, so we copy them explicitly once the build is written.
 */
function copyCoreFonts(nitro: NitroInstanceLike): void {
  const serverDir = nitro.options?.output?.serverDir;
  if (!serverDir) return;
  try {
    const require = createRequire(import.meta.url);
    const corePkg = require.resolve("@emulators/core/package.json");
    const fontsDir = join(dirname(corePkg), "dist", "fonts");
    cpSync(fontsDir, join(serverDir, "fonts"), { recursive: true });
  } catch (err) {
    debug("nuxt", "font copy failed: %o", err);
  }
}

export function withEmulate<T>(nuxtConfig: T): T {
  const config = nuxtConfig as Record<string, unknown>;
  const nitro = { ...((config.nitro as Record<string, unknown> | undefined) ?? {}) };
  const existingHooks = (nitro.hooks as Record<string, unknown> | undefined) ?? {};
  const prevCompiled = existingHooks.compiled as ((nitro: NitroInstanceLike) => unknown) | undefined;

  const compiled = async (nitroInstance: NitroInstanceLike) => {
    if (prevCompiled) await prevCompiled(nitroInstance);
    copyCoreFonts(nitroInstance);
  };

  return {
    ...config,
    nitro: {
      ...nitro,
      hooks: { ...existingHooks, compiled },
    },
  } as T;
}
