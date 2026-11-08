import type { StripeStore } from "./store.js";
import { periodBoundary } from "./billing.js";
import { stripeId } from "./helpers.js";
import type { StripeCustomer, StripeSubscription, StripeTestClock } from "./entities.js";

/** Whose clock a timestamp is read from. Objects of a customer on a test clock follow that clock. */
export interface ClockScope {
  customerId?: string | null;
  /** A test clock id, for objects that belong to a clock directly. */
  testClock?: string;
}

/** Stripe deletes a test clock 30 days after it was created. */
export const TEST_CLOCK_LIFETIME = 30 * 86400;

/** A test clock simulates at most three customers. */
export const MAX_CLOCK_CUSTOMERS = 3;

/** Each customer on a test clock may have at most three subscriptions. */
export const MAX_CLOCK_SUBSCRIPTIONS = 3;

function wallClock(): number {
  return Math.floor(Date.now() / 1000);
}

/** The test clock `scope` belongs to, or undefined for objects on the wall clock. */
export function testClockFor(ss: StripeStore, scope: ClockScope = {}): StripeTestClock | undefined {
  let clockId = scope.testClock;
  if (!clockId && scope.customerId) {
    clockId = ss.customers.findOneBy("stripe_id", scope.customerId)?.test_clock;
  }
  return clockId ? ss.testClocks.findOneBy("stripe_id", clockId) : undefined;
}

/**
 * The current time in Unix seconds for objects in `scope`. Every billing object takes its
 * `created` from here: the frozen time for a customer on a test clock and everything billed to
 * them, the wall clock for everyone else.
 */
export function nowFor(ss: StripeStore, scope: ClockScope = {}): number {
  return testClockFor(ss, scope)?.frozen_time ?? wallClock();
}

export function clockCustomers(ss: StripeStore, clockId: string): StripeCustomer[] {
  return ss.customers.all().filter((customer) => customer.test_clock === clockId);
}

function isLive(sub: StripeSubscription): boolean {
  return sub.status !== "canceled" && sub.status !== "incomplete_expired";
}

/** Subscriptions of `customerId` that count towards the per-customer limit of a test clock. */
export function liveSubscriptionCount(ss: StripeStore, customerId: string): number {
  return ss.subscriptions.findBy("customer_id", customerId).filter(isLive).length;
}

/**
 * The furthest `frozen_time` one advance may reach: two intervals of the shortest subscription
 * on the clock, counted on the calendar from the current frozen time, or two years when the
 * clock has no subscriptions.
 */
export function maxAdvanceTime(ss: StripeStore, clock: StripeTestClock): number {
  let limit: number | undefined;
  for (const sub of ss.subscriptions.all()) {
    if (sub.test_clock !== clock.stripe_id || !isLive(sub)) continue;
    const item = ss.subscriptionItems.findOneBy("subscription_id", sub.stripe_id);
    const recurring = item ? ss.prices.findOneBy("stripe_id", item.price_id)?.recurring : undefined;
    if (!recurring) continue;
    const boundary = periodBoundary(clock.frozen_time, recurring.interval, recurring.interval_count, 2);
    limit = limit === undefined ? boundary : Math.min(limit, boundary);
  }
  return limit ?? periodBoundary(clock.frozen_time, "year", 1, 2);
}

/** Put an existing customer, and what is already billed to it, on a test clock. */
export function attachCustomerToClock(ss: StripeStore, customer: StripeCustomer, clockId: string): void {
  ss.customers.update(customer.id, { test_clock: clockId });
  for (const sub of ss.subscriptions.findBy("customer_id", customer.stripe_id)) {
    ss.subscriptions.update(sub.id, { test_clock: clockId });
  }
  for (const inv of ss.invoices.findBy("customer_id", customer.stripe_id)) {
    ss.invoices.update(inv.id, { test_clock: clockId });
  }
  for (const item of ss.invoiceItems.findBy("customer_id", customer.stripe_id)) {
    ss.invoiceItems.update(item.id, { test_clock: clockId });
  }
}

/**
 * Remove a test clock with its customers and every object that belongs to them. Nothing sends
 * an event of its own: the caller announces only test_helpers.test_clock.deleted.
 */
export function deleteTestClockObjects(ss: StripeStore, clock: StripeTestClock): void {
  for (const customer of clockCustomers(ss, clock.stripe_id)) {
    const customerId = customer.stripe_id;
    for (const sub of ss.subscriptions.findBy("customer_id", customerId)) {
      for (const item of ss.subscriptionItems.findBy("subscription_id", sub.stripe_id)) {
        ss.subscriptionItems.delete(item.id);
      }
      ss.subscriptions.delete(sub.id);
    }
    for (const inv of ss.invoices.findBy("customer_id", customerId)) {
      for (const line of ss.invoiceLineItems.findBy("invoice_id", inv.stripe_id)) ss.invoiceLineItems.delete(line.id);
      for (const payment of ss.invoicePayments.findBy("invoice_id", inv.stripe_id)) {
        ss.invoicePayments.delete(payment.id);
      }
      ss.invoices.delete(inv.id);
    }
    for (const item of ss.invoiceItems.findBy("customer_id", customerId)) ss.invoiceItems.delete(item.id);
    for (const pi of ss.paymentIntents.findBy("customer_id", customerId)) {
      for (const charge of ss.charges.findBy("payment_intent_id", pi.stripe_id)) ss.charges.delete(charge.id);
      ss.paymentIntents.delete(pi.id);
    }
    for (const charge of ss.charges.findBy("customer_id", customerId)) ss.charges.delete(charge.id);
    for (const si of ss.setupIntents.findBy("customer_id", customerId)) ss.setupIntents.delete(si.id);
    for (const pm of ss.paymentMethods.findBy("customer_id", customerId)) ss.paymentMethods.delete(pm.id);
    for (const cs of ss.checkoutSessions.findBy("customer_id", customerId)) ss.checkoutSessions.delete(cs.id);
    ss.customers.delete(customer.id);
  }
  ss.testClocks.delete(clock.id);
}

/** A new clock frozen at `frozenTime`. */
export function insertTestClock(ss: StripeStore, frozenTime: number, name?: string): StripeTestClock {
  const created = wallClock();
  return ss.testClocks.insert({
    stripe_id: stripeId("clock"),
    name,
    frozen_time: frozenTime,
    status: "ready",
    created,
    deletes_after: created + TEST_CLOCK_LIFETIME,
  });
}
