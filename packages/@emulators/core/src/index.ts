import { createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Emulator, SeedConfig, ServiceName } from "emulate";

export interface PersistenceAdapter {
  load(): string | null | Promise<string | null>;
  save(data: string): void | Promise<void>;
}

export function filePersistence(path: string): PersistenceAdapter {
  return {
    async load() {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return null;
        throw error;
      }
    },
    async save(data: string) {
      await writeFile(path, data);
    },
  };
}

export interface Entity {
  id: number;
  created_at: string;
  updated_at: string;
}

export type InsertInput<T extends Entity> = Omit<T, "id" | "created_at" | "updated_at"> & { id?: number };
export type FilterFn<T> = (item: T) => boolean;
export type SortFn<T> = (a: T, b: T) => number;

export interface QueryOptions<T> {
  filter?: FilterFn<T>;
  sort?: SortFn<T>;
  page?: number;
  per_page?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total_count: number;
  page: number;
  per_page: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface CollectionSnapshot<T extends Entity = Entity> {
  items: T[];
  autoId: number;
  indexFields: string[];
}

export interface StoreSnapshot {
  collections: Record<string, CollectionSnapshot>;
  data: Record<string, unknown>;
}

export function serializeValue(value: unknown): unknown {
  if (value instanceof Map) {
    return { __type: "Map" as const, entries: [...value.entries()].map(([key, val]) => [key, serializeValue(val)]) };
  }
  if (value instanceof Set) {
    return { __type: "Set" as const, values: [...value.values()] };
  }
  return value;
}

export function deserializeValue(value: unknown): unknown {
  if (value !== null && typeof value === "object" && "__type" in value) {
    const tagged = value as Record<string, unknown>;
    if (tagged.__type === "Map") {
      const entries = tagged.entries as [unknown, unknown][];
      return new Map(entries.map(([key, val]) => [key, deserializeValue(val)]));
    }
    if (tagged.__type === "Set") {
      return new Set(tagged.values as unknown[]);
    }
  }
  return value;
}

export class Collection<T extends Entity> {
  private items = new Map<number, T>();
  private autoId = 1;
  readonly fieldNames: string[];

  constructor(private indexFields: (keyof T)[] = []) {
    this.fieldNames = indexFields.map(String).sort();
  }

  insert(data: InsertInput<T>): T {
    const now = new Date().toISOString();
    const explicitId = data.id != null && data.id > 0 ? data.id : undefined;
    const id = explicitId ?? this.autoId++;
    if (id >= this.autoId) this.autoId = id + 1;
    const item = { ...data, id, created_at: now, updated_at: now } as unknown as T;
    this.items.set(id, item);
    return item;
  }

  get(id: number): T | undefined {
    return this.items.get(id);
  }

  findBy(field: keyof T, value: T[keyof T] | string | number): T[] {
    return this.all().filter((item) => item[field] === value);
  }

  findOneBy(field: keyof T, value: T[keyof T] | string | number): T | undefined {
    return this.findBy(field, value)[0];
  }

  update(id: number, data: Partial<T>): T | undefined {
    const existing = this.items.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...data, id, updated_at: new Date().toISOString() } as T;
    this.items.set(id, updated);
    return updated;
  }

  delete(id: number): boolean {
    return this.items.delete(id);
  }

  all(): T[] {
    return Array.from(this.items.values());
  }

  query(options: QueryOptions<T> = {}): PaginatedResult<T> {
    let results = this.all();
    if (options.filter) results = results.filter(options.filter);
    if (options.sort) results.sort(options.sort);
    const total_count = results.length;
    const page = options.page ?? 1;
    const per_page = Math.min(options.per_page ?? 30, 100);
    const start = (page - 1) * per_page;
    return {
      items: results.slice(start, start + per_page),
      total_count,
      page,
      per_page,
      has_next: start + per_page < total_count,
      has_prev: page > 1,
    };
  }

  count(filter?: FilterFn<T>): number {
    return filter ? this.all().filter(filter).length : this.items.size;
  }

  clear(): void {
    this.items.clear();
    this.autoId = 1;
  }

  snapshot(): CollectionSnapshot<T> {
    return { items: this.all(), autoId: this.autoId, indexFields: this.fieldNames };
  }

  restore(snap: CollectionSnapshot<T>): void {
    this.clear();
    this.autoId = snap.autoId;
    for (const item of snap.items) this.items.set(item.id, item);
  }
}

export class Store {
  private collections = new Map<string, Collection<Entity>>();
  private data = new Map<string, unknown>();

  collection<T extends Entity>(name: string, indexFields: (keyof T)[] = []): Collection<T> {
    const existing = this.collections.get(name);
    if (existing) {
      if (indexFields.length > 0) {
        const requested = indexFields.map(String).sort();
        if (
          existing.fieldNames.length !== requested.length ||
          existing.fieldNames.some((field, index) => field !== requested[index])
        ) {
          throw new Error(
            `Collection "${name}" already exists with indexes [${existing.fieldNames}] but was requested with [${requested}]`,
          );
        }
      }
      return existing as unknown as Collection<T>;
    }
    const collection = new Collection<T>(indexFields);
    this.collections.set(name, collection as unknown as Collection<Entity>);
    return collection;
  }

  getData<V>(key: string): V | undefined {
    return this.data.get(key) as V | undefined;
  }

  setData<V>(key: string, value: V): void {
    this.data.set(key, value);
  }

  reset(): void {
    for (const collection of this.collections.values()) collection.clear();
    this.data.clear();
  }

  snapshot(): StoreSnapshot {
    const collections: Record<string, CollectionSnapshot> = {};
    for (const [name, collection] of this.collections) collections[name] = collection.snapshot();
    const data: Record<string, unknown> = {};
    for (const [key, value] of this.data) data[key] = serializeValue(value);
    return { collections, data };
  }

  restore(snapshot: StoreSnapshot): void {
    const snapshotNames = new Set(Object.keys(snapshot.collections));
    for (const name of this.collections.keys()) {
      if (!snapshotNames.has(name)) {
        this.collections.delete(name);
      }
    }
    for (const [name, collectionSnapshot] of Object.entries(snapshot.collections)) {
      const collection = this.collection(name, collectionSnapshot.indexFields as (keyof Entity)[]);
      collection.restore(collectionSnapshot);
    }
    this.data.clear();
    for (const [key, value] of Object.entries(snapshot.data)) this.data.set(key, deserializeValue(value));
  }
}

type BodyInitCompat = ConstructorParameters<typeof Response>[0];
type HeadersInitCompat = ConstructorParameters<typeof Headers>[0];
type FormDataEntryValueCompat = string | File;
type VariablesOf<E> = unknown extends E
  ? Record<string, unknown>
  : E extends { Variables: infer V }
    ? V
    : Record<string, unknown>;

export type ContentfulStatusCode = number;
export type Next = () => Promise<void>;
export type Handler<E = unknown, P extends string = string> = (
  context: Context<E, P>,
  next: Next,
) => Response | Promise<Response> | void | Promise<void>;
export type MiddlewareHandler<E = unknown> = Handler<E>;
export type ErrorHandler<E = unknown> = (error: unknown, context: Context<E>) => Response | Promise<Response>;
export type FetchHandler = (request: Request, ...rest: unknown[]) => Response | Promise<Response>;

export interface CorsOptions {
  origin?: string | string[];
}

export interface ServeOptions {
  fetch?: FetchHandler;
  port?: number;
}

export class Context<E = unknown, P extends string = string> {
  req: HonoRequest<P>;
  private values = new Map<string, unknown>();
  private responseHeaders = new Headers();
  private responseStatus = 200;

  constructor(
    request?: Request,
    params: Record<string, string> = {},
    private notFoundHandler: (context: Context<E>) => Response | Promise<Response> = () =>
      new Response("404 Not Found", { status: 404 }),
  ) {
    this.req = new HonoRequest<P>(request, params);
  }

  get<K extends keyof VariablesOf<E> & string>(key: K): VariablesOf<E>[K] | undefined {
    return this.values.get(key) as VariablesOf<E>[K] | undefined;
  }

  set<K extends keyof VariablesOf<E> & string>(key: K, value: VariablesOf<E>[K]): void {
    this.values.set(key, value);
  }

  header(name: string, value: string): void {
    this.responseHeaders.set(name, value);
  }

  status(status: number): void {
    this.responseStatus = status;
  }

  json(value: unknown, status?: ContentfulStatusCode, headers?: HeadersInitCompat): Response {
    return this.response(JSON.stringify(value), status, defaultContentType(headers, "application/json; charset=UTF-8"));
  }

  text(text: string, status?: ContentfulStatusCode, headers?: HeadersInitCompat): Response {
    return this.response(text, status, defaultContentType(headers, "text/plain; charset=UTF-8"));
  }

  html(html: string, status?: ContentfulStatusCode, headers?: HeadersInitCompat): Response {
    return this.response(html, status, defaultContentType(headers, "text/html; charset=UTF-8"));
  }

  body(body: BodyInitCompat | null, status?: ContentfulStatusCode, headers?: HeadersInitCompat): Response {
    return this.response(body, status, headers);
  }

  redirect(location: string, status: ContentfulStatusCode = 302): Response {
    return this.response(null, status, { Location: location });
  }

  notFound(): Response | Promise<Response> {
    return this.notFoundHandler(this);
  }

  finalize(response: Response): Response {
    const headers = new Headers(response.headers);
    this.responseHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private response(body: BodyInitCompat | null, status?: ContentfulStatusCode, headers?: HeadersInitCompat): Response {
    const merged = new Headers(headers);
    this.responseHeaders.forEach((value, key) => {
      merged.set(key, value);
    });
    return new Response(body, {
      status: status ?? this.responseStatus,
      headers: merged,
    });
  }
}

export class HonoRequest<P extends string = string> {
  readonly url: string;
  readonly method: string;
  readonly path: string;

  constructor(
    private request?: Request,
    private params: Record<string, string> = {},
  ) {
    this.url = request?.url ?? "http://localhost/";
    this.method = request?.method ?? "GET";
    this.path = new URL(this.url).pathname;
  }

  header(): Record<string, string>;
  header(name: string): string | undefined;
  header(name?: string): Record<string, string> | string | undefined {
    if (!this.request) return name ? undefined : {};
    if (name) return this.request.headers.get(name) ?? undefined;
    const headers: Record<string, string> = {};
    this.request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  }

  query(name: string): string | undefined {
    return new URL(this.url).searchParams.get(name) ?? undefined;
  }

  queries(name: string): string[] | undefined {
    const values = new URL(this.url).searchParams.getAll(name);
    return values.length > 0 ? values : undefined;
  }

  param(): Record<string, string>;
  param(name: P): string;
  param(name?: P): Record<string, string> | string {
    if (!name) return { ...this.params };
    return this.params[name] ?? "";
  }

  json<T = unknown>(): Promise<T> {
    return (this.request?.json() ?? Promise.resolve({})) as Promise<T>;
  }

  text(): Promise<string> {
    return this.request?.text() ?? Promise.resolve("");
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.request?.arrayBuffer() ?? Promise.resolve(new ArrayBuffer(0));
  }

  async parseBody(): Promise<Record<string, FormDataEntryValueCompat | FormDataEntryValueCompat[]>> {
    const contentType = this.header("Content-Type") ?? "";
    if (!this.request) return {};
    if (contentType.includes("multipart/form-data")) {
      return formDataToObject(await this.request.formData());
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(await this.request.text());
      const body: Record<string, string | string[]> = {};
      for (const [key, value] of params) appendBodyValue(body, key, value);
      return body;
    }
    if (contentType.includes("application/json")) {
      const body = await this.request.json().catch(() => ({}));
      return body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, FormDataEntryValueCompat | FormDataEntryValueCompat[]>)
        : {};
    }
    return {};
  }
}

function defaultContentType(headers: HeadersInitCompat | undefined, contentType: string): Headers {
  const merged = new Headers(headers);
  if (!merged.has("Content-Type")) merged.set("Content-Type", contentType);
  return merged;
}

function appendBodyValue(out: Record<string, string | string[]>, key: string, value: string): void {
  const existing = out[key];
  if (existing === undefined) {
    out[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    out[key] = [existing, value];
  }
}

function formDataToObject(form: FormData): Record<string, FormDataEntryValueCompat | FormDataEntryValueCompat[]> {
  const out: Record<string, FormDataEntryValueCompat | FormDataEntryValueCompat[]> = {};
  for (const [key, value] of form) {
    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  }
  return out;
}

export class Hono<TEnv = unknown> {
  fetch: FetchHandler = async () => new Response("Not found", { status: 404 });

  constructor(readonly env?: TEnv) {}

  use(..._args: unknown[]): this {
    return this;
  }

  get(..._args: unknown[]): this {
    return this;
  }

  post(..._args: unknown[]): this {
    return this;
  }

  put(..._args: unknown[]): this {
    return this;
  }

  patch(..._args: unknown[]): this {
    return this;
  }

  delete(..._args: unknown[]): this {
    return this;
  }

  options(..._args: unknown[]): this {
    return this;
  }

  onError(..._args: unknown[]): this {
    return this;
  }

  notFound(..._args: unknown[]): this {
    return this;
  }
}

export function cors(): MiddlewareHandler {
  return async (_context, next) => {
    await next?.();
  };
}

export function serve(_options: ServeOptions): never {
  throw new Error("The TypeScript server runtime has been removed. Use npx emulate or createServer as a native proxy.");
}

export interface AuthUser {
  login: string;
  id: number;
  scopes: string[];
}

export interface AuthApp {
  appId: number;
  slug: string;
  name: string;
}

export interface AuthInstallation {
  installationId: number;
  appId: number;
  permissions: Record<string, string>;
  repositoryIds: number[];
  repositorySelection: "all" | "selected";
}

export interface AuthFallback {
  login: string;
  id: number;
  scopes: string[];
}

export interface AppKeyResolver {
  (appId: number): { privateKey: string; slug: string; name: string } | null;
}

export type AppEnv = {
  Variables: {
    authUser?: AuthUser;
    authApp?: AuthApp;
    authToken?: string;
    authScopes?: string[];
    docsUrl?: string;
  };
};

export interface TokenEntry {
  token: string;
  login: string;
  id: number;
  scopes: string[];
}

export type TokenMap = Map<string, AuthUser>;

export function serializeTokenMap(tokenMap: TokenMap): TokenEntry[] {
  return [...tokenMap.entries()].map(([token, user]) => ({
    token,
    login: user.login,
    id: user.id,
    scopes: user.scopes,
  }));
}

export function restoreTokenMap(tokenMap: TokenMap, entries: TokenEntry[] | Record<string, TokenEntry[]>): void {
  tokenMap.clear();
  const list = Array.isArray(entries) ? entries : entries.tokens;
  for (const entry of list ?? []) {
    if (entry.token) tokenMap.set(entry.token, { login: entry.login, id: entry.id, scopes: entry.scopes });
  }
}

export interface WebhookSubscription {
  id: number;
  url: string;
  events: string[];
  active: boolean;
  secret?: string;
  owner: string;
  repo?: string;
}

export interface WebhookDelivery {
  id: number;
  hook_id: number;
  event: string;
  action?: string;
  payload: unknown;
  status_code: number | null;
  delivered_at: string;
  duration: number | null;
  success: boolean;
}

export class WebhookDispatcher {
  private subscriptions: WebhookSubscription[] = [];
  private deliveries: WebhookDelivery[] = [];
  private subscriptionIdCounter = 1;
  private deliveryIdCounter = 1;

  register(subscription: Omit<WebhookSubscription, "id"> & { id?: number }): WebhookSubscription {
    const { id: explicitId, ...rest } = subscription;
    const id = explicitId !== undefined ? explicitId : this.subscriptionIdCounter++;
    if (id >= this.subscriptionIdCounter) this.subscriptionIdCounter = id + 1;
    const stored = { ...rest, id };
    this.subscriptions.push(stored);
    return stored;
  }

  subscribe(
    subscription: Omit<WebhookSubscription, "id" | "active" | "events" | "owner"> & Partial<WebhookSubscription>,
  ): void {
    this.register({
      url: subscription.url,
      events: subscription.events ?? ["*"],
      active: subscription.active ?? true,
      secret: subscription.secret,
      owner: subscription.owner ?? "",
      repo: subscription.repo,
      id: subscription.id,
    });
  }

  unregister(id: number): boolean {
    const index = this.subscriptions.findIndex((subscription) => subscription.id === id);
    if (index === -1) return false;
    this.subscriptions.splice(index, 1);
    return true;
  }

  getSubscription(id: number): WebhookSubscription | undefined {
    return this.subscriptions.find((subscription) => subscription.id === id);
  }

  getSubscriptions(owner?: string, repo?: string): WebhookSubscription[] {
    return this.subscriptions.filter((subscription) => {
      if (owner && subscription.owner !== owner) return false;
      if (repo !== undefined && subscription.repo !== repo) return false;
      return true;
    });
  }

  updateSubscription(
    id: number,
    data: Partial<Pick<WebhookSubscription, "url" | "events" | "active" | "secret">>,
  ): WebhookSubscription | undefined {
    const subscription = this.subscriptions.find((item) => item.id === id);
    if (!subscription) return undefined;
    Object.assign(subscription, data);
    return subscription;
  }

  async dispatch(
    event: string,
    action: string | undefined,
    payload: unknown,
    owner = "",
    repo?: string,
  ): Promise<void> {
    const matchingSubscriptions = this.subscriptions.filter((subscription) => {
      if (!subscription.active) return false;
      if (owner && subscription.owner !== owner) return false;
      if (repo !== undefined) {
        if (subscription.repo !== repo) return false;
      } else if (subscription.repo !== undefined) {
        return false;
      }
      return event === "ping" || subscription.events.includes("*") || subscription.events.includes(event);
    });

    for (const subscription of matchingSubscriptions) {
      const delivery: WebhookDelivery = {
        id: this.deliveryIdCounter++,
        hook_id: subscription.id,
        event,
        action,
        payload,
        status_code: null,
        delivered_at: new Date().toISOString(),
        duration: null,
        success: false,
      };
      const body = JSON.stringify(payload);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": String(delivery.id),
      };
      if (subscription.secret) {
        headers["X-Hub-Signature-256"] =
          `sha256=${createHmac("sha256", subscription.secret).update(body).digest("hex")}`;
      }

      try {
        const start = Date.now();
        const response = await fetch(subscription.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(10000),
        });
        delivery.duration = Date.now() - start;
        delivery.status_code = response.status;
        delivery.success = response.ok;
      } catch {
        delivery.duration = 0;
      }
      this.deliveries.push(delivery);
      if (this.deliveries.length > 1000) {
        this.deliveries.splice(0, this.deliveries.length - 1000);
      }
    }
  }

  getDeliveries(hookId?: number): WebhookDelivery[] {
    return hookId === undefined
      ? [...this.deliveries]
      : this.deliveries.filter((delivery) => delivery.hook_id === hookId);
  }

  clear(): void {
    this.subscriptions.length = 0;
    this.deliveries.length = 0;
    this.subscriptionIdCounter = 1;
    this.deliveryIdCounter = 1;
  }
}

export interface RouteContext {
  app: Hono<AppEnv>;
  store: Store;
  webhooks: WebhookDispatcher;
  baseUrl: string;
  tokenMap?: TokenMap;
}

export interface ServicePlugin {
  name: string;
  runtime?: string;
  register?(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void;
  seed?(store: Store, baseUrl: string): void;
}

export interface ServerOptions {
  port?: number;
  baseUrl?: string;
  docsUrl?: string;
  tokens?: Record<string, { login: string; id?: number; scopes?: string[] }>;
  appKeyResolver?: AppKeyResolver;
  fallbackUser?: AuthFallback;
}

export function createServer(plugin: ServicePlugin, options: ServerOptions = {}) {
  const port = options.port ?? 4000;
  const baseUrl = options.baseUrl ?? `http://localhost:${port}`;
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  for (const [token, user] of Object.entries(options.tokens ?? {})) {
    tokenMap.set(token, {
      login: user.login,
      id: user.id ?? 0,
      scopes: user.scopes ?? ["repo", "user", "admin:org", "admin:repo_hook"],
    });
  }

  let runtime: Promise<{ emulator: Emulator; target: string }> | undefined;
  async function ensureRuntime(): Promise<{ emulator: Emulator; target: string }> {
    if (runtime) return runtime;
    runtime = startNativeServerRuntime(plugin.name, port, baseUrl, options.tokens);
    return runtime;
  }

  const app = {
    async fetch(request: Request): Promise<Response> {
      const native = await ensureRuntime();
      const url = new URL(request.url);
      const target = new URL(`${url.pathname}${url.search}`, native.target);
      const init: RequestInit & { duplex?: string } = {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
      };
      if (!["GET", "HEAD"].includes(request.method)) {
        init.body = request.body;
        init.duplex = "half";
      }
      return fetch(new Request(target, init));
    },
  };

  return {
    app,
    store,
    webhooks,
    port,
    baseUrl,
    tokenMap,
    async close() {
      const native = await runtime;
      await native?.emulator.close();
    },
  };
}

async function startNativeServerRuntime(
  service: string,
  port: number,
  baseUrl: string | undefined,
  tokens: ServerOptions["tokens"],
): Promise<{ emulator: Emulator; target: string }> {
  if (!isServiceName(service)) {
    throw new Error(`Unsupported native emulator service: ${service}`);
  }
  const { createEmulator } = await loadEmulateApi();
  const seed = tokens
    ? ({
        tokens: Object.fromEntries(
          Object.entries(tokens).map(([token, user]) => [token, { login: user.login, scopes: user.scopes }]),
        ),
      } as SeedConfig)
    : undefined;
  const emulator = await createEmulator({ service, port, baseUrl, seed });
  return { emulator, target: `http://127.0.0.1:${port}` };
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

function isServiceName(service: string): service is ServiceName {
  return [
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
  ].includes(service);
}

function contextDocsUrl(context: Context): string {
  return (context.get("docsUrl") as string | undefined) ?? "https://emulate.dev";
}

function errorStatus(error: unknown): number {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) return status;
  }
  return 500;
}

export function createApiErrorHandler(documentationUrl?: string): ErrorHandler {
  return (error, context) => {
    if (documentationUrl) context.set("docsUrl", documentationUrl);
    const status = errorStatus(error);
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return context.json({ message, documentation_url: contextDocsUrl(context) }, status);
  };
}

export function createErrorHandler(documentationUrl?: string): MiddlewareHandler {
  return async (context, next) => {
    if (documentationUrl) context.set("docsUrl", documentationUrl);
    await next?.();
  };
}

export const errorHandler: MiddlewareHandler = createErrorHandler();

export class ApiError extends Error {
  status: number;
  errors?: Array<{ resource: string; field: string; code: string }>;

  constructor(status: number, message: string, errors?: ApiError["errors"]);
  constructor(message: string, status?: number, errors?: ApiError["errors"]);
  constructor(
    first: number | string,
    second?: string | number,
    errors?: Array<{ resource: string; field: string; code: string }>,
  ) {
    const status = typeof first === "number" ? first : typeof second === "number" ? second : 400;
    const message = typeof first === "number" ? (typeof second === "string" ? second : "Error") : first;
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.errors = errors;
  }
}

export function notFound(resource?: string): ApiError {
  return new ApiError(404, resource ? `${resource} not found` : "Not Found");
}

export function validationError(message: string, errors?: ApiError["errors"]): ApiError {
  return new ApiError(422, message, errors);
}

export function unauthorized(): ApiError {
  return new ApiError(401, "Requires authentication");
}

export function forbidden(): ApiError {
  return new ApiError(403, "Forbidden");
}

export async function parseJsonBody<T = Record<string, unknown>>(input: Context | Request): Promise<T> {
  try {
    const body = input instanceof Request ? await input.json() : await input.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as T;
    return {} as T;
  } catch {
    throw new ApiError(400, "Problems parsing JSON");
  }
}

export function authMiddleware(): MiddlewareHandler {
  return async (_context, next) => {
    await next?.();
  };
}

export function requireAuth(): AuthUser {
  return { login: "emulate", id: 0, scopes: [] };
}

export function requireAppAuth(): AuthApp {
  return { appId: 0, slug: "emulate", name: "emulate" };
}

export interface PaginationParams {
  page: number;
  per_page: number;
}

export function parsePagination(input: Context | string | URL): PaginationParams {
  const pageValue =
    input instanceof Context ? input.req.query("page") : new URL(input.toString()).searchParams.get("page");
  const perPageValue =
    input instanceof Context ? input.req.query("per_page") : new URL(input.toString()).searchParams.get("per_page");
  return {
    page: Math.max(1, parseInt(pageValue ?? "1", 10) || 1),
    per_page: Math.min(100, Math.max(1, parseInt(perPageValue ?? "30", 10) || 30)),
  };
}

export function setLinkHeader(context: Context, totalCount: number, page: number, perPage: number): void {
  const lastPage = Math.max(1, Math.ceil(totalCount / perPage));
  const baseUrl = new URL(context.req.url);
  const links: string[] = [];
  const makeLink = (targetPage: number, rel: string) => {
    baseUrl.searchParams.set("page", String(targetPage));
    baseUrl.searchParams.set("per_page", String(perPage));
    return `<${baseUrl.toString()}>; rel="${rel}"`;
  };
  if (page < lastPage) {
    links.push(makeLink(page + 1, "next"));
    links.push(makeLink(lastPage, "last"));
  }
  if (page > 1) {
    links.push(makeLink(1, "first"));
    links.push(makeLink(page - 1, "prev"));
  }
  if (links.length > 0) context.header("Link", links.join(", "));
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}

export interface UserButtonOptions {
  label: string;
  value?: string;
}

export interface CheckoutLineItem {
  name: string;
  amount?: number;
  quantity?: number;
}

export interface CheckoutPageOptions {
  title?: string;
  lineItems?: CheckoutLineItem[];
}

export interface InspectorTab {
  id: string;
  label: string;
  content: string;
}

export function renderCardPage(options: { title?: string; body?: string } | string): string {
  const title = typeof options === "string" ? options : (options.title ?? "emulate");
  const body = typeof options === "string" ? "" : (options.body ?? "");
  return `<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

export function renderErrorPage(message: string, status = 500): Response {
  return new Response(renderCardPage({ title: String(status), body: escapeHtml(message) }), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function renderSettingsPage(options: { title?: string; body?: string }): string {
  return renderCardPage(options);
}

export function renderInspectorPage(options: { title?: string; tabs?: InspectorTab[] }): string {
  return renderCardPage({ title: options.title, body: options.tabs?.map((tab) => tab.content).join("") ?? "" });
}

export function renderFormPostPage(action: string, fields: Record<string, string>): string {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}">`)
    .join("");
  return renderCardPage({
    title: "Redirecting",
    body: `<form method="post" action="${escapeAttr(action)}">${inputs}</form>`,
  });
}

export function renderCheckoutPage(options: CheckoutPageOptions): string {
  return renderCardPage({ title: options.title ?? "Checkout" });
}

export function renderUserButton(options: UserButtonOptions): string {
  return `<button value="${escapeAttr(options.value ?? options.label)}">${escapeHtml(options.label)}</button>`;
}

export function registerFontRoutes(): void {
  return undefined;
}

export function normalizeUri(uri: string): string {
  return uri.replace(/\/+$/, "");
}

export function matchesRedirectUri(actual: string, expected: string): boolean {
  return normalizeUri(actual) === normalizeUri(expected);
}

export function constantTimeSecretEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export async function bodyStr(request: Request): Promise<string> {
  return request.text();
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const [name, ...value] = part.trim().split("=");
    if (name) cookies[name] = value.join("=");
  }
  return cookies;
}

export function debug(..._args: unknown[]): void {
  return undefined;
}

export const runtime = "native-go";
