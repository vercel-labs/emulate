import type { Context, RouteContext, WebhookDelivery, WebhookDispatcher } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { parseStripeBody, readStringList, stripeError, toUnixTimestamp } from "../helpers.js";
import {
  REORDER_MODES,
  chaosRandom,
  clearWebhookChaos,
  formatWebhookChaos,
  getOutbox,
  parseChaosConfig,
  reorderItems,
  setWebhookChaos,
  takeHeld,
  type ReorderMode,
} from "../chaos.js";
import { dispatchStoredEvent, eventBatch, syncWebhookEndpoints } from "../events.js";
import { formatPaymentIntent, formatSetupIntent } from "../formatters.js";
import { completeAuthentication, completeSetupAuthentication } from "../payments.js";
import { settleInvoicePaymentIntent } from "../invoicing.js";
import { formatBillingSettings, getBillingSettings, parseBillingSettings, setBillingSettings } from "../settings.js";

type DeliveryStatus = "succeeded" | "failed" | "dropped" | "held";

interface DeliveryRecord {
  event_id: string;
  type: string;
  status: DeliveryStatus;
  status_code: number | null;
  url: string | null;
  delivery_id: number | null;
  created: number;
}

function badParam(c: Context, param: string, message: string) {
  return stripeError(c, 400, "invalid_request_error", message, undefined, param || undefined);
}

function eventIdOf(delivery: WebhookDelivery): string | undefined {
  const payload = delivery.payload as { object?: unknown; id?: unknown } | undefined;
  return payload?.object === "event" && typeof payload.id === "string" ? payload.id : undefined;
}

function formatAttempt(webhooks: WebhookDispatcher, d: WebhookDelivery) {
  return {
    url: webhooks.getSubscription(d.hook_id)?.url ?? null,
    status_code: d.status_code,
    succeeded: d.success,
    delivery_id: d.id,
  };
}

/** Emulator-only controls for webhook delivery, Billing settings and customer actions. Real Stripe has no equivalent. */
export function controlRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const ss = getStripeStore(store);

  // The customer completing or failing 3D Secure, which Stripe.js would otherwise drive.
  app.post("/_stripe/simulate/payment_intents/:id/authenticate", async (c) => {
    const id = c.req.param("id");
    const pi = ss.paymentIntents.findOneBy("stripe_id", id);
    if (!pi) {
      return stripeError(c, 404, "invalid_request_error", `No such payment_intent: '${id}'`, "resource_missing", "id");
    }
    const body = await parseStripeBody(c);
    const result = body.result ?? "succeed";
    if (result !== "succeed" && result !== "fail") {
      return badParam(c, "result", "Invalid result: must be one of succeed, fail.");
    }
    if (pi.status !== "requires_action") {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `This PaymentIntent's status is ${pi.status}, so there is no authentication to complete.`,
        "payment_intent_unexpected_state",
      );
    }
    // The customer acted, not an API call, so the events carry no request.
    const ev = eventBatch(ctx);
    const updated = completeAuthentication(ctx, ev, pi, result);
    settleInvoicePaymentIntent(ctx, ev, updated);
    await ev.commit();
    return c.json(formatPaymentIntent(updated));
  });

  // The same step for a SetupIntent, which saves the card once the customer authenticates.
  app.post("/_stripe/simulate/setup_intents/:id/authenticate", async (c) => {
    const id = c.req.param("id");
    const si = ss.setupIntents.findOneBy("stripe_id", id);
    if (!si) {
      return stripeError(c, 404, "invalid_request_error", `No such setupintent: '${id}'`, "resource_missing", "id");
    }
    const body = await parseStripeBody(c);
    const result = body.result ?? "succeed";
    if (result !== "succeed" && result !== "fail") {
      return badParam(c, "result", "Invalid result: must be one of succeed, fail.");
    }
    if (si.status !== "requires_action") {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `This SetupIntent's status is ${si.status}, so there is no authentication to complete.`,
        "setup_intent_unexpected_state",
      );
    }
    const ev = eventBatch(ctx);
    const updated = completeSetupAuthentication(ctx, ev, si, result);
    await ev.commit();
    return c.json(formatSetupIntent(updated));
  });

  // The Dashboard's Billing settings, which have no API on real Stripe.
  app.get("/_stripe/billing/settings", (c) => c.json(formatBillingSettings(getBillingSettings(store))));

  app.post("/_stripe/billing/settings", async (c) => {
    const parsed = parseBillingSettings(await parseStripeBody(c), getBillingSettings(store));
    if (!parsed.ok) return badParam(c, parsed.error.param, parsed.error.message);
    setBillingSettings(store, parsed.settings);
    return c.json(formatBillingSettings(parsed.settings));
  });

  app.get("/_stripe/webhooks/chaos", (c) => c.json(formatWebhookChaos(store)));

  app.post("/_stripe/webhooks/chaos", async (c) => {
    const parsed = parseChaosConfig(await parseStripeBody(c));
    if (parsed.error) return badParam(c, parsed.error.param, parsed.error.message);
    setWebhookChaos(store, parsed.config);
    return c.json(formatWebhookChaos(store));
  });

  app.delete("/_stripe/webhooks/chaos", (c) => {
    clearWebhookChaos(store);
    return c.json(formatWebhookChaos(store));
  });

  app.post("/_stripe/webhooks/flush", async (c) => {
    const body = await parseStripeBody(c);
    const order = (body.order ?? "none") as ReorderMode;
    if (!REORDER_MODES.includes(order)) {
      return badParam(c, "order", `Invalid order: must be one of ${REORDER_MODES.join(", ")}.`);
    }
    const eventIds = body.event_ids === undefined ? undefined : readStringList(body.event_ids);

    const held = reorderItems(takeHeld(store, eventIds), order, chaosRandom(store));
    syncWebhookEndpoints(store, webhooks);
    const flushed: string[] = [];
    for (const entry of held) {
      const event = ss.events.findOneBy("stripe_id", entry.event_id);
      if (!event) continue;
      await dispatchStoredEvent(ctx, event);
      flushed.push(event.stripe_id);
    }
    return c.json({ object: "webhook_flush", flushed, remaining: getOutbox(store).length });
  });

  app.get("/_stripe/webhooks/deliveries", (c) => {
    const records: Array<DeliveryRecord & { at: number }> = [];

    for (const attempt of ss.webhookAttempts.all()) {
      records.push({
        event_id: attempt.event_id,
        type: attempt.type,
        status: attempt.status,
        status_code: null,
        url: attempt.url,
        delivery_id: null,
        created: attempt.created,
        at: Date.parse(attempt.created_at),
      });
    }
    for (const d of webhooks.getDeliveries()) {
      const eventId = eventIdOf(d);
      if (!eventId) continue;
      records.push({
        event_id: eventId,
        type: d.event,
        status: d.success ? "succeeded" : "failed",
        status_code: d.status_code,
        url: webhooks.getSubscription(d.hook_id)?.url ?? null,
        delivery_id: d.id,
        created: toUnixTimestamp(d.delivered_at),
        at: Date.parse(d.delivered_at),
      });
    }
    for (const h of getOutbox(store)) {
      records.push({
        event_id: h.event_id,
        type: h.type,
        status: "held",
        status_code: null,
        url: null,
        delivery_id: null,
        created: toUnixTimestamp(h.held_at),
        at: Date.parse(h.held_at),
      });
    }

    const eventId = c.req.query("event_id");
    const status = c.req.query("status");
    const type = c.req.query("type");
    const data = records
      .sort((a, b) => a.at - b.at)
      .filter((r) => (!eventId || r.event_id === eventId) && (!status || r.status === status))
      .filter((r) => !type || r.type === type)
      .map(({ at: _at, ...record }) => record);

    return c.json({ object: "list", url: "/_stripe/webhooks/deliveries", has_more: false, data });
  });

  app.post("/_stripe/events/:id/redeliver", async (c) => {
    const id = c.req.param("id");
    const event = ss.events.findOneBy("stripe_id", id);
    if (!event) return stripeError(c, 404, "invalid_request_error", `No such event: '${id}'`, "resource_missing", "id");

    takeHeld(store, [id]);
    syncWebhookEndpoints(store, webhooks);
    const attempts = await dispatchStoredEvent(ctx, event);
    return c.json({
      object: "webhook_redelivery",
      event_id: id,
      deliveries: attempts.map((d) => formatAttempt(webhooks, d)),
    });
  });
}
