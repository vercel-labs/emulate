import type { Context, RouteContext, WebhookDelivery, WebhookDispatcher } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { parseStripeBody, readInt, readStringList, stripeError } from "../helpers.js";
import {
  REORDER_MODES,
  clearWebhookChaos,
  formatWebhookChaos,
  getOutbox,
  getWebhookChaos,
  parseChaosConfig,
  reorderItems,
  seededRandom,
  setWebhookChaos,
  type ReorderMode,
} from "../chaos.js";
import { dispatchStoredEvent, eventBatch, releaseHeld } from "../events.js";
import { formatPaymentIntent, formatPaymentMethod, formatSetupIntent } from "../formatters.js";
import {
  completeAuthentication,
  completeSetupAuthentication,
  SIMULATED_BEHAVIORS,
  simulatedBehavior,
  type SimulatedBehaviorName,
} from "../payments.js";
import { DECLINE_CODES } from "../test-cards.js";
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

const MAX_FLUSH_SEED = 0xffffffff;

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

  // Make later charges on a saved card succeed, decline or ask for 3D Secure, as a real card can
  // start doing long after it was set up. Stripe's test cards cannot change behaviour.
  app.post("/_stripe/simulate/payment_methods/:id", async (c) => {
    const id = c.req.param("id");
    const pm = ss.paymentMethods.findOneBy("stripe_id", id);
    if (!pm) {
      return stripeError(c, 404, "invalid_request_error", `No such PaymentMethod: '${id}'`, "resource_missing", "id");
    }
    const body = await parseStripeBody(c);
    const behavior = body.behavior;
    if (typeof behavior !== "string" || !(SIMULATED_BEHAVIORS as readonly string[]).includes(behavior)) {
      return badParam(c, "behavior", `Invalid behavior: must be one of ${SIMULATED_BEHAVIORS.join(", ")}.`);
    }
    const declineCode = body.decline_code;
    if (declineCode !== undefined && (typeof declineCode !== "string" || !DECLINE_CODES.includes(declineCode))) {
      return badParam(
        c,
        "decline_code",
        "Invalid decline_code: must be one of the decline codes at https://docs.stripe.com/declines/codes.",
      );
    }
    const updated = ss.paymentMethods.update(pm.id, {
      simulated: simulatedBehavior(behavior as SimulatedBehaviorName, declineCode),
    })!;
    return c.json(formatPaymentMethod(updated));
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
    let seed = getWebhookChaos(store)?.seed ?? 0;
    if (body.seed !== undefined && body.seed !== "") {
      const parsed = readInt(body.seed);
      if (parsed === undefined || parsed < 0 || parsed > MAX_FLUSH_SEED) {
        return badParam(c, "seed", `Invalid seed: must be an integer between 0 and ${MAX_FLUSH_SEED}.`);
      }
      seed = parsed;
    }

    // A shuffle draws from its own stream, so it is repeatable and leaves the chaos generator alone.
    const held = reorderItems(releaseHeld(store, eventIds), order, seededRandom(seed));
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
    const eventId = c.req.query("event_id");
    const status = c.req.query("status");
    const type = c.req.query("type");
    // Entries are recorded as things happen, so the entity id is the log's order.
    const data: DeliveryRecord[] = ss.webhookAttempts
      .all()
      .sort((a, b) => a.id - b.id)
      .filter((r) => (!eventId || r.event_id === eventId) && (!status || r.status === status))
      .filter((r) => !type || r.type === type)
      .map((r) => ({
        event_id: r.event_id,
        type: r.type,
        status: r.status,
        status_code: r.status_code ?? null,
        url: r.url ?? null,
        delivery_id: r.delivery_id ?? null,
        created: r.created,
      }));

    return c.json({ object: "list", url: "/_stripe/webhooks/deliveries", has_more: false, data });
  });

  app.post("/_stripe/events/:id/redeliver", async (c) => {
    const id = c.req.param("id");
    const event = ss.events.findOneBy("stripe_id", id);
    if (!event) return stripeError(c, 404, "invalid_request_error", `No such event: '${id}'`, "resource_missing", "id");
    const body = await parseStripeBody(c);
    const endpoint = typeof body.endpoint === "string" && body.endpoint !== "" ? body.endpoint : undefined;
    if (endpoint && !event.webhook_targets?.some((target) => target.endpoint === endpoint)) {
      return badParam(c, "endpoint", `The event ${id} was not sent to webhook endpoint '${endpoint}'.`);
    }

    releaseHeld(store, [id]);
    const attempts = await dispatchStoredEvent(ctx, event, { endpoint });
    return c.json({
      object: "webhook_redelivery",
      event_id: id,
      deliveries: attempts.map((d) => formatAttempt(webhooks, d)),
    });
  });
}
