import { getStripeStore, type StripeStore } from "./store.js";
import { stripeId } from "./helpers.js";
import { liveSubscriptionCount, MAX_CLOCK_SUBSCRIPTIONS, nowFor } from "./clock.js";
import { nextPeriodEnd } from "./periods.js";
import { previousAttributes, type EventBatch } from "./events.js";
import { formatSubscription, subscriptionItems, MAX_SUBSCRIPTION_ITEMS } from "./formatters.js";
import { priceAmount } from "./pricing.js";
import { priceLines, productName } from "./lines.js";
import { usageLines } from "./metering.js";
import {
  applyResume,
  createInvoice,
  finalizeInvoice,
  noPaymentMethodError,
  payInvoice,
  type InvoicingContext,
  type LineFields,
} from "./invoicing.js";
import type { StripeErrorSpec } from "./routes/payment-methods.js";
import type {
  InvoiceBillingReason,
  ResumePaymentBehavior,
  StripeInvoice,
  StripePrice,
  StripeSubscription,
  StripeSubscriptionCancellationDetails,
  StripeSubscriptionItem,
  SubscriptionCancellationReason,
  SubscriptionPauseReason,
} from "./entities.js";

export type SubscriptionResult = { ok: true; sub: StripeSubscription } | { ok: false; error: StripeErrorSpec };

export type PaymentBehavior = "allow_incomplete" | "default_incomplete" | "error_if_incomplete";

/** Stripe sends customer.subscription.trial_will_end three days before a trial ends. */
export const TRIAL_WILL_END_LEAD = 3 * 86400;

/** Trials may last at most two years. */
export const MAX_TRIAL_SECONDS = 730 * 86400;

function invalidRequest(message: string, param?: string, code?: string): StripeErrorSpec {
  return { status: 400, type: "invalid_request_error", message, code, param };
}

/** An EventBatch that keeps its events until they are replayed into another batch. */
function deferredBatch(): EventBatch & { replay(into: EventBatch): void } {
  const held: Array<[string, Record<string, unknown>, Record<string, unknown> | undefined]> = [];
  return {
    emit(type, object, previous) {
      held.push([type, object, previous]);
    },
    async commit() {},
    replay(into) {
      for (const [type, object, previous] of held.splice(0)) into.emit(type, object, previous);
    },
  };
}

/**
 * Check that `priceId` names a recurring price a subscription item can use. `param` is the
 * request param errors point at, such as `items[0][price]`.
 */
export function readSubscriptionPrice(
  ss: StripeStore,
  priceId: unknown,
  param: string,
): { ok: true; price: StripePrice } | { ok: false; error: StripeErrorSpec } {
  if (typeof priceId !== "string" || priceId === "") {
    return { ok: false, error: invalidRequest(`Missing required param: ${param}.`, param, "parameter_missing") };
  }
  const price = ss.prices.findOneBy("stripe_id", priceId);
  if (!price) return { ok: false, error: invalidRequest(`No such price: '${priceId}'`, param, "resource_missing") };
  if (price.type !== "recurring" || !price.recurring) {
    return {
      ok: false,
      error: invalidRequest(
        "The price specified is set to `type=one_time` but this field only accepts prices with `type=recurring`.",
        param,
      ),
    };
  }
  if (!price.active) {
    return {
      ok: false,
      error: invalidRequest(`The price specified is inactive. This field only accepts active prices.`, param),
    };
  }
  return { ok: true, price };
}

/**
 * The 400 for a quantity sent with a metered price, which bills usage instead. `owner` is the
 * param holding the quantity, such as `items[0]`, or undefined for a top-level `quantity`.
 */
export function meteredQuantityError(owner: string | undefined): StripeErrorSpec {
  const param = owner ? `${owner}[quantity]` : "quantity";
  const from = owner ? `\`${owner}\`` : "the request";
  return invalidRequest(
    `Quantity should not be specified where usage_type is \`metered\`. Remove quantity from ${from}.`,
    param,
  );
}

/**
 * The rules every set of subscription items keeps: one to twenty items, one price each, and a
 * single currency and billing interval.
 */
export function checkItemSet(prices: StripePrice[]): StripeErrorSpec | undefined {
  if (prices.length === 0) return invalidRequest("A subscription must have at least one active price.", "items");
  if (prices.length > MAX_SUBSCRIPTION_ITEMS) {
    return invalidRequest(`You can only pass up to ${MAX_SUBSCRIPTION_ITEMS} items.`, "items");
  }
  const ids = new Set<string>();
  for (const price of prices) {
    if (ids.has(price.stripe_id)) {
      return invalidRequest(`Cannot add multiple subscription items with the same price: ${price.stripe_id}.`, "items");
    }
    ids.add(price.stripe_id);
  }
  const [first] = prices;
  if (prices.some((p) => p.currency !== first.currency)) {
    return invalidRequest(
      "Currency and interval fields must match across all plans on this subscription. Found mismatch in currency field.",
      "items",
    );
  }
  const interval = (p: StripePrice) => `${p.recurring?.interval}/${p.recurring?.interval_count}`;
  if (prices.some((p) => interval(p) !== interval(first))) {
    return invalidRequest(
      "Currency and interval fields must match across all plans on this subscription. Found mismatch in interval field.",
      "items",
    );
  }
  return undefined;
}

export { formatMoney, intervalText } from "./lines.js";

/**
 * The invoice lines for one billing period of `items`, billed in advance. A trial bills each
 * item at 0 with "Free trial" in the description. Per-unit prices give one line per item and
 * tiered prices one line per tier reached, plus one for each flat fee. Metered prices are
 * billed in arrears by usageLines and get no line here.
 */
export function subscriptionLines(
  ss: StripeStore,
  sub: StripeSubscription,
  items: StripeSubscriptionItem[],
  period: { start: number; end: number },
  trial: boolean,
): LineFields[] {
  const lines: LineFields[] = [];
  for (const item of items) {
    const price = ss.prices.findOneBy("stripe_id", item.price_id);
    if (!price?.recurring || price.recurring.usage_type === "metered") continue;
    if (trial) {
      lines.push({
        amount: 0,
        currency: sub.currency,
        description: `Free trial for ${item.quantity} × ${productName(ss, price)}`,
        discountable: true,
        metadata: {},
        period: { ...period },
        price_id: price.stripe_id,
        product_id: price.product_id,
        unit_amount_decimal: "0",
        quantity: item.quantity,
        proration: false,
        subscription_item_id: item.stripe_id,
        subscription_id: sub.stripe_id,
      });
      continue;
    }
    lines.push(...priceLines(ss, sub, item, price, item.quantity, period));
  }
  return lines;
}

/** The interval every item of a subscription bills on. */
function subscriptionInterval(ss: StripeStore, items: StripeSubscriptionItem[]) {
  for (const item of items) {
    const recurring = ss.prices.findOneBy("stripe_id", item.price_id)?.recurring;
    if (recurring) return recurring;
  }
  return { interval: "month" as const, interval_count: 1 };
}

/**
 * Create the invoice for the period the subscription's items are in now and make it the
 * latest invoice. Events go to `ev`; invoice.created comes out of it like any other.
 */
function invoiceSubscription(
  ctx: InvoicingContext,
  ev: EventBatch,
  sub: StripeSubscription,
  billingReason: InvoiceBillingReason,
  trial: boolean,
  autoAdvance: boolean,
  invoicePeriod?: { start: number; end: number },
  usagePeriod?: { start: number; end: number },
): StripeInvoice {
  const ss = getStripeStore(ctx.store);
  const items = subscriptionItems(ss, sub.stripe_id);
  const period = { start: items[0].current_period_start, end: items[0].current_period_end };
  const lines = subscriptionLines(ss, sub, items, period, trial);
  if (usagePeriod) lines.push(...usageLines(ss, sub, items, usagePeriod));
  const inv = createInvoice(ctx, ev, {
    period: invoicePeriod,
    customerId: sub.customer_id,
    currency: sub.currency,
    collectionMethod: sub.collection_method,
    autoAdvance,
    daysUntilDue: sub.collection_method === "send_invoice" ? sub.days_until_due : undefined,
    billingReason,
    subscriptionId: sub.stripe_id,
    subscriptionMetadata: { ...sub.metadata },
    lines,
  });
  ss.subscriptions.update(sub.id, { latest_invoice: inv.stripe_id });
  return inv;
}

/**
 * Finalize a subscription invoice and, for automatic collection, attempt it the way Billing
 * does. Returns the payment error, if any, for `error_if_incomplete`.
 */
function collectSubscriptionInvoice(
  ctx: InvoicingContext,
  ev: EventBatch,
  sub: StripeSubscription,
  inv: StripeInvoice,
  attempt: boolean,
): StripeErrorSpec | undefined {
  const finalized = finalizeInvoice(ctx, ev, inv);
  if (!finalized.ok) return finalized.error;
  if (finalized.invoice.status !== "open" || !attempt || sub.collection_method !== "charge_automatically") {
    return undefined;
  }
  const paid = payInvoice(ctx, ev, finalized.invoice, { automatic: true, offSession: sub.off_session ?? false });
  return paid.ok ? undefined : paid.error;
}

/** The payment method Billing would charge for this subscription, if there is one. */
export function subscriptionPaymentMethod(ss: StripeStore, customerId: string, subscriptionDefault?: string) {
  return (
    subscriptionDefault ?? ss.customers.findOneBy("stripe_id", customerId)?.invoice_settings?.default_payment_method
  );
}

export interface SubscriptionItemInput {
  price: StripePrice;
  quantity: number;
  metadata: Record<string, string>;
}

export interface CreateSubscriptionParams {
  customerId: string;
  items: SubscriptionItemInput[];
  collectionMethod: StripeSubscription["collection_method"];
  daysUntilDue?: number;
  defaultPaymentMethod?: string;
  description?: string;
  metadata: Record<string, string>;
  /** The end of a trial. Undefined, or not in the future, means no trial. */
  trialEnd?: number;
  trialMissingPaymentMethod?: StripeSubscription["trial_missing_payment_method"];
  cancelAt?: number | "max_period_end" | "min_period_end";
  cancelAtPeriodEnd: boolean;
  paymentBehavior: PaymentBehavior;
  saveDefaultPaymentMethod?: StripeSubscription["save_default_payment_method"];
  offSession?: boolean;
}

/**
 * Create a subscription with its first invoice, finalized and, for automatic collection,
 * paid in the same request. The subscription starts `incomplete` and becomes `active` when the
 * invoice is paid, `trialing` during a trial, and `active` at once for `send_invoice`.
 * Sends customer.subscription.created before the invoice events. With
 * `error_if_incomplete`, a failed payment is returned as an error and the caller must discard
 * the objects and events this created.
 */
export function createSubscription(
  ctx: InvoicingContext,
  ev: EventBatch,
  params: CreateSubscriptionParams,
): SubscriptionResult {
  const ss = getStripeStore(ctx.store);
  const customer = ss.customers.findOneBy("stripe_id", params.customerId);
  if (customer?.test_clock && liveSubscriptionCount(ss, customer.stripe_id) >= MAX_CLOCK_SUBSCRIPTIONS) {
    return {
      ok: false,
      error: invalidRequest(
        `A customer on a test clock can have at most ${MAX_CLOCK_SUBSCRIPTIONS} subscriptions.`,
        "customer",
      ),
    };
  }
  const now = nowFor(ss, { customerId: params.customerId });
  const trial = params.trialEnd !== undefined && params.trialEnd > now;
  const recurring = params.items[0].price.recurring!;
  const anchor = trial ? params.trialEnd! : now;
  const periodEnd = trial ? params.trialEnd! : nextPeriodEnd(anchor, recurring.interval, recurring.interval_count, now);
  const charged = params.collectionMethod === "charge_automatically";

  const dueNow = params.items.reduce(
    (sum, item) =>
      item.price.recurring?.usage_type === "metered" ? sum : sum + priceAmount(item.price, item.quantity),
    0,
  );
  if (
    charged &&
    !trial &&
    dueNow > 0 &&
    params.paymentBehavior !== "default_incomplete" &&
    !subscriptionPaymentMethod(ss, params.customerId, params.defaultPaymentMethod)
  ) {
    return { ok: false, error: noPaymentMethodError() };
  }

  const cancelAt =
    params.cancelAtPeriodEnd || params.cancelAt === "max_period_end" || params.cancelAt === "min_period_end"
      ? periodEnd
      : params.cancelAt;
  const sub = ss.subscriptions.insert({
    stripe_id: stripeId("sub"),
    customer_id: params.customerId,
    status: trial ? "trialing" : charged ? "incomplete" : "active",
    currency: params.items[0].price.currency,
    collection_method: params.collectionMethod,
    days_until_due: params.daysUntilDue,
    default_payment_method: params.defaultPaymentMethod,
    description: params.description,
    metadata: params.metadata,
    created: now,
    start_date: now,
    billing_cycle_anchor: anchor,
    cancel_at: cancelAt,
    cancel_at_period_end: params.cancelAtPeriodEnd,
    canceled_at: cancelAt !== undefined ? now : undefined,
    cancellation_details: cancelAt !== undefined ? requestedCancellation({}) : {},
    trial_start: trial ? now : undefined,
    trial_end: trial ? params.trialEnd : undefined,
    trial_missing_payment_method: params.trialMissingPaymentMethod,
    off_session: params.offSession,
    save_default_payment_method: params.saveDefaultPaymentMethod,
    test_clock: customer?.test_clock,
  });
  for (const item of params.items) {
    ss.subscriptionItems.insert({
      stripe_id: stripeId("si"),
      subscription_id: sub.stripe_id,
      price_id: item.price.stripe_id,
      quantity: item.quantity,
      metadata: item.metadata,
      created: now,
      current_period_start: now,
      current_period_end: periodEnd,
    });
  }

  // The subscription is announced first, already pointing at its first invoice.
  const held = deferredBatch();
  const attempt = params.paymentBehavior !== "default_incomplete";
  const inv = invoiceSubscription(ctx, held, sub, "subscription_create", trial, attempt);
  ev.emit("customer.subscription.created", formatSubscription(ss, ss.subscriptions.get(sub.id)!));
  held.replay(ev);

  const failure = collectSubscriptionInvoice(ctx, ev, sub, ss.invoices.get(inv.id) ?? inv, attempt);
  if (failure && params.paymentBehavior === "error_if_incomplete") return { ok: false, error: failure };

  const current = ss.subscriptions.get(sub.id)!;
  if (trial && current.trial_end! - now <= TRIAL_WILL_END_LEAD) {
    const warned = ss.subscriptions.update(sub.id, { trial_will_end_sent_for: current.trial_end })!;
    ev.emit("customer.subscription.trial_will_end", formatSubscription(ss, warned));
    return { ok: true, sub: warned };
  }
  return { ok: true, sub: current };
}

/**
 * End a trial now: a new billing period starts, the subscription turns `active` and the
 * period is invoiced with `billing_reason` `subscription_update`. A failed payment leaves it
 * `past_due`. The caller sends customer.subscription.updated.
 */
export function endTrialNow(ctx: InvoicingContext, ev: EventBatch, sub: StripeSubscription): StripeSubscription {
  const ss = getStripeStore(ctx.store);
  const now = nowFor(ss, { customerId: sub.customer_id });
  const items = subscriptionItems(ss, sub.stripe_id);
  const { interval, interval_count } = subscriptionInterval(ss, items);
  const end = nextPeriodEnd(now, interval, interval_count, now);
  for (const item of items)
    ss.subscriptionItems.update(item.id, { current_period_start: now, current_period_end: end });
  const active = ss.subscriptions.update(sub.id, {
    status: "active",
    trial_end: now,
    billing_cycle_anchor: now,
    cancel_at: sub.cancel_at_period_end ? end : sub.cancel_at,
  })!;
  const inv = invoiceSubscription(ctx, ev, active, "subscription_update", false, true);
  const failure = collectSubscriptionInvoice(ctx, ev, active, ss.invoices.get(inv.id) ?? inv, true);
  const current = ss.subscriptions.get(sub.id)!;
  if (failure && current.status === "active") return ss.subscriptions.update(sub.id, { status: "past_due" })!;
  return current;
}

/** The period the items of a subscription are in now. */
function currentItemPeriod(items: StripeSubscriptionItem[]): { start: number; end: number } {
  return { start: items[0].current_period_start, end: items[0].current_period_end };
}

/**
 * Open a new billing period for every item and invoice it with `billing_reason`
 * `subscription_cycle`. The draft looks back on the period that just ended, auto-advances and
 * is finalized an hour later. Licensed items are billed in advance for the new period, metered
 * items in arrears for the period that ended, unless that period was a trial. Sends
 * customer.subscription.updated, carrying the old `items` and `latest_invoice` (and `status`
 * when it changed), before invoice.created.
 */
function startCycle(
  ctx: InvoicingContext,
  ev: EventBatch,
  sub: StripeSubscription,
  updates: Partial<StripeSubscription>,
  periodEnd: (item: StripeSubscriptionItem) => number,
  autoAdvance: boolean,
): StripeSubscription {
  const ss = getStripeStore(ctx.store);
  const before = formatSubscription(ss, sub);
  const items = subscriptionItems(ss, sub.stripe_id);
  const lookBack = currentItemPeriod(items);
  for (const item of items) {
    ss.subscriptionItems.update(item.id, {
      current_period_start: item.current_period_end,
      current_period_end: periodEnd(item),
    });
  }
  const updated = ss.subscriptions.update(sub.id, updates)!;
  const held = deferredBatch();
  const usagePeriod = sub.status === "trialing" ? undefined : lookBack;
  invoiceSubscription(ctx, held, updated, "subscription_cycle", false, autoAdvance, lookBack, usagePeriod);
  const current = ss.subscriptions.get(sub.id)!;
  emitSubscriptionChange(ss, ev, current, before);
  held.replay(ev);
  return current;
}

/**
 * Whether the trial of `sub` would end by canceling or pausing it rather than invoicing: it
 * collects automatically, `trial_settings.end_behavior.missing_payment_method` is `cancel` or
 * `pause`, and neither the subscription nor its customer has a default payment method.
 * Payment sources are not modelled, so `default_source` never counts.
 */
export function trialEndsWithoutInvoice(ss: StripeStore, sub: StripeSubscription): boolean {
  const behavior = sub.trial_missing_payment_method;
  return (
    sub.collection_method === "charge_automatically" &&
    (behavior === "cancel" || behavior === "pause") &&
    !subscriptionPaymentMethod(ss, sub.customer_id, sub.default_payment_method)
  );
}

/**
 * The scheduled end of a trial: the subscription turns `active`, `billing_cycle_anchor` moves
 * to the trial end and the first paid period is invoiced as a `subscription_cycle` draft. With
 * no payment method on file, `missing_payment_method` may instead cancel the subscription or
 * pause it (`trial_end_without_payment_method`), and then no invoice is created.
 */
export function endTrialOnSchedule(ctx: InvoicingContext, ev: EventBatch, sub: StripeSubscription): StripeSubscription {
  const ss = getStripeStore(ctx.store);
  if (trialEndsWithoutInvoice(ss, sub)) {
    return sub.trial_missing_payment_method === "cancel"
      ? cancelSubscription(ctx, ev, sub)
      : pauseSubscription(ctx, ev, sub, "trial_end_without_payment_method");
  }
  const trialEnd = sub.trial_end!;
  const { interval, interval_count } = subscriptionInterval(ss, subscriptionItems(ss, sub.stripe_id));
  return startCycle(
    ctx,
    ev,
    sub,
    { status: "active", billing_cycle_anchor: trialEnd },
    () => nextPeriodEnd(trialEnd, interval, interval_count, trialEnd),
    true,
  );
}

/**
 * Renew a subscription whose period ended: each item's period rolls to the next boundary of
 * `billing_cycle_anchor`, and the new period is invoiced. An `unpaid` subscription keeps
 * creating invoices but leaves them as drafts that are never collected.
 */
export function renewSubscription(ctx: InvoicingContext, ev: EventBatch, sub: StripeSubscription): StripeSubscription {
  const ss = getStripeStore(ctx.store);
  const { interval, interval_count } = subscriptionInterval(ss, subscriptionItems(ss, sub.stripe_id));
  return startCycle(
    ctx,
    ev,
    sub,
    {},
    (item) => nextPeriodEnd(sub.billing_cycle_anchor, interval, interval_count, item.current_period_end),
    sub.status !== "unpaid",
  );
}

/**
 * The period the next renewal of `sub` opens, or undefined when it will not renew: the first
 * paid period after a trial, or the period after the current one.
 */
export function nextRenewalPeriod(
  ss: StripeStore,
  sub: StripeSubscription,
): { start: number; end: number } | undefined {
  const items = subscriptionItems(ss, sub.stripe_id);
  if (items.length === 0) return undefined;
  const { interval, interval_count } = subscriptionInterval(ss, items);
  const start = sub.status === "trialing" && sub.trial_end !== undefined ? sub.trial_end : items[0].current_period_end;
  const anchor = sub.status === "trialing" ? start : sub.billing_cycle_anchor;
  return { start, end: nextPeriodEnd(anchor, interval, interval_count, start) };
}

/** Move a trial's end to a later time. The current period stretches to match. */
export function extendTrial(ss: StripeStore, sub: StripeSubscription, trialEnd: number): StripeSubscription {
  for (const item of subscriptionItems(ss, sub.stripe_id)) {
    ss.subscriptionItems.update(item.id, { current_period_end: trialEnd });
  }
  return ss.subscriptions.update(sub.id, {
    trial_end: trialEnd,
    billing_cycle_anchor: trialEnd,
    cancel_at: sub.cancel_at_period_end ? trialEnd : sub.cancel_at,
  })!;
}

/** The latest end among the current periods of a subscription's items. */
export function currentPeriodEnd(ss: StripeStore, sub: StripeSubscription): number | undefined {
  const ends = subscriptionItems(ss, sub.stripe_id).map((item) => item.current_period_end);
  return ends.length > 0 ? Math.max(...ends) : undefined;
}

/**
 * The fields that undo a scheduled cancellation, shared by the API and the portal's renew so
 * both leave the same wire state. The cancellation's details go with it.
 */
export function unscheduleCancellation(): Pick<
  StripeSubscription,
  "cancel_at" | "cancel_at_period_end" | "canceled_at" | "cancellation_details"
> {
  return { cancel_at: undefined, cancel_at_period_end: false, canceled_at: undefined, cancellation_details: {} };
}

/**
 * The details of a cancellation requested through the API, the Dashboard or the portal. Stripe
 * records `cancellation_requested` as soon as the cancellation is scheduled, together with
 * `canceled_at`, so customer.subscription.updated already carries it.
 */
export function requestedCancellation(
  details: StripeSubscriptionCancellationDetails,
): StripeSubscriptionCancellationDetails {
  return { ...details, reason: "cancellation_requested" };
}

export function isEnded(sub: StripeSubscription): boolean {
  return sub.status === "canceled" || sub.status === "incomplete_expired";
}

/**
 * Cancel a subscription now: at once for an API call, or at its `cancel_at` with `scheduled`,
 * which keeps the `canceled_at` of the request that scheduled it. `reason` defaults to
 * `cancellation_requested`; Billing passes `payment_failed` when retries run out. Its unpaid
 * invoices stop being collected automatically.
 * Sends customer.subscription.deleted, and no customer.subscription.updated, as on Stripe.
 */
export function cancelSubscription(
  ctx: InvoicingContext,
  ev: EventBatch,
  sub: StripeSubscription,
  details: StripeSubscriptionCancellationDetails = {},
  options: { scheduled?: boolean; reason?: SubscriptionCancellationReason } = {},
): StripeSubscription {
  const ss = getStripeStore(ctx.store);
  const now = nowFor(ss, { customerId: sub.customer_id });
  for (const inv of ss.invoices.findBy("subscription_id", sub.stripe_id)) {
    if (inv.status === "open" && inv.auto_advance) {
      ss.invoices.update(inv.id, { auto_advance: false, next_payment_attempt: undefined });
    }
  }
  const canceled = ss.subscriptions.update(sub.id, {
    status: "canceled",
    pending_resume: undefined,
    // A scheduled cancellation keeps the time it was requested, as Stripe documents for canceled_at.
    canceled_at: options.scheduled ? (sub.canceled_at ?? now) : now,
    ended_at: now,
    cancellation_details: {
      ...sub.cancellation_details,
      ...details,
      reason: options.reason ?? "cancellation_requested",
    },
  })!;
  ev.emit("customer.subscription.deleted", formatSubscription(ss, canceled));
  return canceled;
}

/**
 * Move a subscription to `paused` and record why in `status_details.paused`. A paused
 * subscription does not renew or create invoices. `endPeriod` ends the items' current period
 * at the pause, as the pause endpoint does. Sends customer.subscription.updated and then
 * customer.subscription.paused.
 */
export function pauseSubscription(
  ctx: InvoicingContext,
  ev: EventBatch,
  sub: StripeSubscription,
  reason: SubscriptionPauseReason,
  options: { endPeriod?: boolean } = {},
): StripeSubscription {
  const ss = getStripeStore(ctx.store);
  const before = formatSubscription(ss, sub);
  const now = nowFor(ss, { customerId: sub.customer_id });
  if (options.endPeriod) {
    for (const item of subscriptionItems(ss, sub.stripe_id)) {
      ss.subscriptionItems.update(item.id, { current_period_end: now });
    }
  }
  const paused = ss.subscriptions.update(sub.id, {
    status: "paused",
    paused_details: { reason, transitioned_at: now },
  })!;
  const after = emitSubscriptionChange(ss, ev, paused, before);
  ev.emit("customer.subscription.paused", after);
  return paused;
}

/** With `resume_on_payment_attempt`, a resumption invoice nobody attempts within 23 hours is voided. */
export const RESUME_ATTEMPT_WINDOW = 23 * 3600;

/** With `resume_on_payment_success`, the resumption invoice stays payable for a year. */
export const RESUME_SUCCESS_WINDOW = 365 * 86400;

export interface ResumeParams {
  anchor: "now" | "unchanged";
  paymentBehavior: ResumePaymentBehavior;
}

/**
 * Resume a paused subscription. With `billing_cycle_anchor` `unchanged` no proration is
 * modelled, so it turns `active` at once and its items start a period that runs from now to the
 * anchor's next boundary. With `now`, a resumption invoice for a new period starting now is
 * created with `billing_reason` `subscription_update` and finalized, and the subscription stays
 * paused, with the resumption in `pending_update`, until that invoice is settled.
 * `resume_on_payment_success` attempts it at once and retries it on the schedule; a failure
 * leaves the subscription paused. `resume_on_payment_attempt` leaves the attempt to the caller.
 */
export function resumeSubscription(
  ctx: InvoicingContext,
  ev: EventBatch,
  sub: StripeSubscription,
  params: ResumeParams,
): SubscriptionResult {
  const ss = getStripeStore(ctx.store);
  const now = nowFor(ss, { customerId: sub.customer_id });
  const items = subscriptionItems(ss, sub.stripe_id);
  const { interval, interval_count } = subscriptionInterval(ss, items);
  if (params.anchor === "unchanged") {
    const anchor = sub.billing_cycle_anchor;
    const period = { start: now, end: nextPeriodEnd(anchor, interval, interval_count, now) };
    return { ok: true, sub: applyResume(ctx, ev, sub, { billing_cycle_anchor: anchor, period }, "active") };
  }

  const target = {
    billing_cycle_anchor: now,
    period: { start: now, end: nextPeriodEnd(now, interval, interval_count, now) },
  };
  const lines = subscriptionLines(ss, sub, items, target.period, false);
  const success = params.paymentBehavior === "resume_on_payment_success";
  const due = lines.reduce((sum, line) => sum + line.amount, 0);
  if (success && due > 0 && !subscriptionPaymentMethod(ss, sub.customer_id, sub.default_payment_method)) {
    return { ok: false, error: noPaymentMethodError() };
  }

  const before = formatSubscription(ss, sub);
  const inv = createInvoice(ctx, ev, {
    customerId: sub.customer_id,
    currency: sub.currency,
    collectionMethod: sub.collection_method,
    autoAdvance: success,
    billingReason: "subscription_update",
    subscriptionId: sub.stripe_id,
    subscriptionMetadata: { ...sub.metadata },
    lines,
  });
  const pending = ss.subscriptions.update(sub.id, {
    latest_invoice: inv.stripe_id,
    pending_resume: {
      ...target,
      invoice_id: inv.stripe_id,
      payment_behavior: params.paymentBehavior,
      expires_at: now + (success ? RESUME_SUCCESS_WINDOW : RESUME_ATTEMPT_WINDOW),
    },
  })!;
  emitSubscriptionChange(ss, ev, pending, before);
  const finalized = finalizeInvoice(ctx, ev, ss.invoices.get(inv.id) ?? inv);
  if (finalized.ok && finalized.invoice.status === "open" && success) {
    payInvoice(ctx, ev, finalized.invoice, { automatic: true, offSession: true });
  }
  return { ok: true, sub: ss.subscriptions.get(sub.id)! };
}

/** Send customer.subscription.updated when the rendered subscription changed. */
export function emitSubscriptionChange(
  ss: StripeStore,
  ev: EventBatch,
  sub: StripeSubscription,
  before: Record<string, unknown>,
): Record<string, unknown> {
  const after = formatSubscription(ss, sub);
  const previous = previousAttributes(before, after);
  if (Object.keys(previous).length > 0) ev.emit("customer.subscription.updated", after, previous);
  return after;
}
