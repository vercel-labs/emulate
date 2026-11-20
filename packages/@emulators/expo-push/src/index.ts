import type { AppEnv, Context, ServicePlugin, Store } from "@emulators/core";
import type { ExpoPushMessageRecord, ExpoPushRule } from "./entities.js";
import { controlRoutes } from "./routes/control.js";
import { inboxRoutes } from "./routes/inbox.js";
import { pushRoutes } from "./routes/push.js";
import { parseConfig, type ExpoPushSeedConfig } from "./rules.js";
import {
  DEFAULT_CONFIG,
  applyConfig,
  getConfig,
  getExpoPushStore,
  getSeedConfig,
  setConfig,
  setSeedConfig,
} from "./store.js";

export { getExpoPushStore, type ExpoPushStore } from "./store.js";
export { ExpoPushConfigError, type ExpoPushSeedConfig } from "./rules.js";
export * from "./entities.js";

/** Applies a seed `expo-push` block, validated so an unknown key fails at startup with its path. */
export function seedFromConfig(store: Store, _baseUrl: string, config: ExpoPushSeedConfig): void {
  const parsed = parseConfig(config);
  setSeedConfig(store, parsed);
  applyConfig(store, parsed);
}

/** Every recipient record, oldest first. */
export function sentMessages(store: Store): ExpoPushMessageRecord[] {
  return getExpoPushStore(store).messages.all();
}

/** Messages addressed to one Expo push token, oldest first: "what did the service get for token X". */
export function sentTo(store: Store, token: string): ExpoPushMessageRecord[] {
  return getExpoPushStore(store).messages.findBy("token", token);
}

/** Marks a device registered or not. Later receipts for an unregistered device say `DeviceNotRegistered`. */
export function setDeviceRegistered(store: Store, token: string, registered: boolean): void {
  const devices = getExpoPushStore(store).devices;
  const existing = devices.findOneBy("token", token);
  if (existing) devices.update(existing.id, { registered });
  else devices.insert({ token, project: null, platform: null, registered });
}

/** Appends a failure rule at runtime and returns its id. */
export function addFailure(store: Store, rule: NonNullable<ExpoPushSeedConfig["failures"]>[number]): string {
  const config = getConfig(store);
  const parsed = parseConfig({ failures: [{ ...rule, id: rule.id ?? `rule-${config.rules.length + 1}` }] });
  const added: ExpoPushRule = parsed.rules[0];
  if (config.rules.some((existing) => existing.id === added.id)) {
    throw new Error(`expo-push: duplicate rule id "${added.id}"`);
  }
  setConfig(store, { ...config, rules: [...config.rules, added] });
  return added.id;
}

/** Clears the call record and hit counts and restores seeded devices, rules, and ids. */
export function resetExpoPush(store: Store): void {
  applyConfig(store, getSeedConfig(store));
}

function formatError(error: unknown, c: Context<AppEnv>, status: number): Response {
  const message =
    status === 404 ? "Not found. Send to POST /--/api/v2/push/send." : error instanceof Error ? error.message : "Error";
  return c.json({ errors: [{ code: status === 404 ? "NOT_FOUND" : "INTERNAL_SERVER_ERROR", message }] }, status as 404);
}

/** The Expo Push Service emulator plugin. */
export const expoPushPlugin: ServicePlugin = {
  name: "expo-push",
  rateLimit: false,
  formatError,
  register(app, store, webhooks, baseUrl, tokenMap) {
    const ctx = { app, store, webhooks, baseUrl, tokenMap };
    controlRoutes(ctx);
    pushRoutes(ctx);
    inboxRoutes(ctx);
  },
  seed(store) {
    setSeedConfig(store, DEFAULT_CONFIG);
    applyConfig(store, DEFAULT_CONFIG);
  },
};

export default expoPushPlugin;
