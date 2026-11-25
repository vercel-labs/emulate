import { Store, type Collection } from "@emulators/core";
import type { ExpoPushDevice, ExpoPushMessageRecord, ExpoPushRequestRecord, ExpoPushRule } from "./entities.js";

export interface ExpoPushStore {
  devices: Collection<ExpoPushDevice>;
  requests: Collection<ExpoPushRequestRecord>;
  messages: Collection<ExpoPushMessageRecord>;
}

export function getExpoPushStore(store: Store): ExpoPushStore {
  return {
    devices: store.collection<ExpoPushDevice>("expo_push.devices", ["token"]),
    requests: store.collection<ExpoPushRequestRecord>("expo_push.requests"),
    messages: store.collection<ExpoPushMessageRecord>("expo_push.messages", ["token", "request_id"]),
  };
}

export interface ExpoPushConfig {
  seed: number;
  accessToken: string | null;
  rules: ExpoPushRule[];
  devices: Array<{ token: string; project: string | null; platform: "ios" | "android" | null; registered: boolean }>;
}

const CONFIG_KEY = "expo_push.config";
const SEED_KEY = "expo_push.seed_config";
const HITS_KEY = "expo_push.hits";
const IDS_KEY = "expo_push.ids";

export const DEFAULT_CONFIG: ExpoPushConfig = { seed: 1, accessToken: null, rules: [], devices: [] };

export function getConfig(store: Store): ExpoPushConfig {
  return store.getData<ExpoPushConfig>(CONFIG_KEY) ?? DEFAULT_CONFIG;
}

export function setConfig(store: Store, config: ExpoPushConfig): void {
  store.setData(CONFIG_KEY, config);
}

export function setSeedConfig(store: Store, config: ExpoPushConfig): void {
  store.setData(SEED_KEY, config);
}

export function getSeedConfig(store: Store): ExpoPushConfig {
  return store.getData<ExpoPushConfig>(SEED_KEY) ?? DEFAULT_CONFIG;
}

/** Hits per rule id; a hit is one recipient that the rule decided. */
export function getHits(store: Store): Record<string, number> {
  let hits = store.getData<Record<string, number>>(HITS_KEY);
  if (!hits) {
    hits = {};
    store.setData(HITS_KEY, hits);
  }
  return hits;
}

/** Next ordinal for deterministic ids. */
export function nextIdOrdinal(store: Store): number {
  const next = (store.getData<number>(IDS_KEY) ?? 0) + 1;
  store.setData(IDS_KEY, next);
  return next;
}

/** Replaces devices, rules, call record, hit counts, and id counter with the given configuration. */
export function applyConfig(store: Store, config: ExpoPushConfig): void {
  const es = getExpoPushStore(store);
  es.devices.clear();
  es.requests.clear();
  es.messages.clear();
  store.setData(HITS_KEY, {});
  store.setData(IDS_KEY, 0);
  setConfig(store, config);
  for (const device of config.devices) es.devices.insert({ ...device });
}
