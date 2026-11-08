import { randomInt } from "crypto";
import type { Store } from "@emulators/core";
import { eventTypeMatcher, readInt, readNumber, readStringList, isRecord } from "./helpers.js";

/**
 * Opt-in delivery faults for testing webhook handlers: drop, delay until flush, duplicate and
 * reorder. Decisions come from a seeded mulberry32 generator whose state is kept in the store,
 * so a given seed makes the same decisions in every fresh emulator and across a restore.
 */

export type ReorderMode = "none" | "reverse" | "shuffle";

export const REORDER_MODES: readonly ReorderMode[] = ["none", "reverse", "shuffle"];

export interface ChaosRule {
  /** Probability in [0, 1] that the rule fires for a matching event. */
  rate: number;
  /** Event type patterns (`*` wildcards allowed). Undefined matches every type. */
  types?: string[];
}

export interface DuplicateRule extends ChaosRule {
  /** Extra copies sent after the original. */
  count: number;
}

export interface WebhookChaosConfig {
  seed: number;
  drop?: ChaosRule;
  duplicate?: DuplicateRule;
  delay?: ChaosRule;
  reorder: ReorderMode;
}

/** The shape accepted from the control route and the seed config. */
export interface WebhookChaosInput {
  seed?: number;
  drop?: { rate?: number; types?: string[] };
  duplicate?: { rate?: number; types?: string[]; count?: number };
  delay?: { rate?: number; types?: string[] };
  reorder?: ReorderMode;
}

export interface ChaosValidationError {
  param: string;
  message: string;
}

interface ChaosState {
  config: WebhookChaosConfig;
  /** mulberry32 state after the last draw. */
  state: number;
}

export interface HeldEvent {
  event_id: string;
  type: string;
  held_at: string;
}

const CHAOS_KEY = "stripe.webhook_chaos";
const OUTBOX_KEY = "stripe.webhook_outbox";
const MAX_SEED = 0xffffffff;
const MAX_DUPLICATES = 10;

function unknownKey(value: Record<string, unknown>, allowed: readonly string[], prefix: string) {
  const key = Object.keys(value).find((k) => !allowed.includes(k));
  if (key === undefined) return undefined;
  const param = prefix ? `${prefix}.${key}` : key;
  return { param, message: `Received unknown parameter: ${param}` };
}

function parseRule(
  value: unknown,
  name: "drop" | "duplicate" | "delay",
): { rule?: ChaosRule & { count?: number }; error?: ChaosValidationError } {
  if (value === undefined || value === null || value === "") return {};
  if (!isRecord(value)) {
    return { error: { param: name, message: `Invalid ${name}: must be an object with rate and types.` } };
  }
  const allowed = name === "duplicate" ? ["rate", "types", "count"] : ["rate", "types"];
  const unknown = unknownKey(value, allowed, name);
  if (unknown) return { error: unknown };

  let rate = 1;
  if (value.rate !== undefined) {
    const parsed = readNumber(value.rate);
    if (parsed === undefined || parsed < 0 || parsed > 1) {
      return { error: { param: `${name}.rate`, message: `Invalid ${name}.rate: must be a number between 0 and 1.` } };
    }
    rate = parsed;
  }

  let types: string[] | undefined;
  if (value.types !== undefined) {
    const list = readStringList(value.types);
    const raw = Array.isArray(value.types) ? value.types.length : 1;
    if (list.length === 0 || list.length !== raw) {
      return {
        error: { param: `${name}.types`, message: `Invalid ${name}.types: must be a non-empty list of event types.` },
      };
    }
    types = list;
  }

  let count: number | undefined;
  if (name === "duplicate") {
    count = 1;
    if (value.count !== undefined) {
      const parsed = readInt(value.count);
      if (parsed === undefined || parsed < 1 || parsed > MAX_DUPLICATES) {
        return {
          error: {
            param: "duplicate.count",
            message: `Invalid duplicate.count: must be an integer between 1 and ${MAX_DUPLICATES}.`,
          },
        };
      }
      count = parsed;
    }
  }

  return { rule: { rate, ...(types && { types }), ...(count !== undefined && { count }) } };
}

/** Validate chaos settings from a JSON or form body. A missing seed is replaced by a random one. */
export function parseChaosConfig(
  input: unknown,
): { config: WebhookChaosConfig; error?: undefined } | { config?: undefined; error: ChaosValidationError } {
  const value = input === undefined ? {} : input;
  if (!isRecord(value)) return { error: { param: "", message: "Chaos settings must be an object." } };
  const unknown = unknownKey(value, ["seed", "drop", "duplicate", "delay", "reorder"], "");
  if (unknown) return { error: unknown };

  let seed = randomInt(0, MAX_SEED);
  if (value.seed !== undefined) {
    const parsed = readInt(value.seed);
    if (parsed === undefined || parsed < 0 || parsed > MAX_SEED) {
      return { error: { param: "seed", message: `Invalid seed: must be an integer between 0 and ${MAX_SEED}.` } };
    }
    seed = parsed;
  }

  let reorder: ReorderMode = "none";
  if (value.reorder !== undefined) {
    if (!REORDER_MODES.includes(value.reorder as ReorderMode)) {
      return {
        error: { param: "reorder", message: `Invalid reorder: must be one of ${REORDER_MODES.join(", ")}.` },
      };
    }
    reorder = value.reorder as ReorderMode;
  }

  const drop = parseRule(value.drop, "drop");
  if (drop.error) return { error: drop.error };
  const duplicate = parseRule(value.duplicate, "duplicate");
  if (duplicate.error) return { error: duplicate.error };
  const delay = parseRule(value.delay, "delay");
  if (delay.error) return { error: delay.error };

  return {
    config: {
      seed,
      ...(drop.rule && { drop: { rate: drop.rule.rate, ...(drop.rule.types && { types: drop.rule.types }) } }),
      ...(duplicate.rule && { duplicate: duplicate.rule as DuplicateRule }),
      ...(delay.rule && { delay: { rate: delay.rule.rate, ...(delay.rule.types && { types: delay.rule.types }) } }),
      reorder,
    },
  };
}

export function getWebhookChaos(store: Store): WebhookChaosConfig | undefined {
  return store.getData<ChaosState>(CHAOS_KEY)?.config;
}

/** Replace the chaos settings. The generator restarts from the seed. */
export function setWebhookChaos(store: Store, config: WebhookChaosConfig): void {
  store.setData<ChaosState>(CHAOS_KEY, { config, state: config.seed });
}

export function clearWebhookChaos(store: Store): void {
  store.setData<ChaosState | undefined>(CHAOS_KEY, undefined);
}

function chaosEnabled(config: WebhookChaosConfig | undefined): config is WebhookChaosConfig {
  return !!config && (!!config.drop || !!config.duplicate || !!config.delay || config.reorder !== "none");
}

function formatRule(rule: (ChaosRule & { count?: number }) | undefined) {
  if (!rule) return null;
  return {
    rate: rule.rate,
    types: rule.types ?? null,
    ...(rule.count !== undefined && { count: rule.count }),
  };
}

/** The settings as the control route returns them. */
export function formatWebhookChaos(store: Store) {
  const config = getWebhookChaos(store);
  return {
    object: "webhook_chaos" as const,
    enabled: chaosEnabled(config),
    seed: config?.seed ?? null,
    drop: formatRule(config?.drop),
    duplicate: formatRule(config?.duplicate),
    delay: formatRule(config?.delay),
    reorder: config?.reorder ?? "none",
  };
}

function mulberry32(state: number): { state: number; value: number } {
  const next = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(next ^ (next >>> 15), 1 | next);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { state: next, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

/**
 * A draw function over the stored generator. Every draw is written back at once, so decisions
 * survive a snapshot taken between requests. Without chaos settings it falls back to Math.random.
 */
export function chaosRandom(store: Store): () => number {
  return () => {
    const current = store.getData<ChaosState>(CHAOS_KEY);
    if (!current) return Math.random();
    const { state, value } = mulberry32(current.state);
    store.setData<ChaosState>(CHAOS_KEY, { ...current, state });
    return value;
  };
}

/**
 * A mulberry32 stream of its own, for orderings that must be repeatable without drawing from
 * the chaos generator (so they never shift its later decisions) or from Math.random.
 */
export function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    const draw = mulberry32(state);
    state = draw.state;
    return draw.value;
  };
}

export function reorderItems<T>(items: T[], mode: ReorderMode, random: () => number): T[] {
  if (mode === "reverse") return [...items].reverse();
  if (mode !== "shuffle") return [...items];
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function fires(rule: ChaosRule | undefined, type: string, random: () => number): boolean {
  if (!rule) return false;
  if (rule.types && !rule.types.some((pattern) => eventTypeMatcher(pattern)(type))) return false;
  return random() < rule.rate;
}

export interface ChaosPlan<T> {
  /** Events to send now, already reordered. `copies` counts the original. */
  deliver: Array<{ item: T; copies: number }>;
  dropped: T[];
  held: T[];
}

/**
 * Decide what happens to each event of a batch. Each event is checked for drop, then delay,
 * then duplicate, drawing once per rule that matches its type, and the deliverable list is
 * reordered last.
 */
export function planChaos<T extends { type: string }>(store: Store, items: T[]): ChaosPlan<T> {
  const config = getWebhookChaos(store);
  if (!chaosEnabled(config)) return { deliver: items.map((item) => ({ item, copies: 1 })), dropped: [], held: [] };

  const random = chaosRandom(store);
  const plan: ChaosPlan<T> = { deliver: [], dropped: [], held: [] };
  for (const item of items) {
    if (fires(config.drop, item.type, random)) {
      plan.dropped.push(item);
    } else if (fires(config.delay, item.type, random)) {
      plan.held.push(item);
    } else {
      const extra = fires(config.duplicate, item.type, random) ? config.duplicate!.count : 0;
      plan.deliver.push({ item, copies: 1 + extra });
    }
  }
  plan.deliver = reorderItems(plan.deliver, config.reorder, random);
  return plan;
}

export function getOutbox(store: Store): HeldEvent[] {
  return store.getData<HeldEvent[]>(OUTBOX_KEY) ?? [];
}

export function holdEvents(store: Store, events: Array<{ event_id: string; type: string }>): void {
  if (events.length === 0) return;
  const heldAt = new Date().toISOString();
  store.setData<HeldEvent[]>(OUTBOX_KEY, [
    ...getOutbox(store),
    ...events.map((e) => ({ event_id: e.event_id, type: e.type, held_at: heldAt })),
  ]);
}

/** Remove held events from the outbox, all of them or only `eventIds`, in the order they were held. */
export function takeHeld(store: Store, eventIds?: string[]): HeldEvent[] {
  const outbox = getOutbox(store);
  const wanted = eventIds ? new Set(eventIds) : undefined;
  const taken = outbox.filter((h) => !wanted || wanted.has(h.event_id));
  store.setData<HeldEvent[]>(
    OUTBOX_KEY,
    outbox.filter((h) => !taken.includes(h)),
  );
  return taken;
}
