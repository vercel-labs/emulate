import type { Context, RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import {
  expandedJson,
  mergeMetadata,
  parseStripeBody,
  readInt,
  stripeError,
  stripeId,
  stripeList,
  readString,
} from "../helpers.js";
import { nowFor } from "../clock.js";
import { formatSubscription, formatSubscriptionItem, stripeExpandResolver, subscriptionItems } from "../formatters.js";
import { eventBatch } from "../events.js";
import {
  changeBillingInterval,
  checkItemSet,
  emitSubscriptionChange,
  isEnded,
  itemIntervalKey,
  meteredQuantityError,
  readSubscriptionPrice,
} from "../subscriptions.js";
import { isMetered } from "../metering.js";
import { sendStripeError } from "./payment-methods.js";
import type { StripePrice, StripeSubscription, StripeSubscriptionItem } from "../entities.js";

export function subscriptionItemRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);
  const render = (si: StripeSubscriptionItem) => formatSubscriptionItem(ss, si);

  const notFound = (c: Context, id: string) =>
    stripeError(c, 404, "invalid_request_error", `No such subscription item: '${id}'`, "resource_missing", "id");

  const invalidQuantity = (c: Context) =>
    stripeError(
      c,
      400,
      "invalid_request_error",
      "Invalid quantity: must be a non-negative integer.",
      undefined,
      "quantity",
    );

  /** The item set after a change must keep the subscription's currency and interval. */
  const checkPrices = (c: Context, sub: StripeSubscription, prices: StripePrice[]) => {
    const failed = checkItemSet(prices);
    if (failed) return sendStripeError(c, failed);
    if (prices[0].currency !== sub.currency) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "Currency and interval fields must match across all plans on this subscription. Found mismatch in currency field.",
        undefined,
        "price",
      );
    }
    return undefined;
  };

  const ended = (c: Context, sub: StripeSubscription) =>
    stripeError(
      c,
      400,
      "invalid_request_error",
      `The subscription ${sub.stripe_id} is ${sub.status} and its items can no longer be changed.`,
      undefined,
      "subscription",
    );

  const priceOf = (si: StripeSubscriptionItem) => ss.prices.findOneBy("stripe_id", si.price_id)!;

  app.post("/v1/subscription_items", async (c) => {
    const body = await parseStripeBody(c);
    const subId = readString(body.subscription);
    if (!subId) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "Missing required param: subscription.",
        "parameter_missing",
        "subscription",
      );
    }
    const sub = ss.subscriptions.findOneBy("stripe_id", subId);
    if (!sub) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `No such subscription: '${subId}'`,
        "resource_missing",
        "subscription",
      );
    }
    if (isEnded(sub)) return ended(c, sub);
    const price = readSubscriptionPrice(ss, body.price, "price");
    if (!price.ok) return sendStripeError(c, price.error);
    const quantityGiven = body.quantity !== undefined && body.quantity !== "";
    if (quantityGiven && price.price.recurring?.usage_type === "metered") {
      return sendStripeError(c, meteredQuantityError(undefined));
    }
    const quantity = !quantityGiven ? 1 : readInt(body.quantity);
    if (quantity === undefined || quantity < 0) return invalidQuantity(c);
    const current = subscriptionItems(ss, sub.stripe_id);
    const rejected = checkPrices(c, sub, [...current.map(priceOf), price.price]);
    if (rejected) return rejected;

    const before = formatSubscription(ss, sub);
    const si = ss.subscriptionItems.insert({
      stripe_id: stripeId("si"),
      subscription_id: sub.stripe_id,
      price_id: price.price.stripe_id,
      quantity,
      metadata: mergeMetadata({}, body.metadata) ?? {},
      created: nowFor(ss, { customerId: sub.customer_id }),
      current_period_start: current[0].current_period_start,
      current_period_end: current[0].current_period_end,
    });
    const ev = eventBatch(ctx, c);
    emitSubscriptionChange(ss, ev, sub, before);
    await ev.commit();
    return expandedJson(c, render(si), expand, body);
  });

  app.get("/v1/subscription_items", (c) => {
    const subId = c.req.query("subscription");
    if (!subId) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "Missing required param: subscription.",
        "parameter_missing",
        "subscription",
      );
    }
    return stripeList(c, subscriptionItems(ss, subId), "/v1/subscription_items", render, {
      created: (si) => si.created,
      expand,
    });
  });

  app.get("/v1/subscription_items/:id", (c) => {
    const id = c.req.param("id");
    const si = ss.subscriptionItems.findOneBy("stripe_id", id);
    if (!si) return notFound(c, id);
    return expandedJson(c, render(si), expand);
  });

  app.post("/v1/subscription_items/:id", async (c) => {
    const id = c.req.param("id");
    const si = ss.subscriptionItems.findOneBy("stripe_id", id);
    if (!si) return notFound(c, id);
    const sub = ss.subscriptions.findOneBy("stripe_id", si.subscription_id)!;
    const body = await parseStripeBody(c);
    if (isEnded(sub)) return ended(c, sub);

    const updates: Partial<StripeSubscriptionItem> = {};
    if (body.price !== undefined) {
      const price = readSubscriptionPrice(ss, body.price, "price");
      if (!price.ok) return sendStripeError(c, price.error);
      const others = subscriptionItems(ss, sub.stripe_id).filter((item) => item.id !== si.id);
      const rejected = checkPrices(c, sub, [...others.map(priceOf), price.price]);
      if (rejected) return rejected;
      updates.price_id = price.price.stripe_id;
    }
    if (body.quantity !== undefined && body.quantity !== "") {
      if (isMetered(ss, updates.price_id ?? si.price_id)) return sendStripeError(c, meteredQuantityError(undefined));
      const quantity = readInt(body.quantity);
      if (quantity === undefined || quantity < 0) return invalidQuantity(c);
      updates.quantity = quantity;
    }
    const metadata = mergeMetadata(si.metadata, body.metadata);
    if (metadata) updates.metadata = metadata;

    const before = formatSubscription(ss, sub);
    const intervalBefore = itemIntervalKey(ss, sub);
    ss.subscriptionItems.update(si.id, updates);
    const ev = eventBatch(ctx, c);
    if (itemIntervalKey(ss, sub) !== intervalBefore) changeBillingInterval(ctx, ev, sub, before);
    else emitSubscriptionChange(ss, ev, sub, before);
    await ev.commit();
    return expandedJson(c, render(ss.subscriptionItems.get(si.id)!), expand, body);
  });

  app.delete("/v1/subscription_items/:id", async (c) => {
    const id = c.req.param("id");
    const si = ss.subscriptionItems.findOneBy("stripe_id", id);
    if (!si) return notFound(c, id);
    const sub = ss.subscriptions.findOneBy("stripe_id", si.subscription_id)!;
    if (isEnded(sub)) return ended(c, sub);
    if (subscriptionItems(ss, sub.stripe_id).length === 1) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "A subscription must have at least one active price. Cancel the subscription instead of deleting its last item.",
      );
    }
    const before = formatSubscription(ss, sub);
    ss.subscriptionItems.delete(si.id);
    const ev = eventBatch(ctx, c);
    emitSubscriptionChange(ss, ev, sub, before);
    await ev.commit();
    return c.json({ id: si.stripe_id, object: "subscription_item", deleted: true });
  });
}
