import { describe, it, expect, afterEach, vi } from "vitest";
import type Stripe from "stripe";
import { createTestApp, captureWebhooks, api, type TestApp } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

const DAY = 86400;
const HOUR = 3600;
const T = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
const TRIAL_END = T + 7 * DAY;
/** The first collection attempt of the invoice created at the trial end. */
const FIRST_ATTEMPT = TRIAL_END + HOUR;

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

async function clockCustomer(ctx: TestApp, clockId: string, card: string) {
  const res = await api<Json>(ctx.app, "POST", "/v1/customers", {
    email: "dunning@example.com",
    test_clock: clockId,
    payment_method: card,
    invoice_settings: { default_payment_method: card },
  });
  expect(res.status).toBe(200);
  return res.body;
}

async function monthlyPrice(ctx: TestApp) {
  const product = await api<Json>(ctx.app, "POST", "/v1/products", { name: "Pro Plan" });
  const price = await api<Json>(ctx.app, "POST", "/v1/prices", {
    product: product.body.id,
    currency: "usd",
    unit_amount: 2000,
    recurring: { interval: "month" },
  });
  expect(price.status).toBe(200);
  return price.body.id as string;
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

async function getInvoice(ctx: TestApp, id: string) {
  return (await api<Json>(ctx.app, "GET", `/v1/invoices/${id}`)).body;
}

async function getCustomer(ctx: TestApp, id: string) {
  return (await api<Json>(ctx.app, "GET", `/v1/customers/${id}`)).body;
}

async function settings(ctx: TestApp, body: Json) {
  const res = await api<Json>(ctx.app, "POST", "/_stripe/billing/settings", body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** A clock customer on a 7 day trial whose card `card` is charged when the trial ends. */
async function trialing(ctx: TestApp, card: string) {
  const clock = await createClock(ctx);
  const customer = await clockCustomer(ctx, clock.id, card);
  const res = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
    customer: customer.id,
    items: [{ price: await monthlyPrice(ctx) }],
    trial_period_days: 7,
  });
  expect(res.status).toBe(200);
  return { clock, customer, sub: res.body };
}

/** Attach a working card to the customer and make it the invoice default. */
async function replaceDefaultCard(ctx: TestApp, customerId: string, card = "pm_card_visa") {
  const attached = await api<Json>(ctx.app, "POST", `/v1/payment_methods/${card}/attach`, { customer: customerId });
  expect(attached.status).toBe(200);
  const updated = await api<Json>(ctx.app, "POST", `/v1/customers/${customerId}`, {
    invoice_settings: { default_payment_method: attached.body.id },
  });
  expect(updated.status).toBe(200);
  return attached.body.id as string;
}

describe("billing settings for retries", () => {
  it("defaults to three retries at 3, 5 and 7 days, then cancel and leave the invoice open", async () => {
    const ctx = createTestApp();
    const res = await api<Json>(ctx.app, "GET", "/_stripe/billing/settings");
    expect(res.body).toEqual({
      object: "billing_settings",
      upcoming_renewal_days: 3,
      retry_schedule_days: [3, 5, 7],
      after_retries: { subscription: "cancel", invoice: "open" },
    });
  });

  it("validates the schedule and the policies, and takes them from the seed", async () => {
    const ctx = createTestApp();
    const bad: Array<[Json, string]> = [
      [{ retry_schedule_days: [1, 2, 3, 4] }, "retry_schedule_days"],
      [{ retry_schedule_days: [0] }, "retry_schedule_days"],
      [{ retry_schedule_days: ["soon"] }, "retry_schedule_days"],
      [{ after_retries: { subscription: "delete" } }, "after_retries[subscription]"],
      [{ after_retries: { invoice: "void" } }, "after_retries[invoice]"],
    ];
    for (const [body, param] of bad) {
      const res = await api<Json>(ctx.app, "POST", "/_stripe/billing/settings", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toMatchObject({ type: "invalid_request_error", param });
    }

    const changed = await settings(ctx, { retry_schedule_days: [1, 2], after_retries: { subscription: "unpaid" } });
    expect(changed).toMatchObject({
      retry_schedule_days: [1, 2],
      after_retries: { subscription: "unpaid", invoice: "open" },
    });
    expect((await settings(ctx, { retry_schedule_days: "" })).retry_schedule_days).toEqual([]);

    const form = await ctx.app.request("http://localhost:14000/_stripe/billing/settings", {
      method: "POST",
      headers: { Authorization: "Bearer sk_test_abc123", "Content-Type": "application/x-www-form-urlencoded" },
      body: "retry_schedule_days[0]=2&retry_schedule_days[1]=4&after_retries[invoice]=uncollectible",
    });
    expect(await form.json()).toMatchObject({
      retry_schedule_days: [2, 4],
      after_retries: { subscription: "unpaid", invoice: "uncollectible" },
    });

    const seeded = createTestApp({
      seed: { billing: { retry_schedule_days: [2], after_retries: { subscription: "pause" } } },
    });
    expect((await api<Json>(seeded.app, "GET", "/_stripe/billing/settings")).body).toMatchObject({
      retry_schedule_days: [2],
      after_retries: { subscription: "pause", invoice: "open" },
    });
  });
});

describe("failed renewals", () => {
  it("makes the subscription past_due, the customer delinquent and schedules the first retry", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const { clock, customer, sub } = await trialing(ctx, "pm_card_chargeCustomerFail");
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, FIRST_ATTEMPT);
    const [failed] = hooks.ofType("invoice.payment_failed");
    expect(failed.created).toBe(FIRST_ATTEMPT);
    expect(obj(failed)).toMatchObject({
      status: "open",
      attempt_count: 1,
      attempted: true,
      next_payment_attempt: FIRST_ATTEMPT + 3 * DAY,
      billing_reason: "subscription_cycle",
    });

    const updates = hooks.ofType("customer.subscription.updated").filter((e) => obj(e).status === "past_due");
    expect(updates).toHaveLength(1);
    expect(updates[0].data.previous_attributes).toMatchObject({ status: "active" });

    const delinquency = hooks.ofType("customer.updated");
    expect(delinquency).toHaveLength(1);
    expect(obj(delinquency[0])).toMatchObject({ id: customer.id, delinquent: true });
    expect(delinquency[0].data.previous_attributes).toEqual({ delinquent: false });

    const invoice = await getInvoice(ctx, (await getSub(ctx, sub.id)).latest_invoice);
    expect(invoice.next_payment_attempt).toBe(FIRST_ATTEMPT + 3 * DAY);
  });

  it("retries 3, 5 and 7 days apart, then cancels with reason payment_failed and leaves the invoice open", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const { clock, sub } = await trialing(ctx, "pm_card_chargeCustomerFail");
    await advance(ctx, clock.id, FIRST_ATTEMPT);
    const invoiceId = (await getSub(ctx, sub.id)).latest_invoice as string;

    const retries = [
      { at: FIRST_ATTEMPT + 3 * DAY, count: 2, next: FIRST_ATTEMPT + 8 * DAY },
      { at: FIRST_ATTEMPT + 8 * DAY, count: 3, next: FIRST_ATTEMPT + 15 * DAY },
      { at: FIRST_ATTEMPT + 15 * DAY, count: 4, next: null },
    ];
    for (const retry of retries) {
      hooks.deliveries.length = 0;
      await advance(ctx, clock.id, retry.at - 1);
      expect(hooks.ofType("invoice.payment_failed"), `no retry before ${retry.count}`).toHaveLength(0);
      await advance(ctx, clock.id, retry.at);
      const failures = hooks.ofType("invoice.payment_failed");
      expect(failures, `retry ${retry.count}`).toHaveLength(1);
      expect(failures[0].created).toBe(retry.at);
      expect(obj(failures[0])).toMatchObject({
        id: invoiceId,
        attempt_count: retry.count,
        next_payment_attempt: retry.next,
      });
      expect(types(hooks.events)).toContain("charge.failed");
    }

    const [deleted] = hooks.ofType("customer.subscription.deleted");
    expect(deleted.created).toBe(FIRST_ATTEMPT + 15 * DAY);
    expect(obj(deleted)).toMatchObject({
      id: sub.id,
      status: "canceled",
      ended_at: FIRST_ATTEMPT + 15 * DAY,
      canceled_at: FIRST_ATTEMPT + 15 * DAY,
      cancellation_details: { reason: "payment_failed" },
    });
    expect(await getInvoice(ctx, invoiceId)).toMatchObject({
      status: "open",
      auto_advance: false,
      attempt_count: 4,
      next_payment_attempt: null,
    });

    hooks.deliveries.length = 0;
    await advance(ctx, clock.id, FIRST_ATTEMPT + 40 * DAY);
    expect(types(hooks.events)).not.toContain("invoice.payment_failed");
    expect(types(hooks.events)).not.toContain("invoice.created");
  });

  it("follows a custom schedule, marks the invoice uncollectible and leaves the subscription unpaid", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    await settings(ctx, {
      retry_schedule_days: [2],
      after_retries: { subscription: "unpaid", invoice: "uncollectible" },
    });
    const { clock, customer, sub } = await trialing(ctx, "pm_card_chargeCustomerFail");
    await advance(ctx, clock.id, FIRST_ATTEMPT);
    const invoiceId = (await getSub(ctx, sub.id)).latest_invoice as string;
    expect((await getInvoice(ctx, invoiceId)).next_payment_attempt).toBe(FIRST_ATTEMPT + 2 * DAY);
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, FIRST_ATTEMPT + 2 * DAY);
    const [marked] = hooks.ofType("invoice.marked_uncollectible");
    expect(obj(marked)).toMatchObject({
      id: invoiceId,
      status: "uncollectible",
      attempt_count: 2,
      next_payment_attempt: null,
      status_details: { uncollectible: { reason: "max_payment_attempts" } },
    });
    const unpaid = hooks.ofType("customer.subscription.updated").filter((e) => obj(e).status === "unpaid");
    expect(unpaid).toHaveLength(1);
    expect(unpaid[0].data.previous_attributes).toMatchObject({ status: "past_due" });
    expect(types(hooks.events)).not.toContain("customer.subscription.deleted");
    // Only marking it uncollectible through the API forgives the customer.
    expect((await getCustomer(ctx, customer.id)).delinquent).toBe(true);

    const renewal = (await getSub(ctx, sub.id)).items.data[0].current_period_end as number;
    hooks.deliveries.length = 0;
    await advance(ctx, clock.id, renewal + 2 * HOUR);
    const [created] = hooks.ofType("invoice.created");
    expect(obj(created)).toMatchObject({ status: "draft", auto_advance: false, automatically_finalizes_at: null });
    expect(types(hooks.events)).not.toContain("invoice.finalized");
    const current = await getSub(ctx, sub.id);
    expect(current.status).toBe("unpaid");
    expect((await getInvoice(ctx, current.latest_invoice)).status).toBe("draft");
  });

  it("pauses the subscription after the final failure when the policy is pause", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    await settings(ctx, { retry_schedule_days: [1], after_retries: { subscription: "pause" } });
    const { clock, sub } = await trialing(ctx, "pm_card_chargeCustomerFail");
    await advance(ctx, clock.id, FIRST_ATTEMPT);
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, FIRST_ATTEMPT + DAY);
    const [paused] = hooks.ofType("customer.subscription.paused");
    expect(paused.created).toBe(FIRST_ATTEMPT + DAY);
    expect(obj(paused)).toMatchObject({
      id: sub.id,
      status: "paused",
      status_details: {
        paused: {
          subscription: { type: "final_payment_failure" },
          transitioned_at: FIRST_ATTEMPT + DAY,
          type: "subscription",
        },
      },
    });
    const updated = hooks.ofType("customer.subscription.updated").filter((e) => obj(e).status === "paused");
    expect(updated).toHaveLength(1);
    expect(updated[0].data.previous_attributes).toMatchObject({ status: "past_due", status_details: null });

    const current = await getSub(ctx, sub.id);
    expect(current.status).toBe("paused");
    expect((await getInvoice(ctx, current.latest_invoice)).status).toBe("open");

    hooks.deliveries.length = 0;
    await advance(ctx, clock.id, FIRST_ATTEMPT + 40 * DAY);
    expect(types(hooks.events)).not.toContain("invoice.created");
  });

  it("leaves the subscription past_due after the last retry when the policy is past_due", async () => {
    const ctx = createTestApp();
    await settings(ctx, { retry_schedule_days: [], after_retries: { subscription: "past_due" } });
    const { clock, sub } = await trialing(ctx, "pm_card_chargeCustomerFail");
    await advance(ctx, clock.id, FIRST_ATTEMPT + 10 * DAY);
    const current = await getSub(ctx, sub.id);
    expect(current.status).toBe("past_due");
    expect(await getInvoice(ctx, current.latest_invoice)).toMatchObject({
      status: "open",
      attempt_count: 1,
      next_payment_attempt: null,
    });
  });
});

describe("recovering a past_due subscription", () => {
  it("pays with a new default card: invoice.paid, active, no longer delinquent and no more retries", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const { clock, customer, sub } = await trialing(ctx, "pm_card_chargeCustomerFail");
    await advance(ctx, clock.id, FIRST_ATTEMPT + DAY);
    const invoiceId = (await getSub(ctx, sub.id)).latest_invoice as string;
    const card = await replaceDefaultCard(ctx, customer.id);
    hooks.deliveries.length = 0;

    const paid = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoiceId}/pay`);
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: "paid", next_payment_attempt: null, attempt_count: 1 });
    expect(hooks.ofType("invoice.paid")).toHaveLength(1);
    const [reactivated] = hooks.ofType("customer.subscription.updated");
    expect(obj(reactivated).status).toBe("active");
    expect(reactivated.data.previous_attributes).toMatchObject({ status: "past_due" });
    expect(obj(hooks.ofType("customer.updated")[0])).toMatchObject({ delinquent: false });
    expect((await getCustomer(ctx, customer.id)).delinquent).toBe(false);
    expect((await getSub(ctx, sub.id)).status).toBe("active");

    hooks.deliveries.length = 0;
    await advance(ctx, clock.id, FIRST_ATTEMPT + 20 * DAY);
    expect(types(hooks.events)).not.toContain("invoice.payment_failed");
    expect((await getInvoice(ctx, invoiceId)).attempt_count).toBe(1);
    expect(card).toMatch(/^pm_/);
  });

  it("lets the next scheduled retry succeed once the default card changes", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const { clock, customer, sub } = await trialing(ctx, "pm_card_chargeCustomerFail");
    await advance(ctx, clock.id, FIRST_ATTEMPT);
    const invoiceId = (await getSub(ctx, sub.id)).latest_invoice as string;
    const card = await replaceDefaultCard(ctx, customer.id);
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, FIRST_ATTEMPT + 3 * DAY);
    const [paid] = hooks.ofType("invoice.paid");
    expect(paid.created).toBe(FIRST_ATTEMPT + 3 * DAY);
    expect(obj(paid)).toMatchObject({ id: invoiceId, status: "paid", attempt_count: 2 });
    const [succeeded] = hooks.ofType("payment_intent.succeeded");
    expect(obj(succeeded).payment_method).toBe(card);
    expect((await getSub(ctx, sub.id)).status).toBe("active");
    expect((await getCustomer(ctx, customer.id)).delinquent).toBe(false);
  });

  it("makes a past_due subscription active when its open invoice is voided or forgiven", async () => {
    for (const action of ["void", "mark_uncollectible"]) {
      const hooks = captureWebhooks();
      const ctx = createTestApp({ webhook: true });
      const { clock, sub } = await trialing(ctx, "pm_card_chargeCustomerFail");
      await advance(ctx, clock.id, FIRST_ATTEMPT);
      const invoiceId = (await getSub(ctx, sub.id)).latest_invoice as string;
      hooks.deliveries.length = 0;

      const res = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoiceId}/${action}`);
      expect(res.status, action).toBe(200);
      expect(res.body.next_payment_attempt, action).toBeNull();
      const [updated] = hooks.ofType("customer.subscription.updated");
      expect(obj(updated).status, action).toBe("active");
      expect(updated.data.previous_attributes, action).toMatchObject({ status: "past_due" });
      expect(updated.request?.id, action).toMatch(/^req_/);

      hooks.deliveries.length = 0;
      await advance(ctx, clock.id, FIRST_ATTEMPT + 20 * DAY);
      expect(types(hooks.events), action).not.toContain("invoice.payment_failed");
      vi.unstubAllGlobals();
    }
  });
});

describe("hard declines", () => {
  it("keeps scheduling retries without charging until the default payment method changes", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const { clock, customer, sub } = await trialing(ctx, "pm_card_visa");
    const pmId = (await getCustomer(ctx, customer.id)).invoice_settings.default_payment_method as string;
    const simulated = await api<Json>(ctx.app, "POST", `/_stripe/simulate/payment_methods/${pmId}`, {
      behavior: "decline",
      decline_code: "lost_card",
    });
    expect(simulated.status).toBe(200);
    expect(simulated.body).toMatchObject({ id: pmId, object: "payment_method" });
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, FIRST_ATTEMPT);
    const [failedPi] = hooks.ofType("payment_intent.payment_failed");
    expect(obj(failedPi).last_payment_error).toMatchObject({ code: "card_declined", decline_code: "lost_card" });
    const [failed] = hooks.ofType("invoice.payment_failed");
    expect(obj(failed)).toMatchObject({ attempt_count: 1, next_payment_attempt: FIRST_ATTEMPT + 3 * DAY });
    expect((await getSub(ctx, sub.id)).status).toBe("past_due");
    const invoiceId = obj(failed).id as string;

    // The retry is counted but not executed: no new charge with the card that was declined for good.
    hooks.deliveries.length = 0;
    await advance(ctx, clock.id, FIRST_ATTEMPT + 3 * DAY);
    expect(types(hooks.events)).not.toContain("charge.failed");
    expect(types(hooks.events)).not.toContain("payment_intent.payment_failed");
    const [skipped] = hooks.ofType("invoice.payment_failed");
    expect(obj(skipped)).toMatchObject({ attempt_count: 2, next_payment_attempt: FIRST_ATTEMPT + 8 * DAY });

    await replaceDefaultCard(ctx, customer.id);
    hooks.deliveries.length = 0;
    await advance(ctx, clock.id, FIRST_ATTEMPT + 8 * DAY);
    expect(obj(hooks.ofType("invoice.paid")[0])).toMatchObject({ id: invoiceId, attempt_count: 3 });
    expect((await getSub(ctx, sub.id)).status).toBe("active");
  });

  it("does not suspend retries for a soft decline such as insufficient_funds", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const { clock, customer } = await trialing(ctx, "pm_card_visa");
    const pmId = (await getCustomer(ctx, customer.id)).invoice_settings.default_payment_method as string;
    await api<Json>(ctx.app, "POST", `/_stripe/simulate/payment_methods/${pmId}`, {
      behavior: "decline",
      decline_code: "insufficient_funds",
    });
    await advance(ctx, clock.id, FIRST_ATTEMPT);
    hooks.deliveries.length = 0;
    await advance(ctx, clock.id, FIRST_ATTEMPT + 3 * DAY);
    expect(obj(hooks.ofType("charge.failed")[0])).toMatchObject({
      failure_code: "card_declined",
      outcome: expect.objectContaining({ reason: "insufficient_funds" }),
    });

    await api<Json>(ctx.app, "POST", `/_stripe/simulate/payment_methods/${pmId}`, { behavior: "succeed" });
    hooks.deliveries.length = 0;
    await advance(ctx, clock.id, FIRST_ATTEMPT + 8 * DAY);
    expect(hooks.ofType("invoice.paid")).toHaveLength(1);
  });

  it("validates the simulation route", async () => {
    const ctx = createTestApp();
    const missing = await api<Json>(ctx.app, "POST", "/_stripe/simulate/payment_methods/pm_missing", {
      behavior: "decline",
    });
    expect(missing.status).toBe(404);
    const created = await api<Json>(ctx.app, "POST", "/v1/payment_methods", {
      type: "card",
      card: { token: "tok_visa" },
    });
    const pmId = created.body.id as string;
    const badBehavior = await api<Json>(ctx.app, "POST", `/_stripe/simulate/payment_methods/${pmId}`, {
      behavior: "explode",
    });
    expect(badBehavior.status).toBe(400);
    expect(badBehavior.body.error.param).toBe("behavior");
    const badCode = await api<Json>(ctx.app, "POST", `/_stripe/simulate/payment_methods/${pmId}`, {
      behavior: "decline",
      decline_code: "not_a_code",
    });
    expect(badCode.status).toBe(400);
    expect(badCode.body.error.param).toBe("decline_code");

    await api(ctx.app, "POST", `/_stripe/simulate/payment_methods/${pmId}`, { behavior: "decline" });
    const pi = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 500,
      currency: "usd",
      payment_method: pmId,
      confirm: true,
    });
    expect(pi.status).toBe(402);
    expect(pi.body.error).toMatchObject({ code: "card_declined", decline_code: "generic_decline" });
  });
});

describe("the first invoice of an incomplete subscription", () => {
  it("is never retried and expires the subscription 23 hours after it was created", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const clock = await createClock(ctx);
    const customer = await clockCustomer(ctx, clock.id, "pm_card_chargeCustomerFail");
    const res = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customer.id,
      items: [{ price: await monthlyPrice(ctx) }],
    });
    expect(res.body.status).toBe("incomplete");
    const invoiceId = res.body.latest_invoice as string;
    expect((await getInvoice(ctx, invoiceId)).next_payment_attempt).toBeNull();
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, T + 23 * HOUR - 1);
    expect((await getSub(ctx, res.body.id)).status).toBe("incomplete");

    await advance(ctx, clock.id, T + 3 * DAY);
    expect(types(hooks.events)).not.toContain("invoice.payment_failed");
    const [voided] = hooks.ofType("invoice.voided");
    expect(voided.created).toBe(T + 23 * HOUR);
    expect(obj(voided)).toMatchObject({ id: invoiceId, status: "void" });
    const [expired] = hooks.ofType("customer.subscription.updated");
    expect(expired.created).toBe(T + 23 * HOUR);
    expect(obj(expired)).toMatchObject({ status: "incomplete_expired", ended_at: T + 23 * HOUR });
    expect(expired.data.previous_attributes).toMatchObject({ status: "incomplete" });
    expect((await getSub(ctx, res.body.id)).status).toBe("incomplete_expired");
  });
});

describe("renewals that need authentication", () => {
  it("leaves the PaymentIntent requires_action, goes past_due and recovers when the customer authenticates", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const { clock, customer, sub } = await trialing(ctx, "pm_card_authenticationRequired");
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, FIRST_ATTEMPT);
    const [action] = hooks.ofType("invoice.payment_action_required");
    const [failed] = hooks.ofType("invoice.payment_failed");
    expect(obj(action)).toMatchObject({ status: "open", attempt_count: 1 });
    expect(obj(failed)).toMatchObject({ attempt_count: 1, next_payment_attempt: FIRST_ATTEMPT + 3 * DAY });
    const [requires] = hooks.ofType("payment_intent.requires_action");
    const piId = obj(requires).id as string;
    expect(obj(requires).status).toBe("requires_action");
    expect((await getSub(ctx, sub.id)).status).toBe("past_due");
    expect((await getCustomer(ctx, customer.id)).delinquent).toBe(true);

    hooks.deliveries.length = 0;
    const auth = await api<Json>(ctx.app, "POST", `/_stripe/simulate/payment_intents/${piId}/authenticate`, {
      result: "succeed",
    });
    expect(auth.status).toBe(200);
    expect(auth.body.status).toBe("succeeded");
    expect(obj(hooks.ofType("invoice.paid")[0]).id).toBe(obj(failed).id);
    expect((await getSub(ctx, sub.id)).status).toBe("active");
    expect((await getCustomer(ctx, customer.id)).delinquent).toBe(false);
  });

  it("asks for authentication again on each scheduled retry", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const { clock } = await trialing(ctx, "pm_card_authenticationRequired");
    await advance(ctx, clock.id, FIRST_ATTEMPT);
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, FIRST_ATTEMPT + 3 * DAY);
    expect(hooks.ofType("invoice.payment_action_required")).toHaveLength(1);
    expect(obj(hooks.ofType("invoice.payment_failed")[0])).toMatchObject({
      attempt_count: 2,
      next_payment_attempt: FIRST_ATTEMPT + 8 * DAY,
    });
  });

  it("can make a saved card require authentication later through the simulation route", async () => {
    const hooks = captureWebhooks();
    const ctx = createTestApp({ webhook: true });
    const { clock, customer, sub } = await trialing(ctx, "pm_card_visa");
    const pmId = (await getCustomer(ctx, customer.id)).invoice_settings.default_payment_method as string;
    await api(ctx.app, "POST", `/_stripe/simulate/payment_methods/${pmId}`, { behavior: "require_authentication" });
    hooks.deliveries.length = 0;

    await advance(ctx, clock.id, FIRST_ATTEMPT);
    expect(hooks.ofType("invoice.payment_action_required")).toHaveLength(1);
    expect((await getSub(ctx, sub.id)).status).toBe("past_due");
  });
});
