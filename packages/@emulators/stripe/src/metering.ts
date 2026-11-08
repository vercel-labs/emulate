import type { StripeStore } from "./store.js";
import { stripeId } from "./helpers.js";
import { priceLines } from "./lines.js";
import type {
  MeterFormula,
  StripeBillingMeter,
  StripeInvoice,
  StripeInvoiceLineItem,
  StripeMeterEvent,
  StripeSubscription,
  StripeSubscriptionItem,
} from "./entities.js";

/** Stripe enforces identifier uniqueness, and allows cancellation, for 24 hours after receipt. */
export const METER_EVENT_WINDOW = 86400;

/** A meter event's timestamp may be at most 35 days in the past. */
export const MAX_METER_EVENT_AGE = 35 * 86400;

/** A meter event's timestamp may be at most five minutes in the future. */
export const MAX_METER_EVENT_LEAD = 5 * 60;

export function isMetered(ss: StripeStore, priceId: string): boolean {
  return ss.prices.findOneBy("stripe_id", priceId)?.recurring?.usage_type === "metered";
}

/** The active meter that records `eventName`, if any. */
export function activeMeterFor(ss: StripeStore, eventName: string): StripeBillingMeter | undefined {
  return ss.billingMeters.findBy("event_name", eventName).find((meter) => meter.status === "active");
}

/** Aggregate events with a meter's formula. `last` takes the event with the latest timestamp. */
export function aggregate(events: StripeMeterEvent[], formula: MeterFormula): number {
  if (formula === "count") return events.length;
  if (formula === "last") {
    let latest: StripeMeterEvent | undefined;
    for (const event of events) {
      if (
        !latest ||
        event.timestamp > latest.timestamp ||
        (event.timestamp === latest.timestamp && event.id > latest.id)
      ) {
        latest = event;
      }
    }
    return latest?.value ?? 0;
  }
  return events.reduce((sum, event) => sum + (event.value ?? 0), 0);
}

/** Events of `meterId` for `customerId` with a timestamp in [start, end), leaving out canceled ones. */
export function meterEventsIn(
  ss: StripeStore,
  meterId: string,
  customerId: string,
  start: number,
  end: number,
): StripeMeterEvent[] {
  return ss.meterEvents
    .findBy("customer_id", customerId)
    .filter(
      (event) => event.meter_id === meterId && !event.canceled && event.timestamp >= start && event.timestamp < end,
    );
}

/** The usage of a metered price for one customer and period, as the quantity an invoice bills. */
export function usageQuantity(
  ss: StripeStore,
  meterId: string,
  customerId: string,
  period: { start: number; end: number },
): number {
  const meter = ss.billingMeters.findOneBy("stripe_id", meterId);
  if (!meter) return 0;
  const total = aggregate(meterEventsIn(ss, meterId, customerId, period.start, period.end), meter.formula);
  return Math.max(0, Math.floor(total));
}

/** The in-arrears lines for the metered items of `sub` over `period`, from the usage recorded so far. */
export function usageLines(
  ss: StripeStore,
  sub: StripeSubscription,
  items: StripeSubscriptionItem[],
  period: { start: number; end: number },
) {
  return items.flatMap((item) => {
    const price = ss.prices.findOneBy("stripe_id", item.price_id);
    const meter = price?.recurring?.usage_type === "metered" ? price.recurring.meter : undefined;
    if (!price || !meter) return [];
    const quantity = usageQuantity(ss, meter, sub.customer_id, period);
    return priceLines(ss, sub, item, price, quantity, period, true);
  });
}

/**
 * Recompute the metered lines of a draft from the usage recorded by now, as Stripe does when it
 * finalizes the invoice. Each metered item's lines are replaced as a group.
 */
export function refreshUsageLines(ss: StripeStore, inv: StripeInvoice): void {
  const metered = ss.invoiceLineItems.findBy("invoice_id", inv.stripe_id).filter((line) => line.metered);
  if (metered.length === 0) return;
  const groups = new Map<string, StripeInvoiceLineItem[]>();
  for (const line of metered.sort((a, b) => a.id - b.id)) {
    if (!line.subscription_item_id) continue;
    groups.set(line.subscription_item_id, [...(groups.get(line.subscription_item_id) ?? []), line]);
  }
  for (const [itemId, lines] of groups) {
    const [first] = lines;
    const item = ss.subscriptionItems.findOneBy("stripe_id", itemId);
    const price = first.price_id ? ss.prices.findOneBy("stripe_id", first.price_id) : undefined;
    const meter = price?.recurring?.meter;
    // An item removed since the draft was created keeps the lines it had.
    if (!item || !price || !meter || !first.subscription_id) continue;
    for (const line of lines) ss.invoiceLineItems.delete(line.id);
    const owner = { stripe_id: first.subscription_id, currency: inv.currency };
    const quantity = usageQuantity(ss, meter, inv.customer_id, first.period);
    for (const line of priceLines(ss, owner, item, price, quantity, first.period, true)) {
      ss.invoiceLineItems.insert({ stripe_id: stripeId("il"), invoice_id: inv.stripe_id, ...line });
    }
  }
}
