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
  prepareSeed?(
    config: Record<string, unknown>,
    generatedSecrets?: Array<Omit<GeneratedSecret, "service">>,
  ): Promise<PreparedServiceSeed>;
  needsGeneratedSecrets?(config: Record<string, unknown>): boolean;
}

export interface PreparedServiceSeed {
  config: Record<string, unknown>;
  generatedSecrets: Array<Omit<GeneratedSecret, "service">>;
}

export interface GeneratedSecret {
  readonly service: string;
  readonly kind: string;
  readonly id: string;
  readonly label: string;
  readonly value: string;
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
  app: Fetchable;
  store: Store;
  tokenMap: TokenMap;
  plugin: ServicePlugin;
  webhooks: WebhookDispatcher;
}

interface FullSnapshot {
  store: StoreSnapshot;
  tokens: Record<string, TokenEntry[]>;
  generatedSecrets?: GeneratedSecret[];
  seeded?: boolean;
}

interface PreparedState {
  snapshot: FullSnapshot | null;
  seeds: Map<string, Record<string, unknown> | undefined>;
  generatedSecrets: readonly GeneratedSecret[];
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

function takeSnapshot(apps: Map<string, ServiceApp>, generatedSecrets: readonly GeneratedSecret[]): FullSnapshot {
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

  return { store: mergedStore, tokens, generatedSecrets: [...generatedSecrets], seeded: true };
}

function isFullSnapshot(value: unknown): value is FullSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<FullSnapshot>;
  return Boolean(
    snapshot.store &&
    typeof snapshot.store === "object" &&
    snapshot.store.collections &&
    typeof snapshot.store.collections === "object" &&
    snapshot.store.data &&
    typeof snapshot.store.data === "object" &&
    snapshot.tokens &&
    typeof snapshot.tokens === "object" &&
    (snapshot.seeded === undefined || typeof snapshot.seeded === "boolean") &&
    (snapshot.generatedSecrets === undefined ||
      (Array.isArray(snapshot.generatedSecrets) && snapshot.generatedSecrets.every(isGeneratedSecret))),
  );
}

function isGeneratedSecret(value: unknown): value is GeneratedSecret {
  if (!value || typeof value !== "object") return false;
  const secret = value as Partial<GeneratedSecret>;
  return [secret.service, secret.kind, secret.id, secret.label, secret.value].every(
    (field) => typeof field === "string",
  );
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

  const needsDurableGeneratedIdentity = Object.values(serviceEntries).some(
    (entry) => entry.seed && entry.emulator.needsGeneratedSecrets?.(entry.seed),
  );

  async function prepareFreshState(restoredSecrets: readonly GeneratedSecret[] = []): Promise<PreparedState> {
    const seeds = new Map<string, Record<string, unknown> | undefined>();
    const generatedSecrets: GeneratedSecret[] = [];
    for (const [name, entry] of Object.entries(serviceEntries)) {
      if (entry.seed && entry.emulator.prepareSeed) {
        const serviceSecrets = restoredSecrets
          .filter((secret) => secret.service === name)
          .map(({ service: _service, ...secret }) => secret);
        const prepared = await entry.emulator.prepareSeed(entry.seed, serviceSecrets);
        seeds.set(name, prepared.config);
        generatedSecrets.push(...prepared.generatedSecrets.map((secret) => ({ service: name, ...secret })));
      } else {
        seeds.set(name, entry.seed);
      }
    }
    return {
      snapshot: null,
      seeds,
      generatedSecrets: Object.freeze(generatedSecrets.map((secret) => Object.freeze(secret))),
    };
  }

  let preparationPromise: Promise<PreparedState> | null = null;

  function getPreparation(): Promise<PreparedState> {
    if (!preparationPromise) {
      const preparation = (async () => {
        if (persistence) {
          const raw = await persistence.load();
          if (raw) {
            try {
              const snapshot = JSON.parse(raw) as unknown;
              if (!isFullSnapshot(snapshot)) throw new Error("invalid snapshot");
              const generatedSecrets = Object.freeze(
                (snapshot.generatedSecrets ?? []).map((secret) => Object.freeze({ ...secret })),
              );
              if (snapshot.seeded === false) {
                const fresh = await prepareFreshState(generatedSecrets);
                return { ...fresh, snapshot };
              }
              return { snapshot, seeds: new Map(), generatedSecrets };
            } catch {
              if (needsDurableGeneratedIdentity) {
                throw new Error("Cannot restore persisted emulator state without replacing generated identities");
              }
            }
          }
        }

        const fresh = await prepareFreshState();
        if (fresh.generatedSecrets.length === 0 || !persistence) return fresh;
        if (!persistence.initialize) {
          throw new Error("Persistence adapter must implement initialize() for generated identities");
        }
        const identitySnapshot: FullSnapshot = {
          store: { collections: {}, data: {} },
          tokens: {},
          generatedSecrets: [...fresh.generatedSecrets],
          seeded: false,
        };
        const canonicalRaw = await persistence.initialize(JSON.stringify(identitySnapshot));
        const canonical = JSON.parse(canonicalRaw) as unknown;
        if (!isFullSnapshot(canonical)) throw new Error("Persistence initialize() returned an invalid snapshot");
        const canonicalSecrets = Object.freeze(
          (canonical.generatedSecrets ?? []).map((secret) => Object.freeze({ ...secret })),
        );
        if (canonical.seeded !== false) {
          return { snapshot: canonical, seeds: new Map(), generatedSecrets: canonicalSecrets };
        }
        const canonicalFresh = await prepareFreshState(canonicalSecrets);
        return { ...canonicalFresh, snapshot: canonical };
      })();
      preparationPromise = preparation;
      void preparation.catch(() => {
        if (preparationPromise === preparation) preparationPromise = null;
      });
    }
    return preparationPromise;
  }

  function enqueueSave(
    targetApps: Map<string, ServiceApp> | null = apps,
    generatedSecrets: readonly GeneratedSecret[] = [],
    failClosed = false,
  ): Promise<void> {
    if (!persistence || !targetApps) return pendingSave;
    pendingSave = pendingSave
      .catch(() => {})
      .then(async () => {
        const snapshot = takeSnapshot(targetApps, generatedSecrets);
        const json = JSON.stringify(snapshot);
        try {
          await persistence.save(json);
        } catch (err) {
          if (failClosed) throw err;
          debug("persistence", "save failed: %o", err);
        }
      });
    return pendingSave;
  }

  async function initApps(origin: string, mountPath: string): Promise<Map<string, ServiceApp>> {
    let prepared = await getPreparation();
    if (persistence && prepared.snapshot?.seeded === false) {
      const raw = await persistence.load();
      if (raw) {
        try {
          const snapshot = JSON.parse(raw) as unknown;
          if (!isFullSnapshot(snapshot)) throw new Error("invalid snapshot");
          if (snapshot.seeded !== false) {
            prepared = {
              snapshot,
              seeds: new Map(),
              generatedSecrets: Object.freeze(
                (snapshot.generatedSecrets ?? []).map((secret) => Object.freeze({ ...secret })),
              ),
            };
            preparationPromise = Promise.resolve(prepared);
          }
        } catch {
          throw new Error("Cannot restore persisted emulator state without replacing generated identities");
        }
      }
    }
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

    let restored = prepared.snapshot !== null && prepared.snapshot.seeded !== false;
    if (restored && prepared.snapshot) {
      try {
        restoreFromSnapshot(serviceApps, prepared.snapshot);
      } catch {
        if (needsDurableGeneratedIdentity || prepared.generatedSecrets.length > 0) {
          throw new Error("Cannot restore persisted emulator state without replacing generated identities");
        }
        restored = false;
        prepared = await prepareFreshState();
      }
    }

    if (!restored) {
      for (const [name, entry] of Object.entries(serviceEntries)) {
        const sa = serviceApps.get(name)!;
        const servicePrefix = `${mountPath}/${name}`;
        const baseUrl = `${origin}${servicePrefix}`;
        sa.plugin.seed?.(sa.store, baseUrl);
        const seed = prepared.seeds.get(name);
        if (seed && entry.emulator.seedFromConfig) {
          entry.emulator.seedFromConfig(sa.store, baseUrl, seed, sa.webhooks);
        }
      }
      if (persistence) {
        await enqueueSave(serviceApps, prepared.generatedSecrets, prepared.generatedSecrets.length > 0);
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
      initPromise = initApps(origin, mountPath)
        .then((result) => {
          apps = result;
        })
        .catch((error) => {
          initPromise = null;
          throw error;
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
      const prepared = await getPreparation();
      enqueueSave(serviceApps, prepared.generatedSecrets);
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
    async generatedSecrets(): Promise<readonly GeneratedSecret[]> {
      return (await getPreparation()).generatedSecrets;
    },
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
