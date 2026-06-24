import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, ContentfulStatusCode } from "@emulators/core";
import type { TwilioAccount } from "./entities.js";
import type { TwilioStore } from "./store.js";
import type { Entity } from "@emulators/core";

export type TwilioBody = Record<string, string | string[]>;

export async function parseTwilioBody(c: Context): Promise<TwilioBody> {
  const contentType = c.req.header("Content-Type") ?? "";
  const rawText = await c.req.text();
  if (!rawText) return {};

  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const out: TwilioBody = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) out[key] = value.map(String);
      else if (value !== undefined && value !== null) out[key] = String(value);
    }
    return out;
  }

  const params = new URLSearchParams(rawText);
  const out: TwilioBody = {};
  for (const [key, value] of params) {
    const existing = out[key];
    if (Array.isArray(existing)) existing.push(value);
    else if (existing !== undefined) out[key] = [existing, value];
    else out[key] = value;
  }
  return out;
}

export function bodyString(body: TwilioBody, key: string): string | undefined {
  const direct = body[key];
  if (Array.isArray(direct)) return direct[0];
  if (direct !== undefined) return direct;

  const lower = key.toLowerCase();
  const found = Object.entries(body).find(([candidate]) => candidate.toLowerCase() === lower);
  if (!found) return undefined;
  return Array.isArray(found[1]) ? found[1][0] : found[1];
}

export function bodyStrings(body: TwilioBody, key: string): string[] {
  const value = body[key] ?? body[`${key}[]`];
  if (Array.isArray(value)) return value;
  if (value !== undefined) return [value];
  return [];
}

export function twilioError(c: Context, status: number, message: string, code?: number) {
  return c.json(
    {
      code,
      message,
      more_info: code ? `https://www.twilio.com/docs/errors/${code}` : undefined,
      status,
    },
    status as ContentfulStatusCode,
  );
}

export function decodeBasicAuth(c: Context): { username: string; password: string } | null {
  const header = c.req.header("Authorization") ?? "";
  if (!header.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function requireTwilioAuth(c: Context, ts: TwilioStore): TwilioAccount | Response {
  const auth = decodeBasicAuth(c);
  if (!auth) return twilioError(c, 401, "Authenticate", 20003);

  const account = ts.accounts.findOneBy("sid", auth.username);
  if (account && constantTimeEqual(auth.password, account.auth_token)) return account;

  const key = ts.apiKeys.findOneBy("sid", auth.username);
  if (key && key.active && constantTimeEqual(auth.password, key.secret)) {
    const keyAccount = ts.accounts.findOneBy("sid", key.account_sid);
    if (keyAccount) return keyAccount;
  }

  return twilioError(c, 401, "Authenticate", 20003);
}

export function accountFromParam(c: Context, ts: TwilioStore, authenticated: TwilioAccount): TwilioAccount | Response {
  const accountSid = c.req.param("accountSid");
  const account = ts.accounts.findOneBy("sid", accountSid);
  if (!account) return twilioError(c, 404, "The requested resource was not found", 20404);
  if (account.sid !== authenticated.sid) return twilioError(c, 403, "Account access denied", 20003);
  return account;
}

export function twilioDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toUTCString().replace("GMT", "+0000");
}

export function isoDate(): string {
  return new Date().toISOString();
}

export function normalizeMethod(method: string | undefined): string {
  return (method ?? "POST").toUpperCase();
}

export function normalizePhoneNumber(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("whatsapp:")) {
    const number = normalizePhoneNumber(trimmed.slice("whatsapp:".length));
    return number ? `whatsapp:${number}` : null;
  }
  if (/^\+[1-9]\d{6,14}$/.test(trimmed)) return trimmed;
  return null;
}

export function messageSegments(body: string | null): string {
  if (!body) return "0";
  return String(Math.max(1, Math.ceil(body.length / 160)));
}

export function signTwilioRequest(url: string, params: Record<string, string>, authToken: string): string {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");
  return createHmac("sha1", authToken).update(`${url}${sorted}`).digest("base64");
}

export function pageSize(c: Context): number {
  const requested = Number(c.req.query("PageSize") ?? c.req.query("pageSize") ?? 50);
  if (!Number.isFinite(requested)) return 50;
  return Math.min(Math.max(1, requested), 1000);
}

export function pageNumber(c: Context): number {
  const requested = Number(c.req.query("Page") ?? c.req.query("page") ?? 0);
  if (!Number.isFinite(requested)) return 0;
  return Math.max(0, requested);
}

export function twilioList<T extends Entity>(
  c: Context,
  key: string,
  items: T[],
  uri: string,
  formatter: (item: T) => Record<string, unknown>,
) {
  const size = pageSize(c);
  const page = pageNumber(c);
  const start = page * size;
  const records = items.slice(start, start + size);
  const firstPageUri = `${uri}?PageSize=${size}&Page=0`;
  const previousPageUri = page > 0 ? `${uri}?PageSize=${size}&Page=${page - 1}` : null;
  const nextPageUri = start + size < items.length ? `${uri}?PageSize=${size}&Page=${page + 1}` : null;
  return c.json({
    [key]: records.map(formatter),
    end: start + records.length,
    first_page_uri: firstPageUri,
    next_page_uri: nextPageUri,
    page,
    page_size: size,
    previous_page_uri: previousPageUri,
    start,
    uri,
  });
}

export async function dispatchTwilioWebhook(
  ts: TwilioStore,
  account: TwilioAccount,
  event: string,
  url: string | null,
  method: string,
  params: Record<string, string>,
): Promise<void> {
  if (!url) return;
  const normalizedMethod = normalizeMethod(method);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "X-Twilio-Signature": signTwilioRequest(url, params, account.auth_token),
  };
  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let success = false;
  let error: string | null = null;

  try {
    const response = await fetch(url, {
      method: normalizedMethod,
      headers,
      body: normalizedMethod === "GET" ? undefined : new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    responseStatus = response.status;
    responseBody = await response.text();
    success = response.ok;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  ts.webhookDeliveries.insert({
    twilio_id: `TW${String(Date.now())}${String(ts.webhookDeliveries.all().length + 1).padStart(6, "0")}`,
    account_sid: account.sid,
    event,
    url,
    method: normalizedMethod,
    request_body: params,
    request_headers: headers,
    response_status: responseStatus,
    response_body: responseBody,
    success,
    error,
  });
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
