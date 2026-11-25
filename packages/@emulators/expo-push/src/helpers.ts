import { gunzipSync, inflateSync } from "node:zlib";
import type { Context, ContentfulStatusCode } from "@emulators/core";
import type { ExpoPushError } from "./entities.js";

export const MAX_RECIPIENTS_PER_REQUEST = 100;
export const MAX_RECEIPT_IDS = 1000;
/** Payload limit on iOS and Android, from the Expo docs. */
export const MAX_PAYLOAD_BYTES = 4096;

export interface RequestErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export function requestError(c: Context, status: number, code: string, message: string, details?: unknown) {
  const error: RequestErrorBody = { code, message, ...(details === undefined ? {} : { details }) };
  return c.json({ errors: [error] }, status as ContentfulStatusCode);
}

/** Same check as `Expo.isExpoPushToken` in expo-server-sdk. */
export function isExpoPushToken(token: unknown): token is string {
  return (
    typeof token === "string" &&
    (((token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken[")) && token.endsWith("]")) ||
      /^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$/i.test(token))
  );
}

export function errorMessage(error: ExpoPushError, token: string, stage: "ticket" | "receipt"): string {
  switch (error) {
    case "DeviceNotRegistered":
      return stage === "ticket"
        ? `"${token}" is not a registered push notification recipient`
        : "The recipient device is not registered with the push provider.";
    case "MessageTooBig":
      return `Message too big: the total notification payload must be at most ${MAX_PAYLOAD_BYTES} bytes.`;
    case "MessageRateExceeded":
      return "Too many messages are being sent to this device. Retry with exponential backoff.";
    case "MismatchSenderId":
      return "The push token was registered with a different sender id than the credentials of this project.";
    case "InvalidCredentials":
      return "The push credentials of this project are invalid.";
  }
}

/** Reads a JSON body, inflating gzip or deflate as expo-server-sdk sends bodies over 1 KiB compressed. */
export async function readJsonBody(c: Context): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  try {
    let raw = Buffer.from(await c.req.arrayBuffer());
    const encoding = (c.req.header("content-encoding") ?? "").toLowerCase();
    if (encoding === "gzip") raw = gunzipSync(raw);
    else if (encoding === "deflate") raw = inflateSync(raw);
    else if (encoding && encoding !== "identity") {
      return { ok: false, message: `Unsupported content-encoding "${encoding}"` };
    }
    if (raw.length === 0) return { ok: false, message: "Request body must be JSON" };
    return { ok: true, value: JSON.parse(raw.toString("utf8")) };
  } catch {
    return { ok: false, message: "Request body must be valid JSON" };
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STRING_FIELDS = [
  "title",
  "body",
  "subtitle",
  "channelId",
  "categoryId",
  "icon",
  "targetContentId",
  "filterCriteria",
];
const NUMBER_FIELDS = ["ttl", "expiration", "badge", "relevanceScore"];
const BOOLEAN_FIELDS = ["mutableContent", "contentAvailable", "_contentAvailable"];
const PRIORITIES = ["default", "normal", "high"];
const INTERRUPTION_LEVELS = ["active", "critical", "passive", "time-sensitive"];

/** Returns the first violation of the documented message fields, or null. */
export function validateMessage(message: unknown): string | null {
  if (!isPlainObject(message)) return "Each message must be a JSON object";
  const to = message.to;
  if (to === undefined || to === null) return `"to" is required`;
  if (typeof to !== "string" && !(Array.isArray(to) && to.length > 0 && to.every((t) => typeof t === "string"))) {
    return `"to" must be a string or a non-empty array of strings`;
  }
  for (const field of STRING_FIELDS) {
    if (message[field] !== undefined && typeof message[field] !== "string") return `"${field}" must be a string`;
  }
  for (const field of NUMBER_FIELDS) {
    if (message[field] !== undefined && (typeof message[field] !== "number" || !Number.isFinite(message[field]))) {
      return `"${field}" must be a number`;
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (message[field] !== undefined && typeof message[field] !== "boolean") return `"${field}" must be a boolean`;
  }
  const sound = message.sound;
  if (sound !== undefined && sound !== null && typeof sound !== "string") {
    if (!isPlainObject(sound)) return `"sound" must be a string, null, or an object`;
    if (sound.critical !== undefined && typeof sound.critical !== "boolean")
      return `"sound.critical" must be a boolean`;
    if (sound.name !== undefined && sound.name !== null && typeof sound.name !== "string") {
      return `"sound.name" must be a string or null`;
    }
    if (sound.volume !== undefined && (typeof sound.volume !== "number" || !Number.isFinite(sound.volume))) {
      return `"sound.volume" must be a number`;
    }
  }
  if (message.data !== undefined && !isPlainObject(message.data)) return `"data" must be an object`;
  if (message.richContent !== undefined && !isPlainObject(message.richContent))
    return `"richContent" must be an object`;
  if (message.priority !== undefined && !PRIORITIES.includes(message.priority as string)) {
    return `"priority" must be one of [${PRIORITIES.join(", ")}]`;
  }
  if (message.interruptionLevel !== undefined && !INTERRUPTION_LEVELS.includes(message.interruptionLevel as string)) {
    return `"interruptionLevel" must be one of [${INTERRUPTION_LEVELS.join(", ")}]`;
  }
  return null;
}

function mix(state: number): number {
  state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
  state = (Math.imul(state ^ (state >>> 12), 0x297a2d39) + 0x2c1b3c6d) >>> 0;
  return (state ^ (state >>> 15)) >>> 0;
}

export function hashText(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return hash;
}

/** A version 4 shaped UUID derived from the seed and an ordinal, so a replayed scenario gets identical ids. */
export function seededUuid(seed: number, ordinal: number): string {
  const words: number[] = [];
  let state = mix((seed >>> 0) ^ Math.imul(ordinal, 0x9e3779b1));
  for (let i = 0; i < 4; i += 1) {
    state = mix(state + i + 1);
    words.push(state);
  }
  const hex = words.map((w) => w.toString(16).padStart(8, "0")).join("");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Index of the variant a rule uses on its nth hit: one seed-shuffled order, cycled. */
export function variantIndex(seed: number, ruleId: string, hit: number, length: number): number {
  if (length <= 1) return 0;
  let state = (seed ^ hashText(ruleId)) >>> 0;
  const order = Array.from({ length }, (_, index) => index);
  for (let index = length - 1; index > 0; index -= 1) {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
    const swap = state % (index + 1);
    const value = order[index];
    order[index] = order[swap];
    order[swap] = value;
  }
  return order[hit % length];
}
