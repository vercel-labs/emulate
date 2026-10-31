import { Hono, cors, type CorsOptions } from "./http.js";
import { type PersistenceAdapter } from "./persistence.js";
import { WebhookDispatcher } from "./webhooks.js";
import { createCustomInspector, type InspectorOptions } from "./custom-inspector.js";

export interface EmulatorContext<State extends object> {
  app: Hono;
  state: State;
  baseUrl: string;
  signal: AbortSignal;
  webhooks: WebhookDispatcher;
  onDispose(callback: () => void | Promise<void>): void;
}

export interface EmulatorDefinition<State extends object = any> {
  readonly kind: "emulate.http";
  readonly apiVersion: 1;
  readonly name: string;
  readonly stateVersion?: number;
  readonly state: () => State;
  readonly setup: (context: EmulatorContext<State>) => void;
  readonly validateSeed?: (value: unknown) => State;
  readonly cors?: false | CorsOptions;
}

export function defineEmulator<State extends object>(definition: {
  name: string;
  stateVersion?: number;
  state: () => State;
  setup: (context: EmulatorContext<NoInfer<State>>) => void;
  validateSeed?: (value: unknown) => NoInfer<State>;
  cors?: false | CorsOptions;
}): EmulatorDefinition<State> {
  const result = { ...definition, kind: "emulate.http" as const, apiVersion: 1 as const };
  assertEmulatorDefinition(result);
  return Object.freeze(result);
}

export function isEmulatorDefinition(value: unknown): value is EmulatorDefinition {
  return !!value && typeof value === "object" && "kind" in value && value.kind === "emulate.http";
}

export function assertEmulatorDefinition(value: unknown): asserts value is EmulatorDefinition {
  if (!isEmulatorDefinition(value)) throw new Error("Expected a default export created with defineEmulator()");
  if (value.apiVersion !== 1)
    throw new Error(`Unsupported emulator API version ${value.apiVersion}. Update emulate to match this plugin.`);
  if (typeof value.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(value.name))
    throw new Error(
      "Emulator name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens",
    );
  if (typeof value.state !== "function" || typeof value.setup !== "function")
    throw new Error(`Emulator ${value.name} must provide state() and setup()`);
  if (value.validateSeed !== undefined && typeof value.validateSeed !== "function")
    throw new Error("validateSeed must be a function");
  if (
    value.cors !== undefined &&
    value.cors !== false &&
    (!value.cors || typeof value.cors !== "object" || Array.isArray(value.cors))
  )
    throw new Error("cors must be false or a CORS options object");
  if (value.stateVersion !== undefined && (!Number.isSafeInteger(value.stateVersion) || value.stateVersion < 1))
    throw new Error("stateVersion must be a positive integer");
}

export interface EmulatorSnapshot<State extends object = any> {
  formatVersion: 1;
  definition: string;
  stateVersion: number;
  state: State;
}

export interface CustomRuntimeOptions<State extends object = any> {
  seed?: State;
  baseUrl?: string;
  inspector?: boolean | InspectorOptions;
  persistence?: PersistenceAdapter;
  resetPersistence?: boolean;
  shutdownTimeout?: number;
}

export interface CustomRuntime<State extends object = any> {
  readonly baseUrl: string;
  readonly inspectorUrl?: string;
  fetch(request: Request): Promise<Response>;
  request(path: string, init?: RequestInit): Promise<Response>;
  snapshot(): EmulatorSnapshot<State>;
  reset(): Promise<void>;
  restore(snapshot: EmulatorSnapshot<State>): Promise<void>;
  close(): Promise<void>;
}

export function cloneState<T>(value: T): T {
  const ancestors = new Set<object>();
  function check(item: unknown, path: string): void {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object") throw new Error(`State at ${path} must be JSON-compatible`);
    if (ancestors.has(item)) throw new Error(`Circular state at ${path}`);
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null)
      throw new Error(`State at ${path} must be a plain object or array`);
    ancestors.add(item);
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue;
      if (typeof key !== "string") throw new Error(`Symbol state key at ${path}`);
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !("value" in descriptor))
        throw new Error(`State at ${path}.${key} must be an enumerable data property`);
      check(descriptor.value, `${path}.${key}`);
    }
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) if (!(i in item)) throw new Error(`Sparse state array at ${path}[${i}]`);
      if (Object.keys(item).length !== item.length) throw new Error(`Extra array properties at ${path}`);
    }
    ancestors.delete(item);
  }
  check(value, "state");
  return JSON.parse(JSON.stringify(value)) as T;
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createCustomRuntime<State extends object>(
  definition: EmulatorDefinition<State>,
  options: CustomRuntimeOptions<State> = {},
): Promise<CustomRuntime<State>> {
  assertEmulatorDefinition(definition);
  const baseUrl = (options.baseUrl ?? `http://${definition.name}.localhost`).replace(/\/$/, "");
  const timeout = options.shutdownTimeout ?? 5000;
  if (!Number.isFinite(timeout) || timeout < 1) throw new Error("shutdownTimeout must be a positive number");
  if (
    options.inspector !== undefined &&
    typeof options.inspector !== "boolean" &&
    (!options.inspector || typeof options.inspector !== "object" || Array.isArray(options.inspector))
  )
    throw new Error("inspector must be a boolean or an inspector options object");
  function validate(value: unknown): State {
    const state = cloneState(definition.validateSeed ? definition.validateSeed(cloneState(value)) : value);
    if (!state || typeof state !== "object" || Array.isArray(state))
      throw new Error("Initial state must be a JSON-compatible object");
    return state as State;
  }
  const baseline = validate(options.seed === undefined ? definition.state() : options.seed);
  function readSnapshot(value: unknown): State {
    const snap = value as EmulatorSnapshot<State> | undefined;
    if (
      !snap ||
      snap.formatVersion !== 1 ||
      snap.definition !== definition.name ||
      snap.stateVersion !== (definition.stateVersion ?? 1)
    )
      throw new Error(
        `Incompatible snapshot for ${definition.name}. Supply a matching stateVersion or migrate the saved snapshot.`,
      );
    return validate(snap.state);
  }
  const inspector = options.inspector
    ? createCustomInspector(definition.name, baseUrl, typeof options.inspector === "object" ? options.inspector : {})
    : undefined;
  type Generation = {
    app: Hono;
    state: State;
    controller: AbortController;
    disposers: Array<() => void | Promise<void>>;
    active: Set<Promise<unknown>>;
    webhooks: WebhookDispatcher;
    disposed?: Promise<void>;
  };
  function dispose(gen: Generation): Promise<void> {
    return (gen.disposed ??= disposeGeneration(gen));
  }
  async function disposeGeneration(gen: Generation): Promise<void> {
    gen.controller.abort();
    const errors: unknown[] = [];
    try {
      await bounded(
        (async () => {
          while (gen.active.size) await Promise.allSettled([...gen.active]);
        })(),
        timeout,
        "Requests draining",
      );
    } catch (error) {
      errors.push(error);
    }
    for (const callback of [...gen.disposers].reverse()) {
      try {
        await bounded(Promise.resolve().then(callback), timeout, "Emulator cleanup");
      } catch (error) {
        errors.push(error);
      }
    }
    gen.webhooks.clear();
    if (errors.length) throw new AggregateError(errors, `Cleanup failed for ${definition.name}`);
  }
  async function makeGeneration(state: State): Promise<Generation> {
    const controller = new AbortController();
    const gen: Generation = {
      app: new Hono({
        strictRoutes: true,
        strictJson: true,
        onError(error, req) {
          inspector?.recordError(req, error);
          if (!(error && typeof error === "object" && "status" in error && Number(error.status) < 500))
            console.error(`[${definition.name}]`, error);
        },
      }),
      state: cloneState(state),
      controller,
      disposers: [],
      active: new Set(),
      webhooks: new WebhookDispatcher({ signal: controller.signal, neutral: true }),
    };
    gen.app.onError((error, c) => {
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 500;
      return c.json(
        { error: error instanceof Error ? error.message : "Internal Server Error" },
        Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
      );
    });
    gen.app.notFound((c) => c.json({ error: "Not Found" }, 404));
    if (definition.cors !== false) gen.app.use(cors(definition.cors));
    try {
      const result: unknown = definition.setup({
        app: gen.app,
        state: gen.state,
        baseUrl,
        signal: controller.signal,
        webhooks: gen.webhooks,
        onDispose: (fn) => gen.disposers.push(fn),
      });
      if (result && typeof (result as Promise<unknown>).then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new Error("setup() must be synchronous; register asynchronous cleanup with onDispose()");
      }
      cloneState(gen.state);
      return gen;
    } catch (error) {
      await dispose(gen).catch((cleanup) => console.error(cleanup));
      throw error;
    }
  }
  let initial = baseline;
  if (options.persistence && !options.resetPersistence) {
    const raw = await options.persistence.load();
    if (raw !== null) {
      try {
        initial = readSnapshot(JSON.parse(raw));
      } catch (error) {
        throw new Error(`Cannot restore ${definition.name}: ${error instanceof Error ? error.message : error}`, {
          cause: error,
        });
      }
    }
  }
  let generation = await makeGeneration(initial);
  let closed = false;
  let transition: Promise<void> = Promise.resolve();
  let saving: Promise<void> = Promise.resolve();
  let saveRevision = 0;
  let closing: Promise<void> | undefined;
  const snapshot = (): EmulatorSnapshot<State> => ({
    formatVersion: 1,
    definition: definition.name,
    stateVersion: definition.stateVersion ?? 1,
    state: cloneState(generation.state),
  });
  function save(serialized?: string): Promise<void> {
    if (!options.persistence) return Promise.resolve();
    const data = serialized ?? JSON.stringify(snapshot());
    saveRevision++;
    saving = saving.catch(() => {}).then(() => options.persistence!.save(data));
    return saving;
  }
  function trackBody(gen: Generation, response: Response, savedSnapshot?: string, savedRevision?: number): Response {
    if (!response.body) return response;
    const reader = response.body.getReader();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    gen.active.add(done);
    void done.then(() => gen.active.delete(done));
    let settled = false;
    let stopped = false;
    let abort: () => void;
    async function finish(persist: boolean): Promise<void> {
      if (settled) return;
      settled = true;
      gen.controller.signal.removeEventListener("abort", abort);
      try {
        if (persist && savedSnapshot !== undefined && gen === generation && !gen.controller.signal.aborted) {
          const current = JSON.stringify(snapshot());
          if (current !== savedSnapshot || saveRevision !== savedRevision) await save(current);
        }
      } catch (error) {
        console.error(`[${definition.name}] persistence failed`, error);
        throw new Error("Could not persist emulator state", { cause: error });
      } finally {
        resolveDone();
      }
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        abort = () => {
          if (stopped) return;
          stopped = true;
          controller.error(gen.controller.signal.reason);
          void reader
            .cancel(gen.controller.signal.reason)
            .catch(() => {})
            .finally(() => {
              void finish(false);
            });
        };
        gen.controller.signal.addEventListener("abort", abort, { once: true });
        if (gen.controller.signal.aborted) abort();
      },
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (stopped) return;
          if (chunk.done) {
            await finish(true);
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          if (stopped) return;
          await finish(true).catch(() => {});
          controller.error(error);
        }
      },
      async cancel(reason) {
        stopped = true;
        try {
          await reader.cancel(reason);
        } finally {
          await finish(true);
        }
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  function replace(state: State): Promise<void> {
    if (closed) return Promise.reject(new Error("Emulator is closed"));
    const pending = transition
      .catch(() => {})
      .then(async () => {
        const next = await makeGeneration(state);
        const old = generation;
        let cleanupError: unknown;
        try {
          await dispose(old);
        } catch (error) {
          cleanupError = error;
        }
        generation = next;
        inspector?.clear();
        await save();
        if (cleanupError) throw cleanupError;
      });
    transition = pending.catch(() => {});
    return pending;
  }
  const runtime: CustomRuntime<State> = {
    baseUrl,
    inspectorUrl: inspector ? `${baseUrl}/_emulate` : undefined,
    snapshot,
    reset: () => replace(baseline),
    restore(value) {
      try {
        return replace(readSnapshot(value));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    async fetch(request) {
      if (closed) return Response.json({ error: "Emulator is closed" }, { status: 503 });
      // Wait for the most recent transition, including ones queued while waiting.
      let observed: Promise<void>;
      do {
        observed = transition;
        await observed;
      } while (observed !== transition);
      if (closed) return Response.json({ error: "Emulator is closed" }, { status: 503 });
      const pathname = new URL(request.url).pathname;
      if (pathname === "/_emulate" || pathname.startsWith("/_emulate/")) {
        return inspector
          ? inspector.handle(request, { snapshot, reset: runtime.reset, routes: () => generation.app.routeTable })
          : Response.json({ error: "Not Found" }, { status: 404 });
      }
      const gen = generation;
      const task = (async () => {
        const req = new Request(request, { signal: AbortSignal.any([request.signal, gen.controller.signal]) });
        const started = inspector?.begin(req, gen.app.matchedRoute(req.method, pathname));
        let response = await gen.app.fetch(req);
        let savedSnapshot: string | undefined;
        let savedRevision: number | undefined;
        if (gen === generation && !gen.controller.signal.aborted) {
          try {
            savedSnapshot = options.persistence ? JSON.stringify(snapshot()) : undefined;
            const pendingSave = save(savedSnapshot);
            savedRevision = saveRevision;
            await pendingSave;
          } catch (error) {
            console.error(`[${definition.name}] persistence failed`, error);
            void response.body?.cancel().catch(() => {});
            savedSnapshot = undefined;
            savedRevision = undefined;
            response = Response.json({ error: "Could not persist emulator state" }, { status: 500 });
          }
        }
        response = trackBody(gen, response, savedSnapshot, savedRevision);
        if (request.method === "HEAD") {
          // Cancellation is best effort; a streaming body can reject or never settle.
          void response.body?.cancel().catch(() => {});
          response = new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        if (gen === generation && !gen.controller.signal.aborted) await inspector?.finish(req, response, started);
        return response;
      })();
      gen.active.add(task);
      try {
        return await task;
      } finally {
        gen.active.delete(task);
      }
    },
    request(path, init) {
      return runtime.fetch(new Request(new URL(path, `${baseUrl}/`), init));
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await transition.catch(() => {});
        const errors: unknown[] = [];
        try {
          await dispose(generation);
        } catch (error) {
          errors.push(error);
        }
        try {
          await bounded(save(), timeout, "Persistence flush");
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, `Could not close ${definition.name}`);
      })();
      return closing;
    },
  };
  if (options.persistence) {
    try {
      await save();
    } catch (error) {
      await runtime.close().catch(() => {});
      throw error;
    }
  }
  return runtime;
}
