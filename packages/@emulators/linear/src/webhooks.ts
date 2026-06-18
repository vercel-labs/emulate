import { createHmac } from "node:crypto";
import type { Store } from "@emulators/core";
import { getLinearStore } from "./store.js";
import { linearId } from "./ids.js";
import type { LinearUser } from "./entities.js";

export interface LinearWebhookEvent {
  type: string;
  action: string;
  data: unknown;
  actor?: LinearUser | null;
  teamId?: string | null;
  url?: string | null;
  updatedFrom?: Record<string, unknown>;
}

export async function dispatchLinearWebhook(store: Store, event: LinearWebhookEvent): Promise<void> {
  const ls = getLinearStore(store);
  const organization = ls.organizations.all()[0];
  const webhooks = ls.webhooks.all().filter((webhook) => {
    if (!webhook.enabled) return false;
    if (!webhook.resource_types.includes(event.type) && !webhook.resource_types.includes("*")) return false;
    if (webhook.all_public_teams) return true;
    return webhook.team_id === event.teamId;
  });

  for (const webhook of webhooks) {
    const payload = {
      action: event.action,
      type: event.type,
      actor: event.actor
        ? {
            id: event.actor.linear_id,
            name: event.actor.name,
            displayName: event.actor.display_name,
            email: event.actor.email,
          }
        : null,
      data: event.data,
      url: event.url ?? null,
      createdAt: new Date().toISOString(),
      organizationId: organization?.linear_id ?? null,
      webhookTimestamp: Date.now(),
      webhookId: webhook.linear_id,
      ...(event.updatedFrom ? { updatedFrom: event.updatedFrom } : {}),
    };
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Accept-Charset": "utf-8",
      "Content-Type": "application/json; charset=utf-8",
      "Linear-Delivery": linearId(),
      "Linear-Event": event.type,
      "User-Agent": "Linear-Webhook",
    };
    if (webhook.secret) {
      headers["Linear-Signature"] = createHmac("sha256", webhook.secret).update(body).digest("hex");
    }

    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(webhook.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });
      status = res.status;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    ls.webhookDeliveries.insert({
      linear_id: linearId(),
      webhook_id: webhook.linear_id,
      event: event.type,
      action: event.action,
      url: webhook.url,
      status,
      error,
      payload,
      headers,
    });
  }
}
