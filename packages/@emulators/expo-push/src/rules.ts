import {
  EXPO_PUSH_ERRORS,
  type ExpoPushError,
  type ExpoPushFault,
  type ExpoPushMatch,
  type ExpoPushRule,
} from "./entities.js";
import { isPlainObject, variantIndex } from "./helpers.js";
import { DEFAULT_CONFIG, getHits, type ExpoPushConfig } from "./store.js";
import type { Store } from "@emulators/core";

/** Seed `expo-push` block, or the body of `PUT /_expo-push/rules` plus `devices`. */
export interface ExpoPushSeedConfig {
  port?: number;
  /** Seeds ids and the order of rule variants. Default 1. */
  seed?: number;
  /** When set, requests need `Authorization: Bearer <accessToken>`, like Expo's enhanced push security. */
  accessToken?: string;
  devices?: Array<{ token: string; project?: string; platform?: "ios" | "android"; registered?: boolean }>;
  failures?: Array<Omit<ExpoPushRule, "id" | "match"> & { id?: string; match?: ExpoPushMatch }>;
}

const TOP_KEYS = new Set(["port", "seed", "accessToken", "devices", "failures"]);
const MATCH_KEYS = new Set(["token", "title", "body", "channelId", "data"]);

export class ExpoPushConfigError extends Error {}

function fail(path: string, message: string): never {
  throw new ExpoPushConfigError(`expo-push ${path}: ${message}`);
}

function rejectUnknown(obj: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unknown key");
  }
}

function parseFault(raw: unknown, path: string): ExpoPushFault {
  if (!isPlainObject(raw)) return fail(path, "must be an object");
  const at = raw.at;
  if (at === "ok") {
    rejectUnknown(raw, new Set(["at"]), path);
    return { at };
  }
  if (at === "ticket" || at === "receipt") {
    rejectUnknown(raw, new Set(["at", "error", "message"]), path);
    if (!EXPO_PUSH_ERRORS.includes(raw.error as ExpoPushError)) {
      return fail(`${path}.error`, `must be one of ${EXPO_PUSH_ERRORS.join(", ")}`);
    }
    if (raw.message !== undefined && typeof raw.message !== "string")
      return fail(`${path}.message`, "must be a string");
    return { at, error: raw.error as ExpoPushError, ...(raw.message === undefined ? {} : { message: raw.message }) };
  }
  if (at === "request") {
    rejectUnknown(raw, new Set(["at", "status", "code", "message"]), path);
    const status = raw.status;
    if (status !== undefined && (!Number.isInteger(status) || (status as number) < 400 || (status as number) > 599)) {
      return fail(`${path}.status`, "must be an HTTP error status from 400 to 599");
    }
    for (const key of ["code", "message"] as const) {
      if (raw[key] !== undefined && typeof raw[key] !== "string") return fail(`${path}.${key}`, "must be a string");
    }
    return {
      at,
      ...(status === undefined ? {} : { status: status as number }),
      ...(raw.code === undefined ? {} : { code: raw.code as string }),
      ...(raw.message === undefined ? {} : { message: raw.message as string }),
    };
  }
  return fail(`${path}.at`, 'must be "ok", "ticket", "receipt", or "request"');
}

function parseRule(raw: unknown, index: number, ids: Set<string>): ExpoPushRule {
  const path = `failures[${index}]`;
  if (!isPlainObject(raw)) return fail(path, "must be an object");
  rejectUnknown(raw, new Set(["id", "match", "times", "fail"]), path);
  const id = raw.id === undefined ? `rule-${index + 1}` : raw.id;
  if (typeof id !== "string" || !id) return fail(`${path}.id`, "must be a non-empty string");
  if (ids.has(id)) return fail(`${path}.id`, `duplicate rule id "${id}"`);
  ids.add(id);
  const match: ExpoPushMatch = {};
  if (raw.match !== undefined) {
    if (!isPlainObject(raw.match)) return fail(`${path}.match`, "must be an object");
    rejectUnknown(raw.match, MATCH_KEYS, `${path}.match`);
    for (const key of ["token", "title", "body", "channelId"] as const) {
      const value = raw.match[key];
      if (value === undefined) continue;
      if (typeof value !== "string") return fail(`${path}.match.${key}`, "must be a string");
      match[key] = value;
    }
    if (raw.match.data !== undefined) {
      if (!isPlainObject(raw.match.data)) return fail(`${path}.match.data`, "must be an object");
      match.data = raw.match.data;
    }
  }
  if (raw.times !== undefined && (!Number.isInteger(raw.times) || (raw.times as number) < 1)) {
    return fail(`${path}.times`, "must be a positive integer");
  }
  if (raw.fail === undefined) return fail(`${path}.fail`, "is required");
  const fault = Array.isArray(raw.fail)
    ? raw.fail.length === 0
      ? fail(`${path}.fail`, "must not be an empty array")
      : raw.fail.map((f, i) => parseFault(f, `${path}.fail[${i}]`))
    : parseFault(raw.fail, `${path}.fail`);
  return { id, match, ...(raw.times === undefined ? {} : { times: raw.times as number }), fail: fault };
}

/** Validates a seed block into the canonical configuration; an unknown key fails with its path. */
export function parseConfig(raw: unknown): ExpoPushConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_CONFIG, rules: [], devices: [] };
  if (!isPlainObject(raw)) return fail("config", "must be an object");
  rejectUnknown(raw, TOP_KEYS, "config");
  if (raw.seed !== undefined && (!Number.isSafeInteger(raw.seed) || (raw.seed as number) < 0)) {
    return fail("seed", "must be a non-negative integer");
  }
  if (raw.accessToken !== undefined && (typeof raw.accessToken !== "string" || !raw.accessToken)) {
    return fail("accessToken", "must be a non-empty string");
  }
  const devices: ExpoPushConfig["devices"] = [];
  if (raw.devices !== undefined) {
    if (!Array.isArray(raw.devices)) return fail("devices", "must be an array");
    raw.devices.forEach((d, i) => {
      const path = `devices[${i}]`;
      if (!isPlainObject(d)) return fail(path, "must be an object");
      rejectUnknown(d, new Set(["token", "project", "platform", "registered"]), path);
      if (typeof d.token !== "string" || !d.token) return fail(`${path}.token`, "must be a non-empty string");
      if (d.project !== undefined && typeof d.project !== "string") return fail(`${path}.project`, "must be a string");
      if (d.platform !== undefined && d.platform !== "ios" && d.platform !== "android") {
        return fail(`${path}.platform`, 'must be "ios" or "android"');
      }
      if (d.registered !== undefined && typeof d.registered !== "boolean") {
        return fail(`${path}.registered`, "must be a boolean");
      }
      devices.push({
        token: d.token,
        project: (d.project as string | undefined) ?? null,
        platform: (d.platform as "ios" | "android" | undefined) ?? null,
        registered: (d.registered as boolean | undefined) ?? true,
      });
    });
  }
  const ids = new Set<string>();
  let rules: ExpoPushRule[] = [];
  if (raw.failures !== undefined) {
    if (!Array.isArray(raw.failures)) return fail("failures", "must be an array");
    rules = raw.failures.map((r, i) => parseRule(r, i, ids));
  }
  return {
    seed: (raw.seed as number | undefined) ?? DEFAULT_CONFIG.seed,
    accessToken: (raw.accessToken as string | undefined) ?? null,
    rules,
    devices,
  };
}

export interface RecipientView {
  token: string;
  message: Record<string, unknown>;
}

function matches(match: ExpoPushMatch, view: RecipientView): boolean {
  const { token, message } = view;
  if (match.token !== undefined && match.token !== token) return false;
  if (match.title !== undefined && !(typeof message.title === "string" && message.title.includes(match.title))) {
    return false;
  }
  if (match.body !== undefined && !(typeof message.body === "string" && message.body.includes(match.body))) {
    return false;
  }
  if (match.channelId !== undefined && message.channelId !== match.channelId) return false;
  if (match.data !== undefined) {
    const data = isPlainObject(message.data) ? message.data : {};
    for (const [key, value] of Object.entries(match.data)) {
      if (JSON.stringify(data[key]) !== JSON.stringify(value)) return false;
    }
  }
  return true;
}

/** The fault the first matching rule with budget left applies to this recipient, counting one hit; null when none match. */
export function decideFault(store: Store, config: ExpoPushConfig, view: RecipientView): ExpoPushFault | null {
  const hits = getHits(store);
  for (const rule of config.rules) {
    if (!matches(rule.match, view)) continue;
    const hit = hits[rule.id] ?? 0;
    if (rule.times !== undefined && hit >= rule.times) continue;
    hits[rule.id] = hit + 1;
    const variants = Array.isArray(rule.fail) ? rule.fail : [rule.fail];
    return variants[variantIndex(config.seed, rule.id, hit, variants.length)];
  }
  return null;
}
