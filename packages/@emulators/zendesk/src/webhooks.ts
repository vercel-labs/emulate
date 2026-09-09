import { createHmac } from "node:crypto";
import type { ZendeskEventLog, ZendeskWebhook, ZendeskWebhookInvocation } from "./entities.js";
import { formatEventLog } from "./formatters.js";
import { nowIso } from "./helpers.js";
import { ulid } from "./ids.js";
import { accountId, type ZendeskStore } from "./store.js";

export interface ZendeskCtx {
  zs: ZendeskStore;
  baseUrl: string;
}

const MAX_EVENTS = 2000;
const MAX_INVOCATIONS = 1000;

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}${body}`).digest("base64");
}

export function webhookSubscribed(webhook: ZendeskWebhook, type: string): boolean {
  return webhook.subscriptions.some((subscription) => {
    if (subscription === type) return true;
    if (subscription.endsWith("*")) return type.startsWith(subscription.slice(0, -1));
    return false;
  });
}

function authHeaders(webhook: ZendeskWebhook): Record<string, string> {
  const auth = webhook.authentication;
  if (!auth) return {};
  if (auth.type === "basic_auth") {
    return {
      Authorization: `Basic ${Buffer.from(`${auth.data.username ?? ""}:${auth.data.password ?? ""}`).toString("base64")}`,
    };
  }
  if (auth.type === "bearer_token") return { Authorization: `Bearer ${auth.data.token ?? ""}` };
  if (auth.type === "api_key" && auth.data.name) return { [auth.data.name]: auth.data.value ?? "" };
  return {};
}

export async function invokeWebhook(
  ctx: ZendeskCtx,
  webhook: ZendeskWebhook,
  body: string,
  meta: { eventType?: string | null; triggerId?: number | null } = {},
): Promise<ZendeskWebhookInvocation> {
  const { zs } = ctx;
  const invocationId = ulid();
  const timestamp = nowIso();
  const contentType =
    webhook.request_format === "json"
      ? "application/json"
      : webhook.request_format === "xml"
        ? "application/xml"
        : "application/x-www-form-urlencoded";
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "User-Agent": "Zendesk Webhook",
    "X-Zendesk-Webhook-Id": webhook.zd_id,
    "X-Zendesk-Webhook-Invocation-Id": invocationId,
    "X-Zendesk-Webhook-Signature": signWebhook(webhook.signing_secret, timestamp, body),
    "X-Zendesk-Webhook-Signature-Timestamp": timestamp,
    "X-Zendesk-Account-Id": String(accountId(zs)),
    ...webhook.custom_headers,
    ...authHeaders(webhook),
  };
  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;
  let success = false;
  try {
    const hasBody = webhook.http_method !== "GET" && webhook.http_method !== "DELETE";
    const response = await fetch(webhook.endpoint, {
      method: webhook.http_method,
      headers,
      body: hasBody ? body : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    statusCode = response.status;
    success = response.ok;
    try {
      responseBody = typeof response.text === "function" ? await response.text() : null;
    } catch {
      responseBody = null;
    }
    if (!success) errorMessage = `Endpoint responded with HTTP ${response.status}`;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  const invocation = zs.webhookInvocations.insert({
    zd_id: invocationId,
    webhook_id: webhook.zd_id,
    event_type: meta.eventType ?? null,
    trigger_id: meta.triggerId ?? null,
    status: success ? "success" : "failed",
    status_code: statusCode,
    request_body: body,
    request_headers: headers,
    response_body: responseBody,
    error_message: errorMessage,
    completed_at: nowIso(),
  });
  const all = zs.webhookInvocations.all();
  if (all.length > MAX_INVOCATIONS) {
    for (const stale of all.slice(0, all.length - MAX_INVOCATIONS)) zs.webhookInvocations.delete(stale.id);
  }
  return invocation;
}

export async function emitZendeskEvent(
  ctx: ZendeskCtx,
  type: string,
  subject: string,
  detail: Record<string, unknown>,
  event: Record<string, unknown> = {},
): Promise<ZendeskEventLog> {
  const { zs } = ctx;
  const log = zs.events.insert({
    zd_id: ulid(),
    type,
    subject,
    detail,
    event,
    time: nowIso(),
  });
  const all = zs.events.all();
  if (all.length > MAX_EVENTS) {
    for (const stale of all.slice(0, all.length - MAX_EVENTS)) zs.events.delete(stale.id);
  }
  const payload = JSON.stringify(formatEventLog({ zs, baseUrl: ctx.baseUrl }, log));
  const targets = zs.webhooks
    .all()
    .filter((webhook) => webhook.status === "active" && webhookSubscribed(webhook, type));
  for (const webhook of targets) {
    await invokeWebhook(ctx, webhook, payload, { eventType: type });
  }
  return log;
}
