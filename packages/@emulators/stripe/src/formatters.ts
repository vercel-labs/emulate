import { toUnixTimestamp } from "./helpers.js";
import type { StripeCustomer, StripePaymentIntent } from "./entities.js";

export function formatCustomer(c: StripeCustomer) {
  return {
    id: c.stripe_id,
    object: "customer" as const,
    email: c.email,
    name: c.name,
    description: c.description,
    metadata: c.metadata,
    created: toUnixTimestamp(c.created_at),
    livemode: false,
  };
}

export function formatPaymentIntent(pi: StripePaymentIntent) {
  return {
    id: pi.stripe_id,
    object: "payment_intent" as const,
    amount: pi.amount,
    currency: pi.currency,
    status: pi.status,
    customer: pi.customer_id,
    description: pi.description,
    payment_method: pi.payment_method,
    metadata: pi.metadata,
    created: toUnixTimestamp(pi.created_at),
    livemode: false,
  };
}
