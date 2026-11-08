import type { Context, RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import {
  stripeId,
  parseStripeBody,
  readBool,
  stripeError,
  stripeList,
  expandedJson,
  readEnum,
  toUnixTimestamp,
} from "../helpers.js";
import { formatPaymentIntent, stripeExpandResolver } from "../formatters.js";
import { eventBatch } from "../events.js";
import { nowFor } from "../clock.js";
import { attemptPayment, newClientSecret, resolvePaymentMethod } from "../payments.js";
import { isInvoicePaymentIntent, settleInvoicePaymentIntent } from "../invoicing.js";
import { insertCardPaymentMethod, sendStripeError } from "./payment-methods.js";
import { testCardByPaymentMethod } from "../test-cards.js";
import type { StripePaymentIntent, StripePaymentMethod, PaymentIntentStatus } from "../entities.js";

const CAPTURE_METHODS = ["automatic", "automatic_async"] as const;
const CONFIRMATION_METHODS = ["automatic", "manual"] as const;
const SETUP_FUTURE_USAGES = ["off_session", "on_session"] as const;
const CANCELLATION_REASONS = ["abandoned", "duplicate", "fraudulent", "requested_by_customer"] as const;

/** `off_session` takes a boolean, or `one_off` / `recurring`, which both mean true. */
function readOffSession(value: unknown): boolean {
  if (value === "one_off" || value === "recurring") return true;
  return readBool(value) ?? false;
}

export function paymentIntentRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);

  const notFound = (c: Context) =>
    stripeError(c, 404, "invalid_request_error", `No such payment_intent: '${c.req.param("id")}'`, "resource_missing", "intent");

  /**
   * Confirm `pi` and respond. Without any payment method the emulator keeps its old
   * behaviour and pays as if `pm_card_visa` were given; real Stripe returns a 400.
   */
  const confirmAndRespond = async (
    c: Context,
    pi: StripePaymentIntent,
    pm: StripePaymentMethod | undefined,
    body: Record<string, unknown>,
    ev = eventBatch(ctx, c),
  ) => {
    const card = pm ?? insertCardPaymentMethod(ss, testCardByPaymentMethod("pm_card_visa")!);
    const attempt = attemptPayment(ctx, ev, pi, card, { offSession: readOffSession(body.off_session) });
    settleInvoicePaymentIntent(ctx, ev, attempt.pi);
    await ev.commit();
    if (attempt.status === "failed") return sendStripeError(c, attempt.error);
    return expandedJson(c, formatPaymentIntent(attempt.pi), expand, body);
  };

  app.post("/v1/payment_intents", async (c) => {
    const body = await parseStripeBody(c);
    if (!body.amount || !body.currency) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "Missing required param: amount and currency are required.",
        undefined,
        "amount",
      );
    }

    const customerId = typeof body.customer === "string" && body.customer !== "" ? body.customer : null;
    if (customerId && !ss.customers.findOneBy("stripe_id", customerId)) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `No such customer: '${customerId}'`,
        "resource_missing",
        "customer",
      );
    }

    const capture = readEnum(c, body.capture_method, CAPTURE_METHODS, "capture_method");
    if (capture.error) return capture.error;
    const confirmation = readEnum(c, body.confirmation_method, CONFIRMATION_METHODS, "confirmation_method");
    if (confirmation.error) return confirmation.error;
    const futureUsage = readEnum(c, body.setup_future_usage, SETUP_FUTURE_USAGES, "setup_future_usage");
    if (futureUsage.error) return futureUsage.error;

    let pm: StripePaymentMethod | undefined;
    if (typeof body.payment_method === "string" && body.payment_method !== "") {
      const resolved = resolvePaymentMethod(ss, body.payment_method, customerId);
      if (!resolved.ok) return sendStripeError(c, resolved.error);
      pm = resolved.pm;
    }

    const status: PaymentIntentStatus = pm ? "requires_confirmation" : "requires_payment_method";
    const id = stripeId("pi");
    const pi = ss.paymentIntents.insert({
      stripe_id: id,
      amount: body.amount as number,
      currency: (body.currency as string).toLowerCase(),
      status,
      customer_id: customerId,
      description: (body.description as string) ?? null,
      payment_method: pm?.stripe_id ?? null,
      metadata: (body.metadata as Record<string, string>) ?? {},
      created: nowFor(ss, { customerId }),
      client_secret: newClientSecret(id),
      capture_method: capture.value,
      confirmation_method: confirmation.value,
      setup_future_usage: futureUsage.value,
    });

    const ev = eventBatch(ctx, c);
    ev.emit("payment_intent.created", formatPaymentIntent(pi));
    if (readBool(body.confirm)) return confirmAndRespond(c, pi, pm, body, ev);
    await ev.commit();

    return expandedJson(c, formatPaymentIntent(pi), expand, body);
  });

  app.get("/v1/payment_intents/:id", (c) => {
    const pi = ss.paymentIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!pi) return notFound(c);
    return expandedJson(c, formatPaymentIntent(pi), expand);
  });

  app.post("/v1/payment_intents/:id", async (c) => {
    const pi = ss.paymentIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!pi) return notFound(c);
    const body = await parseStripeBody(c);

    const futureUsage = readEnum(c, body.setup_future_usage, SETUP_FUTURE_USAGES, "setup_future_usage");
    if (futureUsage.error) return futureUsage.error;

    // Any update clears the previous attempt's error, as on Stripe.
    const updates: Partial<StripePaymentIntent> = { last_payment_error: undefined };
    if (body.amount !== undefined) updates.amount = body.amount as number;
    if (body.currency !== undefined) updates.currency = (body.currency as string).toLowerCase();
    if (body.description !== undefined) updates.description = body.description as string;
    if (body.metadata !== undefined) updates.metadata = body.metadata as Record<string, string>;
    if (futureUsage.value) updates.setup_future_usage = futureUsage.value;
    if (typeof body.payment_method === "string" && body.payment_method !== "") {
      const resolved = resolvePaymentMethod(ss, body.payment_method, pi.customer_id);
      if (!resolved.ok) return sendStripeError(c, resolved.error);
      updates.payment_method = resolved.pm.stripe_id;
      if (pi.status === "requires_payment_method") {
        updates.status = "requires_confirmation";
      }
    }

    const updated = ss.paymentIntents.update(pi.id, updates);
    return expandedJson(c, formatPaymentIntent(updated!), expand, body);
  });

  app.post("/v1/payment_intents/:id/confirm", async (c) => {
    const pi = ss.paymentIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!pi) return notFound(c);
    const body = await parseStripeBody(c);

    if (pi.status !== "requires_confirmation" && pi.status !== "requires_payment_method") {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `This PaymentIntent's status is ${pi.status}, which does not allow confirmation.`,
        "payment_intent_unexpected_state",
      );
    }

    const futureUsage = readEnum(c, body.setup_future_usage, SETUP_FUTURE_USAGES, "setup_future_usage");
    if (futureUsage.error) return futureUsage.error;

    const requested =
      typeof body.payment_method === "string" && body.payment_method !== "" ? body.payment_method : undefined;
    let pm: StripePaymentMethod | undefined;
    if (requested || pi.payment_method) {
      const resolved = resolvePaymentMethod(ss, requested ?? pi.payment_method!, pi.customer_id);
      if (!resolved.ok) return sendStripeError(c, resolved.error);
      pm = resolved.pm;
    }

    const current = futureUsage.value
      ? ss.paymentIntents.update(pi.id, { setup_future_usage: futureUsage.value })!
      : pi;
    return confirmAndRespond(c, current, pm, body);
  });

  app.post("/v1/payment_intents/:id/cancel", async (c) => {
    const pi = ss.paymentIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!pi) return notFound(c);

    if (pi.status === "succeeded" || pi.status === "canceled") {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `This PaymentIntent's status is ${pi.status}, which does not allow cancellation.`,
        "payment_intent_unexpected_state",
      );
    }
    if (isInvoicePaymentIntent(ss, pi.stripe_id)) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "This PaymentIntent was created by an invoice and cannot be canceled directly. Void the invoice instead.",
        "payment_intent_unexpected_state",
      );
    }
    const body = await parseStripeBody(c);
    const reason = readEnum(c, body.cancellation_reason, CANCELLATION_REASONS, "cancellation_reason");
    if (reason.error) return reason.error;

    const updated = ss.paymentIntents.update(pi.id, {
      status: "canceled",
      canceled_at: nowFor(ss, { customerId: pi.customer_id }),
      cancellation_reason: reason.value,
      next_action: undefined,
    })!;

    const ev = eventBatch(ctx, c);
    ev.emit("payment_intent.canceled", formatPaymentIntent(updated));
    await ev.commit();

    return expandedJson(c, formatPaymentIntent(updated), expand, body);
  });

  app.get("/v1/payment_intents", (c) => {
    let items = ss.paymentIntents.all();
    const customerId = c.req.query("customer");
    const status = c.req.query("status");
    if (customerId) items = items.filter((pi) => pi.customer_id === customerId);
    if (status) items = items.filter((pi) => pi.status === status);
    return stripeList(c, items, "/v1/payment_intents", formatPaymentIntent, {
      created: (pi) => pi.created ?? toUnixTimestamp(pi.created_at),
      expand,
    });
  });
}
