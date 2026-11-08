import type { Entity } from "@emulators/core";
import { getStripeStore, type StripeStore } from "./store.js";
import { derivedInvoicePrefix, stripeId } from "./helpers.js";
import { nowFor } from "./clock.js";
import { previousAttributes, type EventBatch } from "./events.js";
import {
  defaultInvoicePayment,
  formatCustomer,
  formatInvoice,
  formatInvoicePayment,
  formatPaymentIntent,
  formatPaymentMethod,
  formatSubscription,
  invoiceAmounts,
  invoiceLines,
  subscriptionItems,
} from "./formatters.js";
import { attemptPayment, newClientSecret, resolvePaymentMethod, type PaymentContext } from "./payments.js";
import { attachPaymentMethod, type StripeErrorSpec } from "./routes/payment-methods.js";
import { isHardDecline, testCardByPaymentMethod } from "./test-cards.js";
import { getBillingSettings } from "./settings.js";
import { refreshUsageLines } from "./metering.js";
import type {
  InvoiceBillingReason,
  InvoiceUncollectibleReason,
  StripeInvoice,
  StripeInvoiceItem,
  StripeInvoiceLineItem,
  StripeInvoicePayment,
  StripePaymentIntent,
  StripePaymentMethod,
  StripeSubscription,
  StripeSubscriptionPendingResume,
  StripeSubscriptionResumeTarget,
  SubscriptionStatus,
} from "./entities.js";

export type InvoicingContext = PaymentContext;

export type InvoiceResult = { ok: true; invoice: StripeInvoice } | { ok: false; error: StripeErrorSpec };

export { DRAFT_FINALIZE_DELAY } from "./formatters.js";

const DAY = 86400;

const NO_PAYMENT_METHOD_MESSAGE =
  "This customer has no attached payment source or default payment method. Please consider adding a default payment method. For more information, visit https://docs.stripe.com/billing/subscriptions/payment-methods-setting#payment-method-priority.";

const REQUIRES_ACTION_MESSAGE =
  "This payment requires additional user action before it can be completed successfully. Payment can be completed using the PaymentIntent associated with the invoice. For more details see: https://docs.stripe.com/billing/subscriptions/overview#requires-action";

/** The 400 for an invoice with no payment method to charge, coded `resource_missing` as on Stripe. */
export function noPaymentMethodError(): StripeErrorSpec {
  return invalidRequest(NO_PAYMENT_METHOD_MESSAGE, "resource_missing");
}

function invalidRequest(message: string, code?: string, param?: string): StripeErrorSpec {
  return { status: 400, type: "invalid_request_error", message, code, param };
}

export function invoiceNotEditable(inv: StripeInvoice): StripeErrorSpec {
  return invalidRequest(
    `You can only modify draft invoices. This invoice (${inv.stripe_id}) is ${inv.status}.`,
    "invoice_not_editable",
    "invoice",
  );
}

function render(ctx: InvoicingContext, inv: StripeInvoice) {
  return formatInvoice(getStripeStore(ctx.store), inv, ctx.baseUrl);
}

function invoiceNow(ss: StripeStore, inv: Pick<StripeInvoice, "customer_id">): number {
  return nowFor(ss, { customerId: inv.customer_id });
}

/** Set `customer.delinquent`, sending customer.updated when it changes. */
export function setDelinquent(ctx: InvoicingContext, ev: EventBatch, customerId: string, delinquent: boolean): void {
  const ss = getStripeStore(ctx.store);
  const customer = ss.customers.findOneBy("stripe_id", customerId);
  if (!customer || (customer.delinquent ?? false) === delinquent) return;
  const updated = ss.customers.update(customer.id, { delinquent })!;
  const after = formatCustomer(updated);
  ev.emit("customer.updated", after, previousAttributes(formatCustomer(customer), after));
}

export type LineFields = Omit<StripeInvoiceLineItem, keyof Entity | "stripe_id" | "invoice_id">;

function lineFieldsFromItem(item: StripeInvoiceItem): LineFields {
  return {
    amount: item.amount,
    currency: item.currency,
    description: item.description,
    discountable: item.discountable,
    metadata: { ...item.metadata },
    period: { ...item.period },
    price_id: item.price_id,
    product_id: item.product_id,
    unit_amount_decimal: item.unit_amount_decimal,
    quantity: item.quantity,
    proration: item.proration,
    invoice_item_id: item.stripe_id,
    subscription_id: item.subscription_id,
  };
}

/** Put a pending invoice item on a draft invoice as a new line. */
export function attachInvoiceItem(ss: StripeStore, item: StripeInvoiceItem, inv: StripeInvoice): StripeInvoiceItem {
  const attached = ss.invoiceItems.update(item.id, { invoice_id: inv.stripe_id })!;
  ss.invoiceLineItems.insert({ stripe_id: stripeId("il"), invoice_id: inv.stripe_id, ...lineFieldsFromItem(attached) });
  return attached;
}

/** Keep the line generated from `item` in step with it, or remove it once the item is gone. */
export function syncInvoiceItemLine(ss: StripeStore, item: StripeInvoiceItem, removed = false): void {
  for (const line of ss.invoiceLineItems.findBy("invoice_item_id", item.stripe_id)) {
    if (removed) ss.invoiceLineItems.delete(line.id);
    else ss.invoiceLineItems.update(line.id, lineFieldsFromItem(item));
  }
}

/**
 * Send invoice.updated when a change to the lines of a draft altered the invoice. `before` is
 * the invoice as rendered before the change.
 */
export function emitDraftChange(
  ctx: InvoicingContext,
  ev: EventBatch,
  inv: StripeInvoice,
  before: Record<string, unknown>,
): void {
  const after = render(ctx, inv);
  const previous = previousAttributes(before, after);
  if (Object.keys(previous).length > 0) ev.emit("invoice.updated", after, previous);
}

export interface CreateInvoiceParams {
  customerId: string;
  currency?: string;
  collectionMethod?: StripeInvoice["collection_method"];
  autoAdvance?: boolean;
  description?: string;
  footer?: string;
  metadata?: Record<string, string>;
  defaultPaymentMethod?: string;
  dueDate?: number;
  daysUntilDue?: number;
  includePending?: boolean;
  billingReason?: InvoiceBillingReason;
  subscriptionId?: string;
  /** The subscription's metadata, rendered as `parent.subscription_details.metadata`. */
  subscriptionMetadata?: Record<string, string>;
  /** Lines to put on the draft before invoice.created, such as a subscription's items. */
  lines?: LineFields[];
  /**
   * The invoice's `period_start` and `period_end`. A renewal invoice looks back on the period
   * that just ended; other invoices default to their creation time.
   */
  period?: { start: number; end: number };
}

/** Create a draft invoice, optionally sweeping in the customer's pending invoice items. Sends invoice.created. */
export function createInvoice(ctx: InvoicingContext, ev: EventBatch, params: CreateInvoiceParams): StripeInvoice {
  const ss = getStripeStore(ctx.store);
  const now = nowFor(ss, { customerId: params.customerId });
  const pending = params.includePending
    ? ss.invoiceItems
        .findBy("customer_id", params.customerId)
        .filter((item) => !item.invoice_id && item.subscription_id === params.subscriptionId)
        .sort((a, b) => a.id - b.id)
    : [];
  const currency = params.currency ?? pending[0]?.currency ?? "usd";
  const customer = ss.customers.findOneBy("stripe_id", params.customerId);

  const inv = ss.invoices.insert({
    stripe_id: stripeId("in"),
    customer_id: params.customerId,
    status: "draft",
    currency,
    collection_method: params.collectionMethod ?? "charge_automatically",
    billing_reason: params.billingReason ?? "manual",
    auto_advance: params.autoAdvance ?? false,
    metadata: params.metadata ?? {},
    created: now,
    period_start: params.period?.start ?? now,
    period_end: params.period?.end ?? now,
    attempt_count: 0,
    attempted: false,
    amount_paid: 0,
    description: params.description,
    footer: params.footer,
    default_payment_method: params.defaultPaymentMethod,
    due_date: params.dueDate ?? (params.daysUntilDue !== undefined ? now + params.daysUntilDue * 86400 : undefined),
    // Delivery is inline, so the invoice's webhooks are done by the time anyone reads it.
    webhooks_delivered_at: now,
    subscription_id: params.subscriptionId,
    subscription_metadata: params.subscriptionMetadata,
    test_clock: customer?.test_clock,
  });
  for (const line of params.lines ?? []) {
    ss.invoiceLineItems.insert({ stripe_id: stripeId("il"), invoice_id: inv.stripe_id, ...line });
  }
  for (const item of pending) {
    if (item.currency === currency) attachInvoiceItem(ss, item, inv);
  }
  ev.emit("invoice.created", render(ctx, inv));
  return inv;
}

function nextInvoiceNumber(ss: StripeStore, customerId: string): string | undefined {
  const customer = ss.customers.findOneBy("stripe_id", customerId);
  if (!customer) return undefined;
  const sequence = customer.next_invoice_sequence ?? 1;
  ss.customers.update(customer.id, { next_invoice_sequence: sequence + 1 });
  const prefix = customer.invoice_prefix ?? derivedInvoicePrefix(customer.stripe_id);
  return `${prefix}-${String(sequence).padStart(4, "0")}`;
}

/**
 * The description Billing gives the PaymentIntent of a subscription invoice, which its charge
 * inherits: "Subscription creation" for the first invoice and "Subscription update" for later
 * ones. Other invoices leave it null.
 */
function paymentIntentDescription(reason: InvoiceBillingReason): string | null {
  if (reason === "subscription_create") return "Subscription creation";
  if (reason.startsWith("subscription")) return "Subscription update";
  return null;
}

/**
 * Whether the PaymentIntent of `inv` saves the card that pays it: the invoice belongs to a
 * subscription with `payment_settings.save_default_payment_method=on_subscription`. Its
 * PaymentIntent then has `setup_future_usage` `off_session`, so a card confirmed on it client
 * side (the `default_incomplete` flow) is attached to the customer before it becomes the
 * subscription's default and can be charged off-session at renewal.
 */
function savesCardOnSubscription(ss: StripeStore, inv: StripeInvoice): boolean {
  if (!inv.subscription_id) return false;
  return (
    ss.subscriptions.findOneBy("stripe_id", inv.subscription_id)?.save_default_payment_method === "on_subscription"
  );
}

/**
 * Finalize a draft: number it, freeze the customer details and open it. An invoice with an
 * amount due gets its PaymentIntent and default InvoicePayment; one with nothing due is paid
 * at once. Sends payment_intent.created and invoice.finalized.
 */
export function finalizeInvoice(ctx: InvoicingContext, ev: EventBatch, inv: StripeInvoice): InvoiceResult {
  const ss = getStripeStore(ctx.store);
  if (inv.status !== "draft") {
    return {
      ok: false,
      error: invalidRequest("This invoice is already finalized, you can't re-finalize a non-draft invoice."),
    };
  }
  const now = invoiceNow(ss, inv);
  refreshUsageLines(ss, inv);
  const customer = ss.customers.findOneBy("stripe_id", inv.customer_id);
  const opened = ss.invoices.update(inv.id, {
    status: "open",
    number: inv.number ?? nextInvoiceNumber(ss, inv.customer_id),
    finalized_at: now,
    customer_snapshot: { email: customer?.email ?? null, name: customer?.name ?? null },
    next_payment_attempt:
      inv.auto_advance && inv.collection_method === "charge_automatically" ? now : inv.next_payment_attempt,
  })!;

  const { amount_due } = invoiceAmounts(ss, opened);
  if (amount_due > 0) {
    const piId = stripeId("pi");
    const pi = ss.paymentIntents.insert({
      stripe_id: piId,
      amount: amount_due,
      currency: opened.currency,
      status: "requires_payment_method",
      customer_id: opened.customer_id,
      description: paymentIntentDescription(opened.billing_reason),
      payment_method: null,
      metadata: {},
      created: now,
      client_secret: newClientSecret(piId),
      setup_future_usage: savesCardOnSubscription(ss, opened) ? "off_session" : undefined,
    });
    ss.invoicePayments.insert({
      stripe_id: stripeId("inpay"),
      invoice_id: opened.stripe_id,
      amount_requested: amount_due,
      currency: opened.currency,
      is_default: true,
      payment_intent_id: pi.stripe_id,
      status: "open",
      created: now,
    });
    ev.emit("payment_intent.created", formatPaymentIntent(pi));
  }
  ev.emit("invoice.finalized", render(ctx, opened));

  if (amount_due === 0) return { ok: true, invoice: markPaid(ctx, ev, opened, {}) };
  return { ok: true, invoice: opened };
}

interface MarkPaidOptions {
  /** The PaymentIntent that paid the invoice, with the InvoicePayment it belongs to. */
  payment?: { pi: StripePaymentIntent; record: StripeInvoicePayment };
  outOfBand?: boolean;
  /** The invoice as rendered before this request changed it, for previous_attributes. */
  before?: Record<string, unknown>;
}

function cancelInvoicePaymentIntent(
  ctx: InvoicingContext,
  ev: EventBatch,
  inv: StripeInvoice,
  reason: string | undefined,
): void {
  const ss = getStripeStore(ctx.store);
  const record = defaultInvoicePayment(ss, inv.stripe_id);
  if (!record || record.status !== "open") return;
  const now = invoiceNow(ss, inv);
  const pi = ss.paymentIntents.findOneBy("stripe_id", record.payment_intent_id);
  if (pi && pi.status !== "succeeded" && pi.status !== "canceled") {
    const canceled = ss.paymentIntents.update(pi.id, {
      status: "canceled",
      canceled_at: now,
      cancellation_reason: reason,
      next_action: undefined,
    })!;
    ev.emit("payment_intent.canceled", formatPaymentIntent(canceled));
  }
  ss.invoicePayments.update(record.id, { status: "canceled", canceled_at: now });
}

/**
 * Move an open or uncollectible invoice to paid. invoice.payment_succeeded and
 * invoice_payment.paid are sent only when a PaymentIntent paid it, as on Stripe: a $0 invoice
 * or one paid out of band sends invoice.paid alone. Paying clears the customer's delinquency.
 */
function markPaid(ctx: InvoicingContext, ev: EventBatch, inv: StripeInvoice, options: MarkPaidOptions): StripeInvoice {
  const ss = getStripeStore(ctx.store);
  const before = options.before ?? render(ctx, inv);
  const now = invoiceNow(ss, inv);
  const { amount_due } = invoiceAmounts(ss, inv);

  if (options.outOfBand) cancelInvoicePaymentIntent(ctx, ev, inv, undefined);
  const paid = ss.invoices.update(inv.id, {
    status: "paid",
    amount_paid: amount_due,
    amount_paid_off_stripe: options.outOfBand ? amount_due : inv.amount_paid_off_stripe,
    paid_at: now,
    auto_advance: false,
    next_payment_attempt: undefined,
    uncollectible_reason: undefined,
    hard_declined_payment_method: undefined,
  })!;
  const record = options.payment
    ? ss.invoicePayments.update(options.payment.record.id, {
        status: "paid",
        amount_paid: options.payment.pi.amount_received ?? options.payment.pi.amount,
        paid_at: now,
      })!
    : undefined;

  const after = render(ctx, paid);
  ev.emit("invoice.updated", after, previousAttributes(before, after));
  ev.emit("invoice.paid", after);
  if (record) {
    ev.emit("invoice.payment_succeeded", after);
    ev.emit("invoice_payment.paid", formatInvoicePayment(record));
  }
  setDelinquent(ctx, ev, paid.customer_id, false);
  settleSubscriptionInvoice(ctx, ev, paid, SETTLED_BY_PAYMENT, options.payment?.pi.payment_method ?? undefined);
  return paid;
}

/** Statuses that paying the latest invoice makes `active`. */
const SETTLED_BY_PAYMENT: readonly SubscriptionStatus[] = ["incomplete", "past_due", "unpaid"];

/** Statuses that forgiving or voiding the latest invoice makes `active`. */
const SETTLED_BY_RESOLUTION: readonly SubscriptionStatus[] = ["past_due", "unpaid"];

/**
 * Settling a subscription's latest invoice makes a subscription in one of the `from` statuses
 * `active`, and with `save_default_payment_method=on_subscription` saves the card that paid as
 * the subscription's default. Sends customer.subscription.updated when either changes. Settling
 * the resumption invoice of a paused subscription resumes it.
 */
function settleSubscriptionInvoice(
  ctx: InvoicingContext,
  ev: EventBatch,
  inv: StripeInvoice,
  from: readonly SubscriptionStatus[],
  paidWith?: string,
): void {
  if (!inv.subscription_id) return;
  const ss = getStripeStore(ctx.store);
  const sub = ss.subscriptions.findOneBy("stripe_id", inv.subscription_id);
  if (!sub || sub.latest_invoice !== inv.stripe_id) return;
  const updates: Partial<StripeSubscription> = {};
  if (from.includes(sub.status)) updates.status = "active";
  if (sub.save_default_payment_method === "on_subscription" && paidWith && sub.default_payment_method !== paidWith) {
    updates.default_payment_method = paidWith;
  }
  const resume = pendingResumeFor(sub, inv);
  if (resume) {
    applyResume(ctx, ev, sub, resume, "active", updates);
    return;
  }
  if (Object.keys(updates).length === 0) return;
  const before = formatSubscription(ss, sub);
  const after = formatSubscription(ss, ss.subscriptions.update(sub.id, updates)!);
  ev.emit("customer.subscription.updated", after, previousAttributes(before, after));
}

/** The resumption `inv` settles, when `sub` is paused waiting on it. */
function pendingResumeFor(sub: StripeSubscription, inv: StripeInvoice): StripeSubscriptionPendingResume | undefined {
  return sub.status === "paused" && sub.pending_resume?.invoice_id === inv.stripe_id ? sub.pending_resume : undefined;
}

/**
 * Resume a paused subscription: every item starts the period of `target`, the anchor moves to
 * its anchor and the pause and any pending resumption are cleared. `status` is `active`, or
 * `past_due` when a payment attempt on the resumption invoice failed. Sends
 * customer.subscription.updated and then customer.subscription.resumed.
 */
export function applyResume(
  ctx: InvoicingContext,
  ev: EventBatch,
  sub: StripeSubscription,
  target: StripeSubscriptionResumeTarget,
  status: "active" | "past_due",
  extra: Partial<StripeSubscription> = {},
): StripeSubscription {
  const ss = getStripeStore(ctx.store);
  const before = formatSubscription(ss, sub);
  for (const item of subscriptionItems(ss, sub.stripe_id)) {
    ss.subscriptionItems.update(item.id, {
      current_period_start: target.period.start,
      current_period_end: target.period.end,
    });
  }
  const resumed = ss.subscriptions.update(sub.id, {
    ...extra,
    status,
    billing_cycle_anchor: target.billing_cycle_anchor,
    paused_details: undefined,
    pending_resume: undefined,
  })!;
  const after = formatSubscription(ss, resumed);
  ev.emit("customer.subscription.updated", after, previousAttributes(before, after));
  ev.emit("customer.subscription.resumed", after);
  return resumed;
}

/**
 * With `resume_on_payment_attempt`, any payment attempt on the resumption invoice resumes the
 * subscription; one that fails leaves it `past_due`.
 */
function resumeOnFailedAttempt(ctx: InvoicingContext, ev: EventBatch, inv: StripeInvoice): void {
  if (!inv.subscription_id) return;
  const ss = getStripeStore(ctx.store);
  const sub = ss.subscriptions.findOneBy("stripe_id", inv.subscription_id);
  const resume = sub ? pendingResumeFor(sub, inv) : undefined;
  if (!sub || !resume || resume.payment_behavior !== "resume_on_payment_attempt") return;
  applyResume(ctx, ev, sub, resume, "past_due");
}

/**
 * The id of the payment method Billing would charge `inv` with now: the invoice's default,
 * then the default of the subscription that generated it, then the customer's invoice default.
 */
export function invoicePaymentMethodId(ss: StripeStore, inv: StripeInvoice): string | undefined {
  const customer = ss.customers.findOneBy("stripe_id", inv.customer_id);
  const subscription = inv.subscription_id ? ss.subscriptions.findOneBy("stripe_id", inv.subscription_id) : undefined;
  return (
    inv.default_payment_method ??
    subscription?.default_payment_method ??
    customer?.invoice_settings?.default_payment_method
  );
}

/**
 * When Billing retries `inv` after its attempt number `attemptCount` failed at `now`, or
 * undefined when the retry schedule is used up. Only subscription invoices are retried, and
 * never the first invoice of an `incomplete` subscription.
 */
export function nextRetryAt(
  ctx: InvoicingContext,
  inv: StripeInvoice,
  attemptCount: number,
  now: number,
): number | undefined {
  if (!inv.subscription_id || !inv.auto_advance || inv.collection_method !== "charge_automatically") {
    return undefined;
  }
  const sub = getStripeStore(ctx.store).subscriptions.findOneBy("stripe_id", inv.subscription_id);
  if (!sub || sub.status === "incomplete" || sub.status === "incomplete_expired") return undefined;
  const days = getBillingSettings(ctx.store).retry_schedule_days[Math.max(0, attemptCount - 1)];
  return days === undefined ? undefined : now + days * DAY;
}

/**
 * The payment method an invoice is charged with: the `payment_method` param, then the
 * invoice's default, then the default of the subscription that generated it, then the
 * customer's invoice default. A test card id such as `pm_card_visa` is attached to the
 * customer first.
 */
function invoicePaymentMethod(
  ctx: InvoicingContext,
  ev: EventBatch,
  inv: StripeInvoice,
  requested: string | undefined,
): { ok: true; pm: StripePaymentMethod } | { ok: false; error: StripeErrorSpec } {
  const ss = getStripeStore(ctx.store);
  const id = requested ?? invoicePaymentMethodId(ss, inv);
  if (!id) return { ok: false, error: noPaymentMethodError() };

  if (testCardByPaymentMethod(id)) {
    const attached = attachPaymentMethod(ss, id, inv.customer_id);
    if (!attached.ok) return attached;
    if (attached.value.attached) ev.emit("payment_method.attached", formatPaymentMethod(attached.value.pm));
    return { ok: true, pm: attached.value.pm };
  }
  return resolvePaymentMethod(ss, id, inv.customer_id);
}

export interface PayInvoiceOptions {
  paymentMethod?: string;
  /** Defaults to true: Billing charges invoices with the customer away. */
  offSession?: boolean;
  paidOutOfBand?: boolean;
  /**
   * True for Billing's own collection attempts. Each one counts in attempt_count, and a failure
   * makes the customer delinquent.
   */
  automatic?: boolean;
}

/**
 * Attempt to pay an invoice, finalizing a draft first. As on Stripe, the first attempt of any
 * kind counts in attempt_count and after that only automatic retries do. A decline leaves the
 * invoice open; a card that needs 3D Secure leaves its PaymentIntent in requires_action. Both
 * send invoice.payment_failed.
 */
export function payInvoice(
  ctx: InvoicingContext,
  ev: EventBatch,
  inv: StripeInvoice,
  options: PayInvoiceOptions = {},
): InvoiceResult {
  const ss = getStripeStore(ctx.store);
  let current = inv;
  if (current.status === "draft") {
    const finalized = finalizeInvoice(ctx, ev, current);
    if (!finalized.ok || finalized.invoice.status === "paid") return finalized;
    current = finalized.invoice;
  }
  if (current.status === "paid") return { ok: false, error: invalidRequest("Invoice is already paid") };
  if (current.status === "void") {
    return { ok: false, error: invalidRequest("This invoice has been voided and can no longer be paid.") };
  }
  if (options.paidOutOfBand) return { ok: true, invoice: markPaid(ctx, ev, current, { outOfBand: true }) };

  const record = defaultInvoicePayment(ss, current.stripe_id);
  const pi = record ? ss.paymentIntents.findOneBy("stripe_id", record.payment_intent_id) : undefined;
  if (!record || !pi) return { ok: true, invoice: markPaid(ctx, ev, current, {}) };

  const resolved = invoicePaymentMethod(ctx, ev, current, options.paymentMethod);
  if (!resolved.ok) return resolved;

  const before = render(ctx, current);
  const now = invoiceNow(ss, current);
  // A manual attempt that fails keeps the retry Billing already scheduled.
  const scheduled =
    current.next_payment_attempt !== undefined && current.next_payment_attempt > now
      ? current.next_payment_attempt
      : undefined;
  const attemptCount =
    current.attempt_count === 0 || options.automatic ? current.attempt_count + 1 : current.attempt_count;
  current = ss.invoices.update(current.id, {
    attempt_count: attemptCount,
    attempted: true,
    next_payment_attempt: undefined,
  })!;
  const attempt = attemptPayment(ctx, ev, pi, resolved.pm, {
    offSession: options.offSession ?? true,
    initiator: "billing",
  });

  if (attempt.status === "succeeded") {
    return { ok: true, invoice: markPaid(ctx, ev, current, { payment: { pi: attempt.pi, record }, before }) };
  }

  const hardDecline = attempt.status === "failed" && isHardDecline(attempt.pi.last_payment_error);
  current = ss.invoices.update(current.id, {
    next_payment_attempt: options.automatic ? nextRetryAt(ctx, current, attemptCount, now) : scheduled,
    hard_declined_payment_method: hardDecline ? resolved.pm.stripe_id : undefined,
  })!;
  const after = render(ctx, current);
  ev.emit("invoice.updated", after, previousAttributes(before, after));
  if (attempt.status === "requires_action") {
    ev.emit("invoice.payment_action_required", after);
    ev.emit("invoice.payment_failed", after);
    if (options.automatic) setDelinquent(ctx, ev, current.customer_id, true);
    resumeOnFailedAttempt(ctx, ev, current);
    return {
      ok: false,
      error: {
        status: 402,
        type: "card_error",
        message: REQUIRES_ACTION_MESSAGE,
        code: "invoice_payment_intent_requires_action",
        extras: { payment_intent: formatPaymentIntent(attempt.pi) },
      },
    };
  }
  ev.emit("invoice.payment_failed", after);
  if (options.automatic) setDelinquent(ctx, ev, current.customer_id, true);
  resumeOnFailedAttempt(ctx, ev, current);
  return { ok: false, error: attempt.error };
}

/**
 * A scheduled retry that Billing counts but does not execute, because the invoice would be
 * charged with the payment method that was hard declined, or with none at all. No charge is
 * made and the retry moves on to the next scheduled date. Sends invoice.updated and
 * invoice.payment_failed.
 */
export function recordSkippedRetry(ctx: InvoicingContext, ev: EventBatch, inv: StripeInvoice): StripeInvoice {
  const ss = getStripeStore(ctx.store);
  const before = render(ctx, inv);
  const now = invoiceNow(ss, inv);
  const attemptCount = inv.attempt_count + 1;
  const skipped = ss.invoices.update(inv.id, {
    attempt_count: attemptCount,
    attempted: true,
    next_payment_attempt: nextRetryAt(ctx, inv, attemptCount, now),
  })!;
  const after = render(ctx, skipped);
  ev.emit("invoice.updated", after, previousAttributes(before, after));
  ev.emit("invoice.payment_failed", after);
  return skipped;
}

/**
 * Follow up on an invoice's PaymentIntent that changed outside /pay, such as the customer
 * completing 3D Secure or confirming it client side. Does nothing for other intents.
 */
export function settleInvoicePaymentIntent(ctx: InvoicingContext, ev: EventBatch, pi: StripePaymentIntent): void {
  const ss = getStripeStore(ctx.store);
  const record = ss.invoicePayments.findBy("payment_intent_id", pi.stripe_id).find((p) => p.is_default);
  if (!record || record.status !== "open") return;
  const inv = ss.invoices.findOneBy("stripe_id", record.invoice_id);
  if (!inv || (inv.status !== "open" && inv.status !== "uncollectible")) return;
  if (pi.status === "succeeded") {
    markPaid(ctx, ev, inv, { payment: { pi, record } });
  } else if (pi.status === "requires_payment_method" && pi.last_payment_error) {
    ev.emit("invoice.payment_failed", render(ctx, inv));
  }
}

/**
 * What Billing does when an auto-advancing draft reaches `automatically_finalizes_at`:
 * finalize it and, for `charge_automatically`, attempt payment off-session as an automatic
 * collection attempt. A failed attempt, including one with no payment method to charge, leaves
 * the invoice open. Returns the payment error.
 */
export function autoAdvanceDraft(
  ctx: InvoicingContext,
  ev: EventBatch,
  inv: StripeInvoice,
): StripeErrorSpec | undefined {
  const finalized = finalizeInvoice(ctx, ev, inv);
  if (!finalized.ok) return finalized.error;
  const opened = finalized.invoice;
  if (opened.status !== "open" || opened.collection_method !== "charge_automatically") return undefined;
  if (!invoicePaymentMethodId(getStripeStore(ctx.store), opened)) {
    // With nothing to charge, the attempt is counted and fails, and retries are scheduled.
    recordSkippedRetry(ctx, ev, opened);
    setDelinquent(ctx, ev, opened.customer_id, true);
    return noPaymentMethodError();
  }
  const paid = payInvoice(ctx, ev, opened, { automatic: true, offSession: true });
  return paid.ok ? undefined : paid.error;
}

/** Whether `pi` is the PaymentIntent of an invoice's default payment, which Stripe does not let you cancel. */
export function isInvoicePaymentIntent(ss: StripeStore, piId: string): boolean {
  return ss.invoicePayments.findBy("payment_intent_id", piId).some((p) => p.is_default);
}

/**
 * A subscription's status follows its most recent invoice that is not void. Voiding the
 * latest invoice of a `past_due` or `unpaid` subscription makes it `active` again unless an
 * earlier invoice is still open. Voiding a paused subscription's resumption invoice keeps it
 * paused.
 */
function resolveAfterVoid(ctx: InvoicingContext, ev: EventBatch, voided: StripeInvoice): void {
  if (!voided.subscription_id) return;
  const ss = getStripeStore(ctx.store);
  const sub = ss.subscriptions.findOneBy("stripe_id", voided.subscription_id);
  if (sub && pendingResumeFor(sub, voided)) {
    // A voided resumption invoice drops the resumption; the subscription stays paused.
    const before = formatSubscription(ss, sub);
    const after = formatSubscription(ss, ss.subscriptions.update(sub.id, { pending_resume: undefined })!);
    ev.emit("customer.subscription.updated", after, previousAttributes(before, after));
    return;
  }
  if (!sub || sub.latest_invoice !== voided.stripe_id || !SETTLED_BY_RESOLUTION.includes(sub.status)) return;
  const [previous] = ss.invoices
    .findBy("subscription_id", sub.stripe_id)
    .filter((inv) => inv.status !== "void" && inv.status !== "draft")
    .sort((a, b) => b.created - a.created || b.id - a.id);
  if (previous?.status === "open") return;
  settleSubscriptionInvoice(ctx, ev, voided, SETTLED_BY_RESOLUTION);
}

/** Void an open or uncollectible invoice and cancel its PaymentIntent. Sends invoice.voided. */
export function voidInvoice(ctx: InvoicingContext, ev: EventBatch, inv: StripeInvoice): InvoiceResult {
  const ss = getStripeStore(ctx.store);
  if (inv.status !== "open" && inv.status !== "uncollectible") {
    return {
      ok: false,
      error: invalidRequest(`You can only void an open or uncollectible invoice. This invoice is ${inv.status}.`),
    };
  }
  cancelInvoicePaymentIntent(ctx, ev, inv, "void_invoice");
  const voided = ss.invoices.update(inv.id, {
    status: "void",
    voided_at: invoiceNow(ss, inv),
    auto_advance: false,
    next_payment_attempt: undefined,
    uncollectible_reason: undefined,
    hard_declined_payment_method: undefined,
  })!;
  ev.emit("invoice.voided", render(ctx, voided));
  resolveAfterVoid(ctx, ev, voided);
  return { ok: true, invoice: voided };
}

/**
 * Mark an open invoice uncollectible. It stays payable. The API call records `user_forgiven`
 * and clears the customer's delinquency. Sends invoice.marked_uncollectible.
 */
export function markInvoiceUncollectible(
  ctx: InvoicingContext,
  ev: EventBatch,
  inv: StripeInvoice,
  reason: InvoiceUncollectibleReason = "user_forgiven",
): InvoiceResult {
  const ss = getStripeStore(ctx.store);
  if (inv.status !== "open") {
    return {
      ok: false,
      error: invalidRequest(`You can only mark an open invoice as uncollectible. This invoice is ${inv.status}.`),
    };
  }
  const marked = ss.invoices.update(inv.id, {
    status: "uncollectible",
    marked_uncollectible_at: invoiceNow(ss, inv),
    uncollectible_reason: reason,
    auto_advance: false,
    next_payment_attempt: undefined,
    hard_declined_payment_method: undefined,
  })!;
  ev.emit("invoice.marked_uncollectible", render(ctx, marked));
  if (reason === "user_forgiven") {
    setDelinquent(ctx, ev, marked.customer_id, false);
    settleSubscriptionInvoice(ctx, ev, marked, SETTLED_BY_RESOLUTION);
  }
  return { ok: true, invoice: marked };
}

/** Delete a draft invoice together with its lines and the invoice items on it. Sends invoice.deleted. */
export function deleteDraftInvoice(ctx: InvoicingContext, ev: EventBatch, inv: StripeInvoice): InvoiceResult {
  const ss = getStripeStore(ctx.store);
  if (inv.status !== "draft") {
    return { ok: false, error: invalidRequest("You can only delete draft invoices.") };
  }
  const rendered = render(ctx, inv);
  for (const line of invoiceLines(ss, inv.stripe_id)) ss.invoiceLineItems.delete(line.id);
  for (const item of ss.invoiceItems.findBy("invoice_id", inv.stripe_id)) ss.invoiceItems.delete(item.id);
  ss.invoices.delete(inv.id);
  ev.emit("invoice.deleted", rendered);
  return { ok: true, invoice: inv };
}
