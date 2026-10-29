import type { Store } from "@emulators/core";
import { initialBudgets, type RuleBudgets } from "./rules.js";
import type { AiConfig, CallRecord, Delivery, StoredResponse, Timing } from "./types.js";

/** Maximum number of calls kept in the per-instance call record. */
export const CALL_RECORD_LIMIT = 500;

/** State owned by one emulator instance, kept off the shared plugin object. */
export interface AiState {
  config: AiConfig;
  budgets: RuleBudgets;
  generation: number;
  controller: AbortController;
  callSeq: number;
  callsGeneration: number;
  calls: CallRecord[];
  responses: Map<string, StoredResponse>;
  seenModels: Set<string>;
  nextId: number;
}

/** Identifies the state generation and call-record generation a request started in. */
export interface CallStamp {
  generation: number;
  callsGeneration: number;
}

/** A request's combined abort signal plus the cleanup for its listeners. */
export interface RequestScope extends CallStamp {
  signal: AbortSignal;
  dispose(): void;
}

const CONFIG_KEY = "ai.state.config";
const BUDGETS_KEY = "ai.state.budgets";
const CALL_SEQ_KEY = "ai.state.callSeq";
const CALLS_KEY = "ai.state.calls";
const RESPONSES_KEY = "ai.state.responses";
const SEEN_MODELS_KEY = "ai.state.seenModels";
const NEXT_ID_KEY = "ai.state.nextId";
const SEED_KEY = "ai.seed";

function defaultConfig(): AiConfig {
  return {
    strict: false,
    timing: { ttftMs: 0, chunkDelayMs: 0 },
    models: [],
    rules: [],
  };
}

function isAiConfig(value: unknown): value is AiConfig {
  return typeof value === "object" && value !== null && "rules" in value;
}

/**
 * AI state whose serializable fields live in store data so snapshots carry them.
 * The generation counters and abort controller stay in memory across store resets.
 */
class StoreBackedAiState implements AiState {
  private liveController = new AbortController();
  private liveGeneration = 0;
  private liveCallsGeneration = 0;

  constructor(private readonly store: Store) {}

  private read<T>(key: string, create: () => T): T {
    const value = this.store.getData<T>(key);
    if (value !== undefined) return value;
    const created = create();
    this.store.setData(key, created);
    return created;
  }

  get config(): AiConfig {
    return this.read(CONFIG_KEY, defaultConfig);
  }

  set config(value: AiConfig) {
    this.store.setData(CONFIG_KEY, value);
  }

  get budgets(): RuleBudgets {
    return this.read(BUDGETS_KEY, () => initialBudgets(this.config));
  }

  set budgets(value: RuleBudgets) {
    this.store.setData(BUDGETS_KEY, value);
  }

  get generation(): number {
    return this.liveGeneration;
  }

  set generation(value: number) {
    this.liveGeneration = value;
  }

  get controller(): AbortController {
    return this.liveController;
  }

  set controller(value: AbortController) {
    this.liveController = value;
  }

  get callSeq(): number {
    return this.read(CALL_SEQ_KEY, () => 0);
  }

  set callSeq(value: number) {
    this.store.setData(CALL_SEQ_KEY, value);
  }

  get callsGeneration(): number {
    return this.liveCallsGeneration;
  }

  set callsGeneration(value: number) {
    this.liveCallsGeneration = value;
  }

  get calls(): CallRecord[] {
    return this.read(CALLS_KEY, () => [] as CallRecord[]);
  }

  set calls(value: CallRecord[]) {
    this.store.setData(CALLS_KEY, value);
  }

  get responses(): Map<string, StoredResponse> {
    return this.read(RESPONSES_KEY, () => new Map<string, StoredResponse>());
  }

  set responses(value: Map<string, StoredResponse>) {
    this.store.setData(RESPONSES_KEY, value);
  }

  get seenModels(): Set<string> {
    return this.read(SEEN_MODELS_KEY, () => new Set<string>());
  }

  set seenModels(value: Set<string>) {
    this.store.setData(SEEN_MODELS_KEY, value);
  }

  get nextId(): number {
    return this.read(NEXT_ID_KEY, () => 1);
  }

  set nextId(value: number) {
    this.store.setData(NEXT_ID_KEY, value);
  }
}

const states = new WeakMap<Store, AiState>();

/** Returns the state for one store, creating it on first use. */
export function getAiState(store: Store): AiState {
  let state = states.get(store);
  if (!state) {
    state = new StoreBackedAiState(store);
    states.set(store, state);
  }
  return state;
}

/** Stores the seed configuration that reset restores, in snapshot-backed store data. */
export function setSeedConfig(store: Store, config: AiConfig): void {
  store.setData(SEED_KEY, {
    strict: config.strict,
    timing: { ...config.timing },
    models: [...config.models],
    rules: [...config.rules],
  });
}

/** Returns the stored seed configuration, or the defaults when no seed was applied. */
export function getSeedConfig(store: Store): AiConfig {
  const seed = store.getData<unknown>(SEED_KEY);
  return isAiConfig(seed) ? seed : defaultConfig();
}

/**
 * Replaces an instance's config and rebuilds its budgets from the new rules.
 * Runtime rule replacement uses this so no rule keeps a budget across a swap.
 */
export function setAiConfig(state: AiState, config: AiConfig): void {
  state.config = config;
  state.budgets = initialBudgets(config);
}

/**
 * Resets an instance's rules, budgets, ids, call record, and stored responses.
 * Aborts any stream still running under the previous generation.
 */
export function resetAiState(store: Store, config?: Partial<AiConfig>): AiState {
  const state = getAiState(store);
  state.generation += 1;
  state.controller.abort();
  state.controller = new AbortController();
  const timing: Timing = {
    ttftMs: config?.timing?.ttftMs ?? 0,
    chunkDelayMs: config?.timing?.chunkDelayMs ?? 0,
  };
  setAiConfig(state, {
    strict: config?.strict ?? false,
    timing,
    models: [...(config?.models ?? [])],
    rules: [...(config?.rules ?? [])],
  });
  state.callSeq = 0;
  state.callsGeneration += 1;
  state.calls = [];
  state.responses.clear();
  state.seenModels.clear();
  state.nextId = 1;
  return state;
}

/** Returns the next deterministic id number for this instance. */
export function nextId(state: AiState): number {
  return state.nextId++;
}

/** Captures the generations a request writes against. */
export function captureStamp(state: AiState): CallStamp {
  return { generation: state.generation, callsGeneration: state.callsGeneration };
}

/** True when the state generation still matches the one a request captured. */
export function isCurrentGeneration(state: AiState, stamp: { generation: number }): boolean {
  return stamp.generation === state.generation;
}

/**
 * Builds a request signal that aborts when the client goes away or the instance resets.
 * Call dispose when the response settles so no listener outlives the request.
 */
export function beginRequest(state: AiState, clientSignal?: AbortSignal): RequestScope {
  const controller = new AbortController();
  const generation = state.generation;
  const callsGeneration = state.callsGeneration;
  const generationSignal = state.controller.signal;

  const abort = () => controller.abort();
  const link = (signal: AbortSignal | undefined) => {
    if (!signal) return;
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
  };

  link(generationSignal);
  link(clientSignal);

  let disposed = false;
  return {
    generation,
    callsGeneration,
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      generationSignal.removeEventListener("abort", abort);
      clientSignal?.removeEventListener("abort", abort);
    },
  };
}

/** Adds a call to the record unless the instance or record was reset since the request began. */
export function recordCall(state: AiState, call: CallRecord, stamp: CallStamp): boolean {
  if (stamp.generation !== state.generation || stamp.callsGeneration !== state.callsGeneration) return false;
  state.calls.push(call);
  if (state.calls.length > CALL_RECORD_LIMIT) {
    state.calls.splice(0, state.calls.length - CALL_RECORD_LIMIT);
  }
  return true;
}

/** Updates a recorded call's delivery status, ignoring late completions after a reset. */
export function settleCall(
  state: AiState,
  call: CallRecord,
  stamp: CallStamp,
  delivery: Exclude<Delivery, "pending">,
): void {
  if (stamp.generation !== state.generation || stamp.callsGeneration !== state.callsGeneration) return;
  call.delivery = delivery;
}

/** Empties the call record; completions from before the clear cannot repopulate it. */
export function clearCalls(state: AiState): void {
  state.calls = [];
  state.callsGeneration += 1;
}
