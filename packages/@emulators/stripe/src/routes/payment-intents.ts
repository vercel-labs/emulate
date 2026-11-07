import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeId, parseStripeBody, stripeError, stripeList, expandedJson } from "../helpers.js";
import { formatCharge, formatPaymentIntent, stripeExpandResolver } from "../formatters.js";
import { eventBatch } from "../events.js";
import type { StripePaymentIntent, PaymentIntentStatus } from "../entities.js";

export function paymentIntentRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);

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

    if (body.customer && !ss.customers.findOneBy("stripe_id", body.customer as string)) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `No such customer: '${body.customer}'`,
        "resource_missing",
        "customer",
      );
    }

    const status: PaymentIntentStatus = body.payment_method ? "requires_confirmation" : "requires_payment_method";

    const pi = ss.paymentIntents.insert({
      stripe_id: stripeId("pi"),
      amount: body.amount as number,
      currency: (body.currency as string).toLowerCase(),
      status,
      customer_id: (body.customer as string) ?? null,
      description: (body.description as string) ?? null,
      payment_method: (body.payment_method as string) ?? null,
      metadata: (body.metadata as Record<string, string>) ?? {},
    });

    const ev = eventBatch(ctx, c);
    ev.emit("payment_intent.created", formatPaymentIntent(pi));
    await ev.commit();

    return expandedJson(c, formatPaymentIntent(pi), expand, body);
  });

  app.get("/v1/payment_intents/:id", (c) => {
    const pi = ss.paymentIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!pi)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such payment_intent: '${c.req.param("id")}'`,
        "resource_missing",
      );
    return expandedJson(c, formatPaymentIntent(pi), expand);
  });

  app.post("/v1/payment_intents/:id", async (c) => {
    const pi = ss.paymentIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!pi)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such payment_intent: '${c.req.param("id")}'`,
        "resource_missing",
      );
    const body = await parseStripeBody(c);

    const updates: Partial<StripePaymentIntent> = {};
    if (body.amount !== undefined) updates.amount = body.amount as number;
    if (body.currency !== undefined) updates.currency = (body.currency as string).toLowerCase();
    if (body.description !== undefined) updates.description = body.description as string;
    if (body.metadata !== undefined) updates.metadata = body.metadata as Record<string, string>;
    if (body.payment_method !== undefined) {
      updates.payment_method = body.payment_method as string;
      if (pi.status === "requires_payment_method") {
        updates.status = "requires_confirmation";
      }
    }

    const updated = ss.paymentIntents.update(pi.id, updates);
    return expandedJson(c, formatPaymentIntent(updated!), expand, body);
  });

  app.post("/v1/payment_intents/:id/confirm", async (c) => {
    const pi = ss.paymentIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!pi)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such payment_intent: '${c.req.param("id")}'`,
        "resource_missing",
      );
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

    const updated = ss.paymentIntents.update(pi.id, {
      status: "succeeded",
      ...(typeof body.payment_method === "string" && { payment_method: body.payment_method }),
    })!;

    const charge = ss.charges.insert({
      stripe_id: stripeId("ch"),
      amount: updated.amount,
      currency: updated.currency,
      status: "succeeded",
      customer_id: updated.customer_id,
      payment_intent_id: updated.stripe_id,
      description: updated.description,
      metadata: updated.metadata,
      ...(updated.payment_method && { payment_method: updated.payment_method }),
    });

    const ev = eventBatch(ctx, c);
    ev.emit("payment_intent.succeeded", formatPaymentIntent(updated));
    ev.emit("charge.succeeded", formatCharge(charge));
    await ev.commit();

    return expandedJson(c, formatPaymentIntent(updated), expand, body);
  });

  app.post("/v1/payment_intents/:id/cancel", async (c) => {
    const pi = ss.paymentIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!pi)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such payment_intent: '${c.req.param("id")}'`,
        "resource_missing",
      );

    if (pi.status === "succeeded" || pi.status === "canceled") {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `This PaymentIntent's status is ${pi.status}, which does not allow cancellation.`,
        "payment_intent_unexpected_state",
      );
    }
    const body = await parseStripeBody(c);

    const updated = ss.paymentIntents.update(pi.id, { status: "canceled" })!;

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
    return stripeList(c, items, "/v1/payment_intents", formatPaymentIntent, { expand });
  });
}
