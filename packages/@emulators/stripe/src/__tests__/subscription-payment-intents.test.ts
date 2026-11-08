import { describe, it, expect, afterEach, vi } from "vitest";
import Stripe from "stripe";
import { createTestApp, captureWebhooks, api, sdk, type TestApp } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

const T = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
const FEB_15 = Math.floor(Date.UTC(2026, 1, 15, 12, 0, 0) / 1000);

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

async function monthlyPrice(ctx: TestApp) {
  const res = await api<Json>(ctx.app, "POST", "/v1/prices", {
    product_data: { name: "Pro" },
    currency: "usd",
    unit_amount: 2000,
    recurring: { interval: "month" },
  });
  return res.body.id as string;
}

/**
 * The Elements flow: a customer with no card subscribes with default_incomplete, and the
 * client confirms the first invoice's PaymentIntent from its confirmation_secret.
 */
async function incompleteSubscription(ctx: TestApp, extra: Record<string, unknown> = {}, clock?: string) {
  const customer = await api<Json>(ctx.app, "POST", "/v1/customers", {
    email: "elements@example.com",
    ...(clock && { test_clock: clock }),
  });
  const sub = await sdk(ctx.app).subscriptions.create({
    customer: customer.body.id,
    items: [{ price: await monthlyPrice(ctx) }],
    payment_behavior: "default_incomplete",
    expand: ["latest_invoice.confirmation_secret"],
    ...extra,
  });
  const invoice = sub.latest_invoice as Stripe.Invoice;
  const secret = invoice.confirmation_secret!.client_secret;
  const piId = secret.slice(0, secret.indexOf("_secret_"));
  return { customerId: customer.body.id as string, sub, invoiceId: invoice.id!, piId };
}

describe("confirming a subscription invoice's PaymentIntent directly", () => {
  it("pays the invoice and activates the subscription", async () => {
    const ctx = createTestApp({ webhook: true });
    const { sub, invoiceId, piId } = await incompleteSubscription(ctx);
    expect(sub.status).toBe("incomplete");

    const hooks = captureWebhooks();
    const confirmed = await api<Json>(ctx.app, "POST", `/v1/payment_intents/${piId}/confirm`, {
      payment_method: "pm_card_visa",
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ status: "succeeded", amount: 2000, amount_received: 2000 });

    const invoice = await api<Json>(ctx.app, "GET", `/v1/invoices/${invoiceId}?expand[]=payments`);
    expect(invoice.body).toMatchObject({ status: "paid", amount_paid: 2000, amount_remaining: 0 });
    expect(invoice.body.payments.data[0]).toMatchObject({
      status: "paid",
      payment: { type: "payment_intent", payment_intent: piId },
    });
    const active = await api<Json>(ctx.app, "GET", `/v1/subscriptions/${sub.id}`);
    expect(active.body.status).toBe("active");

    expectInOrder(hooks.events, [
      "payment_intent.succeeded",
      "charge.succeeded",
      "invoice.paid",
      "invoice.payment_succeeded",
      "customer.subscription.updated",
    ]);
    const update = hooks.ofType("customer.subscription.updated")[0];
    expect(update.data.previous_attributes).toMatchObject({ status: "incomplete" });
    // Without save_default_payment_method the card is not saved anywhere.
    expect(active.body.default_payment_method).toBeNull();
    expect(confirmed.body.setup_future_usage).toBeNull();
  });

  it("finishes 3D Secure on the invoice's PaymentIntent and then pays the invoice", async () => {
    const ctx = createTestApp({ webhook: true });
    const { sub, invoiceId, piId } = await incompleteSubscription(ctx);
    const confirmed = await api<Json>(ctx.app, "POST", `/v1/payment_intents/${piId}/confirm`, {
      payment_method: "pm_card_authenticationRequired",
    });
    expect(confirmed.body).toMatchObject({ status: "requires_action", next_action: { type: "use_stripe_sdk" } });
    expect((await api<Json>(ctx.app, "GET", `/v1/invoices/${invoiceId}`)).body.status).toBe("open");

    const hooks = captureWebhooks();
    await api(ctx.app, "POST", `/_stripe/simulate/payment_intents/${piId}/authenticate`, { result: "succeed" });
    expect((await api<Json>(ctx.app, "GET", `/v1/invoices/${invoiceId}`)).body.status).toBe("paid");
    expect((await api<Json>(ctx.app, "GET", `/v1/subscriptions/${sub.id}`)).body.status).toBe("active");
    expectInOrder(hooks.events, ["payment_intent.succeeded", "invoice.paid", "customer.subscription.updated"]);
  });

  it("sends invoice.payment_failed and keeps the subscription incomplete on a decline", async () => {
    const ctx = createTestApp({ webhook: true });
    const { sub, invoiceId, piId } = await incompleteSubscription(ctx);
    const hooks = captureWebhooks();
    const declined = await api<Json>(ctx.app, "POST", `/v1/payment_intents/${piId}/confirm`, {
      payment_method: "pm_card_chargeCustomerFail",
    });
    expect(declined.status).toBe(402);
    expect(declined.body.error).toMatchObject({ type: "card_error", code: "card_declined" });
    expect((await api<Json>(ctx.app, "GET", `/v1/invoices/${invoiceId}`)).body.status).toBe("open");
    expect((await api<Json>(ctx.app, "GET", `/v1/subscriptions/${sub.id}`)).body.status).toBe("incomplete");
    expectInOrder(hooks.events, ["payment_intent.payment_failed", "charge.failed", "invoice.payment_failed"]);
  });
});

describe("save_default_payment_method=on_subscription", () => {
  it("saves the card that confirmed the invoice's PaymentIntent to the customer and the subscription", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId, sub, piId } = await incompleteSubscription(ctx, {
      payment_settings: { save_default_payment_method: "on_subscription" },
    });
    expect(sub.payment_settings?.save_default_payment_method).toBe("on_subscription");
    const pending = await api<Json>(ctx.app, "GET", `/v1/payment_intents/${piId}`);
    expect(pending.body).toMatchObject({ setup_future_usage: "off_session", customer: customerId });

    const hooks = captureWebhooks();
    const confirmed = await api<Json>(ctx.app, "POST", `/v1/payment_intents/${piId}/confirm`, {
      payment_method: "pm_card_visa",
    });
    expect(confirmed.body).toMatchObject({ status: "succeeded", setup_future_usage: "off_session" });
    const pmId = confirmed.body.payment_method as string;
    expect(pmId).toMatch(/^pm_/);

    const pm = await api<Json>(ctx.app, "GET", `/v1/payment_methods/${pmId}`);
    expect(pm.body.customer).toBe(customerId);
    const saved = await api<Json>(ctx.app, "GET", `/v1/customers/${customerId}/payment_methods`);
    expect(saved.body.data.map((p: Json) => p.id)).toEqual([pmId]);

    const active = await api<Json>(ctx.app, "GET", `/v1/subscriptions/${sub.id}`);
    expect(active.body).toMatchObject({ status: "active", default_payment_method: pmId });
    const attached = hooks.ofType("payment_method.attached");
    expect(attached).toHaveLength(1);
    expect(attached[0].data.object).toMatchObject({ id: pmId, customer: customerId });
    expectInOrder(hooks.events, [
      "payment_intent.succeeded",
      "payment_method.attached",
      "invoice.paid",
      "customer.subscription.updated",
    ]);
    const updated = hooks.ofType("customer.subscription.updated").at(-1)!;
    expect(updated.data.previous_attributes).toMatchObject({ status: "incomplete", default_payment_method: null });
  });

  it("charges the saved card off-session at the next renewal", async () => {
    const ctx = createTestApp({ webhook: true });
    const clock = await api<Json>(ctx.app, "POST", "/v1/test_helpers/test_clocks", { frozen_time: T });
    const { sub, piId } = await incompleteSubscription(
      ctx,
      { payment_settings: { save_default_payment_method: "on_subscription" } },
      clock.body.id,
    );
    const confirmed = await api<Json>(ctx.app, "POST", `/v1/payment_intents/${piId}/confirm`, {
      payment_method: "pm_card_visa",
    });
    const pmId = confirmed.body.payment_method;

    await api(ctx.app, "POST", `/v1/test_helpers/test_clocks/${clock.body.id}/advance`, {
      frozen_time: FEB_15 + 2 * 3600,
    });
    const renewed = await api<Json>(ctx.app, "GET", `/v1/subscriptions/${sub.id}?expand[]=latest_invoice.payments`);
    expect(renewed.body.status).toBe("active");
    const invoice = renewed.body.latest_invoice;
    expect(invoice).toMatchObject({ billing_reason: "subscription_cycle", status: "paid" });
    const renewalPi = await api<Json>(
      ctx.app,
      "GET",
      `/v1/payment_intents/${invoice.payments.data[0].payment.payment_intent}`,
    );
    expect(renewalPi.body).toMatchObject({ status: "succeeded", payment_method: pmId });
  });

  it("leaves the PaymentIntent of a subscription without it free of setup_future_usage", async () => {
    const ctx = createTestApp();
    const { piId } = await incompleteSubscription(ctx, { payment_settings: { save_default_payment_method: "off" } });
    const pi = await api<Json>(ctx.app, "GET", `/v1/payment_intents/${piId}`);
    expect(pi.body.setup_future_usage).toBeNull();
  });
});
