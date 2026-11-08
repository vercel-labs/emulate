import { describe, it, expect, afterEach, vi } from "vitest";
import Stripe from "stripe";
import { createTestApp, captureWebhooks, api, type TestApp } from "./support.js";
import { periodBoundary } from "../billing.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

const DAY = 86400;
const T = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
const FEB_15 = Math.floor(Date.UTC(2026, 1, 15, 12, 0, 0) / 1000);

function types(events: Stripe.Event[]): string[] {
  return events.map((e) => e.type);
}

async function clockCustomer(ctx: TestApp, card = "pm_card_visa") {
  const clock = await api<Json>(ctx.app, "POST", "/v1/test_helpers/test_clocks", { frozen_time: T });
  const customer = await api<Json>(ctx.app, "POST", "/v1/customers", {
    email: "plans@example.com",
    test_clock: clock.body.id,
    payment_method: card,
    invoice_settings: { default_payment_method: card },
  });
  expect(customer.status).toBe(200);
  return { clockId: clock.body.id as string, customerId: customer.body.id as string };
}

async function price(ctx: TestApp, unitAmount: number, interval: "month" | "year", name = "Pro") {
  const res = await api<Json>(ctx.app, "POST", "/v1/prices", {
    product_data: { name },
    currency: "usd",
    unit_amount: unitAmount,
    recurring: { interval },
  });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function advance(ctx: TestApp, clockId: string, to: number) {
  const res = await api<Json>(ctx.app, "POST", `/v1/test_helpers/test_clocks/${clockId}/advance`, {
    frozen_time: to,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function invoicesOf(ctx: TestApp, subId: string): Promise<Json[]> {
  const res = await api<Json>(ctx.app, "GET", `/v1/invoices?subscription=${subId}&limit=100`);
  return [...res.body.data].reverse();
}

describe("changing the price of a subscription item", () => {
  it("swaps the price of an existing item through items[0][id] and items[0][price]", async () => {
    const ctx = createTestApp({ webhook: true });
    const { clockId, customerId } = await clockCustomer(ctx);
    const basic = await price(ctx, 1000, "month", "Basic");
    const pro = await price(ctx, 3000, "month", "Pro");
    const created = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: basic, quantity: 2 }],
    });
    const item = created.body.items.data[0];

    const hooks = captureWebhooks();
    await advance(ctx, clockId, T + 10 * DAY);
    const res = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${created.body.id}`, {
      items: [{ id: item.id, price: pro }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items.data).toHaveLength(1);
    const swapped = res.body.items.data[0];
    expect(swapped).toMatchObject({
      id: item.id,
      quantity: 2,
      price: { id: pro, unit_amount: 3000 },
      plan: { id: pro, amount: 3000, interval: "month" },
      current_period_start: T,
      current_period_end: FEB_15,
    });
    // Same interval: the cycle and the latest invoice stay, and no invoice is created.
    expect(res.body).toMatchObject({
      status: "active",
      billing_cycle_anchor: T,
      latest_invoice: created.body.latest_invoice,
    });
    expect(await invoicesOf(ctx, created.body.id)).toHaveLength(1);

    const updates = hooks.ofType("customer.subscription.updated");
    expect(updates).toHaveLength(1);
    const previous = updates[0].data.previous_attributes as Json;
    expect(previous.items.data[0]).toMatchObject({ id: item.id, price: { id: basic } });
    expect(types(hooks.events)).not.toContain("invoice.created");

    // The next renewal bills the new price for the next month.
    await advance(ctx, clockId, FEB_15 + 2 * 3600);
    const renewal = (await invoicesOf(ctx, created.body.id))[1];
    expect(renewal).toMatchObject({ billing_reason: "subscription_cycle", status: "paid", amount_paid: 6000 });
    expect(renewal.lines.data[0]).toMatchObject({
      quantity: 2,
      pricing: { price_details: { price: pro } },
      period: { start: FEB_15, end: periodBoundary(T, "month", 1, 2) },
    });
  });

  it("resets the billing cycle and invoices at once when the interval changes", async () => {
    const ctx = createTestApp({ webhook: true });
    const { clockId, customerId } = await clockCustomer(ctx);
    const monthly = await price(ctx, 2000, "month");
    const yearly = await price(ctx, 20000, "year");
    const created = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: monthly }],
    });
    const item = created.body.items.data[0];
    const changeAt = T + 10 * DAY;
    const yearEnd = periodBoundary(changeAt, "year", 1, 1);

    await advance(ctx, clockId, changeAt);
    const hooks = captureWebhooks();
    const res = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${created.body.id}`, {
      items: [{ id: item.id, price: yearly }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: "active", billing_cycle_anchor: changeAt });
    expect(res.body.items.data[0]).toMatchObject({
      id: item.id,
      plan: { interval: "year" },
      current_period_start: changeAt,
      current_period_end: yearEnd,
    });
    expect(res.body.latest_invoice).not.toBe(created.body.latest_invoice);

    const invoice = await api<Json>(ctx.app, "GET", `/v1/invoices/${res.body.latest_invoice}`);
    expect(invoice.body).toMatchObject({
      billing_reason: "subscription_update",
      status: "paid",
      amount_paid: 20000,
      created: changeAt,
      parent: { subscription_details: { subscription: created.body.id } },
    });
    expect(invoice.body.lines.data[0]).toMatchObject({
      amount: 20000,
      period: { start: changeAt, end: yearEnd },
    });

    const seen = types(hooks.events);
    expect(seen[0]).toBe("customer.subscription.updated");
    expect(seen.indexOf("invoice.created")).toBeGreaterThan(0);
    expect(seen.indexOf("invoice.paid")).toBeGreaterThan(seen.indexOf("invoice.finalized"));
    const previous = hooks.ofType("customer.subscription.updated")[0].data.previous_attributes as Json;
    expect(previous).toMatchObject({
      billing_cycle_anchor: T,
      latest_invoice: created.body.latest_invoice,
    });
    expect(previous.items.data[0]).toMatchObject({ current_period_end: FEB_15, plan: { interval: "month" } });

    // The old monthly boundary passes without an invoice; the next one is a year after the change.
    await advance(ctx, clockId, FEB_15 + DAY);
    expect(await invoicesOf(ctx, created.body.id)).toHaveLength(2);
  });

  it("restarts the cycle when POST /v1/subscription_items/:id moves the only item to a yearly price", async () => {
    const ctx = createTestApp();
    const { clockId, customerId } = await clockCustomer(ctx);
    const monthly = await price(ctx, 2000, "month");
    const yearly = await price(ctx, 20000, "year");
    const created = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: monthly }],
    });
    await advance(ctx, clockId, T + 3 * DAY);
    const item = await api<Json>(ctx.app, "POST", `/v1/subscription_items/${created.body.items.data[0].id}`, {
      price: yearly,
    });
    expect(item.status).toBe(200);
    expect(item.body).toMatchObject({
      current_period_start: T + 3 * DAY,
      current_period_end: periodBoundary(T + 3 * DAY, "year", 1, 1),
    });
    const sub = await api<Json>(ctx.app, "GET", `/v1/subscriptions/${created.body.id}`);
    expect(sub.body.billing_cycle_anchor).toBe(T + 3 * DAY);
    const invoices = await invoicesOf(ctx, created.body.id);
    expect(invoices.map((inv) => [inv.billing_reason, inv.amount_paid])).toEqual([
      ["subscription_create", 2000],
      ["subscription_update", 20000],
    ]);
  });

  it("leaves the subscription past_due when the invoice for the new interval fails", async () => {
    const ctx = createTestApp({ webhook: true });
    const { clockId, customerId } = await clockCustomer(ctx);
    const monthly = await price(ctx, 2000, "month");
    const yearly = await price(ctx, 20000, "year");
    const created = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: monthly }],
    });
    const failing = await api<Json>(ctx.app, "POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", {
      customer: customerId,
    });
    await api(ctx.app, "POST", `/v1/customers/${customerId}`, {
      invoice_settings: { default_payment_method: failing.body.id },
    });
    await advance(ctx, clockId, T + DAY);

    const hooks = captureWebhooks();
    const res = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${created.body.id}`, {
      items: [{ id: created.body.items.data[0].id, price: yearly }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "past_due", billing_cycle_anchor: T + DAY });
    const invoice = await api<Json>(ctx.app, "GET", `/v1/invoices/${res.body.latest_invoice}`);
    expect(invoice.body).toMatchObject({ status: "open", attempt_count: 1, billing_reason: "subscription_update" });
    expect(invoice.body.next_payment_attempt).toBeGreaterThan(T + DAY);
    expect(types(hooks.events)).toContain("invoice.payment_failed");
    const statuses = hooks.ofType("customer.subscription.updated").map((e) => (e.data.object as Json).status);
    expect(statuses.at(-1)).toBe("past_due");
  });

  it("keeps a trial when the interval changes during it, and bills the new interval when it ends", async () => {
    const ctx = createTestApp({ webhook: true });
    const { clockId, customerId } = await clockCustomer(ctx);
    const monthly = await price(ctx, 2000, "month");
    const yearly = await price(ctx, 20000, "year");
    const created = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: monthly }],
      trial_period_days: 14,
    });
    const trialEnd = T + 14 * DAY;
    const res = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${created.body.id}`, {
      items: [{ id: created.body.items.data[0].id, price: yearly }],
    });
    expect(res.body).toMatchObject({ status: "trialing", trial_end: trialEnd, billing_cycle_anchor: trialEnd });
    expect(res.body.latest_invoice).toBe(created.body.latest_invoice);

    await advance(ctx, clockId, trialEnd + 2 * 3600);
    const [, first] = await invoicesOf(ctx, created.body.id);
    expect(first).toMatchObject({ billing_reason: "subscription_cycle", amount_paid: 20000 });
    const sub = await api<Json>(ctx.app, "GET", `/v1/subscriptions/${created.body.id}`);
    expect(sub.body.items.data[0].current_period_end).toBe(periodBoundary(trialEnd, "year", 1, 1));
  });
});
