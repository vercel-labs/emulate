import { createHmac } from "node:crypto";
import type { MailgunEvent, WebhookType } from "./entities.js";
import { formatEvent } from "./formatters.js";
import { token } from "./ids.js";
import { webhookSigningKey, type MailgunStore } from "./store.js";

export interface MailgunCtx {
  ms: MailgunStore;
  baseUrl: string;
}

const MAX_DELIVERIES = 1000;

export function signWebhook(signingKey: string, timestamp: string, nonce: string): string {
  return createHmac("sha256", signingKey).update(`${timestamp}${nonce}`).digest("hex");
}

export function signature(ms: MailgunStore): { timestamp: string; token: string; signature: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = token(50);
  return { timestamp, token: nonce, signature: signWebhook(webhookSigningKey(ms), timestamp, nonce) };
}

export function webhookTypeFor(event: MailgunEvent): WebhookType | null {
  switch (event.event) {
    case "accepted":
      return "accepted";
    case "delivered":
      return "delivered";
    case "opened":
      return "opened";
    case "clicked":
      return "clicked";
    case "unsubscribed":
      return "unsubscribed";
    case "complained":
      return "complained";
    case "failed":
      return event.severity === "temporary" ? "temporary_fail" : "permanent_fail";
    default:
      return null;
  }
}

export async function deliverEventWebhooks(ctx: MailgunCtx, event: MailgunEvent): Promise<void> {
  const { ms } = ctx;
  const type = webhookTypeFor(event);
  if (!type) return;
  const webhooks = ms.webhooks.findBy("domain", event.domain).filter((webhook) => webhook.type === type);
  for (const webhook of webhooks) {
    for (const url of webhook.urls) {
      const payload = JSON.stringify({
        signature: signature(ms),
        "event-data": formatEvent({ ms, baseUrl: ctx.baseUrl }, event),
      });
      let statusCode: number | null = null;
      let success = false;
      let error: string | null = null;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "mailgun/treq-emulate" },
          body: payload,
          signal: AbortSignal.timeout(10_000),
        });
        statusCode = response.status;
        success = response.ok;
        if (!success) error = `Endpoint responded with HTTP ${response.status}`;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      ms.webhookDeliveries.insert({
        domain: event.domain,
        type,
        url,
        event_id: event.event_id,
        status_code: statusCode,
        success,
        error,
        body: payload,
      });
    }
  }
  const all = ms.webhookDeliveries.all();
  if (all.length > MAX_DELIVERIES) {
    for (const stale of all.slice(0, all.length - MAX_DELIVERIES)) ms.webhookDeliveries.delete(stale.id);
  }
}

export async function postForm(
  url: string,
  fields: Record<string, string>,
): Promise<{ status: number | null; ok: boolean; error: string | null }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "mailgun/treq-emulate" },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    return {
      status: response.status,
      ok: response.ok,
      error: response.ok ? null : `Endpoint responded with HTTP ${response.status}`,
    };
  } catch (err) {
    return { status: null, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
