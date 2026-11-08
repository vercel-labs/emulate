import { describe, it, expect, afterEach, vi } from "vitest";
import type Stripe from "stripe";
import { createTestApp, captureWebhooks, api, base, type TestApp } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

const DAY = 86400;
const HOUR = 3600;
const T = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
const TRIAL_END = T + 7 * DAY;
const PERIOD_END = Math.floor(Date.UTC(2026, 1, 15, 12, 0, 0) / 1000);

function obj(event: Stripe.Event): Json {
  return event.data.object as unknown as Json;
}

function types(events: Stripe.Event[]): string[] {
  return events.map((e) => e.type);
}

async function createClock(ctx: TestApp, frozenTime = T) {
  const res = await api<Json>(ctx.app, "POST", "/v1/test_helpers/test_clocks", { frozen_time: frozenTime });
  expect(res.status).toBe(200);
  return res.body;
}

async function advance(ctx: TestApp, clockId: string, frozenTime: number) {
  const res = await api<Json>(ctx.app, "POST", `/v1/test_helpers/test_clocks/${clockId}/advance`, {
    frozen_time: frozenTime,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function clockCustomer(ctx: TestApp, clockId: string, card?: string) {
  const res = await api<Json>(ctx.app, "POST", "/v1/customers", {
    email: "trial@example.com",
    test_clock: clockId,
    ...(card && { payment_method: card, invoice_settings: { default_payment_method: card } }),
  });
  expect(res.status).toBe(200);
  return res.body;
}

async function product(ctx: TestApp, name = "Pro Plan") {
  return (await api<Json>(ctx.app, "POST", "/v1/products", { name })).body.id as string;
}

async function monthlyPrice(ctx: TestApp, unitAmount = 2000) {
  const res = await api<Json>(ctx.app, "POST", "/v1/prices", {
    product: await product(ctx),
    currency: "usd",
    unit_amount: unitAmount,
    recurring: { interval: "month" },
  });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function meteredPrice(ctx: TestApp) {
  const meter = await api<Json>(ctx.app, "POST", "/v1/billing/meters", {
    display_name: "API calls",
    event_name: "api_calls",
    default_aggregation: { formula: "sum" },
  });
  expect(meter.status).toBe(200);
  const res = await api<Json>(ctx.app, "POST", "/v1/prices", {
    product: await product(ctx, "API"),
    currency: "usd",
    unit_amount: 10,
    recurring: { interval: "month", usage_type: "metered", meter: meter.body.id },
  });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function sendUsage(ctx: TestApp, customerId: string, value: number) {
  const res = await api<Json>(ctx.app, "POST", "/v1/billing/meter_events", {
    event_name: "api_calls",
    payload: { value: String(value), stripe_customer_id: customerId },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function getSub(ctx: TestApp, id: string) {
  return (await api<Json>(ctx.app, "GET", `/v1/subscriptions/${id}`)).body;
}

async function getInvoice(ctx: TestApp, id: string) {
  return (await api<Json>(ctx.app, "GET", `/v1/invoices/${id}`)).body;
}

async function subInvoices(ctx: TestApp, subId: string): Promise<Json[]> {
  const res = await api<Json>(ctx.app, "GET", `/v1/invoices?subscription=${subId}&limit=100`);
  return (res.body.data as Json[]).slice().reverse();
}

/** A 7 day trial on a clock customer with no card, ending with `behavior`. */
async function cardlessTrial(ctx: TestApp, behavior: string, extraItems: Json[] = []) {
  const clock = await createClock(ctx);
  const customer = await clockCustomer(ctx, clock.id);
  const res = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
    customer: customer.id,
    items: [{ price: await monthlyPrice(ctx) }, ...extraItems],
    trial_period_days: 7,
    trial_settings: { end_behavior: { missing_payment_method: behavior } },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.status).toBe("trialing");
  return { clock, customer, sub: res.body };
}

/** A clock customer paying for a monthly subscription with a working card. */
async function activeSubscription(ctx: TestApp, extra: Json = {}) {
  const clock = await createClock(ctx);
  const customer = await clockCustomer(ctx, clock.id, "pm_card_visa");
  const res = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
    customer: customer.id,
    items: [{ price: await monthlyPrice(ctx) }],
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.status).toBe("active");
  return { clock, customer, sub: res.body };
}

/** Attach `card` to the customer and make it the invoice default. */
async function addDefaultCard(ctx: TestApp, customerId: string, card = "pm_card_visa") {
  const attached = await api<Json>(ctx.app, "POST", `/v1/payment_methods/${card}/attach`, { customer: customerId });
  expect(attached.status).toBe(200);
  const updated = await api<Json>(ctx.app, "POST", `/v1/customers/${customerId}`, {
    invoice_settings: { default_payment_method: attached.body.id },
  });
  expect(updated.status).toBe(200);
  return attached.body.id as string;
}

async function pausedAtTrialEnd(ctx: TestApp, extraItems: Json[] = []) {
  const trial = await cardlessTrial(ctx, "pause", extraItems);
  await advance(ctx, trial.clock.id, TRIAL_END + HOUR);
  expect((await getSub(ctx, trial.sub.id)).status).toBe("paused");
  return trial;
}

describe("Trial end without a payment method", () => {
  it("cancels a cardless Checkout trial with missing_payment_method=cancel and creates no invoice", async () => {
    const ctx = createTestApp({ webhook: true });
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    const created = await api<Json>(ctx.app, "POST", "/v1/checkout/sessions", {
      mode: "subscription",
      customer: customer.id,
      success_url: "https://shop.example/success",
      line_items: [{ price: await monthlyPrice(ctx), quantity: 1 }],
      payment_method_collection: "if_required",
      subscription_data: {
        trial_period_days: 7,
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const form = new URLSearchParams({ email: "trial@example.com", payment_method: "none" });
    const completed = await ctx.app.request(`${base}/checkout/${created.body.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(completed.status).toBe(302);
    const session = (await api<Json>(ctx.app, "GET", `/v1/checkout/sessions/${created.body.id}`)).body;
    const subId = session.subscription as string;
    const trialInvoice = (await getSub(ctx, subId)).latest_invoice;

    const hooks = captureWebhooks();
    await advance(ctx, clock.id, TRIAL_END + 2 * HOUR);

    expect(types(hooks.events)).not.toContain("invoice.created");
    const [deleted] = hooks.ofType("customer.subscription.deleted");
    expect(deleted.created).toBe(TRIAL_END);
    expect(obj(deleted)).toMatchObject({
      id: subId,
      status: "canceled",
      canceled_at: TRIAL_END,
      ended_at: TRIAL_END,
      cancellation_details: { reason: "cancellation_requested" },
    });
    const sub = await getSub(ctx, subId);
    expect(sub.status).toBe("canceled");
    expect(sub.latest_invoice).toBe(trialInvoice);
    expect(await subInvoices(ctx, subId)).toHaveLength(1);
  });

  it("pauses with trial_end_without_payment_method and stays paused with no invoices", async () => {
    const ctx = createTestApp({ webhook: true });
    const { clock, sub } = await cardlessTrial(ctx, "pause");
    const hooks = captureWebhooks();
    await advance(ctx, clock.id, TRIAL_END + HOUR);

    const [paused] = hooks.ofType("customer.subscription.paused");
    expect(paused.created).toBe(TRIAL_END);
    const statusDetails = {
      paused: {
        subscription: { type: "trial_end_without_payment_method" },
        transitioned_at: TRIAL_END,
        type: "subscription",
      },
    };
    expect(obj(paused)).toMatchObject({ status: "paused", status_details: statusDetails });
    const updated = hooks.ofType("customer.subscription.updated").find((e) => obj(e).status === "paused");
    expect(updated?.data.previous_attributes).toMatchObject({ status: "trialing", status_details: null });
    expect(types(hooks.events)).not.toContain("invoice.created");

    await advance(ctx, clock.id, TRIAL_END + 45 * DAY);
    expect(types(hooks.events)).not.toContain("invoice.created");
    expect(types(hooks.events)).not.toContain("invoice.upcoming");
    const current = await getSub(ctx, sub.id);
    expect(current).toMatchObject({ status: "paused", status_details: statusDetails, pending_update: null });
    expect(current.items.data[0].current_period_end).toBe(TRIAL_END);
    expect(await subInvoices(ctx, sub.id)).toHaveLength(1);
  });

  it("checks the subscription's own default payment method too", async () => {
    const ctx = createTestApp({ webhook: true });
    const { clock, customer, sub } = await cardlessTrial(ctx, "pause");
    const pm = await api<Json>(ctx.app, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: customer.id });
    const set = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}`, {
      default_payment_method: pm.body.id,
    });
    expect(set.status).toBe(200);
    await advance(ctx, clock.id, TRIAL_END + 2 * HOUR);
    const current = await getSub(ctx, sub.id);
    expect(current.status).toBe("active");
    expect((await getInvoice(ctx, current.latest_invoice)).status).toBe("paid");
  });

  it("invoices with create_invoice and goes past_due when the payment fails for lack of a card", async () => {
    const ctx = createTestApp({ webhook: true });
    const { clock, customer, sub } = await cardlessTrial(ctx, "create_invoice");
    const hooks = captureWebhooks();
    await advance(ctx, clock.id, TRIAL_END + 2 * HOUR);

    const [created] = hooks.ofType("invoice.created");
    expect(created.created).toBe(TRIAL_END);
    const [failed] = hooks.ofType("invoice.payment_failed");
    expect(failed.created).toBe(TRIAL_END + HOUR);
    expect(obj(failed)).toMatchObject({ status: "open", attempt_count: 1, attempted: true });
    expect(obj(failed).next_payment_attempt).toBe(TRIAL_END + HOUR + 3 * DAY);
    const pastDue = hooks.ofType("customer.subscription.updated").find((e) => obj(e).status === "past_due");
    expect(pastDue).toBeDefined();

    const current = await getSub(ctx, sub.id);
    expect(current.status).toBe("past_due");
    const inv = await getInvoice(ctx, current.latest_invoice);
    expect(inv).toMatchObject({ status: "open", billing_reason: "subscription_cycle", amount_due: 2000 });
    const cust = (await api<Json>(ctx.app, "GET", `/v1/customers/${customer.id}`)).body;
    expect(cust.delinquent).toBe(true);
  });
});

describe("POST /v1/subscriptions/:id/pause", () => {
  it("pauses an active subscription with pause_requested", async () => {
    const ctx = createTestApp({ webhook: true });
    const { clock, sub } = await activeSubscription(ctx);
    await advance(ctx, clock.id, T + 10 * DAY);
    const hooks = captureWebhooks();

    const res = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/pause`, { type: "subscription" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      status: "paused",
      status_details: {
        paused: { subscription: { type: "pause_requested" }, transitioned_at: T + 10 * DAY, type: "subscription" },
      },
    });
    expect(res.body.items.data[0].current_period_end).toBe(T + 10 * DAY);
    expect(types(hooks.events)).toEqual(
      expect.arrayContaining(["customer.subscription.updated", "customer.subscription.paused"]),
    );
    expect(obj(hooks.ofType("customer.subscription.paused")[0]).status).toBe("paused");

    await advance(ctx, clock.id, PERIOD_END + 10 * DAY);
    expect(types(hooks.events)).not.toContain("invoice.created");
    expect((await getSub(ctx, sub.id)).status).toBe("paused");
  });

  it("rejects subscriptions that cannot be paused and unknown params", async () => {
    const ctx = createTestApp();
    const { sub } = await activeSubscription(ctx);
    const badType = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/pause`, { type: "collection" });
    expect(badType.status).toBe(400);
    expect(badType.body.error.param).toBe("type");
    const badBehavior = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/pause`, {
      invoicing_behavior: "later",
    });
    expect(badBehavior.status).toBe(400);
    expect(badBehavior.body.error.param).toBe("invoicing_behavior");

    expect((await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/pause`)).status).toBe(200);
    const again = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/pause`);
    expect(again.status).toBe(400);
    expect(again.body.error.type).toBe("invalid_request_error");

    const trial = await cardlessTrial(ctx, "pause");
    expect((await api<Json>(ctx.app, "POST", `/v1/subscriptions/${trial.sub.id}/pause`)).status).toBe(400);

    const missing = await api<Json>(ctx.app, "POST", "/v1/subscriptions/sub_missing/pause");
    expect(missing.status).toBe(404);
  });

  it("lets a paused subscription be updated without invoicing", async () => {
    const ctx = createTestApp({ webhook: true });
    const { sub } = await activeSubscription(ctx);
    await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/pause`);
    const hooks = captureWebhooks();
    const res = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}`, {
      metadata: { reason: "vacation" },
      items: [{ id: sub.items.data[0].id, quantity: 3 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: "paused", metadata: { reason: "vacation" } });
    expect(res.body.items.data[0].quantity).toBe(3);
    expect(types(hooks.events)).not.toContain("invoice.created");
  });
});

describe("POST /v1/subscriptions/:id/resume", () => {
  it("finalizes a resumption invoice without paying it, and activates the subscription once paid", async () => {
    const ctx = createTestApp({ webhook: true });
    const { clock, customer, sub } = await pausedAtTrialEnd(ctx);
    const resumeAt = TRIAL_END + 5 * DAY;
    await advance(ctx, clock.id, resumeAt);
    await addDefaultCard(ctx, customer.id);
    const hooks = captureWebhooks();

    const res = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/resume`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("paused");
    expect(res.body.pending_update).toEqual({
      billing_cycle_anchor: resumeAt,
      cancel_at_period_end: null,
      discount: null,
      discounts: null,
      expires_at: resumeAt + 23 * HOUR,
      metadata: null,
      subscription_items: null,
      trial_end: null,
      trial_from_plan: null,
    });
    const inv = await getInvoice(ctx, res.body.latest_invoice);
    expect(inv).toMatchObject({
      status: "open",
      billing_reason: "subscription_update",
      amount_due: 2000,
      attempt_count: 0,
      attempted: false,
    });
    expect(inv.lines.data[0].period).toEqual({ start: resumeAt, end: resumeAt + 31 * DAY });
    expect(types(hooks.events)).toEqual(expect.arrayContaining(["invoice.created", "invoice.finalized"]));
    expect(types(hooks.events)).not.toContain("invoice.payment_failed");
    expect(types(hooks.events)).not.toContain("customer.subscription.resumed");

    const paid = await api<Json>(ctx.app, "POST", `/v1/invoices/${inv.id}/pay`);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const [resumed] = hooks.ofType("customer.subscription.resumed");
    expect(obj(resumed)).toMatchObject({
      status: "active",
      status_details: null,
      pending_update: null,
      billing_cycle_anchor: resumeAt,
    });
    const activated = hooks.ofType("customer.subscription.updated").find((e) => obj(e).status === "active");
    expect(activated?.data.previous_attributes).toMatchObject({ status: "paused" });
    const seen = types(hooks.events);
    expect(seen.indexOf("invoice.paid")).toBeLessThan(seen.indexOf("customer.subscription.resumed"));

    const current = await getSub(ctx, sub.id);
    expect(current.items.data[0]).toMatchObject({
      current_period_start: resumeAt,
      current_period_end: resumeAt + 31 * DAY,
    });

    // The next cycle bills from the new anchor.
    await advance(ctx, clock.id, resumeAt + 31 * DAY + 2 * HOUR);
    const renewal = await getInvoice(ctx, (await getSub(ctx, sub.id)).latest_invoice);
    expect(renewal).toMatchObject({ billing_reason: "subscription_cycle", status: "paid" });
  });

  it("activates on mark_uncollectible and stays paused when the resumption invoice is voided", async () => {
    const ctx = createTestApp({ webhook: true });
    const forgiven = await pausedAtTrialEnd(ctx);
    const first = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${forgiven.sub.id}/resume`);
    const marked = await api<Json>(ctx.app, "POST", `/v1/invoices/${first.body.latest_invoice}/mark_uncollectible`);
    expect(marked.status).toBe(200);
    expect((await getSub(ctx, forgiven.sub.id)).status).toBe("active");

    const voided = await pausedAtTrialEnd(ctx);
    const second = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${voided.sub.id}/resume`);
    const hooks = captureWebhooks();
    expect((await api<Json>(ctx.app, "POST", `/v1/invoices/${second.body.latest_invoice}/void`)).status).toBe(200);
    const current = await getSub(ctx, voided.sub.id);
    expect(current).toMatchObject({ status: "paused", pending_update: null });
    const dropped = hooks.ofType("customer.subscription.updated")[0];
    expect(dropped.data.previous_attributes).toHaveProperty("pending_update");
    expect(types(hooks.events)).not.toContain("customer.subscription.resumed");
  });

  it("voids an unattempted resumption invoice after 23 hours and stays paused", async () => {
    const ctx = createTestApp({ webhook: true });
    const { clock, customer, sub } = await pausedAtTrialEnd(ctx);
    await addDefaultCard(ctx, customer.id);
    const resumed = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/resume`, {
      billing_cycle_anchor: { type: "now" },
      payment_behavior: "resume_on_payment_attempt",
    });
    expect(resumed.status).toBe(200);
    const invoiceId = resumed.body.latest_invoice as string;
    const hooks = captureWebhooks();

    await advance(ctx, clock.id, TRIAL_END + HOUR + 22 * HOUR);
    expect((await getInvoice(ctx, invoiceId)).status).toBe("open");
    await advance(ctx, clock.id, TRIAL_END + HOUR + 24 * HOUR);

    const [voided] = hooks.ofType("invoice.voided");
    expect(obj(voided).id).toBe(invoiceId);
    expect(voided.created).toBe(TRIAL_END + HOUR + 23 * HOUR);
    expect(types(hooks.events)).not.toContain("customer.subscription.resumed");
    const current = await getSub(ctx, sub.id);
    expect(current).toMatchObject({ status: "paused", pending_update: null });
    expect(current.status_details.paused.subscription.type).toBe("trial_end_without_payment_method");
  });

  it("turns past_due when a manual payment of the resumption invoice fails", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customer, sub } = await pausedAtTrialEnd(ctx);
    await addDefaultCard(ctx, customer.id, "pm_card_chargeCustomerFail");
    const resumed = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/resume`);
    const hooks = captureWebhooks();
    const paid = await api<Json>(ctx.app, "POST", `/v1/invoices/${resumed.body.latest_invoice}/pay`);
    expect(paid.status).toBe(402);
    const current = await getSub(ctx, sub.id);
    expect(current).toMatchObject({ status: "past_due", status_details: null, pending_update: null });
    expect(types(hooks.events)).toContain("customer.subscription.resumed");
    expect((await getInvoice(ctx, current.latest_invoice)).next_payment_attempt).toBeNull();
  });

  it("resumes in one call with resume_on_payment_success and a working card", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customer, sub } = await pausedAtTrialEnd(ctx);
    await addDefaultCard(ctx, customer.id);
    const hooks = captureWebhooks();
    const res = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/resume`, {
      payment_behavior: "resume_on_payment_success",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: "active", status_details: null, pending_update: null });
    expect((await getInvoice(ctx, res.body.latest_invoice)).status).toBe("paid");
    const seen = types(hooks.events);
    expect(seen).toEqual(expect.arrayContaining(["invoice.paid", "customer.subscription.resumed"]));
    expect(seen.indexOf("invoice.paid")).toBeLessThan(seen.indexOf("customer.subscription.resumed"));
  });

  it("stays paused when resume_on_payment_success fails, and retries on schedule", async () => {
    const ctx = createTestApp({ webhook: true });
    const { clock, customer, sub } = await pausedAtTrialEnd(ctx);
    await addDefaultCard(ctx, customer.id, "pm_card_chargeCustomerFail");
    const hooks = captureWebhooks();
    const res = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/resume`, {
      payment_behavior: "resume_on_payment_success",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("paused");
    expect(res.body.pending_update.expires_at).toBe(TRIAL_END + HOUR + 365 * DAY);
    const inv = await getInvoice(ctx, res.body.latest_invoice);
    expect(inv).toMatchObject({ status: "open", attempt_count: 1 });
    expect(inv.next_payment_attempt).toBe(TRIAL_END + HOUR + 3 * DAY);
    expect(types(hooks.events)).toContain("invoice.payment_failed");
    expect(types(hooks.events)).not.toContain("customer.subscription.resumed");

    await addDefaultCard(ctx, customer.id);
    await advance(ctx, clock.id, TRIAL_END + HOUR + 3 * DAY);
    expect((await getSub(ctx, sub.id)).status).toBe("active");
    expect(types(hooks.events)).toContain("customer.subscription.resumed");
  });

  it("requires a payment method for resume_on_payment_success and creates nothing without one", async () => {
    const ctx = createTestApp({ webhook: true });
    const { sub } = await pausedAtTrialEnd(ctx);
    const hooks = captureWebhooks();
    const res = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/resume`, {
      payment_behavior: "resume_on_payment_success",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ type: "invalid_request_error", code: "resource_missing" });
    expect(hooks.events).toHaveLength(0);
    expect(await subInvoices(ctx, sub.id)).toHaveLength(1);
    expect((await getSub(ctx, sub.id)).status).toBe("paused");
  });

  it("resumes at once with billing_cycle_anchor unchanged, keeping the anchor", async () => {
    const ctx = createTestApp({ webhook: true });
    const { clock, sub } = await activeSubscription(ctx);
    await advance(ctx, clock.id, T + 5 * DAY);
    await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/pause`);
    await advance(ctx, clock.id, T + 40 * DAY);
    const hooks = captureWebhooks();
    const res = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/resume`, {
      billing_cycle_anchor: { type: "unchanged" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: "active", billing_cycle_anchor: T, pending_update: null });
    const nextBoundary = Math.floor(Date.UTC(2026, 2, 15, 12, 0, 0) / 1000);
    expect(res.body.items.data[0]).toMatchObject({
      current_period_start: T + 40 * DAY,
      current_period_end: nextBoundary,
    });
    expect(types(hooks.events)).not.toContain("invoice.created");
    expect(types(hooks.events)).toContain("customer.subscription.resumed");
  });

  it("rejects resuming a subscription that is not paused, and bad params", async () => {
    const ctx = createTestApp();
    const { sub } = await activeSubscription(ctx);
    const active = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/resume`);
    expect(active.status).toBe(400);
    expect(active.body.error.type).toBe("invalid_request_error");

    await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/pause`);
    const badAnchor = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/resume`, {
      billing_cycle_anchor: { type: "later" },
    });
    expect(badAnchor.status).toBe(400);
    expect(badAnchor.body.error.param).toBe("billing_cycle_anchor[type]");
    const stringAnchor = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/resume`, {
      billing_cycle_anchor: "now",
    });
    expect(stringAnchor.status).toBe(400);
    expect(stringAnchor.body.error.param).toBe("billing_cycle_anchor");
    const badBehavior = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/resume`, {
      payment_behavior: "allow_incomplete",
    });
    expect(badBehavior.status).toBe(400);
    expect(badBehavior.body.error.param).toBe("payment_behavior");

    const first = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/resume`);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("paused");
    const second = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/resume`);
    expect(second.status).toBe(400);
  });

  it("does not bill usage recorded while paused", async () => {
    const ctx = createTestApp({ webhook: true });
    const metered = await meteredPrice(ctx);
    const { clock, customer, sub } = await pausedAtTrialEnd(ctx, [{ price: metered }]);
    await advance(ctx, clock.id, TRIAL_END + 2 * DAY);
    await sendUsage(ctx, customer.id, 500);
    await addDefaultCard(ctx, customer.id);

    const resumeAt = TRIAL_END + 3 * DAY;
    await advance(ctx, clock.id, resumeAt);
    const res = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}/resume`, {
      payment_behavior: "resume_on_payment_success",
    });
    expect(res.body.status).toBe("active");
    await advance(ctx, clock.id, resumeAt + DAY);
    await sendUsage(ctx, customer.id, 7);

    await advance(ctx, clock.id, resumeAt + 31 * DAY + 2 * HOUR);
    const renewal = await getInvoice(ctx, (await getSub(ctx, sub.id)).latest_invoice);
    const usage = (renewal.lines.data as Json[]).find((line) => line.pricing.price_details.price === metered);
    expect(usage?.quantity).toBe(7);
  });
});
