import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeError, stripeId, toUnixTimestamp } from "../helpers.js";
import type { StripeSubscription } from "../entities.js";

export function formatSubscription(
  subscription: StripeSubscription,
  ss: ReturnType<typeof getStripeStore>,
) {
  const price = ss.prices.findOneBy("stripe_id", subscription.price_id);
  const product = price
    ? ss.products.findOneBy("stripe_id", price.product_id)
    : null;
  const formattedPrice = price
    ? {
        id: price.stripe_id,
        object: "price",
        product: product
          ? {
              id: product.stripe_id,
              object: "product",
              name: product.name,
              active: product.active,
              livemode: false,
            }
          : price.product_id,
        currency: price.currency,
        unit_amount: price.unit_amount,
        type: price.type,
        billing_scheme: price.billing_scheme,
        tax_behavior: price.tax_behavior,
        recurring: price.recurring,
        active: price.active,
        livemode: false,
      }
    : subscription.price_id;
  return {
    id: subscription.stripe_id,
    object: "subscription",
    customer: subscription.customer_id,
    status: subscription.status,
    cancel_at_period_end: subscription.cancel_at_period_end,
    current_period_end: subscription.current_period_end,
    items: {
      object: "list",
      data: [
        {
          id: `si_${subscription.stripe_id.slice(4)}`,
          object: "subscription_item",
          current_period_end: subscription.current_period_end,
          price: formattedPrice,
          quantity: subscription.quantity,
        },
      ],
      has_more: false,
    },
    metadata: subscription.metadata,
    created: toUnixTimestamp(subscription.created_at),
    livemode: false,
  };
}

function stripeEvent(store: RouteContext["store"], type: string, object: Record<string, unknown>) {
  return {
    id: stripeId("evt"),
    object: "event",
    api_version: store.getData<string>("stripe.api_version") ?? "2026-06-24.preview",
    created: Math.floor(Date.now() / 1000),
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    type,
  };
}

export function subscriptionRoutes({ app, store, webhooks }: RouteContext): void {
  const ss = getStripeStore(store);

  app.get("/v1/subscriptions/:id", (c) => {
    const subscription = ss.subscriptions.findOneBy("stripe_id", c.req.param("id"));
    if (!subscription) {
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such subscription: '${c.req.param("id")}'`,
        "resource_missing",
      );
    }
    return c.json(formatSubscription(subscription, ss));
  });

  app.delete("/v1/subscriptions/:id", async (c) => {
    const subscription = ss.subscriptions.findOneBy("stripe_id", c.req.param("id"));
    if (!subscription) {
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such subscription: '${c.req.param("id")}'`,
        "resource_missing",
      );
    }
    const canceled = ss.subscriptions.update(subscription.id, {
      status: "canceled",
      cancel_at_period_end: false,
    })!;
    const formatted = formatSubscription(canceled, ss);
    await webhooks.dispatch(
      "customer.subscription.deleted",
      undefined,
      stripeEvent(store, "customer.subscription.deleted", formatted),
      "stripe",
    );
    return c.json(formatted);
  });
}
