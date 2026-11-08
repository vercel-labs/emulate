import { getStripeStore, type StripeStore } from "./store.js";
import { stripeId } from "./helpers.js";
import { clockCustomers } from "./clock.js";
import { eventBatch, type EventBatch, type EventBatchContext } from "./events.js";
import { formatInvoice, formatSubscription, subscriptionItems } from "./formatters.js";
import {
  autoAdvanceDraft,
  DRAFT_FINALIZE_DELAY,
  invoicePaymentMethodId,
  markInvoiceUncollectible,
  payInvoice,
  recordSkippedRetry,
  voidInvoice,
  type InvoicingContext,
} from "./invoicing.js";
import {
  cancelSubscription,
  emitSubscriptionChange,
  endTrialOnSchedule,
  nextRenewalPeriod,
  pauseSubscription,
  renewSubscription,
  sendTrialWillEnd,
  subscriptionLines,
  TRIAL_WILL_END_LEAD,
  trialEndsWithoutInvoice,
} from "./subscriptions.js";
import { nowFor } from "./clock.js";
import { getBillingSettings } from "./settings.js";
import { usageLines } from "./metering.js";
import type { StripeInvoice, StripeSubscription, StripeTestClock } from "./entities.js";

export { nextPeriodEnd, periodBoundary } from "./periods.js";

const DAY = 86400;

export type BillingContext = InvoicingContext & EventBatchContext;

/**
 * One thing Billing does at a point in simulated time. `rank` breaks ties between actions due
 * at the same second: older work (collecting a draft) runs before newer work (a renewal).
 */
interface DueAction {
  at: number;
  rank: number;
  key: number;
  run(ev: EventBatch): void;
}

const RANK = { finalize: 0, retry: 1, overdue: 2, expire: 3, trialWillEnd: 4, upcoming: 5, period: 6 } as const;

/** An `incomplete` subscription whose first invoice is not paid within 23 hours expires. */
export const INCOMPLETE_EXPIRY = 23 * 3600;

/** An advance that keeps finding work after this many actions is treated as a clock failure. */
const MAX_ACTIONS = 10_000;

function isBilled(sub: StripeSubscription): boolean {
  return sub.status === "active" || sub.status === "past_due" || sub.status === "unpaid";
}

/** When the subscription next renews or ends: its trial end, or the end of its items' period. */
function nextBoundary(ss: StripeStore, sub: StripeSubscription): number | undefined {
  if (sub.status === "trialing") return sub.trial_end;
  if (!isBilled(sub)) return undefined;
  return subscriptionItems(ss, sub.stripe_id)[0]?.current_period_end;
}

/** The start of the period the subscription is in now, used to bound how early invoice.upcoming may fire. */
function currentPeriodStart(ss: StripeStore, sub: StripeSubscription): number {
  return subscriptionItems(ss, sub.stripe_id)[0]?.current_period_start ?? sub.start_date;
}

/**
 * The renewal invoice `sub` would get, as Stripe sends it in invoice.upcoming: a draft with
 * `billing_reason` `upcoming` and the next period's lines, rendered without being stored.
 * Stripe documents that this invoice has no id.
 */
function upcomingInvoice(ctx: BillingContext, sub: StripeSubscription, period: { start: number; end: number }) {
  const ss = getStripeStore(ctx.store);
  const items = subscriptionItems(ss, sub.stripe_id);
  const inv = ss.invoices.insert({
    stripe_id: stripeId("in"),
    customer_id: sub.customer_id,
    status: "draft",
    currency: sub.currency,
    collection_method: sub.collection_method,
    billing_reason: "upcoming",
    auto_advance: false,
    metadata: {},
    created: period.start,
    period_start: currentPeriodStart(ss, sub),
    period_end: period.start,
    attempt_count: 0,
    attempted: false,
    amount_paid: 0,
    subscription_id: sub.stripe_id,
    subscription_metadata: { ...sub.metadata },
    test_clock: sub.test_clock,
  });
  const usage =
    sub.status === "trialing" || items.length === 0
      ? []
      : usageLines(ss, sub, items, { start: items[0].current_period_start, end: items[0].current_period_end });
  const lines = [...subscriptionLines(ss, sub, items, period, false), ...usage].map((line) =>
    ss.invoiceLineItems.insert({ stripe_id: stripeId("il_tmp"), invoice_id: inv.stripe_id, ...line }),
  );
  const rendered = formatInvoice(ss, inv, ctx.baseUrl);
  for (const line of lines) ss.invoiceLineItems.delete(line.id);
  ss.invoices.delete(inv.id);

  const { id: _id, ...preview } = rendered;
  return {
    ...preview,
    lines: {
      ...preview.lines,
      data: preview.lines.data.map((line) => ({ ...line, invoice: null })),
      url: `/v1/invoices/upcoming/lines?subscription=${sub.stripe_id}`,
    },
  };
}

/** A failed collection of the subscription's latest invoice makes an active subscription past_due. */
function markPastDue(ctx: BillingContext, ev: EventBatch, inv: StripeInvoice): void {
  if (!inv.subscription_id) return;
  const ss = getStripeStore(ctx.store);
  const sub = ss.subscriptions.findOneBy("stripe_id", inv.subscription_id);
  if (!sub || sub.latest_invoice !== inv.stripe_id || sub.status !== "active") return;
  const before = formatSubscription(ss, sub);
  emitSubscriptionChange(ss, ev, ss.subscriptions.update(sub.id, { status: "past_due" })!, before);
}

/**
 * A `send_invoice` subscription becomes `past_due` when its latest invoice is still unpaid at
 * the due date. The account's overdue-invoice automations (canceling the subscription or
 * marking it unpaid later, invoice.overdue) are not modelled.
 */
function markOverdue(ctx: BillingContext, ev: EventBatch, inv: StripeInvoice): void {
  const ss = getStripeStore(ctx.store);
  const handled = ss.invoices.update(inv.id, { overdue_handled: true })!;
  markPastDue(ctx, ev, handled);
}

/**
 * What the account's settings do once the last scheduled attempt on a `past_due`
 * subscription's invoice has failed: the invoice stays open or is marked uncollectible with
 * reason `max_payment_attempts`, and the subscription is canceled (reason `payment_failed`),
 * turned `unpaid`, paused (`final_payment_failure`) or left `past_due`.
 */
function applyFinalFailurePolicy(ctx: BillingContext, ev: EventBatch, inv: StripeInvoice): void {
  if (!inv.subscription_id) return;
  const ss = getStripeStore(ctx.store);
  const sub = ss.subscriptions.findOneBy("stripe_id", inv.subscription_id);
  if (!sub || sub.status !== "past_due") return;
  const policy = getBillingSettings(ctx.store).after_retries;
  if (policy.invoice === "uncollectible") markInvoiceUncollectible(ctx, ev, inv, "max_payment_attempts");

  const current = ss.subscriptions.get(sub.id)!;
  if (policy.subscription === "cancel") {
    cancelSubscription(ctx, ev, current, {}, { reason: "payment_failed" });
  } else if (policy.subscription === "unpaid") {
    const before = formatSubscription(ss, current);
    emitSubscriptionChange(ss, ev, ss.subscriptions.update(current.id, { status: "unpaid" })!, before);
  } else if (policy.subscription === "pause") {
    pauseSubscription(ctx, ev, current, "final_payment_failure");
  }
}

/** After an automatic attempt on `invoiceId` failed: past_due first, then the final policy once no retry is left. */
function afterFailedAttempt(ctx: BillingContext, ev: EventBatch, invoiceId: number): void {
  const ss = getStripeStore(ctx.store);
  const inv = ss.invoices.get(invoiceId);
  if (!inv || inv.status !== "open") return;
  markPastDue(ctx, ev, inv);
  if (inv.next_payment_attempt === undefined) applyFinalFailurePolicy(ctx, ev, inv);
}

/**
 * A scheduled retry of an open invoice. It charges the payment method the invoice would use
 * now, so a new default takes effect. While that is still the payment method that was hard
 * declined, or there is none, the retry is counted without a charge.
 */
function retryInvoice(ctx: BillingContext, ev: EventBatch, inv: StripeInvoice): void {
  const ss = getStripeStore(ctx.store);
  const pmId = invoicePaymentMethodId(ss, inv);
  if (!pmId || pmId === inv.hard_declined_payment_method) {
    recordSkippedRetry(ctx, ev, inv);
  } else {
    const result = payInvoice(ctx, ev, inv, { automatic: true, offSession: true });
    if (result.ok) return;
    // A payment method that can no longer be used fails before any attempt is counted.
    const current = ss.invoices.get(inv.id);
    if (current && current.attempt_count === inv.attempt_count) recordSkippedRetry(ctx, ev, current);
  }
  afterFailedAttempt(ctx, ev, inv.id);
}

/**
 * An `incomplete` subscription whose first invoice is still unpaid 23 hours after it was
 * created turns `incomplete_expired`, a terminal status, and its open invoice is voided.
 */
function expireIncomplete(ctx: BillingContext, ev: EventBatch, sub: StripeSubscription): void {
  const ss = getStripeStore(ctx.store);
  const before = formatSubscription(ss, sub);
  const expired = ss.subscriptions.update(sub.id, {
    status: "incomplete_expired",
    ended_at: nowFor(ss, { customerId: sub.customer_id }),
  })!;
  emitSubscriptionChange(ss, ev, expired, before);
  const inv = sub.latest_invoice ? ss.invoices.findOneBy("stripe_id", sub.latest_invoice) : undefined;
  if (inv && (inv.status === "open" || inv.status === "uncollectible")) voidInvoice(ctx, ev, inv);
}

/**
 * A resumption still pending at its `expires_at` lapses: its invoice is voided and the
 * subscription stays paused.
 */
function expireResume(ctx: BillingContext, ev: EventBatch, sub: StripeSubscription): void {
  const ss = getStripeStore(ctx.store);
  const pending = sub.pending_resume;
  if (!pending) return;
  const inv = ss.invoices.findOneBy("stripe_id", pending.invoice_id);
  if (inv && (inv.status === "open" || inv.status === "uncollectible")) {
    voidInvoice(ctx, ev, inv);
    return;
  }
  const before = formatSubscription(ss, sub);
  emitSubscriptionChange(ss, ev, ss.subscriptions.update(sub.id, { pending_resume: undefined })!, before);
}

function subscriptionActions(ctx: BillingContext, sub: StripeSubscription, frozenTime: number): DueAction[] {
  const ss = getStripeStore(ctx.store);
  const actions: DueAction[] = [];
  if (sub.status === "incomplete") {
    actions.push({
      at: Math.max(sub.created + INCOMPLETE_EXPIRY, frozenTime),
      rank: RANK.expire,
      key: sub.id,
      run(ev) {
        expireIncomplete(ctx, ev, sub);
      },
    });
    return actions;
  }
  if (sub.status === "paused") {
    // A paused subscription neither renews nor invoices; only its pending resumption expires.
    const pending = sub.pending_resume;
    if (pending) {
      actions.push({
        at: Math.max(pending.expires_at, frozenTime),
        rank: RANK.expire,
        key: sub.id,
        run(ev) {
          expireResume(ctx, ev, sub);
        },
      });
    }
    if (sub.cancel_at !== undefined) {
      actions.push({
        at: Math.max(sub.cancel_at, frozenTime),
        rank: RANK.period,
        key: sub.id,
        run(ev) {
          cancelSubscription(ctx, ev, sub, {}, { scheduled: true });
        },
      });
    }
    return actions;
  }
  const boundary = nextBoundary(ss, sub);
  if (boundary === undefined) return actions;
  const ending = sub.cancel_at !== undefined && sub.cancel_at <= boundary;

  if (sub.status === "trialing" && sub.trial_will_end_sent_for !== sub.trial_end) {
    actions.push({
      at: Math.max(boundary - TRIAL_WILL_END_LEAD, frozenTime),
      rank: RANK.trialWillEnd,
      key: sub.id,
      run(ev) {
        sendTrialWillEnd(ss, ev, sub);
      },
    });
  }

  const days = getBillingSettings(ctx.store).upcoming_renewal_days;
  const due = boundary - days * DAY;
  if (
    days > 0 &&
    !ending &&
    sub.status !== "unpaid" &&
    sub.collection_method === "charge_automatically" &&
    sub.upcoming_sent_for !== boundary &&
    due >= currentPeriodStart(ss, sub) &&
    !(sub.status === "trialing" && trialEndsWithoutInvoice(ss, sub))
  ) {
    actions.push({
      at: Math.max(due, frozenTime),
      rank: RANK.upcoming,
      key: sub.id,
      run(ev) {
        const period = nextRenewalPeriod(ss, sub);
        const marked = ss.subscriptions.update(sub.id, { upcoming_sent_for: boundary })!;
        if (period) ev.emit("invoice.upcoming", upcomingInvoice(ctx, marked, period));
      },
    });
  }

  actions.push({
    // A subscription attached to a clock later than its boundary catches up at the clock's time.
    at: Math.max(ending ? sub.cancel_at! : boundary, frozenTime),
    rank: RANK.period,
    key: sub.id,
    run(ev) {
      if (ending) cancelSubscription(ctx, ev, sub, {}, { scheduled: true, finalInvoice: "cycle" });
      else if (sub.status === "trialing") endTrialOnSchedule(ctx, ev, sub);
      else renewSubscription(ctx, ev, sub);
    },
  });
  return actions;
}

/** Everything Billing has scheduled for the objects on a clock, due or not. */
function scheduledActions(ctx: BillingContext, clock: StripeTestClock): DueAction[] {
  const ss = getStripeStore(ctx.store);
  const actions: DueAction[] = [];
  for (const customer of clockCustomers(ss, clock.stripe_id)) {
    for (const sub of ss.subscriptions.findBy("customer_id", customer.stripe_id)) {
      actions.push(...subscriptionActions(ctx, sub, clock.frozen_time));
    }
    for (const inv of ss.invoices.findBy("customer_id", customer.stripe_id)) {
      if (
        inv.status === "open" &&
        inv.collection_method === "send_invoice" &&
        inv.subscription_id !== undefined &&
        inv.due_date !== undefined &&
        !inv.overdue_handled
      ) {
        actions.push({
          at: Math.max(inv.due_date, clock.frozen_time),
          rank: RANK.overdue,
          key: inv.id,
          run(ev) {
            markOverdue(ctx, ev, inv);
          },
        });
      }
      if (!inv.auto_advance) continue;
      if (inv.status === "draft") {
        actions.push({
          at: Math.max(inv.created + DRAFT_FINALIZE_DELAY, clock.frozen_time),
          rank: RANK.finalize,
          key: inv.id,
          run(ev) {
            if (autoAdvanceDraft(ctx, ev, inv)) afterFailedAttempt(ctx, ev, inv.id);
          },
        });
      } else if (
        inv.status === "open" &&
        inv.attempted &&
        inv.subscription_id !== undefined &&
        inv.collection_method === "charge_automatically" &&
        inv.next_payment_attempt !== undefined
      ) {
        actions.push({
          at: Math.max(inv.next_payment_attempt, clock.frozen_time),
          rank: RANK.retry,
          key: inv.id,
          run(ev) {
            retryInvoice(ctx, ev, inv);
          },
        });
      }
    }
  }
  return actions;
}

function earliest(actions: DueAction[]): DueAction | undefined {
  let best: DueAction | undefined;
  for (const action of actions) {
    if (
      !best ||
      action.at < best.at ||
      (action.at === best.at && (action.rank < best.rank || (action.rank === best.rank && action.key < best.key)))
    ) {
      best = action;
    }
  }
  return best;
}

/**
 * Run Billing on a test clock up to `target`: repeatedly take the earliest action due at or
 * before the target, move the clock's `frozen_time` to it and run it. Every action of the
 * advance emits into one event batch, so webhook chaos (reorder, duplicate, drop, delay) acts
 * on the advance as a whole, as one request's events. The events have no request and each is
 * `created` at the simulated time of the action that raised it; they are delivered, in emit
 * order unless chaos reorders them, once Billing has caught up. The caller sets the final
 * `frozen_time` and status. Returns false when the clock keeps finding work, which the caller
 * reports as `internal_failure`.
 */
export async function runBillingUntil(ctx: BillingContext, clockId: string, target: number): Promise<boolean> {
  const ss = getStripeStore(ctx.store);
  let at = 0;
  const ev = eventBatch(ctx, undefined, () => at);
  let finished = false;
  for (let i = 0; i < MAX_ACTIONS; i++) {
    const clock = ss.testClocks.findOneBy("stripe_id", clockId);
    const next = clock && earliest(scheduledActions(ctx, clock).filter((action) => action.at <= target));
    if (!clock || !next) {
      finished = true;
      break;
    }
    // A clock only moves forward; every action is clamped to frozen_time, so this never goes back.
    if (next.at > clock.frozen_time) ss.testClocks.update(clock.id, { frozen_time: next.at });
    at = next.at;
    next.run(ev);
  }
  await ev.commit();
  return finished;
}
