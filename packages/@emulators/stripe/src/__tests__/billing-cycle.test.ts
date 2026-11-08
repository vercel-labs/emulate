import { describe, it, expect, afterEach, vi } from "vitest";
import type Stripe from "stripe";
import { createTestApp, captureWebhooks, api, verify, type TestApp } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

const DAY = 86400;
const HOUR = 3600;
const T = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);

function utc(year: number, month: number, day: number, hour = 0): number {
  return Math.floor(Date.UTC(year, month, day, hour) / 1000);
}

function types(events: Stripe.Event[]): string[] {
  return events.map((e) => e.type);
}

function obj(event: Stripe.Event): Json {
  return event.data.object as unknown as Json;
}

async function createClock(ctx: TestApp, frozenTime = T) {
  const res = await api<Json>(ctx.app, "POST", "/v1/test_helpers/test_clocks", { frozen_time: frozenTime });
  expect(res.status).toBe(200);
  return res.body;
}

async function clockCustomer(ctx: TestApp, clockId: string, card: string | false = "pm_card_visa") {
  const res = await api<Json>(ctx.app, "POST", "/v1/customers", {
    email: "cycle@example.com",
    test_clock: clockId,
    ...(card && { payment_method: card, invoice_settings: { default_payment_method: card } }),
  });
  expect(res.status).toBe(200);
  return res.body;
}

async function monthlyPrice(ctx: TestApp, unitAmount = 2000) {
  const product = await api<Json>(ctx.app, "POST", "/v1/products", { name: "Pro Plan" });
  const price = await api<Json>(ctx.app, "POST", "/v1/prices", {
    product: product.body.id,
    currency: "usd",
    unit_amount: unitAmount,
    recurring: { interval: "month" },
  });
  expect(price.status).toBe(200);
  return price.body.id as string;
}

async function subscribe(ctx: TestApp, customerId: string, priceId: string, extra: Json = {}) {
  const res = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
    customer: customerId,
    items: [{ price: priceId }],
    ...extra,
  });
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

async function getSub(ctx: TestApp, id: string) {
  return (await api<Json>(ctx.app, "GET", `/v1/subscriptions/${id}`)).body;
}

async function subInvoices(ctx: TestApp, subId: string): Promise<Json[]> {
  const res = await api<Json>(ctx.app, "GET", `/v1/invoices?subscription=${subId}&limit=100`);
  return (res.body.data as Json[]).slice().reverse();
}

/** Asserts `first` was delivered before `second`. */
function before(events: Stripe.Event[], first: string, second: string) {
  const a = events.findIndex((e) => e.type === first);
  const b = events.findIndex((e) => e.type === second);
  expect(a, first).toBeGreaterThanOrEqual(0);
  expect(b, second).toBeGreaterThanOrEqual(0);
  expect(a, `${first} before ${second}`).toBeLessThan(b);
}

describe("trials on a test clock", () => {
  it("sends trial_will_end three days ahead, activates at trial end and collects an hour later", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    const priceId = await monthlyPrice(ctx);
    const sub = await subscribe(ctx, customer.id, priceId, { trial_period_days: 7 });
    const trialEnd = T + 7 * DAY;
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, T + 4 * DAY);
    const warnings = hooks.ofType("customer.subscription.trial_will_end");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].request).toEqual({ id: null, idempotency_key: null });
    expect(warnings[0].created).toBe(trialEnd - 3 * DAY);
    expect(obj(warnings[0])).toMatchObject({ id: sub.id, status: "trialing" });
    expect((await getSub(ctx, sub.id)).status).toBe("trialing");
    expect(hooks.events.at(-1)?.type).toBe("test_helpers.test_clock.ready");

    hooks.deliveries.length = 0;
    await advance(ctx, clock.id, trialEnd);
    const [updated] = hooks.ofType("customer.subscription.updated");
    expect(updated).toBeDefined();
    expect(updated.created).toBe(trialEnd);
    expect(updated.request).toEqual({ id: null, idempotency_key: null });
    expect(obj(updated)).toMatchObject({ status: "active", billing_cycle_anchor: trialEnd });
    const previous = updated.data.previous_attributes as Json;
    expect(previous.status).toBe("trialing");
    expect(previous.latest_invoice).toBe(sub.latest_invoice);
    expect(previous.items.data[0]).toMatchObject({ current_period_start: T, current_period_end: trialEnd });
    expect(obj(updated).items.data[0]).toMatchObject({
      current_period_start: trialEnd,
      current_period_end: utc(2026, 1, 22, 12),
    });

    const [created] = hooks.ofType("invoice.created");
    expect(created.created).toBe(trialEnd);
    const draft = obj(created);
    expect(draft).toMatchObject({
      status: "draft",
      billing_reason: "subscription_cycle",
      auto_advance: true,
      automatically_finalizes_at: trialEnd + HOUR,
      amount_due: 2000,
      created: trialEnd,
      period_start: T,
      period_end: trialEnd,
      parent: { subscription_details: { subscription: sub.id } },
    });
    expect(obj(updated).latest_invoice).toBe(draft.id);
    expect(types(hooks.events)).not.toContain("invoice.finalized");
    expect(hooks.events.at(-1)?.type).toBe("test_helpers.test_clock.ready");

    hooks.deliveries.length = 0;
    await advance(ctx, clock.id, trialEnd + HOUR);
    before(hooks.events, "invoice.finalized", "invoice.paid");
    before(hooks.events, "invoice.paid", "invoice.payment_succeeded");
    for (const type of ["invoice.finalized", "invoice.paid", "invoice.payment_succeeded"]) {
      const [event] = hooks.ofType(type);
      expect(obj(event).id, type).toBe(draft.id);
      expect(event.created, type).toBe(trialEnd + HOUR);
      expect(event.request, type).toEqual({ id: null, idempotency_key: null });
    }
    expect(obj(hooks.ofType("invoice.paid")[0])).toMatchObject({
      status: "paid",
      amount_paid: 2000,
      attempt_count: 1,
    });
    expect(types(hooks.events)).toContain("payment_intent.succeeded");
    expect(hooks.ofType("customer.subscription.trial_will_end")).toHaveLength(0);
    expect(hooks.events.at(-1)?.type).toBe("test_helpers.test_clock.ready");

    const invoice = await api<Json>(ctx.app, "GET", `/v1/invoices/${draft.id}`);
    expect(invoice.body).toMatchObject({
      status: "paid",
      amount_paid: 2000,
      status_transitions: { paid_at: trialEnd + HOUR },
    });
    expect((await getSub(ctx, sub.id)).status).toBe("active");
  });

  it("leaves a renewal that is declined open and the subscription past_due", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id, "pm_card_chargeCustomerFail");
    const sub = await subscribe(ctx, customer.id, await monthlyPrice(ctx), { trial_period_days: 7 });
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, T + 7 * DAY + HOUR);
    const [failed] = hooks.ofType("invoice.payment_failed");
    expect(obj(failed)).toMatchObject({ status: "open", attempt_count: 1, billing_reason: "subscription_cycle" });
    const current = await getSub(ctx, sub.id);
    expect(current.status).toBe("past_due");
    const invoice = await api<Json>(ctx.app, "GET", `/v1/invoices/${current.latest_invoice}`);
    expect(invoice.body.status).toBe("open");
  });
});

describe("renewals on a test clock", () => {
  it("rolls item periods by the clamped month and invoices each period from an anchor on the 31st", async () => {
    const ctx = createTestApp();
    const anchor = utc(2026, 0, 31);
    const clock = await createClock(ctx, anchor);
    const customer = await clockCustomer(ctx, clock.id);
    const sub = await subscribe(ctx, customer.id, await monthlyPrice(ctx));
    expect(sub.items.data[0]).toMatchObject({ current_period_start: anchor, current_period_end: utc(2026, 1, 28) });

    const boundaries = [utc(2026, 1, 28), utc(2026, 2, 31), utc(2026, 3, 30), utc(2026, 4, 31)];
    let previousEnd = anchor;
    for (let i = 0; i < 3; i++) {
      await advance(ctx, clock.id, boundaries[i]);
      const current = await getSub(ctx, sub.id);
      expect(current.status).toBe("active");
      expect(current.billing_cycle_anchor).toBe(anchor);
      expect(current.items.data[0]).toMatchObject({
        current_period_start: boundaries[i],
        current_period_end: boundaries[i + 1],
      });
      const invoice = (await api<Json>(ctx.app, "GET", `/v1/invoices/${current.latest_invoice}`)).body;
      expect(invoice).toMatchObject({
        billing_reason: "subscription_cycle",
        created: boundaries[i],
        period_start: previousEnd,
        period_end: boundaries[i],
      });
      expect(invoice.lines.data).toHaveLength(1);
      expect(invoice.lines.data[0].period).toEqual({ start: boundaries[i], end: boundaries[i + 1] });
      expect(invoice.lines.data[0].amount).toBe(2000);
      previousEnd = boundaries[i];
    }

    const cycles = (await subInvoices(ctx, sub.id)).filter((inv) => inv.billing_reason === "subscription_cycle");
    expect(cycles).toHaveLength(3);
    expect(cycles.map((inv) => inv.status)).toEqual(["paid", "paid", "draft"]);
  });

  it("gives two invoices for one advance that spans two periods", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const anchor = utc(2026, 0, 31);
    const clock = await createClock(ctx, anchor);
    const customer = await clockCustomer(ctx, clock.id);
    const sub = await subscribe(ctx, customer.id, await monthlyPrice(ctx));
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, utc(2026, 2, 31));
    const created = hooks.ofType("invoice.created").map(obj);
    expect(created.map((inv) => inv.created)).toEqual([utc(2026, 1, 28), utc(2026, 2, 31)]);
    expect(created.every((inv) => inv.billing_reason === "subscription_cycle")).toBe(true);

    const cycles = (await subInvoices(ctx, sub.id)).filter((inv) => inv.billing_reason === "subscription_cycle");
    expect(cycles.map((inv) => inv.status)).toEqual(["paid", "draft"]);
    const updates = hooks.ofType("customer.subscription.updated");
    expect(updates.map((e) => e.created)).toEqual([utc(2026, 1, 28), utc(2026, 2, 31)]);
    expect((updates[0].data.previous_attributes as Json).latest_invoice).toBe(sub.latest_invoice);
    expect(hooks.events.at(-1)?.type).toBe("test_helpers.test_clock.ready");
  });

  it("cancels at period end without a new invoice", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    const sub = await subscribe(ctx, customer.id, await monthlyPrice(ctx));
    const periodEnd = sub.items.data[0].current_period_end as number;
    const scheduled = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}`, { cancel_at_period_end: true });
    expect(scheduled.body).toMatchObject({ cancel_at: periodEnd, canceled_at: T });
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, periodEnd + DAY);
    const [deleted] = hooks.ofType("customer.subscription.deleted");
    expect(deleted.created).toBe(periodEnd);
    expect(deleted.request).toEqual({ id: null, idempotency_key: null });
    expect(obj(deleted)).toMatchObject({
      status: "canceled",
      ended_at: periodEnd,
      canceled_at: T,
      cancel_at_period_end: true,
      cancellation_details: { reason: "cancellation_requested" },
    });
    expect(types(hooks.events)).not.toContain("invoice.created");
    expect(types(hooks.events)).not.toContain("invoice.upcoming");
    expect(types(hooks.events)).not.toContain("customer.subscription.updated");
    expect(await subInvoices(ctx, sub.id)).toHaveLength(1);
  });

  it("cancels at a cancel_at inside the period", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    const sub = await subscribe(ctx, customer.id, await monthlyPrice(ctx), { cancel_at: T + 10 * DAY });
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, T + 20 * DAY);
    const [deleted] = hooks.ofType("customer.subscription.deleted");
    expect(obj(deleted)).toMatchObject({ id: sub.id, status: "canceled", ended_at: T + 10 * DAY });
    expect(deleted.created).toBe(T + 10 * DAY);
  });
});

describe("invoice.upcoming", () => {
  it("previews the renewal three days ahead without storing an invoice", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    const sub = await subscribe(ctx, customer.id, await monthlyPrice(ctx));
    const renewal = utc(2026, 1, 15, 12);
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, renewal - 3 * DAY - 1);
    expect(hooks.ofType("invoice.upcoming")).toHaveLength(0);

    await advance(ctx, clock.id, renewal - 3 * DAY);
    const upcoming = hooks.ofType("invoice.upcoming");
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].created).toBe(renewal - 3 * DAY);
    expect(upcoming[0].request).toEqual({ id: null, idempotency_key: null });
    const preview = obj(upcoming[0]);
    expect(preview).not.toHaveProperty("id");
    expect(preview).toMatchObject({
      object: "invoice",
      status: "draft",
      billing_reason: "upcoming",
      customer: customer.id,
      amount_due: 2000,
      number: null,
      hosted_invoice_url: null,
      automatically_finalizes_at: null,
      parent: { subscription_details: { subscription: sub.id } },
    });
    expect(preview.lines.data[0]).toMatchObject({
      amount: 2000,
      period: { start: renewal, end: utc(2026, 2, 15, 12) },
    });

    expect(await subInvoices(ctx, sub.id)).toHaveLength(1);
    await advance(ctx, clock.id, renewal - DAY);
    expect(hooks.ofType("invoice.upcoming")).toHaveLength(1);
  });

  it("is turned off by upcoming_renewal_days 0 and skipped for send_invoice", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const initial = await api<Json>(ctx.app, "GET", "/_stripe/billing/settings");
    expect(initial.body).toEqual({ object: "billing_settings", upcoming_renewal_days: 3 });

    const off = await api<Json>(ctx.app, "POST", "/_stripe/billing/settings", { upcoming_renewal_days: 0 });
    expect(off.status).toBe(200);
    expect(off.body.upcoming_renewal_days).toBe(0);
    expect((await api<Json>(ctx.app, "GET", "/_stripe/billing/settings")).body.upcoming_renewal_days).toBe(0);

    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    await subscribe(ctx, customer.id, await monthlyPrice(ctx));
    await advance(ctx, clock.id, utc(2026, 1, 14, 12));
    expect(hooks.ofType("invoice.upcoming")).toHaveLength(0);

    const on = createTestApp({ webhook: true });
    const otherClock = await createClock(on);
    const other = await clockCustomer(on, otherClock.id, false);
    await subscribe(on, other.id, await monthlyPrice(on), { collection_method: "send_invoice", days_until_due: 30 });
    hooks.deliveries.length = 0;
    await advance(on, otherClock.id, utc(2026, 1, 14, 12));
    expect(hooks.ofType("invoice.upcoming")).toHaveLength(0);
  });

  it("validates settings and takes them from the seed", async () => {
    const ctx = createTestApp();
    for (const value of ["soon", -1, 1.5]) {
      const bad = await api<Json>(ctx.app, "POST", "/_stripe/billing/settings", { upcoming_renewal_days: value });
      expect(bad.status, String(value)).toBe(400);
      expect(bad.body.error).toMatchObject({ type: "invalid_request_error", param: "upcoming_renewal_days" });
    }

    const hooks = captureWebhooks();
    const seeded = createTestApp({ webhook: true, seed: { billing: { upcoming_renewal_days: 7 } } });
    expect((await api<Json>(seeded.app, "GET", "/_stripe/billing/settings")).body.upcoming_renewal_days).toBe(7);
    const clock = await createClock(seeded);
    const customer = await clockCustomer(seeded, clock.id);
    await subscribe(seeded, customer.id, await monthlyPrice(seeded));
    await advance(seeded, clock.id, utc(2026, 1, 8, 12));
    const [upcoming] = hooks.ofType("invoice.upcoming");
    expect(upcoming.created).toBe(utc(2026, 1, 8, 12));
  });
});

describe("signatures across a long advance", () => {
  it("still verifies every delivery after a two-month advance", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    await subscribe(ctx, customer.id, await monthlyPrice(ctx));
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, utc(2026, 2, 15, 12));
    expect(hooks.ofType("invoice.paid").length).toBeGreaterThanOrEqual(1);
    expect(hooks.deliveries.length).toBeGreaterThan(5);
    for (const delivery of hooks.deliveries) {
      const event = verify(delivery.body, delivery.headers["Stripe-Signature"]);
      expect(event.id).toBe(delivery.event.id);
    }
    const stored = await api<Json>(ctx.app, "GET", `/v1/events/${hooks.ofType("invoice.created")[0].id}`);
    expect(stored.body.created).toBe(utc(2026, 1, 15, 12));
  });
});
