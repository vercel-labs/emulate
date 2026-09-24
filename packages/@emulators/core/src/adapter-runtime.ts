import { debug } from "./debug.js";
import {
  restoreTokenMap,
  serializeTokenMap,
  type AppKeyResolver,
  type TokenEntry,
  type TokenMap,
} from "./middleware/auth.js";
import type { ServicePlugin } from "./plugin.js";
import { createServer } from "./server.js";
import type { Store, StoreSnapshot } from "./store.js";
import type { WebhookDispatcher } from "./webhooks.js";
import type { PersistenceAdapter } from "./persistence.js";
import {
  createCustomRuntime,
  isEmulatorDefinition,
  type EmulatorDefinition,
  type CustomRuntime,
  type EmulatorSnapshot,
} from "./custom.js";
import type { InspectorOptions } from "./custom-inspector.js";
import { Store as CustomStore } from "./store.js";
import { WebhookDispatcher as CustomWebhooks } from "./webhooks.js";
export interface AdapterEmulatorModule {
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
export interface AdapterEmulatorEntry {
  emulator: AdapterEmulatorModule | EmulatorDefinition;
  seed?: Record<string, unknown>;
  inspector?: boolean | InspectorOptions;
  persistence?: PersistenceAdapter;
}
export interface AdapterHandlerConfig {
  services: Record<string, AdapterEmulatorEntry>;
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
  custom?: CustomRuntime;
}
interface FullSnapshot {
  store: StoreSnapshot;
  tokens: Record<string, TokenEntry[]>;
  generatedSecrets?: GeneratedSecret[];
  seeded?: boolean;
  custom?: Record<string, EmulatorSnapshot>;
}
interface PreparedState {
  snapshot: FullSnapshot | null;
  seeds: Map<string, Record<string, unknown> | undefined>;
  generatedSecrets: readonly GeneratedSecret[];
}
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isGeneratedSecret = (value: unknown): value is GeneratedSecret =>
  isRecord(value) && [value.service, value.kind, value.id, value.label, value.value].every(isNonEmptyString);
const secretIdentity = ({ service, kind, id, value }: GeneratedSecret) => JSON.stringify([service, kind, id, value]);
function isFullSnapshot(value: unknown): value is FullSnapshot {
  if (!isRecord(value) || !isRecord(value.store)) return false;
  return (
    isRecord(value.store.collections) &&
    isRecord(value.store.data) &&
    isRecord(value.tokens) &&
    Object.values(value.tokens).every(Array.isArray) &&
    (value.seeded === undefined || typeof value.seeded === "boolean") &&
    (value.custom === undefined || isRecord(value.custom)) &&
    (value.generatedSecrets === undefined ||
      (Array.isArray(value.generatedSecrets) && value.generatedSecrets.every(isGeneratedSecret)))
  );
}
function parseSnapshot(raw: string, message = "invalid snapshot"): FullSnapshot {
  const snapshot = JSON.parse(raw) as unknown;
  if (!isFullSnapshot(snapshot)) throw new Error(message);
  return snapshot;
}
function freezeSecrets(snapshot: FullSnapshot): readonly GeneratedSecret[] {
  return Object.freeze((snapshot.generatedSecrets ?? []).map((secret) => Object.freeze({ ...secret })));
}
function resolvePlugin(mod: AdapterEmulatorModule): ServicePlugin {
  const plugin = mod.plugin ?? mod.default;
  if (!plugin) throw new Error("Emulator module must export `plugin` or a default export implementing ServicePlugin");
  return plugin;
}
function takeSnapshot(apps: Map<string, ServiceApp>, generatedSecrets: readonly GeneratedSecret[]): FullSnapshot {
  const mergedStore: StoreSnapshot = { collections: {}, data: {} };
  const tokens: Record<string, TokenEntry[]> = {};
  const custom: Record<string, EmulatorSnapshot> = {};
  for (const [name, service] of apps) {
    if (service.custom) {
      custom[name] = service.custom.snapshot();
      continue;
    }
    const snapshot = service.store.snapshot();
    for (const [collection, value] of Object.entries(snapshot.collections)) {
      mergedStore.collections[`${name}:${collection}`] = value;
    }
    for (const [key, value] of Object.entries(snapshot.data)) mergedStore.data[`${name}:${key}`] = value;
    tokens[name] = serializeTokenMap(service.tokenMap);
  }
  return {
    store: mergedStore,
    tokens,
    generatedSecrets: [...generatedSecrets],
    seeded: true,
    ...(Object.keys(custom).length ? { custom } : {}),
  };
}
function restoreFromSnapshot(apps: Map<string, ServiceApp>, snapshot: FullSnapshot): void {
  const stores = new Map<string, StoreSnapshot>();
  for (const [qualifiedName, value] of Object.entries(snapshot.store.collections)) {
    const separator = qualifiedName.indexOf(":");
    const name = qualifiedName.slice(0, separator);
    const collection = qualifiedName.slice(separator + 1);
    if (!stores.has(name)) stores.set(name, { collections: {}, data: {} });
    stores.get(name)!.collections[collection] = value;
  }
  for (const [qualifiedKey, value] of Object.entries(snapshot.store.data)) {
    const separator = qualifiedKey.indexOf(":");
    const name = qualifiedKey.slice(0, separator);
    const key = qualifiedKey.slice(separator + 1);
    if (!stores.has(name)) stores.set(name, { collections: {}, data: {} });
    stores.get(name)!.data[key] = value;
  }
  for (const [name, service] of apps) {
    if (service.custom) continue;
    const storeSnapshot = stores.get(name);
    if (storeSnapshot) service.store.restore(storeSnapshot);
    restoreTokenMap(service.tokenMap, snapshot.tokens[name] ?? []);
  }
}
function prefixedLocation(location: string | null, servicePrefix: string): string | undefined {
  if (!location?.startsWith("/") || location.startsWith("//")) return undefined;
  if (
    location === servicePrefix ||
    location.startsWith(`${servicePrefix}/`) ||
    location.startsWith(`${servicePrefix}?`) ||
    location.startsWith(`${servicePrefix}#`)
  )
    return undefined;
  return servicePrefix + location;
}

async function rewriteResponse(response: Response, servicePrefix: string, rewriteHtml: boolean): Promise<Response> {
  const contentType = response.headers.get("Content-Type") ?? "";
  const location = prefixedLocation(response.headers.get("Location"), servicePrefix);
  if (!rewriteHtml || !contentType.includes("text/html")) {
    if (!location) return response;
    const headers = new Headers(response.headers);
    headers.set("Location", location);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  let html = await response.text();
  html = html.replace(/(action|href)="(\/[^\"]*?)"/g, (_match, attr, path) =>
    path.startsWith(servicePrefix) ? `${attr}="${path}"` : `${attr}="${servicePrefix}${path}"`,
  );
  html = html.replace(/url\('(\/[^']*?)'\)/g, (_match, path) =>
    path.startsWith(servicePrefix) ? `url('${path}')` : `url('${servicePrefix}${path}')`,
  );
  const headers = new Headers(response.headers);
  if (location) headers.set("Location", location);
  headers.delete("Content-Length");
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}
export function createAdapterRuntime(
  config: AdapterHandlerConfig,
  servicePath: (mountPath: string, service: string) => string,
) {
  const { services: serviceEntries, persistence } = config;
  let apps: Map<string, ServiceApp> | null = null;
  let initPromise: Promise<void> | null = null;
  let preparationPromise: Promise<PreparedState> | null = null;
  let pendingSave: Promise<void> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<Response>>();
  const hasCustom = Object.values(serviceEntries).some((entry) => isEmulatorDefinition(entry.emulator));
  if (persistence && Object.values(serviceEntries).some((entry) => entry.persistence))
    throw new Error("Choose either shared persistence or per-service persistence, not both");
  const needsDurableGeneratedIdentity = Object.values(serviceEntries).some(
    (entry) =>
      !isEmulatorDefinition(entry.emulator) && entry.seed && entry.emulator.needsGeneratedSecrets?.(entry.seed),
  );
  async function prepareFreshState(restoredSecrets: readonly GeneratedSecret[] = [], strict = false) {
    const seeds = new Map<string, Record<string, unknown> | undefined>();
    const generatedSecrets: GeneratedSecret[] = [];
    for (const [name, entry] of Object.entries(serviceEntries)) {
      if (!isEmulatorDefinition(entry.emulator) && entry.seed && entry.emulator.prepareSeed) {
        const serviceSecrets = restoredSecrets
          .filter((secret) => secret.service === name)
          .map(({ service: _service, ...secret }) => secret);
        const prepared = await entry.emulator.prepareSeed(entry.seed, serviceSecrets);
        seeds.set(name, prepared.config);
        generatedSecrets.push(...prepared.generatedSecrets.map((secret) => ({ service: name, ...secret })));
      } else seeds.set(name, entry.seed);
    }
    const restoredIdentities = new Set(restoredSecrets.map(secretIdentity));
    if (strict && generatedSecrets.some((secret) => !restoredIdentities.has(secretIdentity(secret)))) {
      throw new Error("Cannot initialize emulator state without replacing generated identities");
    }
    return {
      snapshot: null,
      seeds,
      generatedSecrets: Object.freeze(generatedSecrets.map((secret) => Object.freeze(secret))),
    };
  }
  function getPreparation(): Promise<PreparedState> {
    if (!preparationPromise) {
      const preparation = (async () => {
        if (persistence) {
          const raw = await persistence.load();
          if (raw !== null && (raw !== "" || hasCustom)) {
            try {
              const snapshot = parseSnapshot(raw);
              const generatedSecrets = freezeSecrets(snapshot);
              if (snapshot.seeded === false) return { ...(await prepareFreshState(generatedSecrets, true)), snapshot };
              return { snapshot, seeds: new Map(), generatedSecrets };
            } catch (error) {
              if (hasCustom)
                throw new Error(
                  "Cannot restore persisted custom emulator state. Repair or remove the saved snapshot.",
                  { cause: error },
                );
              if (needsDurableGeneratedIdentity) {
                throw new Error("Cannot restore persisted emulator state without replacing generated identities", {
                  cause: error,
                });
              }
            }
          }
        }
        const fresh = await prepareFreshState();
        if (fresh.generatedSecrets.length === 0 || !persistence) return fresh;
        if (!persistence.initialize) {
          throw new Error("Persistence adapter must implement initialize() for generated identities");
        }
        const canonical = parseSnapshot(
          await persistence.initialize(
            JSON.stringify({
              store: { collections: {}, data: {} },
              tokens: {},
              generatedSecrets: [...fresh.generatedSecrets],
              seeded: false,
            } satisfies FullSnapshot),
          ),
          "Persistence initialize() returned an invalid snapshot",
        );
        const generatedSecrets = freezeSecrets(canonical);
        if (canonical.seeded !== false) return { snapshot: canonical, seeds: new Map(), generatedSecrets };
        return { ...(await prepareFreshState(generatedSecrets, true)), snapshot: canonical };
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
        try {
          await persistence.save(JSON.stringify(takeSnapshot(targetApps, generatedSecrets)));
        } catch (error) {
          if (failClosed) throw error;
          debug("persistence", "save failed: %o", error);
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
          const snapshot = parseSnapshot(raw);
          if (snapshot.seeded !== false) {
            prepared = { snapshot, seeds: new Map(), generatedSecrets: freezeSecrets(snapshot) };
            preparationPromise = Promise.resolve(prepared);
          }
        } catch {
          throw new Error("Cannot restore persisted emulator state without replacing generated identities");
        }
      }
    }
    const serviceApps = new Map<string, ServiceApp>();
    try {
      for (const [name, entry] of Object.entries(serviceEntries)) {
        const baseUrl = `${origin}${servicePath(mountPath, name)}`;
        if (isEmulatorDefinition(entry.emulator)) {
          if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid custom instance name: ${name}`);
          const sharedCustomPersistence: PersistenceAdapter | undefined = persistence && {
            async load() {
              const saved = prepared.snapshot?.custom;
              return saved && Object.hasOwn(saved, name) ? JSON.stringify(saved[name]) : null;
            },
            async save() {
              // A shared snapshot needs every service, so initialization writes it after setup.
              if (apps) await enqueueSave(apps, prepared.generatedSecrets, true);
            },
          };
          const custom = await createCustomRuntime(entry.emulator, {
            baseUrl,
            seed: entry.seed,
            inspector: entry.inspector,
            persistence: entry.persistence ?? sharedCustomPersistence,
          });
          serviceApps.set(name, {
            app: custom,
            custom,
            store: new CustomStore(),
            tokenMap: new Map(),
            webhooks: new CustomWebhooks({ neutral: true }),
            plugin: { name, register() {} },
          });
          continue;
        }
        const plugin = resolvePlugin(entry.emulator);
        let appKeyResolver: AppKeyResolver | undefined;
        const server = createServer(plugin, {
          baseUrl,
          appKeyResolver: entry.emulator.createAppKeyResolver ? (appId) => appKeyResolver!(appId) : undefined,
        });
        if (entry.emulator.createAppKeyResolver) appKeyResolver = entry.emulator.createAppKeyResolver(server.store);
        serviceApps.set(name, { ...server, plugin });
      }
      let restored = prepared.snapshot !== null && prepared.snapshot.seeded !== false;
      if (restored && prepared.snapshot) {
        try {
          restoreFromSnapshot(serviceApps, prepared.snapshot);
        } catch {
          if (hasCustom || needsDurableGeneratedIdentity || prepared.generatedSecrets.length > 0) {
            throw new Error("Cannot restore persisted emulator state without replacing generated identities");
          }
          restored = false;
          prepared = await prepareFreshState();
        }
      }
      if (!restored) {
        for (const [name, entry] of Object.entries(serviceEntries)) {
          const service = serviceApps.get(name)!;
          const baseUrl = `${origin}${servicePath(mountPath, name)}`;
          service.plugin.seed?.(service.store, baseUrl);
          const seed = prepared.seeds.get(name);
          if (!isEmulatorDefinition(entry.emulator) && seed && entry.emulator.seedFromConfig) {
            entry.emulator.seedFromConfig(service.store, baseUrl, seed, service.webhooks);
          }
        }
        if (persistence)
          await enqueueSave(serviceApps, prepared.generatedSecrets, hasCustom || prepared.generatedSecrets.length > 0);
      }
      return serviceApps;
    } catch (error) {
      await Promise.allSettled([...serviceApps.values()].map((service) => service.custom?.close()));
      throw error;
    }
  }
  async function ensureInit(origin: string, mountPath: string): Promise<Map<string, ServiceApp>> {
    if (apps) return apps;
    if (!initPromise) {
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
  async function handle(req: Request, pathSegments: string[], mountPath: string): Promise<Response> {
    const serviceApps = await ensureInit(new URL(req.url).origin, mountPath);
    if (pathSegments.length === 0) return new Response("Not found", { status: 404 });
    const serviceName = pathSegments[0];
    const service = serviceApps.get(serviceName);
    if (!service) return new Response(`Unknown service: ${serviceName}`, { status: 404 });
    const url = new URL(req.url);
    const strippedUrl = new URL("/" + pathSegments.slice(1).join("/") + url.search, url.origin);
    const strippedReq = new Request(strippedUrl, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      duplex: "half",
      signal: req.signal,
    } as RequestInit & { duplex: string });
    const rawResponse = await service.app.fetch(strippedReq);
    const response = await rewriteResponse(rawResponse, servicePath(mountPath, serviceName), !service.custom);
    if (persistence && !service.custom && MUTATING_METHODS.has(req.method))
      enqueueSave(serviceApps, (await getPreparation()).generatedSecrets);
    return response;
  }
  return {
    handle(req: Request, pathSegments: string[], mountPath: string): Promise<Response> {
      if (closed) return Promise.resolve(new Response("Emulator is closed", { status: 503 }));
      const request = handle(req, pathSegments, mountPath);
      active.add(request);
      return request.finally(() => active.delete(request));
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => {
              await initPromise?.catch(() => {});
              const results = await Promise.allSettled(
                [...(apps?.values() ?? [])].map((service) => service.custom?.close()),
              );
              await Promise.allSettled([...active]);
              if (apps && hasCustom) await enqueueSave(apps, (await getPreparation()).generatedSecrets, true);
              else await pendingSave;
              for (const service of apps?.values() ?? []) service.webhooks.clear();
              const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
              if (errors.length)
                throw new AggregateError(
                  errors.map((result) => result.reason),
                  "Adapter cleanup failed",
                );
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Adapter shutdown exceeded 10000ms")), 10000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      })();
      return closing;
    },
    async generatedSecrets(): Promise<readonly GeneratedSecret[]> {
      return (await getPreparation()).generatedSecrets;
    },
  };
}
