import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach, vi } from "vitest";
import Stripe from "stripe";
import { parse as parseYaml } from "yaml";
import { createTestApp, captureWebhooks, verify, sdk, api, base, WEBHOOK_SECRET, type TestApp } from "./support.js";
import type { StripeSeedConfig } from "../index.js";
import { getStripeStore } from "../store.js";

/**
 * The billing scenarios a SaaS integration runs against Stripe: a 7 day trial with a card on
 * file, a monthly flat plan plus a metered overage price whose first 1000 units are free, and
 * webhooks that drive entitlement. Every call goes through stripe-node and every delivered
 * webhook must pass stripe.webhooks.constructEvent.
 */

type Json = Record<string, any>;
type Hooks = ReturnType<typeof captureWebhooks>;

const DAY = 86400;
const HOUR = 3600;
const T = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
const TRIAL_END = T + 7 * DAY;
const FEB_15 = Math.floor(Date.UTC(2026, 1, 15, 12, 0, 0) / 1000);
const MAR_15 = Math.floor(Date.UTC(2026, 2, 15, 12, 0, 0) / 1000);
const SUCCESS_URL = "https://saas.example/welcome?session_id={CHECKOUT_SESSION_ID}";

let active: Hooks | undefined;

afterEach(() => {
  const hooks = active;
  active = undefined;
  vi.unstubAllGlobals();
  if (!hooks) return;
  expect(hooks.deliveries.length).toBeGreaterThan(0);
  for (const delivery of hooks.deliveries) {
    const event = verify(delivery.body, delivery.headers["Stripe-Signature"], WEBHOOK_SECRET);
    expect(event.id).toBe(delivery.event.id);
  }
});

interface Saas {
  ctx: TestApp;
  hooks: Hooks;
  stripe: Stripe;
  clock: Stripe.TestHelpers.TestClock;
  flat: Stripe.Price;
  metered: Stripe.Price;
  meter: Stripe.Billing.Meter;
}

/** The SaaS catalogue on a fresh emulator, with a test clock frozen at T. */
async function saas(): Promise<Saas> {
  const ctx = createTestApp({ webhook: true });
  const hooks = captureWebhooks();
  active = hooks;
  const stripe = sdk(ctx.app);
  const product = await stripe.products.create({ name: "Pro Plan" });
  const flat = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: 2000,
    recurring: { interval: "month" },
    lookup_key: "pro_monthly",
  });
  const meter = await stripe.billing.meters.create({
    display_name: "API calls",
    event_name: "api_calls",
    default_aggregation: { formula: "sum" },
  });
  const metered = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    recurring: { interval: "month", usage_type: "metered", meter: meter.id },
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    tiers: [
      { up_to: 1000, unit_amount: 0 },
      { up_to: "inf", unit_amount: 2 },
    ],
  });
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: T, name: "saas" });
  return { ctx, hooks, stripe, clock, flat, metered, meter };
}

function types(events: Stripe.Event[]): string[] {
  return events.map((e) => e.type);
}

function obj(event: Stripe.Event): Json {
  return event.data.object as unknown as Json;
}

/** Assert that each type occurs, in this order, among the events. */
function expectInOrder(events: Stripe.Event[], expected: string[]) {
  const seen = types(events);
  let from = 0;
  for (const type of expected) {
    const at = seen.indexOf(type, from);
    expect(at, `${type} after position ${from} in ${seen.join(", ")}`).toBeGreaterThanOrEqual(0);
    from = at + 1;
  }
}

/** The deliveries from index `from` on, for asserting what one step sent. */
function since(hooks: Hooks, from: number): Stripe.Event[] {
  return hooks.events.slice(from);
}

async function advance(s: Saas, frozenTime: number) {
  const from = s.hooks.events.length;
  const clock = await s.stripe.testHelpers.testClocks.advance(s.clock.id, { frozen_time: frozenTime });
  expect(clock.status).toBe("advancing");
  const sent = since(s.hooks, from);
  expect(sent[0].type).toBe("test_helpers.test_clock.advancing");
  expect(sent.at(-1)?.type).toBe("test_helpers.test_clock.ready");
  const ready = await s.stripe.testHelpers.testClocks.retrieve(s.clock.id);
  expect(ready).toMatchObject({ status: "ready", frozen_time: frozenTime });
  return sent;
}

async function clockCustomer(s: Saas, card?: string, email = "founder@saas.example") {
  return s.stripe.customers.create({
    email,
    test_clock: s.clock.id,
    ...(card && { payment_method: card, invoice_settings: { default_payment_method: card } }),
  });
}

/** Submit the hosted checkout page, as the customer would, with a test card or "none". */
async function completeCheckout(ctx: TestApp, session: Stripe.Checkout.Session, paymentMethod: string) {
  const form = new URLSearchParams({ email: "founder@saas.example", payment_method: paymentMethod });
  const res = await ctx.app.request(`${base}/checkout/${session.id}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  expect(res.status, await res.clone().text()).toBe(302);
  expect(res.headers.get("location")).toBe(SUCCESS_URL.replace("{CHECKOUT_SESSION_ID}", session.id));
}

/** Scenario 1: a 7 day trial through subscription-mode Checkout. */
async function checkoutTrial(
  s: Saas,
  card: string,
  options: { collection?: "always" | "if_required"; missing?: "cancel" | "pause" | "create_invoice" } = {},
) {
  const customer = await clockCustomer(s);
  const session = await s.stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customer.id,
    line_items: [{ price: s.flat.id, quantity: 1 }, { price: s.metered.id }],
    payment_method_collection: options.collection ?? "always",
    subscription_data: {
      trial_period_days: 7,
      ...(options.missing && { trial_settings: { end_behavior: { missing_payment_method: options.missing } } }),
    },
    success_url: SUCCESS_URL,
    cancel_url: "https://saas.example/pricing",
  });
  expect(session.url).toBe(`${base}/checkout/${session.id}`);
  expect(session.amount_total).toBe(0);
  await completeCheckout(s.ctx, session, card);
  const done = await s.stripe.checkout.sessions.retrieve(session.id, { expand: ["subscription"] });
  const subscription = done.subscription as Stripe.Subscription;
  return { customer, session: done, subscription };
}

async function latestInvoice(s: Saas, subscriptionId: string) {
  const sub = await s.stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
  return { sub, invoice: sub.latest_invoice as Stripe.Invoice };
}

/** A subscription created through the API for a clock customer whose default card is set. */
async function subscribe(s: Saas, card: string, items?: Stripe.SubscriptionCreateParams.Item[]) {
  const customer = await clockCustomer(s, card);
  const subscription = await s.stripe.subscriptions.create({
    customer: customer.id,
    items: items ?? [{ price: s.flat.id }],
    expand: ["latest_invoice"],
  });
  return { customer, subscription };
}

// Each scenario walks a whole billing lifecycle, so it gets more than the default 5 seconds.
describe("Billing scenarios through stripe-node", { timeout: 30_000 }, () => {
  it("1: Checkout with a trial and a card saves the card and starts a trialing subscription", async () => {
    const s = await saas();
    const { customer, session, subscription } = await checkoutTrial(s, "pm_card_visa");

    expect(session).toMatchObject({ status: "complete", payment_status: "paid", customer: customer.id });
    expect(subscription.id).toMatch(/^sub_/);
    expect(subscription.status).toBe("trialing");
    expect(subscription.trial_start).toBe(T);
    expect(subscription.trial_end).toBe(TRIAL_END);
    expect(subscription.default_payment_method).toMatch(/^pm_/);
    expect(subscription.test_clock).toBe(s.clock.id);
    const [flatItem, meteredItem] = subscription.items.data;
    expect(flatItem).toMatchObject({ quantity: 1, current_period_start: T, current_period_end: TRIAL_END });
    expect(flatItem.id).toMatch(/^si_/);
    expect(flatItem.plan.interval).toBe("month");
    expect(meteredItem).not.toHaveProperty("quantity");

    const events = s.hooks.events;
    expectInOrder(events, [
      "setup_intent.created",
      "payment_method.attached",
      "setup_intent.succeeded",
      "customer.subscription.created",
      "invoice.paid",
      "checkout.session.completed",
    ]);
    expect(events.at(-1)?.type).toBe("checkout.session.completed");
    const created = s.hooks.ofType("customer.subscription.created")[0];
    expect(obj(created)).toMatchObject({ id: subscription.id, status: "trialing" });
    const completed = s.hooks.ofType("checkout.session.completed")[0];
    expect(obj(completed)).toMatchObject({ id: session.id, subscription: subscription.id, mode: "subscription" });
    expect(completed.request).toEqual({ id: null, idempotency_key: null });

    const first = await s.stripe.invoices.retrieve(session.invoice as string);
    expect(first).toMatchObject({ billing_reason: "subscription_create", status: "paid", amount_due: 0 });
  });

  it("2: trial_will_end fires three days before the trial ends when the clock advances", async () => {
    const s = await saas();
    const { subscription } = await checkoutTrial(s, "pm_card_visa");
    expect(s.hooks.ofType("customer.subscription.trial_will_end")).toHaveLength(0);

    const early = await advance(s, TRIAL_END - 3 * DAY - HOUR);
    expect(types(early)).not.toContain("customer.subscription.trial_will_end");

    const sent = await advance(s, TRIAL_END - 3 * DAY);
    const [warning] = sent.filter((e) => e.type === "customer.subscription.trial_will_end");
    expect(obj(warning)).toMatchObject({ id: subscription.id, status: "trialing", trial_end: TRIAL_END });
    expect(warning.created).toBe(TRIAL_END - 3 * DAY);
    expect(warning.request).toEqual({ id: null, idempotency_key: null });
    expect((await s.stripe.subscriptions.retrieve(subscription.id)).status).toBe("trialing");

    const later = await advance(s, TRIAL_END - DAY);
    expect(types(later)).not.toContain("customer.subscription.trial_will_end");
  });

  it("3: the trial ends with a good card: the first paid invoice is paid and the subscription turns active", async () => {
    const s = await saas();
    const { subscription } = await checkoutTrial(s, "pm_card_visa");

    const sent = await advance(s, TRIAL_END + HOUR);
    expectInOrder(sent, [
      "customer.subscription.updated",
      "invoice.created",
      "invoice.finalized",
      "invoice.paid",
      "invoice.payment_succeeded",
    ]);
    const updated = sent.find((e) => e.type === "customer.subscription.updated")!;
    expect(obj(updated).status).toBe("active");
    expect(updated.data.previous_attributes).toMatchObject({ status: "trialing" });
    expect(updated.created).toBe(TRIAL_END);

    const { sub, invoice } = await latestInvoice(s, subscription.id);
    expect(sub.status).toBe("active");
    expect(sub.billing_cycle_anchor).toBe(TRIAL_END);
    expect(sub.items.data[0]).toMatchObject({ current_period_start: TRIAL_END });
    expect(invoice).toMatchObject({
      billing_reason: "subscription_cycle",
      status: "paid",
      amount_paid: 2000,
      attempt_count: 1,
      customer: subscription.customer,
    });
    expect(invoice.id).toMatch(/^in_/);
    expect(invoice.parent?.subscription_details?.subscription).toBe(subscription.id);
    const paid = sent.find((e) => e.type === "invoice.paid")!;
    expect(obj(paid).id).toBe(invoice.id);
    expect(paid.created).toBe(TRIAL_END + HOUR);
  });

  it("4: a declining card goes past_due, retries on the schedule, then cancels", async () => {
    const s = await saas();
    const { customer, subscription } = await checkoutTrial(s, "pm_card_chargeCustomerFail");

    const firstAttempt = TRIAL_END + HOUR;
    const sent = await advance(s, firstAttempt);
    expectInOrder(sent, ["invoice.created", "invoice.finalized", "invoice.payment_failed"]);
    expect(types(sent)).not.toContain("invoice.paid");
    const failed = sent.find((e) => e.type === "invoice.payment_failed")!;
    expect(obj(failed)).toMatchObject({
      status: "open",
      attempt_count: 1,
      next_payment_attempt: firstAttempt + 3 * DAY,
    });
    const pastDue = sent.find((e) => e.type === "customer.subscription.updated" && obj(e).status === "past_due");
    expect(pastDue?.data.previous_attributes).toMatchObject({ status: "active" });
    expect(sent.find((e) => e.type === "customer.updated")?.data.object).toMatchObject({ delinquent: true });
    expect((await s.stripe.subscriptions.retrieve(subscription.id)).status).toBe("past_due");

    const retry1 = await advance(s, firstAttempt + 3 * DAY);
    expect(retry1.filter((e) => e.type === "invoice.payment_failed").map((e) => obj(e).attempt_count)).toEqual([2]);
    const retry2 = await advance(s, firstAttempt + 8 * DAY);
    expect(retry2.filter((e) => e.type === "invoice.payment_failed").map((e) => obj(e).attempt_count)).toEqual([3]);
    const last = await advance(s, firstAttempt + 15 * DAY);
    const finalFailure = last.find((e) => e.type === "invoice.payment_failed")!;
    expect(obj(finalFailure)).toMatchObject({ attempt_count: 4, next_payment_attempt: null });
    expectInOrder(last, ["invoice.payment_failed", "customer.subscription.deleted"]);

    const canceled = await s.stripe.subscriptions.retrieve(subscription.id);
    expect(canceled).toMatchObject({
      status: "canceled",
      ended_at: firstAttempt + 15 * DAY,
      cancellation_details: { reason: "payment_failed" },
    });
    expect((await s.stripe.customers.retrieve(customer.id)) as Stripe.Customer).toMatchObject({ delinquent: true });
  });

  it("4: with after_retries[subscription]=unpaid the subscription ends unpaid instead", async () => {
    const s = await saas();
    const settings = await api<Json>(s.ctx.app, "POST", "/_stripe/billing/settings", {
      retry_schedule_days: [2],
      after_retries: { subscription: "unpaid", invoice: "uncollectible" },
    });
    expect(settings.status).toBe(200);
    const { subscription } = await checkoutTrial(s, "pm_card_chargeCustomerFail");

    await advance(s, TRIAL_END + HOUR);
    const last = await advance(s, TRIAL_END + HOUR + 2 * DAY);
    expectInOrder(last, ["invoice.payment_failed", "invoice.marked_uncollectible"]);
    const unpaid = last.find((e) => e.type === "customer.subscription.updated" && obj(e).status === "unpaid");
    expect(unpaid?.data.previous_attributes).toMatchObject({ status: "past_due" });
    const { sub, invoice } = await latestInvoice(s, subscription.id);
    expect(sub.status).toBe("unpaid");
    expect(invoice).toMatchObject({
      status: "uncollectible",
      attempt_count: 2,
      status_details: { uncollectible: { reason: "max_payment_attempts" } },
    });
  });

  it("5: recovery with a new default card and a paid open invoice makes the subscription active again", async () => {
    const s = await saas();
    const { customer, subscription } = await checkoutTrial(s, "pm_card_chargeCustomerFail");
    await advance(s, TRIAL_END + HOUR);
    const { invoice: open } = await latestInvoice(s, subscription.id);
    expect(open.status).toBe("open");

    const from = s.hooks.events.length;
    const card = await s.stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
    expect(card.id).toMatch(/^pm_/);
    await s.stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: card.id } });
    // The Checkout card is the subscription's own default and overrides the customer's.
    await s.stripe.subscriptions.update(subscription.id, { default_payment_method: card.id });
    const paid = await s.stripe.invoices.pay(open.id!);
    expect(paid).toMatchObject({ status: "paid", amount_paid: 2000, attempt_count: 1, next_payment_attempt: null });

    const sent = since(s.hooks, from);
    expectInOrder(sent, ["payment_method.attached", "invoice.paid", "customer.subscription.updated"]);
    const reactivated = sent.filter((e) => e.type === "customer.subscription.updated").at(-1)!;
    expect(obj(reactivated).status).toBe("active");
    expect(reactivated.data.previous_attributes).toMatchObject({ status: "past_due" });
    expect(reactivated.request?.id).toMatch(/^req_/);
    expect((await s.stripe.subscriptions.retrieve(subscription.id)).status).toBe("active");
    expect((await s.stripe.customers.retrieve(customer.id)) as Stripe.Customer).toMatchObject({ delinquent: false });

    const retries = await advance(s, TRIAL_END + HOUR + 4 * DAY);
    expect(types(retries)).not.toContain("invoice.payment_failed");
  });

  it("6: cancel_at_period_end cancels at the period end, and DELETE cancels at once", async () => {
    const s = await saas();
    const { subscription } = await subscribe(s, "pm_card_visa");
    expect(subscription.status).toBe("active");
    expect(subscription.items.data[0]).toMatchObject({ current_period_start: T, current_period_end: FEB_15 });

    const scheduled = await s.stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true });
    expect(scheduled).toMatchObject({ cancel_at_period_end: true, cancel_at: FEB_15, status: "active" });

    const sent = await advance(s, FEB_15 + HOUR);
    expect(types(sent)).not.toContain("invoice.created");
    const deleted = sent.find((e) => e.type === "customer.subscription.deleted")!;
    expect(obj(deleted)).toMatchObject({ id: subscription.id, status: "canceled", ended_at: FEB_15 });
    expect(deleted.created).toBe(FEB_15);

    const second = await subscribe(s, "pm_card_visa", [{ price: s.flat.id }]);
    const from = s.hooks.events.length;
    const canceled = await s.stripe.subscriptions.cancel(second.subscription.id);
    expect(canceled).toMatchObject({
      status: "canceled",
      canceled_at: FEB_15 + HOUR,
      ended_at: FEB_15 + HOUR,
      cancellation_details: { reason: "cancellation_requested" },
    });
    expect(types(since(s.hooks, from))).toEqual(["customer.subscription.deleted"]);
  });

  it("7: monthly renewals on the clock bill one invoice per period and move the item periods", async () => {
    const s = await saas();
    const { subscription } = await subscribe(s, "pm_card_visa");

    const tooFar = await api<Json>(s.ctx.app, "POST", `/v1/test_helpers/test_clocks/${s.clock.id}/advance`, {
      frozen_time: MAR_15 + 20 * DAY,
    });
    expect(tooFar.status).toBe(400);
    expect(tooFar.body.error.param).toBe("frozen_time");

    const first = await advance(s, FEB_15 + HOUR);
    const renewal = first.find((e) => e.type === "customer.subscription.updated")!;
    expect(renewal.data.previous_attributes).toHaveProperty("items");
    expect(renewal.data.previous_attributes).toHaveProperty("latest_invoice");
    const afterFirst = await s.stripe.subscriptions.retrieve(subscription.id);
    expect(afterFirst.items.data[0]).toMatchObject({ current_period_start: FEB_15, current_period_end: MAR_15 });

    await advance(s, MAR_15 + HOUR);
    const afterSecond = await s.stripe.subscriptions.retrieve(subscription.id);
    const APR_15 = Math.floor(Date.UTC(2026, 3, 15, 12, 0, 0) / 1000);
    expect(afterSecond.items.data[0]).toMatchObject({ current_period_start: MAR_15, current_period_end: APR_15 });
    expect(afterSecond.status).toBe("active");

    const invoices = await s.stripe.invoices.list({ subscription: subscription.id });
    const ordered = [...invoices.data].reverse();
    expect(ordered.map((i) => [i.billing_reason, i.status, i.amount_paid])).toEqual([
      ["subscription_create", "paid", 2000],
      ["subscription_cycle", "paid", 2000],
      ["subscription_cycle", "paid", 2000],
    ]);
    expect(ordered.map((i) => i.lines.data[0].period)).toEqual([
      { start: T, end: FEB_15 },
      { start: FEB_15, end: MAR_15 },
      { start: MAR_15, end: APR_15 },
    ]);
  });

  it("8: metered usage is deduplicated, summed per customer and billed with a free first tier", async () => {
    const s = await saas();
    const items = [{ price: s.flat.id }, { price: s.metered.id }];
    const a = await subscribe(s, "pm_card_visa", items);
    const b = await subscribe(s, "pm_card_mastercard", items);
    const report = (customer: string, value: number, identifier: string) =>
      s.stripe.billing.meterEvents.create({
        event_name: "api_calls",
        identifier,
        payload: { stripe_customer_id: customer, value: String(value) },
      });

    const recorded = await report(a.customer.id, 600, "a-1");
    expect(recorded).toMatchObject({ object: "billing.meter_event", identifier: "a-1", timestamp: T });
    await report(a.customer.id, 900, "a-2");
    const duplicate = await report(a.customer.id, 600, "a-1").catch((e: unknown) => e);
    expect(duplicate).toBeInstanceOf(Stripe.errors.StripeInvalidRequestError);
    expect((duplicate as Stripe.errors.StripeError).code).toBe("duplicate_meter_event");
    await report(b.customer.id, 5000, "b-1");

    const summaries = await s.stripe.billing.meters.listEventSummaries(s.meter.id, {
      customer: a.customer.id,
      start_time: T,
      end_time: T + HOUR,
    });
    expect(summaries.data).toHaveLength(1);
    expect(summaries.data[0]).toMatchObject({
      object: "billing.meter_event_summary",
      aggregated_value: 1500,
      meter: s.meter.id,
    });

    await advance(s, T + 25 * HOUR);
    const later = await report(a.customer.id, 0, "a-1");
    expect(later.identifier).toBe("a-1");

    await advance(s, FEB_15 + HOUR);
    const invoiceA = (await latestInvoice(s, a.subscription.id)).invoice;
    const invoiceB = (await latestInvoice(s, b.subscription.id)).invoice;
    const meteredLines = (invoice: Stripe.Invoice) =>
      invoice.lines.data
        .filter((line) => line.pricing?.price_details?.price === s.metered.id)
        .map((line) => [line.quantity, line.amount]);
    expect(meteredLines(invoiceA)).toEqual([
      [1000, 0],
      [500, 1000],
    ]);
    expect(meteredLines(invoiceB)).toEqual([
      [1000, 0],
      [4000, 8000],
    ]);
    expect(invoiceA).toMatchObject({ billing_reason: "subscription_cycle", status: "paid", amount_paid: 3000 });
    expect(invoiceB).toMatchObject({ status: "paid", amount_paid: 10000 });
    const usageLine = invoiceA.lines.data.find((line) => line.pricing?.price_details?.price === s.metered.id)!;
    expect(usageLine.period).toEqual({ start: T, end: FEB_15 });
  });

  it("9: a card that needs 3D Secure leaves the invoice waiting on requires_action", async () => {
    const s = await saas();
    const { subscription } = await subscribe(s, "pm_card_authenticationRequired");
    expect(subscription.status).toBe("incomplete");
    const first = subscription.latest_invoice as Stripe.Invoice;
    expect(first).toMatchObject({ status: "open", attempt_count: 1 });
    expectInOrder(s.hooks.events, [
      "customer.subscription.created",
      "invoice.finalized",
      "payment_intent.requires_action",
      "invoice.payment_action_required",
    ]);
    const requires = s.hooks.ofType("payment_intent.requires_action")[0];
    const intent = obj(requires);
    expect(intent).toMatchObject({ status: "requires_action", next_action: { type: "use_stripe_sdk" } });
    expect(intent.id).toMatch(/^pi_/);
    const action = s.hooks.ofType("invoice.payment_action_required")[0];
    expect(obj(action).id).toBe(first.id);

    const auth = await api<Json>(s.ctx.app, "POST", `/_stripe/simulate/payment_intents/${intent.id}/authenticate`, {
      result: "succeed",
    });
    expect(auth.status).toBe(200);
    expect((await s.stripe.paymentIntents.retrieve(intent.id)).status).toBe("succeeded");
    expect((await s.stripe.invoices.retrieve(first.id!)).status).toBe("paid");
    expect((await s.stripe.subscriptions.retrieve(subscription.id)).status).toBe("active");

    // Later the bank asks for authentication again, on an off-session renewal.
    const pm = (await s.stripe.subscriptions.retrieve(subscription.id)).default_payment_method;
    const customer = (await s.stripe.customers.retrieve(subscription.customer as string)) as Stripe.Customer;
    const cardId = (pm as string | null) ?? (customer.invoice_settings.default_payment_method as string);
    const simulated = await api<Json>(s.ctx.app, "POST", `/_stripe/simulate/payment_methods/${cardId}`, {
      behavior: "require_authentication",
    });
    expect(simulated.status).toBe(200);
    const sent = await advance(s, FEB_15 + HOUR);
    expectInOrder(sent, ["invoice.finalized", "invoice.payment_action_required", "invoice.payment_failed"]);
    const { sub, invoice } = await latestInvoice(s, subscription.id);
    expect(sub.status).toBe("past_due");
    expect(invoice.status).toBe("open");
    const renewalIntent = obj(sent.find((e) => e.type === "payment_intent.requires_action")!);
    expect(renewalIntent.status).toBe("requires_action");
  });

  it("10: webhooks are full Event objects that verify, with request and pending_webhooks", async () => {
    const s = await saas();
    const customer = await s.stripe.customers.create(
      { email: "envelope@saas.example" },
      { idempotencyKey: "signup-42" },
    );
    const delivery = s.hooks.deliveries.find((d) => d.event.type === "customer.created")!;
    const event = verify(delivery.body, delivery.headers["Stripe-Signature"], WEBHOOK_SECRET);
    expect(Object.keys(event).sort()).toEqual(
      ["api_version", "created", "data", "id", "livemode", "object", "pending_webhooks", "request", "type"].sort(),
    );
    expect(event).toMatchObject({
      object: "event",
      api_version: "2026-10-28.endive",
      livemode: false,
      pending_webhooks: 1,
      type: "customer.created",
      request: { idempotency_key: "signup-42" },
    });
    expect(event.id).toMatch(/^evt_/);
    expect(event.request?.id).toMatch(/^req_/);
    expect(typeof event.created).toBe("number");
    expect(obj(event)).toMatchObject({ id: customer.id, object: "customer" });
    expect(() => verify(delivery.body, delivery.headers["Stripe-Signature"], "whsec_wrong")).toThrow(
      Stripe.errors.StripeSignatureVerificationError,
    );

    const stored = await s.stripe.events.retrieve(event.id);
    expect(stored.pending_webhooks).toBe(0);
    expect(stored.data).toEqual(event.data);

    const updated = await s.stripe.customers.update(customer.id, { name: "Ada" });
    const change = s.hooks.ofType("customer.updated").at(-1)!;
    expect(obj(change).name).toBe(updated.name);
    expect(change.data.previous_attributes).toEqual({ name: null });

    for (const e of s.hooks.events) {
      expect(e.object).toBe("event");
      expect(e.livemode).toBe(false);
      expect(e.data.object).toBeTypeOf("object");
    }
  });

  it("11: chaos duplicates, reorders, holds and drops deliveries on request", async () => {
    const s = await saas();
    const customer = await clockCustomer(s, "pm_card_visa");
    const chaos = await api<Json>(s.ctx.app, "POST", "/_stripe/webhooks/chaos", {
      seed: 7,
      duplicate: { types: ["invoice.paid"], count: 1 },
      delay: { types: ["customer.subscription.created"] },
      drop: { types: ["invoice.finalized"] },
      reorder: "reverse",
    });
    expect(chaos.status).toBe(200);
    expect(chaos.body.enabled).toBe(true);

    const from = s.hooks.events.length;
    const subscription = await s.stripe.subscriptions.create({ customer: customer.id, items: [{ price: s.flat.id }] });
    expect(subscription.status).toBe("active");
    const sent = since(s.hooks, from);
    const paid = sent.filter((e) => e.type === "invoice.paid");
    expect(paid).toHaveLength(2);
    expect(paid[0].id).toBe(paid[1].id);
    expect(types(sent)).not.toContain("customer.subscription.created");
    expect(types(sent)).not.toContain("invoice.finalized");
    // Reversed: the invoice is paid before it is reported created.
    expect(types(sent).indexOf("invoice.paid")).toBeLessThan(types(sent).indexOf("invoice.created"));

    const log = await api<{ data: Json[] }>(s.ctx.app, "GET", "/_stripe/webhooks/deliveries?status=dropped");
    const dropped = log.body.data.find((d) => d.type === "invoice.finalized")!;
    expect(dropped).toBeDefined();

    const flushed = await api<Json>(s.ctx.app, "POST", "/_stripe/webhooks/flush", {});
    expect(flushed.status).toBe(200);
    expect(flushed.body.remaining).toBe(0);
    expect(s.hooks.events.at(-1)?.type).toBe("customer.subscription.created");

    const redelivered = await api<Json>(s.ctx.app, "POST", `/_stripe/events/${dropped.event_id}/redeliver`);
    expect(redelivered.status).toBe(200);
    expect(s.hooks.events.at(-1)).toMatchObject({ id: dropped.event_id, type: "invoice.finalized" });

    const cleared = await api<Json>(s.ctx.app, "DELETE", "/_stripe/webhooks/chaos");
    expect(cleared.body.enabled).toBe(false);
  });

  it("11: chaos can be turned on from the seed config", async () => {
    const ctx = createTestApp({ webhook: true, seed: { webhook_chaos: { seed: 3, duplicate: { types: ["*"] } } } });
    const hooks = captureWebhooks();
    active = hooks;
    await sdk(ctx.app).customers.create({ email: "twice@saas.example" });
    expect(types(hooks.events)).toEqual(["customer.created", "customer.created"]);
    expect(hooks.events[0].id).toBe(hooks.events[1].id);
  });

  it("12: a billing portal session returns a URL to the portal page", async () => {
    const s = await saas();
    const { customer, subscription } = await subscribe(s, "pm_card_visa");
    const portal = await s.stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: "https://saas.example/account",
    });
    expect(portal.id).toMatch(/^bps_/);
    expect(portal).toMatchObject({
      object: "billing_portal.session",
      customer: customer.id,
      return_url: "https://saas.example/account",
      livemode: false,
      url: `${base}/billing_portal/${portal.id}`,
    });
    expect(portal.configuration).toMatch(/^bpc_/);
    expect(obj(s.hooks.ofType("billing_portal.session.created")[0]).id).toBe(portal.id);

    const page = await s.ctx.app.request(portal.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(subscription.id);

    const from = s.hooks.events.length;
    const cancel = await s.ctx.app.request(`${portal.url}/subscriptions/${subscription.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ feedback: "too_expensive" }).toString(),
    });
    expect(cancel.status).toBeLessThan(400);
    const updated = since(s.hooks, from).find((e) => e.type === "customer.subscription.updated")!;
    expect(obj(updated)).toMatchObject({
      cancel_at_period_end: true,
      cancellation_details: { feedback: "too_expensive" },
    });
  });

  it("13: if_required without a card, missing_payment_method=cancel cancels at trial end", async () => {
    const s = await saas();
    const { subscription } = await checkoutTrial(s, "none", { collection: "if_required", missing: "cancel" });
    expect(subscription).toMatchObject({ status: "trialing", default_payment_method: null });
    expect(subscription.trial_settings?.end_behavior.missing_payment_method).toBe("cancel");

    const sent = await advance(s, TRIAL_END + HOUR);
    expect(types(sent)).not.toContain("invoice.created");
    const deleted = sent.find((e) => e.type === "customer.subscription.deleted")!;
    expect(obj(deleted)).toMatchObject({ status: "canceled", ended_at: TRIAL_END });
    expect((await s.stripe.subscriptions.retrieve(subscription.id)).status).toBe("canceled");
  });

  it("13: if_required without a card, missing_payment_method=pause pauses at trial end", async () => {
    const s = await saas();
    const { subscription } = await checkoutTrial(s, "none", { collection: "if_required", missing: "pause" });

    const sent = await advance(s, TRIAL_END + HOUR);
    expect(types(sent)).not.toContain("invoice.created");
    expectInOrder(sent, ["customer.subscription.updated", "customer.subscription.paused"]);
    const paused = await s.stripe.subscriptions.retrieve(subscription.id);
    expect(paused.status).toBe("paused");
    expect(paused.status_details?.paused?.subscription?.type).toBe("trial_end_without_payment_method");

    const later = await advance(s, TRIAL_END + 40 * DAY);
    expect(types(later)).not.toContain("invoice.created");
  });

  it("13: if_required without a card, missing_payment_method=create_invoice invoices and goes past_due", async () => {
    const s = await saas();
    const { subscription } = await checkoutTrial(s, "none", { collection: "if_required", missing: "create_invoice" });

    const sent = await advance(s, TRIAL_END + HOUR);
    expectInOrder(sent, [
      "customer.subscription.updated",
      "invoice.created",
      "invoice.finalized",
      "invoice.payment_failed",
    ]);
    const { sub, invoice } = await latestInvoice(s, subscription.id);
    expect(sub.status).toBe("past_due");
    expect(invoice).toMatchObject({ status: "open", attempt_count: 1, billing_reason: "subscription_cycle" });
    expect(invoice.next_payment_attempt).toBe(TRIAL_END + HOUR + 3 * DAY);
  });
});

/** The first ```yaml block after a heading in the package README. */
function readmeYaml(heading: string): string {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = readme.slice(readme.indexOf(heading));
  const match = /```yaml\n([\s\S]*?)```/.exec(section);
  if (!match) throw new Error(`No yaml block under ${heading}`);
  return match[1];
}

describe("Seed examples in the docs", { timeout: 30_000 }, () => {
  it("parses and seeds through seedFromConfig, and the seeded catalogue bills end to end", async () => {
    const parsed = parseYaml(readmeYaml("## Seed Configuration")) as { stripe: StripeSeedConfig };
    const seed = parsed.stripe;
    // The README points at a local app; deliveries are captured here instead.
    const ctx = createTestApp({ seed: { ...seed, webhooks: [] }, webhook: true });
    const ss = getStripeStore(ctx.store);
    expect(ss.customers.all().map((c) => c.email)).toEqual(["test@example.com", "card@example.com"]);
    expect(ss.billingMeters.all().map((m) => m.event_name)).toEqual(["api_calls"]);
    expect(ss.prices.all()).toHaveLength(2);

    const stripe = sdk(ctx.app);
    const settings = await api<Json>(ctx.app, "GET", "/_stripe/billing/settings");
    expect(settings.body).toMatchObject({
      upcoming_renewal_days: 3,
      retry_schedule_days: [3, 5, 7],
      after_retries: { subscription: "cancel", invoice: "open" },
    });
    const chaos = await api<Json>(ctx.app, "GET", "/_stripe/webhooks/chaos");
    expect(chaos.body).toMatchObject({ seed: 42, reorder: "reverse" });
    await api(ctx.app, "DELETE", "/_stripe/webhooks/chaos");

    const hooks = captureWebhooks();
    active = hooks;
    const [monthly] = (await stripe.prices.list({ lookup_keys: ["pro_monthly"] })).data;
    const metered = (await stripe.prices.list({ recurring: { usage_type: "metered" } } as Stripe.PriceListParams))
      .data[0];
    expect(monthly).toMatchObject({ unit_amount: 2000, recurring: { interval: "month" } });
    expect(metered).toMatchObject({ billing_scheme: "tiered", tiers_mode: "graduated" });

    // The seeded customer is on the seeded clock with a default card, so it subscribes as is.
    const clock = await stripe.testHelpers.testClocks.retrieve("clock_renewals");
    expect(clock.frozen_time).toBe(T);
    const customer = await stripe.customers.retrieve("cus_with_card");
    expect(customer).toMatchObject({
      test_clock: clock.id,
      invoice_settings: { default_payment_method: expect.stringMatching(/^pm_/) },
    });
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: monthly.id }, { price: metered.id }],
    });
    await stripe.billing.meterEvents.create({
      event_name: "api_calls",
      payload: { stripe_customer_id: customer.id, value: "1200" },
    });
    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: FEB_15 + HOUR });
    const renewed = await stripe.subscriptions.retrieve(subscription.id, { expand: ["latest_invoice"] });
    expect((renewed.latest_invoice as Stripe.Invoice).amount_paid).toBe(2000 + 200 * 2);
  });

  const repo = new URL("../../../../../", import.meta.url);
  const docs = [
    "README.md",
    "skills/stripe/SKILL.md",
    "apps/web/content/docs/stripe.mdx",
    "apps/web/content/docs/configuration.mdx",
  ];

  it.each(docs)("seeds every Stripe example in %s, with a monthly and a metered price", (path) => {
    const text = readFileSync(new URL(path, repo), "utf8");
    const seeds = [...text.matchAll(/```ya?ml[^\n]*\n([\s\S]*?)```/g)]
      .map((m) => parseYaml(m[1]) as { stripe?: StripeSeedConfig } | null)
      .flatMap((config) => (config?.stripe ? [config.stripe] : []));
    expect(seeds.length, `a stripe seed example in ${path}`).toBeGreaterThan(0);
    for (const seed of seeds) {
      const ctx = createTestApp({ seed: { ...seed, webhooks: [] } });
      const prices = getStripeStore(ctx.store).prices.all();
      expect(prices.some((p) => p.recurring?.interval === "month" && p.recurring.usage_type !== "metered")).toBe(true);
      expect(prices.some((p) => p.recurring?.usage_type === "metered")).toBe(true);
    }
  });
});
