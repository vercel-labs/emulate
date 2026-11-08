import { getStripeStore, type StripeStore } from "./store.js";
import { stripeId } from "./helpers.js";
import { clockCustomers } from "./clock.js";
import { eventBatch, type EventBatch, type EventBatchContext } from "./events.js";
import { formatInvoice, formatSubscription, subscriptionItems } from "./formatters.js";
import { autoAdvanceDraft, DRAFT_FINALIZE_DELAY, type InvoicingContext } from "./invoicing.js";
import {
  cancelSubscription,
  emitSubscriptionChange,
  endTrialOnSchedule,
  nextRenewalPeriod,
  renewSubscription,
  subscriptionLines,
  TRIAL_WILL_END_LEAD,
} from "./subscriptions.js";
import { getBillingSettings } from "./settings.js";
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

const RANK = { finalize: 0, trialWillEnd: 1, upcoming: 2, period: 3 } as const;

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
  const lines = subscriptionLines(ss, sub, items, period, false).map((line) =>
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

function subscriptionActions(ctx: BillingContext, sub: StripeSubscription, frozenTime: number): DueAction[] {
  const ss = getStripeStore(ctx.store);
  const actions: DueAction[] = [];
  const boundary = nextBoundary(ss, sub);
  if (boundary === undefined) return actions;
  const ending = sub.cancel_at !== undefined && sub.cancel_at <= boundary;

  if (sub.status === "trialing" && sub.trial_will_end_sent_for !== sub.trial_end) {
    actions.push({
      at: Math.max(boundary - TRIAL_WILL_END_LEAD, frozenTime),
      rank: RANK.trialWillEnd,
      key: sub.id,
      run(ev) {
        const warned = ss.subscriptions.update(sub.id, { trial_will_end_sent_for: sub.trial_end })!;
        ev.emit("customer.subscription.trial_will_end", formatSubscription(ss, warned));
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
    due >= currentPeriodStart(ss, sub)
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
    at: ending ? sub.cancel_at! : boundary,
    rank: RANK.period,
    key: sub.id,
    run(ev) {
      if (ending) cancelSubscription(ctx, ev, sub, {}, { scheduled: true });
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
      if (inv.status !== "draft" || !inv.auto_advance) continue;
      actions.push({
        at: Math.max(inv.created + DRAFT_FINALIZE_DELAY, clock.frozen_time),
        rank: RANK.finalize,
        key: inv.id,
        run(ev) {
          if (autoAdvanceDraft(ctx, ev, inv)) markPastDue(ctx, ev, ss.invoices.get(inv.id) ?? inv);
        },
      });
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
 * before the target, move the clock's `frozen_time` to it and run it in its own event batch,
 * whose events have no request and are `created` at the simulated time. The caller sets the
 * final `frozen_time` and status. Returns false when the clock keeps finding work, which the
 * caller reports as `internal_failure`.
 */
export async function runBillingUntil(ctx: BillingContext, clockId: string, target: number): Promise<boolean> {
  const ss = getStripeStore(ctx.store);
  for (let i = 0; i < MAX_ACTIONS; i++) {
    const clock = ss.testClocks.findOneBy("stripe_id", clockId);
    if (!clock) return true;
    const next = earliest(scheduledActions(ctx, clock).filter((action) => action.at <= target));
    if (!next) return true;
    if (next.at !== clock.frozen_time) ss.testClocks.update(clock.id, { frozen_time: next.at });
    const ev = eventBatch(ctx, undefined, next.at);
    next.run(ev);
    await ev.commit();
  }
  return false;
}
