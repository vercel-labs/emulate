import type { WebhookDispatcher, WebhookHeaderContext } from "@emulators/core";
import type { EventSource, WebhookStatus } from "./entities.js";
import { formatEvent } from "./formatters.js";
import { prefixedId } from "./ids.js";
import { nowSeconds, type ChargebeeStore } from "./store.js";

export const WEBHOOK_OWNER = "chargebee";

export type EventEmitter = (type: string, content: Record<string, unknown>, source?: EventSource) => Promise<void>;

export interface ChargebeeCtx {
  cs: ChargebeeStore;
  baseUrl: string;
  emit: EventEmitter;
}

export function chargebeeWebhookHeaders({ subscription }: WebhookHeaderContext): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (subscription.secret) {
    headers["Authorization"] = `Basic ${Buffer.from(subscription.secret).toString("base64")}`;
  }
  return headers;
}

export function createEmitter(cs: ChargebeeStore, webhooks: WebhookDispatcher): EventEmitter {
  return async (type, content, source = "api") => {
    const subscriptions = webhooks.getSubscriptions(WEBHOOK_OWNER).filter((sub) => sub.active);
    const matching = subscriptions.filter((sub) => sub.events.includes("*") || sub.events.includes(type));
    const event = cs.events.insert({
      cb_id: prefixedId("ev"),
      event_type: type,
      occurred_at: nowSeconds(cs),
      source,
      user: null,
      content,
      webhook_status: matching.length > 0 ? "scheduled" : "not_configured",
      webhooks: matching.map((sub) => ({ id: String(sub.id), webhook_status: "scheduled" as WebhookStatus })),
    });
    if (matching.length === 0) return;

    await webhooks.dispatch(type, undefined, formatEvent(event), WEBHOOK_OWNER);

    const deliveries = webhooks
      .getDeliveries()
      .filter((delivery) => (delivery.payload as { id?: string } | null)?.id === event.cb_id);
    const hooks = matching.map((sub) => {
      const delivery = deliveries.find((item) => item.hook_id === sub.id);
      const status: WebhookStatus = delivery ? (delivery.success ? "succeeded" : "failed") : "failed";
      return { id: String(sub.id), webhook_status: status };
    });
    cs.events.update(event.id, {
      webhooks: hooks,
      webhook_status: hooks.every((hook) => hook.webhook_status === "succeeded") ? "succeeded" : "failed",
    });
  };
}

export function silentEmitter(): EventEmitter {
  return async () => {};
}
