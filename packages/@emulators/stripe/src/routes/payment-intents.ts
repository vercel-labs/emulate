import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeId, parseStripeBody, stripeError, stripeList, applyExpand, parseExpand } from "../helpers.js";
import { formatCustomer, formatPaymentIntent } from "../formatters.js";
import type { StripePaymentIntent, PaymentIntentStatus } from "../entities.js";

export function paymentIntentRoutes({ app, store, webhooks }: RouteContext): void {
  const ss = getStripeStore(store);

  const expandResolvers = {
    customer: (id: string) => {
      const cust = ss.customers.findOneBy("stripe_id", id);
      return cust ? formatCustomer(cust) : undefined;
    },
  };

  app.post("/v1/payment_intents", async (c) => {
    const body = await parseStripeBody(c);
    if (!body.amount || !body.currency) {
      return stripeError(c, 400, "invalid_request_error", "Missing required param: amount and currency are required.", undefined, "amount");
    }

    if (body.customer && !ss.customers.findOneBy("stripe_id", body.customer as string)) {
      return stripeError(c, 400, "invalid_request_error", `No such customer: '${body.customer}'`, "resource_missing", "customer");
    }

    const status: PaymentIntentStatus = body.payment_method
      ? "requires_confirmation"
      : "requires_payment_method";

    const pi = ss.paymentIntents.insert({
      stripe_id: stripeId("pi"),
      amount: body.amount,
      currency: (body.currency as string).toLowerCase(),
      status,
      customer_id: body.customer ?? null,
      description: body.description ?? null,
      payment_method: body.payment_method ?? null,
      metadata: body.metadata ?? {},
    });

    await webhooks.dispatch(
      "payment_intent.created",
      undefined,
      { type: "payment_intent.created", data: { object: formatPaymentIntent(pi) } },
      "stripe",
    );

    return c.json(formatPaymentIntent(pi), 200);
  });

  app.get("/v1/payment_intents/:id", (c) => {
    const pi = ss.paymentIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!pi) return stripeError(c, 404, "invalid_request_error", `No such payment_intent: '${c.req.param("id")}'`, "resource_missing");
    const expand = parseExpand(c);
    const result = applyExpand(formatPaymentIntent(pi), expand, expandResolvers);
    return c.json(result);
  });

  app.post("/v1/payment_intents/:id", async (c) => {
    const pi = ss.paymentIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!pi) return stripeError(c, 404, "invalid_request_error", `No such payment_intent: '${c.req.param("id")}'`, "resource_missing");
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
    return c.json(formatPaymentIntent(updated!));
  });

  app.post("/v1/payment_intents/:id/confirm", async (c) => {
    const pi = ss.paymentIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!pi) return stripeError(c, 404, "invalid_request_error", `No such payment_intent: '${c.req.param("id")}'`, "resource_missing");
    const body = await parseStripeBody(c);

    if (pi.status !== "requires_confirmation" && pi.status !== "requires_payment_method") {
      return stripeError(c, 400, "invalid_request_error", `This PaymentIntent's status is ${pi.status}, which does not allow confirmation.`, "payment_intent_unexpected_state");
    }

    if (body.payment_method) {
      ss.paymentIntents.update(pi.id, { payment_method: body.payment_method as string });
    }

    const updated = ss.paymentIntents.update(pi.id, { status: "succeeded" })!;

    const charge = ss.charges.insert({
      stripe_id: stripeId("ch"),
      amount: updated.amount,
      currency: updated.currency,
      status: "succeeded",
      customer_id: updated.customer_id,
      payment_intent_id: updated.stripe_id,
      description: updated.description,
      metadata: updated.metadata,
    });

    await webhooks.dispatch(
      "payment_intent.succeeded",
      undefined,
      { type: "payment_intent.succeeded", data: { object: formatPaymentIntent(updated) } },
      "stripe",
    );

    await webhooks.dispatch(
      "charge.succeeded",
      undefined,
      { type: "charge.succeeded", data: { object: { id: charge.stripe_id, object: "charge", amount: charge.amount, currency: charge.currency, status: charge.status } } },
      "stripe",
    );

    return c.json(formatPaymentIntent(updated));
  });

  app.post("/v1/payment_intents/:id/cancel", async (c) => {
    const pi = ss.paymentIntents.findOneBy("stripe_id", c.req.param("id"));
    if (!pi) return stripeError(c, 404, "invalid_request_error", `No such payment_intent: '${c.req.param("id")}'`, "resource_missing");

    if (pi.status === "succeeded" || pi.status === "canceled") {
      return stripeError(c, 400, "invalid_request_error", `This PaymentIntent's status is ${pi.status}, which does not allow cancellation.`, "payment_intent_unexpected_state");
    }

    const updated = ss.paymentIntents.update(pi.id, { status: "canceled" })!;

    await webhooks.dispatch(
      "payment_intent.canceled",
      undefined,
      { type: "payment_intent.canceled", data: { object: formatPaymentIntent(updated) } },
      "stripe",
    );

    return c.json(formatPaymentIntent(updated));
  });

  app.get("/v1/payment_intents", (c) => {
    let items = ss.paymentIntents.all();
    const customerId = c.req.query("customer");
    const status = c.req.query("status");
    if (customerId) items = items.filter((pi) => pi.customer_id === customerId);
    if (status) items = items.filter((pi) => pi.status === status);
    return stripeList(c, items, "/v1/payment_intents", formatPaymentIntent);
  });
}
