import { describe, it, expect, afterEach, vi } from "vitest";
import Stripe from "stripe";
import { createTestApp, captureWebhooks, api, sdk, type TestApp } from "./support.js";
import { nextPeriodEnd, periodBoundary } from "../billing.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

const DAY = 86400;

/** The JSON a stripe-node object was parsed from. */
function wire<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value));
}

function utc(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function types(events: Stripe.Event[]): string[] {
  return events.map((e) => e.type);
}

/** Assert that each type occurs, in this order, among the delivered events. */
function expectInOrder(events: Stripe.Event[], expected: string[]) {
  const seen = types(events);
  let from = 0;
  for (const type of expected) {
    const at = seen.indexOf(type, from);
    expect(at, `${type} after position ${from} in ${seen.join(", ")}`).toBeGreaterThanOrEqual(0);
    from = at + 1;
  }
}

/** A customer whose invoice default payment method is `card`, or one with no card when `card` is false. */
async function customer(ctx: TestApp, card: string | false = "pm_card_visa") {
  const created = await api<Json>(ctx.app, "POST", "/v1/customers", { email: "sub@example.com", name: "Sub" });
  if (!card) return { customerId: created.body.id as string, pmId: undefined };
  const pm = await api<Json>(ctx.app, "POST", `/v1/payment_methods/${card}/attach`, { customer: created.body.id });
  expect(pm.status).toBe(200);
  await api(ctx.app, "POST", `/v1/customers/${created.body.id}`, {
    invoice_settings: { default_payment_method: pm.body.id },
  });
  return { customerId: created.body.id as string, pmId: pm.body.id as string };
}

async function recurringPrice(
  ctx: TestApp,
  options: { unitAmount?: number; interval?: string; intervalCount?: number; name?: string; currency?: string } = {},
) {
  const product = await api<Json>(ctx.app, "POST", "/v1/products", { name: options.name ?? "Pro Plan" });
  const price = await api<Json>(ctx.app, "POST", "/v1/prices", {
    product: product.body.id,
    currency: options.currency ?? "usd",
    unit_amount: options.unitAmount ?? 2000,
    recurring: { interval: options.interval ?? "month", interval_count: options.intervalCount ?? 1 },
  });
  expect(price.status).toBe(200);
  return { productId: product.body.id as string, priceId: price.body.id as string };
}

/** The keys of the Subscription object, in the order of the API reference. */
const SUBSCRIPTION_KEYS = [
  "id",
  "object",
  "application",
  "application_fee_percent",
  "automatic_tax",
  "billing_cycle_anchor",
  "billing_cycle_anchor_config",
  "billing_mode",
  "billing_thresholds",
  "cancel_at",
  "cancel_at_period_end",
  "canceled_at",
  "cancellation_details",
  "collection_method",
  "created",
  "currency",
  "customer",
  "customer_account",
  "days_until_due",
  "default_payment_method",
  "default_source",
  "default_tax_rates",
  "description",
  "discounts",
  "ended_at",
  "invoice_settings",
  "items",
  "latest_invoice",
  "livemode",
  "metadata",
  "next_pending_invoice_item_invoice",
  "on_behalf_of",
  "pause_collection",
  "payment_settings",
  "pending_invoice_item_interval",
  "pending_setup_intent",
  "pending_update",
  "presentment_details",
  "schedule",
  "start_date",
  "status",
  "status_details",
  "test_clock",
  "transfer_data",
  "trial_end",
  "trial_settings",
  "trial_start",
];

describe("billing periods", () => {
  it("clamps monthly periods to the end of short months and returns to the anchor day", () => {
    const anchor = utc("2026-01-31T10:00:00Z");
    expect(periodBoundary(anchor, "month", 1, 1)).toBe(utc("2026-02-28T10:00:00Z"));
    expect(periodBoundary(anchor, "month", 1, 2)).toBe(utc("2026-03-31T10:00:00Z"));
    expect(nextPeriodEnd(anchor, "month", 1, anchor)).toBe(utc("2026-02-28T10:00:00Z"));
    expect(nextPeriodEnd(anchor, "month", 1, utc("2026-02-28T10:00:00Z"))).toBe(utc("2026-03-31T10:00:00Z"));
  });

  it("clamps a yearly anchor on Feb 29 to Feb 28 and goes back on the next leap year", () => {
    const anchor = utc("2028-02-29T00:00:00Z");
    expect(periodBoundary(anchor, "year", 1, 1)).toBe(utc("2029-02-28T00:00:00Z"));
    expect(periodBoundary(anchor, "year", 1, 4)).toBe(utc("2032-02-29T00:00:00Z"));
  });

  it("counts days, weeks and multi-month intervals", () => {
    const anchor = utc("2026-03-15T12:30:00Z");
    expect(periodBoundary(anchor, "day", 3, 1)).toBe(anchor + 3 * DAY);
    expect(periodBoundary(anchor, "week", 2, 1)).toBe(anchor + 14 * DAY);
    expect(periodBoundary(anchor, "month", 3, 1)).toBe(utc("2026-06-15T12:30:00Z"));
    expect(periodBoundary(anchor, "month", 12, 1)).toBe(utc("2027-03-15T12:30:00Z"));
  });
});

describe("POST /v1/subscriptions", () => {
  it("activates a subscription paid with the customer's default card", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customer(ctx);
    const { priceId, productId } = await recurringPrice(ctx);
    const hooks = captureWebhooks();
    const stripe = sdk(ctx.app);

    const sub = await stripe.subscriptions.create({ customer: customerId, items: [{ price: priceId }] });
    const json = wire(sub);

    expect(json.id).toMatch(/^sub_[A-Za-z0-9]+$/);
    expect(Object.keys(json)).toEqual(SUBSCRIPTION_KEYS);
    expect(json).toMatchObject({
      object: "subscription",
      status: "active",
      customer: customerId,
      currency: "usd",
      collection_method: "charge_automatically",
      cancel_at: null,
      cancel_at_period_end: false,
      canceled_at: null,
      cancellation_details: { comment: null, feedback: null, reason: null },
      billing_mode: { type: "flexible", flexible: { proration_discounts: "included" } },
      invoice_settings: { account_tax_ids: null, issuer: { type: "self" } },
      payment_settings: {
        payment_method_options: null,
        payment_method_types: null,
        save_default_payment_method: "off",
      },
      trial_settings: { end_behavior: { missing_payment_method: "create_invoice", billing_cycle_anchor: "now" } },
      pause_collection: null,
      pending_update: null,
      discounts: null,
      status_details: null,
      test_clock: null,
      trial_start: null,
      trial_end: null,
      default_payment_method: null,
      livemode: false,
    });
    expect(json).not.toHaveProperty("current_period_start");
    expect(json).not.toHaveProperty("current_period_end");
    expect(json).not.toHaveProperty("plan");
    expect(json.billing_cycle_anchor).toBe(json.start_date);

    expect(json.items).toMatchObject({
      object: "list",
      has_more: false,
      total_count: 1,
      url: `/v1/subscription_items?subscription=${json.id}`,
    });
    const item = json.items.data[0];
    expect(item.id).toMatch(/^si_[A-Za-z0-9]+$/);
    expect(item).toMatchObject({
      object: "subscription_item",
      current_trial: null,
      metadata: {},
      quantity: 1,
      subscription: json.id,
      tax_rates: [],
      price: { id: priceId, object: "price", product: productId, type: "recurring", unit_amount: 2000 },
      plan: {
        id: priceId,
        object: "plan",
        active: true,
        amount: 2000,
        amount_decimal: "2000",
        billing_scheme: "per_unit",
        currency: "usd",
        interval: "month",
        interval_count: 1,
        product: productId,
        usage_type: "licensed",
        trial_period_days: null,
        transform_usage: null,
      },
    });
    expect(item.current_period_start).toBe(json.start_date);
    expect(item.current_period_end).toBe(nextPeriodEnd(json.start_date, "month", 1, json.start_date));

    const invoice = wire(await stripe.invoices.retrieve(json.latest_invoice as string));
    expect(invoice).toMatchObject({
      status: "paid",
      billing_reason: "subscription_create",
      amount_paid: 2000,
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: json.id, metadata: {} },
      },
    });
    const line = invoice.lines.data[0];
    expect(line).toMatchObject({
      amount: 2000,
      description: "1 × Pro Plan (at $20.00 / month)",
      period: { start: item.current_period_start, end: item.current_period_end },
      parent: {
        type: "subscription_item_details",
        subscription_item_details: { subscription: json.id, subscription_item: item.id },
      },
      pricing: { price_details: { price: priceId, product: productId } },
    });

    expectInOrder(hooks.events, [
      "customer.subscription.created",
      "invoice.created",
      "invoice.finalized",
      "invoice.paid",
      "customer.subscription.updated",
    ]);
    expect(types(hooks.events)).toContain("invoice.payment_succeeded");
    expect(types(hooks.events)).toContain("payment_intent.succeeded");
    const created = hooks.ofType("customer.subscription.created")[0].data.object as Json;
    expect(created.status).toBe("incomplete");
    expect(created.latest_invoice).toBe(json.latest_invoice);
    const updated = hooks.ofType("customer.subscription.updated")[0];
    expect((updated.data.object as Json).status).toBe("active");
    expect(updated.data.previous_attributes).toMatchObject({ status: "incomplete" });
  });

  it("expands latest_invoice and items.data.price.product", async () => {
    const ctx = createTestApp();
    const { customerId } = await customer(ctx);
    const { priceId } = await recurringPrice(ctx);
    const sub = await sdk(ctx.app).subscriptions.create({
      customer: customerId,
      items: [{ price: priceId, quantity: 3 }],
      expand: ["latest_invoice.payments", "items.data.price.product"],
    });
    const json = wire(sub);
    expect(json.latest_invoice).toMatchObject({ object: "invoice", amount_paid: 6000 });
    expect(json.latest_invoice.payments.data[0]).toMatchObject({ object: "invoice_payment", status: "paid" });
    expect(json.items.data[0].price.product).toMatchObject({ object: "product", name: "Pro Plan" });
    expect(json.items.data[0].quantity).toBe(3);
  });

  it("bills a graduated price with one line per tier reached", async () => {
    const ctx = createTestApp();
    const { customerId } = await customer(ctx);
    const product = await api<Json>(ctx.app, "POST", "/v1/products", { name: "Seats" });
    const price = await api<Json>(ctx.app, "POST", "/v1/prices", {
      product: product.body.id,
      currency: "usd",
      recurring: { interval: "month" },
      billing_scheme: "tiered",
      tiers_mode: "graduated",
      tiers: [
        { up_to: 5, unit_amount: 1000, flat_amount: 500 },
        { up_to: "inf", unit_amount: 800 },
      ],
    });
    const sub = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: price.body.id, quantity: 7 }],
    });
    expect(sub.body.status).toBe("active");
    expect(sub.body.items.data[0].plan).toMatchObject({
      amount: null,
      billing_scheme: "tiered",
      tiers_mode: "graduated",
    });
    const invoice = await api<Json>(ctx.app, "GET", `/v1/invoices/${sub.body.latest_invoice}`);
    expect(invoice.body.amount_paid).toBe(5 * 1000 + 500 + 2 * 800);
    expect(invoice.body.lines.data.map((line: Json) => [line.quantity, line.amount])).toEqual([
      [5, 5000],
      [1, 500],
      [2, 1600],
    ]);
  });

  it("charges the subscription's default payment method before the customer's", async () => {
    const ctx = createTestApp();
    const { customerId } = await customer(ctx, "pm_card_chargeCustomerFail");
    const visa = await api<Json>(ctx.app, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: customerId });
    const { priceId } = await recurringPrice(ctx);
    const sub = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: priceId }],
      default_payment_method: visa.body.id,
    });
    expect(sub.status).toBe(200);
    expect(sub.body).toMatchObject({ status: "active", default_payment_method: visa.body.id });
  });

  it("leaves a declined subscription incomplete and activates it once the invoice is paid", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customer(ctx, "pm_card_chargeCustomerFail");
    const { priceId } = await recurringPrice(ctx);
    const hooks = captureWebhooks();
    const stripe = sdk(ctx.app);

    const sub = await stripe.subscriptions.create({ customer: customerId, items: [{ price: priceId }] });
    expect(sub.status).toBe("incomplete");
    const invoice = await stripe.invoices.retrieve(sub.latest_invoice as string);
    expect(invoice.status).toBe("open");
    expect(invoice.attempt_count).toBe(1);
    expect(types(hooks.events)).toContain("invoice.payment_failed");
    expect(types(hooks.events)).not.toContain("customer.subscription.updated");

    const before = hooks.events.length;
    const paid = await stripe.invoices.pay(invoice.id!, { payment_method: "pm_card_visa" });
    expect(paid.status).toBe("paid");
    const after = await stripe.subscriptions.retrieve(sub.id);
    expect(after.status).toBe("active");
    const later = hooks.events.slice(before);
    expectInOrder(later, ["invoice.paid", "customer.subscription.updated"]);
    const updated = later.find((e) => e.type === "customer.subscription.updated")!;
    expect(updated.data.previous_attributes).toMatchObject({ status: "incomplete" });
  });

  it("persists nothing when error_if_incomplete fails", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customer(ctx, "pm_card_chargeCustomerFail");
    const { priceId } = await recurringPrice(ctx);
    const hooks = captureWebhooks();

    const res = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "error_if_incomplete",
    });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ type: "card_error", code: "card_declined" });
    expect(hooks.events).toHaveLength(0);

    const list = await api<Json>(ctx.app, "GET", "/v1/subscriptions?status=all");
    expect(list.body.data).toHaveLength(0);
    const invoices = await api<Json>(ctx.app, "GET", `/v1/invoices?customer=${customerId}`);
    expect(invoices.body.data).toHaveLength(0);
    const charges = await api<Json>(ctx.app, "GET", "/v1/charges");
    expect(charges.body.data).toHaveLength(0);
  });

  it("creates an incomplete subscription without attempting payment for default_incomplete", async () => {
    const ctx = createTestApp();
    const { customerId } = await customer(ctx);
    const { priceId } = await recurringPrice(ctx);
    const stripe = sdk(ctx.app);

    const sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      expand: ["latest_invoice.confirmation_secret"],
    });
    expect(sub.status).toBe("incomplete");
    const invoice = wire(sub.latest_invoice);
    expect(invoice).toMatchObject({ status: "open", auto_advance: false, attempt_count: 0, attempted: false });
    expect(invoice.confirmation_secret.client_secret).toMatch(/^pi_.+_secret_/);
    const charges = await api<Json>(ctx.app, "GET", "/v1/charges");
    expect(charges.body.data).toHaveLength(0);

    await stripe.invoices.pay(invoice.id, { payment_method: "pm_card_visa" });
    expect((await stripe.subscriptions.retrieve(sub.id)).status).toBe("active");
  });

  it("starts a trial with a paid $0 invoice", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customer(ctx);
    const { priceId } = await recurringPrice(ctx);
    const hooks = captureWebhooks();
    const stripe = sdk(ctx.app);

    const sub = wire(
      await stripe.subscriptions.create({ customer: customerId, items: [{ price: priceId }], trial_period_days: 7 }),
    );
    expect(sub.status).toBe("trialing");
    expect(sub.trial_start).toBe(sub.start_date);
    expect(sub.trial_end).toBe(sub.start_date + 7 * DAY);
    expect(sub.billing_cycle_anchor).toBe(sub.trial_end);
    expect(sub.items.data[0].current_period_start).toBe(sub.start_date);
    expect(sub.items.data[0].current_period_end).toBe(sub.trial_end);

    const invoice = wire(await stripe.invoices.retrieve(sub.latest_invoice));
    expect(invoice).toMatchObject({ status: "paid", amount_due: 0, total: 0, billing_reason: "subscription_create" });
    expect(invoice.lines.data[0].amount).toBe(0);
    expect(invoice.lines.data[0].description).toContain("Free trial");
    expect(types(hooks.events)).toContain("invoice.paid");
    expect(types(hooks.events)).not.toContain("customer.subscription.trial_will_end");
    expect(types(hooks.events)).not.toContain("customer.subscription.updated");
  });

  it("sends trial_will_end at once for a trial shorter than three days", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customer(ctx);
    const { priceId } = await recurringPrice(ctx);
    const hooks = captureWebhooks();

    const res = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: priceId }],
      trial_period_days: 2,
    });
    expect(res.body.status).toBe("trialing");
    expectInOrder(hooks.events, ["customer.subscription.created", "customer.subscription.trial_will_end"]);
  });

  it("starts a trial without a payment method", async () => {
    const ctx = createTestApp();
    const { customerId } = await customer(ctx, false);
    const { priceId } = await recurringPrice(ctx);
    const trialEnd = Math.floor(Date.now() / 1000) + 10 * DAY;
    const res = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: priceId }],
      trial_end: trialEnd,
      trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "trialing",
      trial_end: trialEnd,
      trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
    });
  });

  it("rejects a charge_automatically subscription for a customer without a payment method", async () => {
    const ctx = createTestApp();
    const { customerId } = await customer(ctx, false);
    const { priceId } = await recurringPrice(ctx);
    const res = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: priceId }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("no attached payment source or default payment method");
    const list = await api<Json>(ctx.app, "GET", "/v1/subscriptions?status=all");
    expect(list.body.data).toHaveLength(0);
  });

  it("activates a send_invoice subscription with an open invoice due later", async () => {
    const ctx = createTestApp();
    const { customerId } = await customer(ctx, false);
    const { priceId } = await recurringPrice(ctx);
    const res = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: priceId }],
      collection_method: "send_invoice",
      days_until_due: 14,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "active", collection_method: "send_invoice", days_until_due: 14 });
    const invoice = await api<Json>(ctx.app, "GET", `/v1/invoices/${res.body.latest_invoice}`);
    expect(invoice.body).toMatchObject({ status: "open", collection_method: "send_invoice", attempted: false });
    expect(invoice.body.due_date).toBe(invoice.body.created + 14 * DAY);
  });

  it("validates items", async () => {
    const ctx = createTestApp();
    const { customerId } = await customer(ctx);
    const product = await api<Json>(ctx.app, "POST", "/v1/products", { name: "Once" });
    const oneTime = await api<Json>(ctx.app, "POST", "/v1/prices", {
      product: product.body.id,
      currency: "usd",
      unit_amount: 500,
    });
    const monthly = await recurringPrice(ctx);
    const yearly = await recurringPrice(ctx, { interval: "year", name: "Yearly" });
    const euro = await recurringPrice(ctx, { currency: "eur", name: "Euro" });

    const oneTimeRes = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: oneTime.body.id }],
    });
    expect(oneTimeRes.status).toBe(400);
    expect(oneTimeRes.body.error).toMatchObject({ type: "invalid_request_error", param: "items[0][price]" });

    const missing = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: "price_missing" }],
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ code: "resource_missing", param: "items[0][price]" });

    const mixedInterval = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: monthly.priceId }, { price: yearly.priceId }],
    });
    expect(mixedInterval.status).toBe(400);
    const mixedCurrency = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: monthly.priceId }, { price: euro.priceId }],
    });
    expect(mixedCurrency.status).toBe(400);

    const noItems = await api<Json>(ctx.app, "POST", "/v1/subscriptions", { customer: customerId });
    expect(noItems.status).toBe(400);
    expect(noItems.body.error.param).toBe("items");

    const noCustomer = await api<Json>(ctx.app, "POST", "/v1/subscriptions", { items: [{ price: monthly.priceId }] });
    expect(noCustomer.status).toBe(400);
    expect(noCustomer.body.error.param).toBe("customer");

    const list = await api<Json>(ctx.app, "GET", "/v1/subscriptions?status=all");
    expect(list.body.data).toHaveLength(0);
  });
});

describe("POST /v1/subscriptions/:id", () => {
  it("schedules cancellation at period end from a form string", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customer(ctx);
    const { priceId } = await recurringPrice(ctx);
    const stripe = sdk(ctx.app);
    const sub = await stripe.subscriptions.create({ customer: customerId, items: [{ price: priceId }] });
    const hooks = captureWebhooks();

    const updated = wire(await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true }));
    const periodEnd = updated.items.data[0].current_period_end;
    expect(updated).toMatchObject({ status: "active", cancel_at_period_end: true, cancel_at: periodEnd });
    expect(updated.canceled_at).toBeGreaterThanOrEqual(updated.created);

    const event = hooks.ofType("customer.subscription.updated")[0];
    expect(event.data.previous_attributes).toMatchObject({
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
    });

    const undone = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
    expect(undone).toMatchObject({ cancel_at_period_end: false, cancel_at: null, canceled_at: null });
  });

  it("clears cancellation_details when a scheduled cancellation is undone", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customer(ctx);
    const { priceId } = await recurringPrice(ctx);
    const stripe = sdk(ctx.app);
    const sub = await stripe.subscriptions.create({ customer: customerId, items: [{ price: priceId }] });
    const cleared = { reason: null, feedback: null, comment: null };

    await stripe.subscriptions.update(sub.id, {
      cancel_at_period_end: true,
      cancellation_details: { comment: "Cheaper elsewhere", feedback: "too_expensive" },
    });
    const hooks = captureWebhooks();
    const undone = wire(await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false }));
    expect(undone.cancellation_details).toEqual(cleared);
    expect(hooks.ofType("customer.subscription.updated")[0].data.previous_attributes).toMatchObject({
      cancel_at_period_end: true,
      cancellation_details: { comment: "Cheaper elsewhere", feedback: "too_expensive" },
    });

    await stripe.subscriptions.update(sub.id, {
      cancel_at: undone.items.data[0].current_period_end,
      cancellation_details: { comment: "Leaving" },
    });
    const unset = (await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}`, { cancel_at: "" })).body;
    expect(unset).toMatchObject({ cancel_at: null, canceled_at: null, cancellation_details: cleared });
  });

  it("updates metadata, cancellation_details and items without prorations", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customer(ctx);
    const { priceId } = await recurringPrice(ctx);
    const seat = await recurringPrice(ctx, { unitAmount: 500, name: "Seat" });
    const stripe = sdk(ctx.app);
    const sub = await stripe.subscriptions.create({ customer: customerId, items: [{ price: priceId }] });
    const itemId = sub.items.data[0].id;
    const hooks = captureWebhooks();

    const updated = await stripe.subscriptions.update(sub.id, {
      metadata: { plan: "pro" },
      cancellation_details: { comment: "maybe later", feedback: "too_expensive" },
      items: [
        { id: itemId, quantity: 2 },
        { price: seat.priceId, quantity: 4 },
      ],
    });
    expect(updated.metadata).toEqual({ plan: "pro" });
    expect(updated.cancellation_details).toEqual({ comment: "maybe later", feedback: "too_expensive", reason: null });
    expect(updated.items.data).toHaveLength(2);
    const [first, added] = updated.items.data;
    expect(first).toMatchObject({ id: itemId, quantity: 2 });
    expect(added).toMatchObject({ quantity: 4, price: { id: seat.priceId } });
    expect(added.current_period_end).toBe(first.current_period_end);
    expect(updated.latest_invoice).toBe(sub.latest_invoice);
    const event = hooks.ofType("customer.subscription.updated")[0];
    expect(event.data.previous_attributes).toMatchObject({ metadata: { plan: null } });
    expect((event.data.previous_attributes as Json).items.data).toHaveLength(1);

    const removed = await stripe.subscriptions.update(sub.id, { items: [{ id: added.id, deleted: true }] });
    expect(removed.items.data.map((i) => i.id)).toEqual([itemId]);

    const lastOne = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.id}`, {
      items: [{ id: itemId, deleted: true }],
    });
    expect(lastOne.status).toBe(400);
  });

  it("restricts updates of incomplete and canceled subscriptions", async () => {
    const ctx = createTestApp();
    const { customerId } = await customer(ctx, "pm_card_chargeCustomerFail");
    const visa = await api<Json>(ctx.app, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: customerId });
    const { priceId } = await recurringPrice(ctx);
    const sub = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: priceId }],
    });
    expect(sub.body.status).toBe("incomplete");

    const blocked = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.body.id}`, {
      cancel_at_period_end: true,
    });
    expect(blocked.status).toBe(400);
    const allowed = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.body.id}`, {
      metadata: { a: "1" },
      default_payment_method: visa.body.id,
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ metadata: { a: "1" }, default_payment_method: visa.body.id });

    await api(ctx.app, "DELETE", `/v1/subscriptions/${sub.body.id}`);
    const canceledBlocked = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.body.id}`, {
      default_payment_method: visa.body.id,
    });
    expect(canceledBlocked.status).toBe(400);
    const canceledAllowed = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.body.id}`, {
      metadata: { b: "2" },
      cancellation_details: { comment: "bye" },
    });
    expect(canceledAllowed.status).toBe(200);
    expect(canceledAllowed.body.cancellation_details).toEqual({
      comment: "bye",
      feedback: null,
      reason: "cancellation_requested",
    });
  });

  it("extends a trial", async () => {
    const ctx = createTestApp();
    const { customerId } = await customer(ctx);
    const { priceId } = await recurringPrice(ctx);
    const sub = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: priceId }],
      trial_period_days: 7,
    });
    const later = sub.body.trial_end + 3 * DAY;
    const res = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.body.id}`, { trial_end: later });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "trialing", trial_end: later, billing_cycle_anchor: later });
    expect(res.body.items.data[0].current_period_end).toBe(later);
  });

  it("ends a trial now and bills the first period", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customer(ctx);
    const { priceId } = await recurringPrice(ctx);
    const sub = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: priceId }],
      trial_period_days: 7,
    });
    const hooks = captureWebhooks();
    const res = await api<Json>(ctx.app, "POST", `/v1/subscriptions/${sub.body.id}`, { trial_end: "now" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(res.body.trial_end).toBe(res.body.billing_cycle_anchor);
    expect(res.body.latest_invoice).not.toBe(sub.body.latest_invoice);
    const invoice = await api<Json>(ctx.app, "GET", `/v1/invoices/${res.body.latest_invoice}`);
    expect(invoice.body).toMatchObject({ status: "paid", amount_paid: 2000, billing_reason: "subscription_update" });
    expect(types(hooks.events)).toContain("customer.subscription.updated");
  });
});

describe("DELETE /v1/subscriptions/:id", () => {
  it("cancels at once and hides the subscription from default lists", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customer(ctx);
    const { priceId } = await recurringPrice(ctx);
    const stripe = sdk(ctx.app);
    const sub = await stripe.subscriptions.create({ customer: customerId, items: [{ price: priceId }] });
    const hooks = captureWebhooks();

    const canceled = await stripe.subscriptions.cancel(sub.id);
    expect(canceled.status).toBe("canceled");
    expect(canceled.canceled_at).not.toBeNull();
    expect(canceled.ended_at).toBe(canceled.canceled_at);
    expect(canceled.cancellation_details?.reason).toBe("cancellation_requested");
    expect(types(hooks.events)).toEqual(["customer.subscription.deleted"]);

    const again = await api<Json>(ctx.app, "DELETE", `/v1/subscriptions/${sub.id}`);
    expect(again.status).toBe(400);

    const active = await api<Json>(ctx.app, "GET", "/v1/subscriptions");
    expect(active.body.data).toHaveLength(0);
    const all = await api<Json>(ctx.app, "GET", "/v1/subscriptions?status=all");
    expect(all.body.data.map((s: Json) => s.id)).toEqual([sub.id]);
    const onlyCanceled = await api<Json>(ctx.app, "GET", "/v1/subscriptions?status=canceled");
    expect(onlyCanceled.body.data).toHaveLength(1);
  });

  it("stops automatic collection of the subscription's open invoices", async () => {
    const ctx = createTestApp();
    const { customerId } = await customer(ctx, "pm_card_chargeCustomerFail");
    const { priceId } = await recurringPrice(ctx);
    const sub = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: priceId }],
    });
    const open = await api<Json>(ctx.app, "GET", `/v1/invoices/${sub.body.latest_invoice}`);
    expect(open.body).toMatchObject({ status: "open", auto_advance: true });
    await api(ctx.app, "DELETE", `/v1/subscriptions/${sub.body.id}`);
    const after = await api<Json>(ctx.app, "GET", `/v1/invoices/${sub.body.latest_invoice}`);
    expect(after.body).toMatchObject({ status: "open", auto_advance: false });
  });

  it("cancels a deleted customer's subscriptions", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customer(ctx);
    const { priceId } = await recurringPrice(ctx);
    const sub = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customerId,
      items: [{ price: priceId }],
    });
    const hooks = captureWebhooks();
    await api(ctx.app, "DELETE", `/v1/customers/${customerId}`);
    expectInOrder(hooks.events, ["customer.subscription.deleted", "customer.deleted"]);
    const after = await api<Json>(ctx.app, "GET", `/v1/subscriptions/${sub.body.id}`);
    expect(after.body.status).toBe("canceled");
  });
});

describe("GET /v1/subscriptions", () => {
  it("filters by customer, price and status", async () => {
    const ctx = createTestApp();
    const a = await customer(ctx);
    const b = await customer(ctx);
    const pro = await recurringPrice(ctx);
    const basic = await recurringPrice(ctx, { unitAmount: 900, name: "Basic" });
    const subA = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: a.customerId,
      items: [{ price: pro.priceId }],
    });
    const subB = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: b.customerId,
      items: [{ price: basic.priceId }],
      trial_period_days: 14,
    });

    const byCustomer = await api<Json>(ctx.app, "GET", `/v1/subscriptions?customer=${a.customerId}`);
    expect(byCustomer.body.data.map((s: Json) => s.id)).toEqual([subA.body.id]);
    const byPrice = await api<Json>(ctx.app, "GET", `/v1/subscriptions?price=${basic.priceId}`);
    expect(byPrice.body.data.map((s: Json) => s.id)).toEqual([subB.body.id]);
    const trialing = await api<Json>(ctx.app, "GET", "/v1/subscriptions?status=trialing");
    expect(trialing.body.data.map((s: Json) => s.id)).toEqual([subB.body.id]);
    const list = await sdk(ctx.app).subscriptions.list({ limit: 10 });
    expect(list.data.map((s) => s.id)).toEqual([subB.body.id, subA.body.id]);
    expect(list.url).toBe("/v1/subscriptions");

    const bad = await api<Json>(ctx.app, "GET", "/v1/subscriptions?status=nope");
    expect(bad.status).toBe(400);
  });
});

describe("/v1/subscription_items", () => {
  it("creates, updates, lists and deletes items", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customer(ctx);
    const { priceId } = await recurringPrice(ctx);
    const seat = await recurringPrice(ctx, { unitAmount: 500, name: "Seat" });
    const stripe = sdk(ctx.app);
    const sub = await stripe.subscriptions.create({ customer: customerId, items: [{ price: priceId }] });
    const hooks = captureWebhooks();

    const item = await stripe.subscriptionItems.create({ subscription: sub.id, price: seat.priceId, quantity: 2 });
    expect(item).toMatchObject({ object: "subscription_item", subscription: sub.id, quantity: 2 });
    expect(item.current_period_end).toBe(sub.items.data[0].current_period_end);
    expect(types(hooks.events)).toEqual(["customer.subscription.updated"]);

    const retrieved = await stripe.subscriptionItems.retrieve(item.id);
    expect(retrieved.id).toBe(item.id);

    const updated = await stripe.subscriptionItems.update(item.id, { quantity: 5, metadata: { team: "a" } });
    expect(updated).toMatchObject({ quantity: 5, metadata: { team: "a" } });

    const list = await stripe.subscriptionItems.list({ subscription: sub.id });
    expect(list.data.map((i) => i.id).sort()).toEqual([sub.items.data[0].id, item.id].sort());
    expect(list.url).toBe("/v1/subscription_items");

    const deleted = await stripe.subscriptionItems.del(item.id);
    expect(deleted).toMatchObject({ id: item.id, object: "subscription_item", deleted: true });
    const missing = await api<Json>(ctx.app, "GET", `/v1/subscription_items/${item.id}`);
    expect(missing.status).toBe(404);

    const last = await api<Json>(ctx.app, "DELETE", `/v1/subscription_items/${sub.items.data[0].id}`);
    expect(last.status).toBe(400);

    const noSubscription = await api<Json>(ctx.app, "GET", "/v1/subscription_items");
    expect(noSubscription.status).toBe(400);
  });
});
