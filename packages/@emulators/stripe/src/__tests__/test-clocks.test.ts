import { describe, it, expect, afterEach, vi } from "vitest";
import Stripe from "stripe";
import { createTestApp, captureWebhooks, api, sdk, type TestApp } from "./support.js";
import { periodBoundary } from "../billing.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

const DAY = 86400;
const T = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);

/** The JSON a stripe-node object was parsed from. */
function wire<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value));
}

function types(events: Stripe.Event[]): string[] {
  return events.map((e) => e.type);
}

const CLOCK_KEYS = [
  "id",
  "object",
  "created",
  "deletes_after",
  "frozen_time",
  "livemode",
  "name",
  "status",
  "status_details",
];

async function createClock(ctx: TestApp, frozenTime = T, name?: string) {
  const res = await api<Json>(ctx.app, "POST", "/v1/test_helpers/test_clocks", {
    frozen_time: frozenTime,
    ...(name && { name }),
  });
  expect(res.status).toBe(200);
  return res.body;
}

async function clockCustomer(ctx: TestApp, clockId: string, card: string | false = "pm_card_visa") {
  const res = await api<Json>(ctx.app, "POST", "/v1/customers", {
    email: "clock@example.com",
    test_clock: clockId,
    ...(card && { payment_method: card, invoice_settings: { default_payment_method: card } }),
  });
  expect(res.status).toBe(200);
  return res.body;
}

async function recurringPrice(ctx: TestApp, interval = "month", intervalCount = 1) {
  const product = await api<Json>(ctx.app, "POST", "/v1/products", { name: `Plan ${interval}` });
  const price = await api<Json>(ctx.app, "POST", "/v1/prices", {
    product: product.body.id,
    currency: "usd",
    unit_amount: 2000,
    recurring: { interval, interval_count: intervalCount },
  });
  expect(price.status).toBe(200);
  return price.body.id as string;
}

async function subscribe(ctx: TestApp, customerId: string, priceId: string, extra: Json = {}) {
  return api<Json>(ctx.app, "POST", "/v1/subscriptions", {
    customer: customerId,
    items: [{ price: priceId }],
    ...extra,
  });
}

describe("test clock objects", () => {
  it("creates a ready clock that deletes after 30 days and sends test_helpers.test_clock.created", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const before = Math.floor(Date.now() / 1000);
    const clock = await createClock(ctx, T, "Annual renewal");

    expect(Object.keys(clock)).toEqual(CLOCK_KEYS);
    expect(clock.id).toMatch(/^clock_[A-Za-z0-9]{24}$/);
    expect(clock).toMatchObject({
      object: "test_helpers.test_clock",
      frozen_time: T,
      livemode: false,
      name: "Annual renewal",
      status: "ready",
      status_details: {},
    });
    expect(clock.created).toBeGreaterThanOrEqual(before);
    expect(clock.deletes_after).toBe(clock.created + 30 * DAY);

    expect(types(hooks.events)).toEqual(["test_helpers.test_clock.created"]);
    expect(hooks.events[0].data.object).toEqual(clock);
  });

  it("defaults name to null and rejects a missing or non-integer frozen_time", async () => {
    const ctx = createTestApp();
    const clock = await createClock(ctx);
    expect(clock.name).toBeNull();

    const missing = await api<Json>(ctx.app, "POST", "/v1/test_helpers/test_clocks", {});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "parameter_missing",
      param: "frozen_time",
    });

    const bad = await api<Json>(ctx.app, "POST", "/v1/test_helpers/test_clocks", { frozen_time: "soon" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.param).toBe("frozen_time");
  });

  it("retrieves, lists newest first and 404s an unknown clock", async () => {
    const ctx = createTestApp();
    const first = await createClock(ctx, T, "first");
    const second = await createClock(ctx, T, "second");

    const got = await api<Json>(ctx.app, "GET", `/v1/test_helpers/test_clocks/${first.id}`);
    expect(got.body).toEqual(first);

    const list = await api<Json>(ctx.app, "GET", "/v1/test_helpers/test_clocks");
    expect(list.body).toMatchObject({ object: "list", url: "/v1/test_helpers/test_clocks", has_more: false });
    expect(list.body.data.map((c: Json) => c.id)).toEqual([second.id, first.id]);

    const page = await api<Json>(ctx.app, "GET", "/v1/test_helpers/test_clocks?limit=1");
    expect(page.body.has_more).toBe(true);
    expect(page.body.data.map((c: Json) => c.id)).toEqual([second.id]);

    const missing = await api<Json>(ctx.app, "GET", "/v1/test_helpers/test_clocks/clock_missing");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ type: "invalid_request_error", code: "resource_missing" });
  });

  it("works through stripe-node", async () => {
    const ctx = createTestApp();
    const stripe = sdk(ctx.app);
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: T, name: "sdk" });
    expect(clock.status).toBe("ready");

    const advancing = await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: T + DAY });
    expect(advancing.status).toBe("advancing");
    expect(advancing.status_details.advancing?.target_frozen_time).toBe(T + DAY);

    const ready = await stripe.testHelpers.testClocks.retrieve(clock.id);
    expect(wire(ready)).toMatchObject({ status: "ready", frozen_time: T + DAY, status_details: {} });

    const list = await stripe.testHelpers.testClocks.list({ limit: 10 });
    expect(list.data.map((c) => c.id)).toContain(clock.id);

    const deleted = await stripe.testHelpers.testClocks.del(clock.id);
    expect(wire(deleted)).toEqual({ id: clock.id, object: "test_helpers.test_clock", deleted: true });
  });
});

describe("time on a test clock", () => {
  it("gives clock customers and their subscriptions the frozen time", async () => {
    const ctx = createTestApp();
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    expect(customer.test_clock).toBe(clock.id);
    expect(customer.created).toBe(T);

    const priceId = await recurringPrice(ctx);
    const sub = await subscribe(ctx, customer.id, priceId, { trial_period_days: 7 });
    expect(sub.status).toBe(200);
    expect(sub.body).toMatchObject({
      status: "trialing",
      test_clock: clock.id,
      created: T,
      start_date: T,
      trial_start: T,
      trial_end: T + 7 * DAY,
      billing_cycle_anchor: T + 7 * DAY,
    });
    expect(sub.body.items.data[0]).toMatchObject({
      created: T,
      current_period_start: T,
      current_period_end: T + 7 * DAY,
    });

    const invoice = await api<Json>(ctx.app, "GET", `/v1/invoices/${sub.body.latest_invoice}`);
    expect(invoice.body).toMatchObject({ created: T, test_clock: clock.id });

    const pms = await api<Json>(ctx.app, "GET", `/v1/customers/${customer.id}/payment_methods`);
    expect(pms.body.data[0].created).toBe(T);
  });

  it("advances: answers advancing with the old frozen_time, then stores ready at the target", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const clock = await createClock(ctx);
    hooks.deliveries.length = 0;

    const res = await api<Json>(ctx.app, "POST", `/v1/test_helpers/test_clocks/${clock.id}/advance`, {
      frozen_time: T + DAY,
    });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(CLOCK_KEYS);
    expect(res.body).toMatchObject({
      id: clock.id,
      status: "advancing",
      frozen_time: T,
      status_details: { advancing: { target_frozen_time: T + DAY } },
    });

    const got = await api<Json>(ctx.app, "GET", `/v1/test_helpers/test_clocks/${clock.id}`);
    expect(got.body).toMatchObject({ status: "ready", frozen_time: T + DAY, status_details: {} });

    expect(types(hooks.events)).toEqual(["test_helpers.test_clock.advancing", "test_helpers.test_clock.ready"]);
    const [advancing, ready] = hooks.events;
    expect(advancing.data.object).toEqual(res.body);
    expect(ready.data.object).toEqual(got.body);
    expect(advancing.request?.id).toMatch(/^req_/);
    expect(ready.request).toEqual({ id: null, idempotency_key: null });
  });

  it("stamps objects created after an advance with the new frozen time", async () => {
    const ctx = createTestApp();
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    await api(ctx.app, "POST", `/v1/test_helpers/test_clocks/${clock.id}/advance`, { frozen_time: T + 3 * DAY });

    const item = await api<Json>(ctx.app, "POST", "/v1/invoiceitems", {
      customer: customer.id,
      amount: 500,
      currency: "usd",
    });
    expect(item.body.date).toBe(T + 3 * DAY);

    const later = await clockCustomer(ctx, clock.id, false);
    expect(later.created).toBe(T + 3 * DAY);
  });

  it("leaves customers without a clock on the wall clock", async () => {
    const ctx = createTestApp();
    await createClock(ctx);
    const before = Math.floor(Date.now() / 1000);
    const plain = await api<Json>(ctx.app, "POST", "/v1/customers", { email: "plain@example.com" });
    expect(plain.body.test_clock).toBeNull();
    expect(plain.body.created).toBeGreaterThanOrEqual(before);
  });
});

describe("advance limits", () => {
  it("rejects a frozen_time that is not after the current one", async () => {
    const ctx = createTestApp();
    const clock = await createClock(ctx);
    for (const frozen_time of [T, T - 1]) {
      const res = await api<Json>(ctx.app, "POST", `/v1/test_helpers/test_clocks/${clock.id}/advance`, {
        frozen_time,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ type: "invalid_request_error", param: "frozen_time" });
    }
    const missing = await api<Json>(ctx.app, "POST", `/v1/test_helpers/test_clocks/${clock.id}/advance`, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ code: "parameter_missing", param: "frozen_time" });

    const unknown = await api<Json>(ctx.app, "POST", "/v1/test_helpers/test_clocks/clock_missing/advance", {
      frozen_time: T + 1,
    });
    expect(unknown.status).toBe(404);
  });

  it("allows two years without subscriptions, and not a second more", async () => {
    const ctx = createTestApp();
    const clock = await createClock(ctx);
    const limit = periodBoundary(T, "year", 1, 2);
    const over = await api<Json>(ctx.app, "POST", `/v1/test_helpers/test_clocks/${clock.id}/advance`, {
      frozen_time: limit + 1,
    });
    expect(over.status).toBe(400);
    expect(over.body.error.param).toBe("frozen_time");

    const ok = await api<Json>(ctx.app, "POST", `/v1/test_helpers/test_clocks/${clock.id}/advance`, {
      frozen_time: limit,
    });
    expect(ok.status).toBe(200);
  });

  it("allows two intervals of the shortest subscription on the clock", async () => {
    const ctx = createTestApp();
    const clock = await createClock(ctx);
    const monthly = await clockCustomer(ctx, clock.id);
    expect((await subscribe(ctx, monthly.id, await recurringPrice(ctx, "month"))).status).toBe(200);

    const twoMonths = periodBoundary(T, "month", 1, 2);
    const tooFar = await api<Json>(ctx.app, "POST", `/v1/test_helpers/test_clocks/${clock.id}/advance`, {
      frozen_time: twoMonths + 1,
    });
    expect(tooFar.status).toBe(400);
    expect(tooFar.body.error.param).toBe("frozen_time");

    const weekly = await clockCustomer(ctx, clock.id);
    expect((await subscribe(ctx, weekly.id, await recurringPrice(ctx, "week"))).status).toBe(200);
    const threeWeeks = await api<Json>(ctx.app, "POST", `/v1/test_helpers/test_clocks/${clock.id}/advance`, {
      frozen_time: T + 21 * DAY,
    });
    expect(threeWeeks.status).toBe(400);

    const twoWeeks = await api<Json>(ctx.app, "POST", `/v1/test_helpers/test_clocks/${clock.id}/advance`, {
      frozen_time: T + 14 * DAY,
    });
    expect(twoWeeks.status).toBe(200);
  });
});

describe("clock scoping and limits", () => {
  it("rejects an unknown test_clock and a fourth customer", async () => {
    const ctx = createTestApp();
    const unknown = await api<Json>(ctx.app, "POST", "/v1/customers", { test_clock: "clock_missing" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({ code: "resource_missing", param: "test_clock" });

    const clock = await createClock(ctx);
    for (let i = 0; i < 3; i++) await clockCustomer(ctx, clock.id, false);
    const fourth = await api<Json>(ctx.app, "POST", "/v1/customers", { test_clock: clock.id });
    expect(fourth.status).toBe(400);
    expect(fourth.body.error).toMatchObject({ type: "invalid_request_error", param: "test_clock" });
  });

  it("allows three subscriptions per clock customer", async () => {
    const ctx = createTestApp();
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    for (const interval of ["month", "year", "week"]) {
      const priceId = await recurringPrice(ctx, interval);
      expect((await subscribe(ctx, customer.id, priceId)).status).toBe(200);
    }
    const fourth = await subscribe(ctx, customer.id, await recurringPrice(ctx, "day"));
    expect(fourth.status).toBe(400);
    expect(fourth.body.error.type).toBe("invalid_request_error");
  });

  it("hides clock objects from unfiltered lists", async () => {
    const ctx = createTestApp();
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    const sub = await subscribe(ctx, customer.id, await recurringPrice(ctx));
    const invoiceId = sub.body.latest_invoice as string;
    const ids = (body: Json) => body.data.map((o: Json) => o.id);

    const customers = await api<Json>(ctx.app, "GET", "/v1/customers?limit=100");
    expect(ids(customers.body)).not.toContain(customer.id);
    const byEmail = await api<Json>(ctx.app, "GET", "/v1/customers?email=clock@example.com");
    expect(ids(byEmail.body)).not.toContain(customer.id);
    const onClock = await api<Json>(ctx.app, "GET", `/v1/customers?test_clock=${clock.id}`);
    expect(ids(onClock.body)).toEqual([customer.id]);

    const subs = await api<Json>(ctx.app, "GET", "/v1/subscriptions");
    expect(ids(subs.body)).not.toContain(sub.body.id);
    for (const query of [`customer=${customer.id}`, `test_clock=${clock.id}`]) {
      const res = await api<Json>(ctx.app, "GET", `/v1/subscriptions?${query}`);
      expect(ids(res.body), query).toEqual([sub.body.id]);
    }

    const invoices = await api<Json>(ctx.app, "GET", "/v1/invoices");
    expect(ids(invoices.body)).not.toContain(invoiceId);
    for (const query of [`customer=${customer.id}`, `subscription=${sub.body.id}`, `test_clock=${clock.id}`]) {
      const res = await api<Json>(ctx.app, "GET", `/v1/invoices?${query}`);
      expect(ids(res.body), query).toEqual([invoiceId]);
    }
  });

  it("expands test_clock on customers, subscriptions and invoices", async () => {
    const ctx = createTestApp();
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    const sub = await subscribe(ctx, customer.id, await recurringPrice(ctx));

    const cus = await api<Json>(ctx.app, "GET", `/v1/customers/${customer.id}?expand[]=test_clock`);
    expect(cus.body.test_clock).toEqual(clock);
    const s = await api<Json>(ctx.app, "GET", `/v1/subscriptions/${sub.body.id}?expand[]=test_clock`);
    expect(s.body.test_clock.id).toBe(clock.id);
    const inv = await api<Json>(ctx.app, "GET", `/v1/invoices/${sub.body.latest_invoice}?expand[]=test_clock`);
    expect(inv.body.test_clock.object).toBe("test_helpers.test_clock");
  });

  it("attaches an existing customer when the clock is created with customer", async () => {
    const ctx = createTestApp();
    const now = Math.floor(Date.now() / 1000);
    const customer = await api<Json>(ctx.app, "POST", "/v1/customers", { email: "existing@example.com" });

    const past = await api<Json>(ctx.app, "POST", "/v1/test_helpers/test_clocks", {
      frozen_time: now - DAY,
      customer: customer.body.id,
    });
    expect(past.status).toBe(400);
    expect(past.body.error.param).toBe("frozen_time");

    const clock = await api<Json>(ctx.app, "POST", "/v1/test_helpers/test_clocks", {
      frozen_time: now + DAY,
      customer: customer.body.id,
    });
    expect(clock.status).toBe(200);
    const got = await api<Json>(ctx.app, "GET", `/v1/customers/${customer.body.id}`);
    expect(got.body.test_clock).toBe(clock.body.id);

    const again = await api<Json>(ctx.app, "POST", "/v1/test_helpers/test_clocks", {
      frozen_time: now + DAY,
      customer: customer.body.id,
    });
    expect(again.status).toBe(400);
    expect(again.body.error.param).toBe("customer");
  });
});

describe("deleting a test clock", () => {
  it("removes the clock and its objects, sending only test_helpers.test_clock.deleted", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id);
    const sub = await subscribe(ctx, customer.id, await recurringPrice(ctx));
    const pms = await api<Json>(ctx.app, "GET", `/v1/customers/${customer.id}/payment_methods`);
    const pmId = pms.body.data[0].id as string;
    const invoice = await api<Json>(ctx.app, "GET", `/v1/invoices/${sub.body.latest_invoice}?expand[]=payments`);
    const piId = invoice.body.payments.data[0].payment.payment_intent as string;
    hooks.deliveries.length = 0;

    const res = await api<Json>(ctx.app, "DELETE", `/v1/test_helpers/test_clocks/${clock.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: clock.id, object: "test_helpers.test_clock", deleted: true });

    expect(types(hooks.events)).toEqual(["test_helpers.test_clock.deleted"]);
    expect(hooks.events[0].data.object).toMatchObject({ id: clock.id, object: "test_helpers.test_clock" });

    for (const path of [
      `/v1/test_helpers/test_clocks/${clock.id}`,
      `/v1/customers/${customer.id}`,
      `/v1/subscriptions/${sub.body.id}`,
      `/v1/invoices/${invoice.body.id}`,
      `/v1/payment_methods/${pmId}`,
      `/v1/payment_intents/${piId}`,
    ]) {
      const got = await api<Json>(ctx.app, "GET", path);
      expect(got.status, path).toBe(404);
    }

    const again = await api<Json>(ctx.app, "DELETE", `/v1/test_helpers/test_clocks/${clock.id}`);
    expect(again.status).toBe(404);
  });
});
