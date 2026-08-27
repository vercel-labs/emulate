import { createHash } from "crypto";
import type { Collection, Context } from "@emulators/core";
import type { ResendIdempotencyRecord } from "./entities.js";

export const RESEND_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export const INVALID_IDEMPOTENCY_KEY_MESSAGE = "Idempotency keys, if present, must have between 1 and 256 characters.";
export const INVALID_IDEMPOTENT_REQUEST_MESSAGE =
  "This idempotency key has been used with this HTTP method and endpoint within the last 24 hours, but the request body was modified and doesn’t match the original request.";
export const CONCURRENT_IDEMPOTENT_REQUESTS_MESSAGE =
  "There is another request in progress with the same idempotency key.";

export type IdempotencyDecision =
  | { kind: "reserved"; record: ResendIdempotencyRecord }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "payload_conflict" }
  | { kind: "concurrent" };

export function readIdempotencyKey(c: Context): { present: false } | { present: true; key: string } {
  if (!c.req.raw.headers.has("Idempotency-Key")) return { present: false };
  return { present: true, key: c.req.raw.headers.get("Idempotency-Key") ?? "" };
}

export function isValidIdempotencyKey(key: string): boolean {
  const length = Array.from(key).length;
  return length >= 1 && length <= 256;
}

export function canonicalizeEmailPayload(body: Record<string, unknown>): Record<string, unknown> {
  const canonical: Record<string, unknown> = { ...body };

  canonical.html = body.html ?? null;
  canonical.text = body.text ?? null;
  canonical.cc = canonicalizeAddress(body, "cc", []);
  canonical.bcc = canonicalizeAddress(body, "bcc", []);
  canonical.reply_to = canonicalizeAddress(body, "reply_to", []);
  canonical.headers = body.headers ?? {};
  canonical.tags = body.tags ?? [];
  canonical.scheduled_at = body.scheduled_at ?? null;

  if (Object.prototype.hasOwnProperty.call(body, "to")) {
    canonical.to = canonicalizeAddress(body, "to", body.to);
  }

  return canonical;
}

export function requestFingerprint(value: unknown): string {
  return sha256(stableSerialize(value));
}

export function idempotencyLookupDigest(c: Context, method: string, endpoint: string, key: string): string {
  return sha256(JSON.stringify([credentialNamespace(c), method.toUpperCase(), endpoint, key]));
}

export function reserveIdempotencyRecord(
  records: Collection<ResendIdempotencyRecord>,
  lookupDigest: string,
  fingerprint: string,
  now = Date.now(),
): IdempotencyDecision {
  let existing = records.findOneBy("lookup_digest", lookupDigest);
  if (existing && Date.parse(existing.expires_at) <= now) {
    records.delete(existing.id);
    existing = undefined;
  }

  if (existing) {
    if (existing.state === "in_progress") return { kind: "concurrent" };
    if (existing.request_fingerprint !== fingerprint) return { kind: "payload_conflict" };
    return {
      kind: "replay",
      status: existing.response_status ?? 200,
      body: existing.response_body,
    };
  }

  return {
    kind: "reserved",
    record: records.insert({
      lookup_digest: lookupDigest,
      request_fingerprint: fingerprint,
      state: "in_progress",
      response_status: null,
      response_body: null,
      expires_at: new Date(now + RESEND_IDEMPOTENCY_TTL_MS).toISOString(),
    }),
  };
}

export function completeIdempotencyRecord(
  records: Collection<ResendIdempotencyRecord>,
  recordId: number,
  responseStatus: number,
  responseBody: unknown,
): void {
  const record = records.get(recordId);
  if (!record || record.state !== "in_progress") return;
  records.update(recordId, {
    state: "completed",
    response_status: responseStatus,
    response_body: responseBody,
  });
}

export function releaseIdempotencyRecord(records: Collection<ResendIdempotencyRecord>, recordId: number): void {
  const record = records.get(recordId);
  if (record?.state === "in_progress") records.delete(recordId);
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(sortRecursively(value));
}

function canonicalizeAddress(
  body: Record<string, unknown>,
  field: "to" | "cc" | "bcc" | "reply_to",
  omittedDefault: unknown,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(body, field) || body[field] == null) return omittedDefault;
  const value = body[field];
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value.map((address) => String(address));
  return value;
}

function credentialNamespace(c: Context): string {
  const authenticatedToken = c.get("authToken");
  if (typeof authenticatedToken === "string" && authenticatedToken.length > 0) return `token:${authenticatedToken}`;

  const authorization = c.req.header("Authorization")?.trim();
  if (!authorization) return "anonymous";

  const tokenMatch = authorization.match(/^(?:Bearer|token)\s+(.+)$/i);
  if (tokenMatch) return `token:${tokenMatch[1].trim()}`;

  const separator = authorization.indexOf(" ");
  if (separator === -1) return `authorization:${authorization}`;
  return `authorization:${authorization.slice(0, separator).toLowerCase()} ${authorization.slice(separator + 1).trim()}`;
}

function sortRecursively(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (value === null || typeof value !== "object") return value;

  // A null prototype keeps JSON keys such as "__proto__" as ordinary data.
  const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortRecursively((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
