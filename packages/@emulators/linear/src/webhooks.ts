import { createHmac } from "node:crypto";
import type { Store } from "@emulators/core";
import { getLinearStore } from "./store.js";
import { linearId } from "./ids.js";
import type { LinearUser } from "./entities.js";

export interface LinearWebhookEvent {
  type: string;
  action: string;
  data?: unknown;
  actor?: LinearUser | null;
  teamId?: string | null;
  url?: string | null;
  /** For update actions: the entity's payload before the change. Only the properties that changed are sent. */
  previous?: Record<string, unknown>;
  /**
   * The event's own fields, for events such as AgentSessionEvent whose payload has no entity envelope. They replace
   * actor, data, url, and updatedFrom.
   */
  fields?: Record<string, unknown>;
}

function isScalarOrScalarList(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Array.isArray(value) && value.every((entry) => entry === null || typeof entry !== "object");
}

/**
 * Linear's `updatedFrom` is "an object containing the previous values of all updated properties. Properties that
 * were previously not set, will have a value of null." Nested child payloads such as `state` and `labels` are
 * reported through their id fields (`stateId`, `labelIds`).
 */
export function updatedFromValues(previous: Record<string, unknown>, data: unknown): Record<string, unknown> {
  const current = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (!isScalarOrScalarList(value) || !isScalarOrScalarList(previous[key])) continue;
    if (JSON.stringify(previous[key] ?? null) !== JSON.stringify(value ?? null)) changed[key] = previous[key] ?? null;
  }
  if (Object.keys(changed).length > 0 && "updatedAt" in previous && !("updatedAt" in changed)) {
    changed.updatedAt = previous.updatedAt ?? null;
  }
  return changed;
}

export async function dispatchLinearWebhook(store: Store, event: LinearWebhookEvent): Promise<void> {
  const ls = getLinearStore(store);
  const organization = ls.organizations.all()[0];
  const webhooks = ls.webhooks.all().filter((webhook) => {
    if (!webhook.enabled) return false;
    if (!webhook.resource_types.includes(event.type) && !webhook.resource_types.includes("*")) return false;
    if (webhook.all_public_teams) {
      const team = event.teamId ? ls.teams.findOneBy("linear_id", event.teamId) : undefined;
      return !team?.private;
    }
    return webhook.team_id === event.teamId;
  });

  for (const webhook of webhooks) {
    const webhookTimestamp = Date.now();
    const payload = event.fields
      ? {
          action: event.action,
          type: event.type,
          ...event.fields,
          createdAt: new Date().toISOString(),
          organizationId: organization?.linear_id ?? null,
          webhookTimestamp,
          webhookId: webhook.linear_id,
        }
      : entityPayload(event, organization?.linear_id ?? null, webhook.linear_id, webhookTimestamp);
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Accept-Charset": "utf-8",
      "Content-Type": "application/json; charset=utf-8",
      "Linear-Delivery": linearId(),
      "Linear-Event": event.type,
      "Linear-Timestamp": String(webhookTimestamp),
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

function entityPayload(
  event: LinearWebhookEvent,
  organizationId: string | null,
  webhookId: string,
  webhookTimestamp: number,
): Record<string, unknown> {
  return {
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
    organizationId,
    webhookTimestamp,
    webhookId,
    ...(event.previous ? { updatedFrom: updatedFromValues(event.previous, event.data) } : {}),
  };
}
