import { describe, it, expect, afterEach, vi } from "vitest";
import { createTestApp, captureWebhooks, api, sdk, type TestApp } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

const DAY = 86400;
const HOUR = 3600;
const T = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
const PERIOD_END = Math.floor(Date.UTC(2026, 1, 15, 12, 0, 0) / 1000);
const SECOND_PERIOD_END = Math.floor(Date.UTC(2026, 2, 15, 12, 0, 0) / 1000);

async function createMeter(ctx: TestApp, params: Json = {}) {
  const res = await api<Json>(ctx.app, "POST", "/v1/billing/meters", {
    display_name: "API calls",
    event_name: "api_calls",
    default_aggregation: { formula: "sum" },
    ...params,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function sendUsage(ctx: TestApp, customerId: string, value: number | string, extra: Json = {}) {
  return api<Json>(ctx.app, "POST", "/v1/billing/meter_events", {
    event_name: "api_calls",
    payload: { value: String(value), stripe_customer_id: customerId },
    ...extra,
  });
}

async function createClock(ctx: TestApp, frozenTime = T) {
  const res = await api<Json>(ctx.app, "POST", "/v1/test_helpers/test_clocks", { frozen_time: frozenTime });
  expect(res.status).toBe(200);
  return res.body;
}

async function clockCustomer(ctx: TestApp, clockId: string, email = "usage@example.com") {
  const res = await api<Json>(ctx.app, "POST", "/v1/customers", {
    email,
    test_clock: clockId,
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" },
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

async function product(ctx: TestApp, name = "Search API") {
  return (await api<Json>(ctx.app, "POST", "/v1/products", { name })).body.id as string;
}

async function flatPrice(ctx: TestApp, unitAmount = 1000) {
  const res = await api<Json>(ctx.app, "POST", "/v1/prices", {
    product: await product(ctx, "Platform fee"),
    currency: "usd",
    unit_amount: unitAmount,
    recurring: { interval: "month" },
  });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function meteredPrice(ctx: TestApp, meterId: string, params: Json = {}) {
  const res = await api<Json>(ctx.app, "POST", "/v1/prices", {
    product: await product(ctx),
    currency: "usd",
    recurring: { interval: "month", usage_type: "metered", meter: meterId },
    ...params,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.id as string;
}

async function graduatedPrice(ctx: TestApp, meterId: string) {
  return meteredPrice(ctx, meterId, {
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    tiers: [
      { up_to: 1000, unit_amount: 0 },
      { up_to: "inf", unit_amount: 2 },
    ],
  });
}

async function subscribe(ctx: TestApp, customerId: string, items: Json[], extra: Json = {}) {
  const res = await api<Json>(ctx.app, "POST", "/v1/subscriptions", { customer: customerId, items, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function subInvoices(ctx: TestApp, subId: string): Promise<Json[]> {
  const res = await api<Json>(ctx.app, "GET", `/v1/invoices?subscription=${subId}&limit=100`);
  return (res.body.data as Json[]).slice().reverse();
}

describe("Billing meters", () => {
  it("creates a meter with the default mappings and sends billing.meter.created", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const meter = await createMeter(ctx);

    expect(meter.id).toMatch(/^mtr_test_/);
    expect(meter).toMatchObject({
      object: "billing.meter",
      customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
      default_aggregation: { formula: "sum" },
      display_name: "API calls",
      event_name: "api_calls",
      event_time_window: null,
      livemode: false,
      status: "active",
      status_transitions: { deactivated_at: null },
      value_settings: { event_payload_key: "value" },
    });
    expect(meter.updated).toBe(meter.created);
    const [created] = hooks.ofType("billing.meter.created");
    expect(created.data.object).toMatchObject({ id: meter.id });

    const duplicate = await api<Json>(ctx.app, "POST", "/v1/billing/meters", {
      display_name: "Other",
      event_name: "api_calls",
      default_aggregation: { formula: "count" },
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toMatchObject({ type: "invalid_request_error", param: "event_name" });

    const missing = await api<Json>(ctx.app, "POST", "/v1/billing/meters", { display_name: "x", event_name: "y" });
    expect(missing.status).toBe(400);
    expect(missing.body.error.param).toBe("default_aggregation[formula]");
  });

  it("updates the display name, lists by status, deactivates and reactivates", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const meter = await createMeter(ctx);

    const renamed = await api<Json>(ctx.app, "POST", `/v1/billing/meters/${meter.id}`, { display_name: "Calls" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.display_name).toBe("Calls");
    const [updated] = hooks.ofType("billing.meter.updated");
    expect(updated.data.previous_attributes).toMatchObject({ display_name: "API calls" });

    const off = await api<Json>(ctx.app, "POST", `/v1/billing/meters/${meter.id}/deactivate`);
    expect(off.status).toBe(200);
    expect(off.body.status).toBe("inactive");
    expect(typeof off.body.status_transitions.deactivated_at).toBe("number");
    expect(hooks.ofType("billing.meter.deactivated")).toHaveLength(1);

    const active = await api<Json>(ctx.app, "GET", "/v1/billing/meters?status=active");
    expect(active.body.data).toHaveLength(0);
    const inactive = await api<Json>(ctx.app, "GET", "/v1/billing/meters?status=inactive");
    expect(inactive.body.data.map((m: Json) => m.id)).toEqual([meter.id]);

    const customer = (await api<Json>(ctx.app, "POST", "/v1/customers", { email: "a@example.com" })).body;
    const rejected = await sendUsage(ctx, customer.id, 5);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe("archived_meter");

    // An inactive meter frees its event name, and cannot be reactivated while another holds it.
    const other = await createMeter(ctx, { display_name: "Second" });
    const blocked = await api<Json>(ctx.app, "POST", `/v1/billing/meters/${meter.id}/reactivate`);
    expect(blocked.status).toBe(400);
    await api<Json>(ctx.app, "POST", `/v1/billing/meters/${other.id}/deactivate`);

    const on = await api<Json>(ctx.app, "POST", `/v1/billing/meters/${meter.id}/reactivate`);
    expect(on.status).toBe(200);
    expect(on.body.status).toBe("active");
    expect(on.body.status_transitions.deactivated_at).toBeNull();
    expect(hooks.ofType("billing.meter.reactivated")).toHaveLength(1);
    expect((await sendUsage(ctx, customer.id, 5)).status).toBe(200);
  });

  it("works through stripe-node", async () => {
    const ctx = createTestApp();
    const stripe = sdk(ctx.app);
    const meter = await stripe.billing.meters.create({
      display_name: "Tokens",
      event_name: "tokens",
      default_aggregation: { formula: "sum" },
    });
    const customer = await stripe.customers.create({ email: "node@example.com" });
    const event = await stripe.billing.meterEvents.create({
      event_name: "tokens",
      payload: { value: "25", stripe_customer_id: customer.id },
      identifier: "node_1",
    });
    expect(event.identifier).toBe("node_1");
    const now = Math.floor(Date.now() / 1000);
    const start = Math.floor(now / 60) * 60 - 3600;
    const summaries = await stripe.billing.meters.listEventSummaries(meter.id, {
      customer: customer.id,
      start_time: start,
      end_time: start + 7200,
    });
    expect(summaries.data).toHaveLength(1);
    expect(summaries.data[0].aggregated_value).toBe(25);
    expect(summaries.data[0].id).toMatch(/^mtrusg_test_/);
  });
});

describe("Meter events", () => {
  it("returns the event without an id and keeps payload values as strings", async () => {
    const ctx = createTestApp();
    await createMeter(ctx);
    const customer = (await api<Json>(ctx.app, "POST", "/v1/customers", { email: "a@example.com" })).body;

    const res = await api<Json>(ctx.app, "POST", "/v1/billing/meter_events", {
      event_name: "api_calls",
      payload: { value: 25, stripe_customer_id: customer.id },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ["created", "event_name", "identifier", "livemode", "object", "payload", "timestamp"].sort(),
    );
    expect(res.body).toMatchObject({
      object: "billing.meter_event",
      event_name: "api_calls",
      livemode: false,
      payload: { value: "25", stripe_customer_id: customer.id },
    });
    expect(typeof res.body.identifier).toBe("string");
    expect(res.body.identifier.length).toBeGreaterThan(0);
    expect(res.body.timestamp).toBe(res.body.created);
  });

  it("rejects unknown meters, unknown customers and bad values synchronously", async () => {
    const ctx = createTestApp();
    await createMeter(ctx);
    const customer = (await api<Json>(ctx.app, "POST", "/v1/customers", { email: "a@example.com" })).body;

    const noMeter = await api<Json>(ctx.app, "POST", "/v1/billing/meter_events", {
      event_name: "nope",
      payload: { value: "1", stripe_customer_id: customer.id },
    });
    expect(noMeter.status).toBe(400);
    expect(noMeter.body.error.code).toBe("no_meter");

    const noCustomer = await sendUsage(ctx, "cus_missing", 1);
    expect(noCustomer.status).toBe(400);
    expect(noCustomer.body.error.code).toBe("meter_event_customer_not_found");

    const unmapped = await api<Json>(ctx.app, "POST", "/v1/billing/meter_events", {
      event_name: "api_calls",
      payload: { value: "1" },
    });
    expect(unmapped.status).toBe(400);
    expect(unmapped.body.error.code).toBe("meter_event_no_customer_defined");

    const badValue = await sendUsage(ctx, customer.id, "lots");
    expect(badValue.status).toBe(400);
    expect(badValue.body.error.code).toBe("meter_event_invalid_value");

    const noValue = await api<Json>(ctx.app, "POST", "/v1/billing/meter_events", {
      event_name: "api_calls",
      payload: { stripe_customer_id: customer.id },
    });
    expect(noValue.status).toBe(400);
    expect(noValue.body.error).toMatchObject({ code: "meter_event_value_not_found", param: "payload[value]" });
  });

  it("accepts decimal usage values", async () => {
    const ctx = createTestApp();
    const meter = await createMeter(ctx);
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);

    const decimal = await sendUsage(ctx, customer.id, "2.5");
    expect(decimal.status, JSON.stringify(decimal.body)).toBe(200);
    expect(decimal.body.payload.value).toBe("2.5");
    expect((await sendUsage(ctx, customer.id, "0.1")).status).toBe(200);
    expect((await sendUsage(ctx, customer.id, "0.2")).status).toBe(200);
    expect((await sendUsage(ctx, customer.id, "1.2.3")).body.error.code).toBe("meter_event_invalid_value");

    const range = `customer=${customer.id}&start_time=${T - HOUR}&end_time=${T + HOUR}`;
    const summary = await api<Json>(ctx.app, "GET", `/v1/billing/meters/${meter.id}/event_summaries?${range}`);
    expect(summary.body.data[0].aggregated_value).toBe(2.8);
  });

  it("enforces identifier uniqueness for 24 hours and the timestamp window on the customer's clock", async () => {
    const ctx = createTestApp();
    await createMeter(ctx);
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);

    const first = await sendUsage(ctx, customer.id, 1, { identifier: "req_1" });
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(T);
    expect(first.body.timestamp).toBe(T);

    const again = await sendUsage(ctx, customer.id, 1, { identifier: "req_1" });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("duplicate_meter_event");

    const old = await sendUsage(ctx, customer.id, 1, { timestamp: T - 36 * DAY });
    expect(old.status).toBe(400);
    expect(old.body.error).toMatchObject({ code: "timestamp_too_far_in_past", param: "timestamp" });
    const ahead = await sendUsage(ctx, customer.id, 1, { timestamp: T + 6 * 60 });
    expect(ahead.status).toBe(400);
    expect(ahead.body.error).toMatchObject({ code: "timestamp_in_future", param: "timestamp" });
    expect((await sendUsage(ctx, customer.id, 1, { timestamp: T + 4 * 60 })).status).toBe(200);
    expect((await sendUsage(ctx, customer.id, 1, { timestamp: T - 34 * DAY })).status).toBe(200);

    await advance(ctx, clock.id, T + DAY + 1);
    const later = await sendUsage(ctx, customer.id, 1, { identifier: "req_1" });
    expect(later.status).toBe(200);
    expect(later.body.created).toBe(T + DAY + 1);
  });

  it("cancels an event by identifier within 24 hours", async () => {
    const ctx = createTestApp();
    const meter = await createMeter(ctx);
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    await sendUsage(ctx, customer.id, 10, { identifier: "keep" });
    await sendUsage(ctx, customer.id, 5, { identifier: "drop" });
    await sendUsage(ctx, customer.id, 7, { identifier: "late" });

    const adjustment = await api<Json>(ctx.app, "POST", "/v1/billing/meter_event_adjustments", {
      event_name: "api_calls",
      type: "cancel",
      cancel: { identifier: "drop" },
    });
    expect(adjustment.status, JSON.stringify(adjustment.body)).toBe(200);
    expect(adjustment.body).toEqual({
      object: "billing.meter_event_adjustment",
      livemode: false,
      status: "pending",
      event_name: "api_calls",
      type: "cancel",
      cancel: { identifier: "drop" },
    });

    await advance(ctx, clock.id, T + DAY + 60);
    const tooLate = await api<Json>(ctx.app, "POST", "/v1/billing/meter_event_adjustments", {
      event_name: "api_calls",
      type: "cancel",
      cancel: { identifier: "late" },
    });
    expect(tooLate.status).toBe(400);

    const summaries = await api<Json>(
      ctx.app,
      "GET",
      `/v1/billing/meters/${meter.id}/event_summaries?customer=${customer.id}&start_time=${T}&end_time=${T + 60}`,
    );
    expect(summaries.body.data[0].aggregated_value).toBe(17);
  });
});

describe("Meter event summaries", () => {
  it("aggregates only the requested customer, in day buckets newest first", async () => {
    const ctx = createTestApp();
    const meter = await createMeter(ctx);
    const clock = await createClock(ctx);
    const a = await clockCustomer(ctx, clock.id, "a@example.com");
    const b = await clockCustomer(ctx, clock.id, "b@example.com");
    const dayStart = Math.floor(T / DAY) * DAY;

    await sendUsage(ctx, a.id, 3, { timestamp: T - 2 * DAY });
    await sendUsage(ctx, a.id, 4, { timestamp: T - 2 * DAY + HOUR });
    await sendUsage(ctx, a.id, 10, { timestamp: T });
    await sendUsage(ctx, b.id, 500, { timestamp: T });

    const query = `customer=${a.id}&start_time=${dayStart - 3 * DAY}&end_time=${dayStart + DAY}`;
    const total = await api<Json>(ctx.app, "GET", `/v1/billing/meters/${meter.id}/event_summaries?${query}`);
    expect(total.status, JSON.stringify(total.body)).toBe(200);
    expect(total.body.url).toBe(`/v1/billing/meters/${meter.id}/event_summaries`);
    expect(total.body.data).toHaveLength(1);
    expect(total.body.data[0]).toMatchObject({
      object: "billing.meter_event_summary",
      aggregated_value: 17,
      livemode: false,
      meter: meter.id,
      start_time: dayStart - 3 * DAY,
      end_time: dayStart + DAY,
    });

    const daily = await api<Json>(
      ctx.app,
      "GET",
      `/v1/billing/meters/${meter.id}/event_summaries?${query}&value_grouping_window=day`,
    );
    expect(daily.body.data.map((s: Json) => [s.start_time, s.aggregated_value])).toEqual([
      [dayStart, 10],
      [dayStart - 2 * DAY, 7],
    ]);

    const unaligned = await api<Json>(
      ctx.app,
      "GET",
      `/v1/billing/meters/${meter.id}/event_summaries?customer=${a.id}&start_time=${T + 1}&end_time=${T + 600}`,
    );
    expect(unaligned.status).toBe(400);
    expect(unaligned.body.error.param).toBe("start_time");
  });

  it("supports the count and last formulas", async () => {
    const ctx = createTestApp();
    const count = await createMeter(ctx, { event_name: "logins", default_aggregation: { formula: "count" } });
    const last = await createMeter(ctx, { event_name: "seats", default_aggregation: { formula: "last" } });
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);

    for (const value of [5, 9, 2]) {
      await sendUsage(ctx, customer.id, value, { event_name: "logins" });
    }
    await sendUsage(ctx, customer.id, 8, { event_name: "seats", timestamp: T - 120 });
    await sendUsage(ctx, customer.id, 3, { event_name: "seats", timestamp: T - 60 });
    await sendUsage(ctx, customer.id, 6, { event_name: "seats", timestamp: T - 180 });

    const range = `customer=${customer.id}&start_time=${T - HOUR}&end_time=${T + HOUR}`;
    const counted = await api<Json>(ctx.app, "GET", `/v1/billing/meters/${count.id}/event_summaries?${range}`);
    expect(counted.body.data[0].aggregated_value).toBe(3);
    const lastValue = await api<Json>(ctx.app, "GET", `/v1/billing/meters/${last.id}/event_summaries?${range}`);
    expect(lastValue.body.data[0].aggregated_value).toBe(3);
  });

  it("pages hour buckets with starting_after and ending_before", async () => {
    const ctx = createTestApp();
    const meter = await createMeter(ctx);
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    for (const hoursAgo of [1, 2, 3]) {
      await sendUsage(ctx, customer.id, hoursAgo, { timestamp: T - hoursAgo * HOUR });
    }
    const hour = Math.floor(T / HOUR) * HOUR;
    const base =
      `/v1/billing/meters/${meter.id}/event_summaries?customer=${customer.id}` +
      `&start_time=${hour - 4 * HOUR}&end_time=${hour + HOUR}&value_grouping_window=hour`;

    const all = (await api<Json>(ctx.app, "GET", base)).body.data as Json[];
    expect(all.map((s) => s.aggregated_value)).toEqual([1, 2, 3]);

    const first = await api<Json>(ctx.app, "GET", `${base}&limit=1`);
    expect(first.body.data.map((s: Json) => s.aggregated_value)).toEqual([1]);
    expect(first.body.has_more).toBe(true);
    const after = await api<Json>(ctx.app, "GET", `${base}&limit=1&starting_after=${all[1].id}`);
    expect(after.body.data.map((s: Json) => s.aggregated_value)).toEqual([3]);
    expect(after.body.has_more).toBe(false);

    const before = await api<Json>(ctx.app, "GET", `${base}&limit=1&ending_before=${all[2].id}`);
    expect(before.body.data.map((s: Json) => s.aggregated_value)).toEqual([2]);
    expect(before.body.has_more).toBe(true);
    const start = await api<Json>(ctx.app, "GET", `${base}&limit=1&ending_before=${all[1].id}`);
    expect(start.body.data.map((s: Json) => s.aggregated_value)).toEqual([1]);
    expect(start.body.has_more).toBe(false);
  });
});

describe("Metered prices and items", () => {
  it("needs an active meter, renders null quantities and rejects quantities on metered lines", async () => {
    const ctx = createTestApp();
    const meter = await createMeter(ctx);
    const priceId = await meteredPrice(ctx, meter.id);
    const price = (await api<Json>(ctx.app, "GET", `/v1/prices/${priceId}`)).body;
    expect(price.recurring).toMatchObject({ usage_type: "metered", meter: meter.id });

    const customer = (await api<Json>(ctx.app, "POST", "/v1/customers", { email: "m@example.com" })).body;
    const withQuantity = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customer.id,
      items: [{ price: priceId, quantity: 3 }],
    });
    expect(withQuantity.status).toBe(400);
    expect(withQuantity.body.error.param).toBe("items[0][quantity]");

    const sub = await subscribe(ctx, customer.id, [{ price: priceId }]);
    expect(sub.status).toBe("active");
    expect(sub.items.data[0].quantity).toBeNull();
    const [first] = await subInvoices(ctx, sub.id);
    expect(first).toMatchObject({ billing_reason: "subscription_create", amount_due: 0 });
    expect(first.lines.data).toHaveLength(0);

    const checkout = await api<Json>(ctx.app, "POST", "/v1/checkout/sessions", {
      mode: "subscription",
      success_url: "https://shop.example/success",
      line_items: [{ price: priceId, quantity: 1 }],
    });
    expect(checkout.status).toBe(400);
    expect(checkout.body.error.param).toBe("line_items[0][quantity]");
    const noQuantity = await api<Json>(ctx.app, "POST", "/v1/checkout/sessions", {
      mode: "subscription",
      success_url: "https://shop.example/success",
      line_items: [{ price: priceId }],
    });
    expect(noQuantity.status, JSON.stringify(noQuantity.body)).toBe(200);

    await api<Json>(ctx.app, "POST", `/v1/billing/meters/${meter.id}/deactivate`);
    const inactive = await api<Json>(ctx.app, "POST", "/v1/prices", {
      product: price.product,
      currency: "usd",
      recurring: { interval: "month", usage_type: "metered", meter: meter.id },
    });
    expect(inactive.status).toBe(400);
    expect(inactive.body.error.param).toBe("recurring[meter]");
  });
});

describe("Usage on cycle invoices", () => {
  it("bills the flat fee in advance and graduated usage in arrears, per customer", async () => {
    const ctx = createTestApp();
    const meter = await createMeter(ctx);
    const clock = await createClock(ctx);
    const a = await clockCustomer(ctx, clock.id, "a@example.com");
    const b = await clockCustomer(ctx, clock.id, "b@example.com");
    const flat = await flatPrice(ctx);
    const usage = await graduatedPrice(ctx, meter.id);
    const sub = await subscribe(ctx, a.id, [{ price: flat }, { price: usage }]);

    expect((await sendUsage(ctx, a.id, 900)).status).toBe(200);
    expect((await sendUsage(ctx, b.id, 5000)).status).toBe(200);

    // The draft is created at the period end. Usage that arrives before it finalizes still counts.
    await advance(ctx, clock.id, PERIOD_END + 30 * 60);
    const draft = (await subInvoices(ctx, sub.id)).at(-1)!;
    expect(draft).toMatchObject({ status: "draft", billing_reason: "subscription_cycle" });
    expect((await sendUsage(ctx, a.id, 600, { timestamp: PERIOD_END - 60 })).status).toBe(200);
    // Usage stamped after the period end belongs to the next period.
    expect((await sendUsage(ctx, a.id, 50, { timestamp: PERIOD_END + 60 })).status).toBe(200);

    await advance(ctx, clock.id, PERIOD_END + 2 * HOUR);
    const invoice = (await subInvoices(ctx, sub.id)).at(-1)!;
    expect(invoice.id).toBe(draft.id);
    expect(invoice.status).toBe("paid");
    expect(invoice.total).toBe(2000);
    const lines = invoice.lines.data as Json[];
    const flatLine = lines.find((l) => l.pricing.price_details.price === flat)!;
    expect(flatLine).toMatchObject({ amount: 1000, quantity: 1, period: { start: PERIOD_END } });
    const usageLines = lines.filter((l) => l.pricing.price_details.price === usage);
    expect(usageLines.map((l) => [l.quantity, l.amount])).toEqual([
      [1000, 0],
      [500, 1000],
    ]);
    for (const line of usageLines) expect(line.period).toEqual({ start: T, end: PERIOD_END });

    // The next period bills only what was stamped inside it.
    await advance(ctx, clock.id, SECOND_PERIOD_END + 2 * HOUR);
    const next = (await subInvoices(ctx, sub.id)).at(-1)!;
    const nextUsage = (next.lines.data as Json[]).filter((l) => l.pricing.price_details.price === usage);
    expect(nextUsage.map((l) => l.quantity)).toEqual([50]);
    expect(next.total).toBe(1000);
  });

  it("excludes trial usage and clamps a negative total to zero", async () => {
    const ctx = createTestApp();
    await createMeter(ctx);
    const meter = (await api<Json>(ctx.app, "GET", "/v1/billing/meters")).body.data[0];
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    const perUnit = await meteredPrice(ctx, meter.id, { unit_amount: 3 });
    const sub = await subscribe(ctx, customer.id, [{ price: perUnit }], { trial_period_days: 10 });
    const trialEnd = T + 10 * DAY;

    await sendUsage(ctx, customer.id, 400);
    await advance(ctx, clock.id, trialEnd + 2 * HOUR);
    const afterTrial = (await subInvoices(ctx, sub.id)).at(-1)!;
    expect(afterTrial.lines.data).toHaveLength(0);
    expect(afterTrial.total).toBe(0);

    await sendUsage(ctx, customer.id, -50);
    await sendUsage(ctx, customer.id, 20);
    const periodEnd = Math.floor(Date.UTC(2026, 1, 25, 12, 0, 0) / 1000);
    await advance(ctx, clock.id, periodEnd + 2 * HOUR);
    const cycle = (await subInvoices(ctx, sub.id)).at(-1)!;
    expect(cycle.billing_reason).toBe("subscription_cycle");
    expect(cycle.lines.data.map((l: Json) => [l.quantity, l.amount])).toEqual([[0, 0]]);
    expect(cycle.lines.data[0].period).toEqual({ start: trialEnd, end: periodEnd });
  });

  it("bills count and last meters on the cycle invoice", async () => {
    const ctx = createTestApp();
    const logins = await createMeter(ctx, { event_name: "logins", default_aggregation: { formula: "count" } });
    const seats = await createMeter(ctx, { event_name: "seats", default_aggregation: { formula: "last" } });
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    const perLogin = await meteredPrice(ctx, logins.id, { unit_amount: 10 });
    const perSeat = await meteredPrice(ctx, seats.id, { unit_amount: 500 });
    const sub = await subscribe(ctx, customer.id, [{ price: perLogin }, { price: perSeat }]);

    for (const value of [5, 9, 2, 7]) await sendUsage(ctx, customer.id, value, { event_name: "logins" });
    await sendUsage(ctx, customer.id, 8, { event_name: "seats", timestamp: T + 60 });
    await sendUsage(ctx, customer.id, 3, { event_name: "seats", timestamp: T + 180 });
    await sendUsage(ctx, customer.id, 6, { event_name: "seats", timestamp: T + 120 });

    await advance(ctx, clock.id, PERIOD_END + 2 * HOUR);
    const invoice = (await subInvoices(ctx, sub.id)).at(-1)!;
    expect(invoice.billing_reason).toBe("subscription_cycle");
    const byPrice = (priceId: string) =>
      (invoice.lines.data as Json[])
        .filter((l) => l.pricing.price_details.price === priceId)
        .map((l) => [l.quantity, l.amount]);
    expect(byPrice(perLogin)).toEqual([[4, 40]]);
    expect(byPrice(perSeat)).toEqual([[3, 1500]]);
    expect(invoice.total).toBe(1540);
  });

  it("bills decimal usage with a truncated quantity and the full quantity_decimal", async () => {
    const ctx = createTestApp();
    const meter = await createMeter(ctx);
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    const perUnit = await meteredPrice(ctx, meter.id, { unit_amount: 4 });
    const sub = await subscribe(ctx, customer.id, [{ price: perUnit }]);

    await sendUsage(ctx, customer.id, "2.5");
    await sendUsage(ctx, customer.id, "0.25");
    await advance(ctx, clock.id, PERIOD_END + 2 * HOUR);
    const invoice = (await subInvoices(ctx, sub.id)).at(-1)!;
    expect(invoice.lines.data).toHaveLength(1);
    expect(invoice.lines.data[0]).toMatchObject({ quantity: 2, quantity_decimal: "2.75", amount: 11 });
    expect(invoice.lines.data[0].description).toMatch(/^2\.75 × /);
    expect(invoice.total).toBe(11);
  });

  it("seeds meters and metered tiered prices that bill end to end", async () => {
    const ctx = createTestApp({
      seed: {
        meters: [{ id: "mtr_test_seeded", display_name: "Tokens", event_name: "tokens" }],
        products: [{ id: "prod_tokens", name: "Tokens" }],
        prices: [
          {
            id: "price_tokens",
            product: "Tokens",
            currency: "usd",
            recurring: { interval: "month", usage_type: "metered", meter: "tokens" },
            tiers_mode: "graduated",
            tiers: [
              { up_to: 100, unit_amount: 0 },
              { up_to: "inf", unit_amount: 5 },
            ],
          },
        ],
      },
    });
    const meter = (await api<Json>(ctx.app, "GET", "/v1/billing/meters/mtr_test_seeded")).body;
    expect(meter).toMatchObject({ event_name: "tokens", default_aggregation: { formula: "sum" } });
    const price = (await api<Json>(ctx.app, "GET", "/v1/prices/price_tokens")).body;
    expect(price.recurring.meter).toBe("mtr_test_seeded");

    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    const sub = await subscribe(ctx, customer.id, [{ price: "price_tokens" }]);
    const sent = await api<Json>(ctx.app, "POST", "/v1/billing/meter_events", {
      event_name: "tokens",
      payload: { value: "150", stripe_customer_id: customer.id },
    });
    expect(sent.status).toBe(200);

    await advance(ctx, clock.id, PERIOD_END + 2 * HOUR);
    const invoice = (await subInvoices(ctx, sub.id)).at(-1)!;
    expect(invoice.status).toBe("paid");
    expect(invoice.lines.data.map((l: Json) => [l.quantity, l.amount])).toEqual([
      [100, 0],
      [50, 250],
    ]);
    expect(invoice.amount_paid).toBe(250);
  });
});
