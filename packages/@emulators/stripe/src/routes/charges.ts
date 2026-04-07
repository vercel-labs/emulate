import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { toUnixTimestamp, stripeError, stripeList, applyExpand, parseExpand } from "../helpers.js";
import { formatCustomer, formatPaymentIntent } from "../formatters.js";
import type { StripeCharge } from "../entities.js";

function formatCharge(ch: StripeCharge) {
  return {
    id: ch.stripe_id,
    object: "charge" as const,
    amount: ch.amount,
    currency: ch.currency,
    status: ch.status,
    customer: ch.customer_id,
    payment_intent: ch.payment_intent_id,
    description: ch.description,
    metadata: ch.metadata,
    created: toUnixTimestamp(ch.created_at),
    livemode: false,
  };
}

export function chargeRoutes({ app, store }: RouteContext): void {
  const ss = getStripeStore(store);

  const expandResolvers = {
    customer: (id: string) => {
      const cust = ss.customers.findOneBy("stripe_id", id);
      return cust ? formatCustomer(cust) : undefined;
    },
    payment_intent: (id: string) => {
      const pi = ss.paymentIntents.findOneBy("stripe_id", id);
      return pi ? formatPaymentIntent(pi) : undefined;
    },
  };

  app.get("/v1/charges/:id", (c) => {
    const charge = ss.charges.findOneBy("stripe_id", c.req.param("id"));
    if (!charge)
      return stripeError(c, 404, "invalid_request_error", `No such charge: '${c.req.param("id")}'`, "resource_missing");
    const expand = parseExpand(c);
    const result = applyExpand(formatCharge(charge), expand, expandResolvers);
    return c.json(result);
  });

  app.get("/v1/charges", (c) => {
    let items = ss.charges.all();
    const customerId = c.req.query("customer");
    const piId = c.req.query("payment_intent");
    if (customerId) items = items.filter((ch) => ch.customer_id === customerId);
    if (piId) items = items.filter((ch) => ch.payment_intent_id === piId);
    return stripeList(c, items, "/v1/charges", formatCharge);
  });
}
