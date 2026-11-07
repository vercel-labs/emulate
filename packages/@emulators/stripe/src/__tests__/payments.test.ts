import { describe, it, expect, afterEach, vi } from "vitest";
import Stripe from "stripe";
import { createTestApp, captureWebhooks, sdk, api, type TestApp } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

/** A customer with `card` attached as its saved payment method. */
async function customerWithCard(ctx: TestApp, card = "pm_card_visa") {
  const customer = await api<Json>(ctx.app, "POST", "/v1/customers", { email: "payer@example.com" });
  const pm = await api<Json>(ctx.app, "POST", `/v1/payment_methods/${card}/attach`, { customer: customer.body.id });
  expect(pm.status).toBe(200);
  return { customerId: customer.body.id as string, pmId: pm.body.id as string };
}

function types(events: Stripe.Event[]): string[] {
  return events.map((e) => e.type);
}

describe("PaymentIntent object", () => {
  it("renders every field Stripe returns, in reference order", async () => {
    const { app } = createTestApp();
    const pi = await api<Json>(app, "POST", "/v1/payment_intents", { amount: 2000, currency: "usd" });
    expect(Object.keys(pi.body)).toEqual([
      "id",
      "object",
      "amount",
      "amount_capturable",
      "amount_details",
      "amount_received",
      "application",
      "application_fee_amount",
      "automatic_payment_methods",
      "canceled_at",
      "cancellation_reason",
      "capture_method",
      "client_secret",
      "confirmation_method",
      "created",
      "currency",
      "customer",
      "description",
      "excluded_payment_method_types",
      "last_payment_error",
      "latest_charge",
      "livemode",
      "metadata",
      "next_action",
      "on_behalf_of",
      "payment_method",
      "payment_method_configuration_details",
      "payment_method_options",
      "payment_method_types",
      "processing",
      "receipt_email",
      "review",
      "setup_future_usage",
      "shipping",
      "source",
      "statement_descriptor",
      "statement_descriptor_suffix",
      "status",
      "transfer_data",
      "transfer_group",
    ]);
    expect(pi.body).toMatchObject({
      amount_received: 0,
      capture_method: "automatic_async",
      confirmation_method: "automatic",
      last_payment_error: null,
      latest_charge: null,
      next_action: null,
      payment_method: null,
      payment_method_types: ["card"],
      setup_future_usage: null,
      status: "requires_payment_method",
    });
    expect(pi.body.client_secret).toMatch(new RegExp(`^${pi.body.id}_secret_[A-Za-z0-9]+$`));
  });

  it("clones a test card id into a new pm_ when it is set on the intent", async () => {
    const { app } = createTestApp();
    const pi = await api<Json>(app, "POST", "/v1/payment_intents", {
      amount: 1000,
      currency: "usd",
      payment_method: "pm_card_visa",
    });
    expect(pi.body.status).toBe("requires_confirmation");
    expect(pi.body.payment_method).toMatch(/^pm_[A-Za-z0-9]+$/);
    expect(pi.body.payment_method).not.toBe("pm_card_visa");
    const pm = await api<Json>(app, "GET", `/v1/payment_methods/${pi.body.payment_method}`);
    expect(pm.body.card.last4).toBe("4242");
  });

  it("rejects payment methods that do not exist or belong to another customer", async () => {
    const ctx = createTestApp();
    const missing = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 1000,
      currency: "usd",
      payment_method: "pm_nope",
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "resource_missing",
      param: "payment_method",
      message: "No such PaymentMethod: 'pm_nope'",
    });

    const { pmId } = await customerWithCard(ctx);
    const other = await api<Json>(ctx.app, "POST", "/v1/customers", { email: "other@example.com" });
    const foreign = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 1000,
      currency: "usd",
      customer: other.body.id,
      payment_method: pmId,
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toMatchObject({ type: "invalid_request_error", param: "payment_method" });
  });
});

describe("confirming against test cards", () => {
  it("charges a saved visa off-session in one create call", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId, pmId } = await customerWithCard(ctx);
    const hooks = captureWebhooks();

    const pi = await sdk(ctx.app).paymentIntents.create({
      amount: 4200,
      currency: "usd",
      customer: customerId,
      payment_method: pmId,
      confirm: true,
      off_session: true,
    });
    expect(pi.status).toBe("succeeded");
    expect(pi.amount_received).toBe(4200);
    expect(pi.payment_method).toBe(pmId);
    expect(pi.latest_charge).toMatch(/^ch_[A-Za-z0-9]+$/);
    expect(pi.next_action).toBeNull();

    const seen = types(hooks.events);
    expect(seen).toEqual(
      expect.arrayContaining(["payment_intent.created", "charge.succeeded", "payment_intent.succeeded"]),
    );
    expect(seen.indexOf("payment_intent.created")).toBeLessThan(seen.indexOf("charge.succeeded"));
    expect(seen.indexOf("payment_intent.created")).toBeLessThan(seen.indexOf("payment_intent.succeeded"));

    const charge = await sdk(ctx.app).charges.retrieve(pi.latest_charge as string);
    expect(charge).toMatchObject({
      status: "succeeded",
      paid: true,
      captured: true,
      amount_captured: 4200,
      balance_transaction: null,
      failure_code: null,
      payment_intent: pi.id,
      payment_method: pmId,
      outcome: { type: "authorized", network_status: "approved_by_network" },
      payment_method_details: {
        type: "card",
        card: { brand: "visa", last4: "4242", funding: "credit", network: "visa", three_d_secure: null },
      },
    });
    expect(charge.payment_method_details?.card?.checks?.cvc_check).toBe("pass");
  });

  it("declines 0341 after it was attached, with a failed charge", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId, pmId } = await customerWithCard(ctx, "pm_card_chargeCustomerFail");
    const created = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 1500,
      currency: "usd",
      customer: customerId,
      payment_method: pmId,
    });
    const hooks = captureWebhooks();

    const res = await api<Json>(ctx.app, "POST", `/v1/payment_intents/${created.body.id}/confirm`, {});
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({
      type: "card_error",
      code: "card_declined",
      decline_code: "generic_decline",
      message: "Your card was declined.",
      payment_intent: { id: created.body.id, status: "requires_payment_method" },
      payment_method: { id: pmId },
    });
    const chargeId = res.body.error.charge as string;
    expect(chargeId).toMatch(/^ch_/);

    const pi = await api<Json>(ctx.app, "GET", `/v1/payment_intents/${created.body.id}`);
    expect(pi.body.status).toBe("requires_payment_method");
    expect(pi.body.payment_method).toBeNull();
    expect(pi.body.latest_charge).toBe(chargeId);
    expect(pi.body.amount_received).toBe(0);
    expect(pi.body.last_payment_error).toMatchObject({
      type: "card_error",
      code: "card_declined",
      decline_code: "generic_decline",
      charge: chargeId,
      payment_method: { id: pmId, object: "payment_method" },
    });

    const charge = await api<Json>(ctx.app, "GET", `/v1/charges/${chargeId}`);
    expect(charge.body).toMatchObject({
      status: "failed",
      paid: false,
      captured: false,
      amount_captured: 0,
      failure_code: "card_declined",
      failure_message: "Your card was declined.",
      outcome: { type: "issuer_declined", network_status: "declined_by_network", reason: "generic_decline" },
      payment_method_details: { type: "card", card: { last4: "0341" } },
    });

    expect(types(hooks.events)).toEqual(expect.arrayContaining(["charge.failed", "payment_intent.payment_failed"]));
    expect(hooks.ofType("payment_intent.payment_failed")[0].data.object).toMatchObject({
      last_payment_error: { code: "card_declined" },
    });
    expect(hooks.ofType("charge.failed")[0].data.object).toEqual(charge.body);
  });

  it("raises the decline as a StripeCardError in stripe-node", async () => {
    const ctx = createTestApp();
    const { customerId, pmId } = await customerWithCard(ctx, "pm_card_chargeCustomerFail");
    const err = await sdk(ctx.app)
      .paymentIntents.create({
        amount: 500,
        currency: "usd",
        customer: customerId,
        payment_method: pmId,
        confirm: true,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Stripe.errors.StripeCardError);
    const cardErr = err as Stripe.errors.StripeCardError;
    expect(cardErr.statusCode).toBe(402);
    expect(cardErr.code).toBe("card_declined");
    expect(cardErr.payment_intent?.status).toBe("requires_payment_method");
  });

  it("declines with the card's own decline code after authentication (3178)", async () => {
    const ctx = createTestApp();
    const pi = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 900,
      currency: "eur",
      payment_method: "pm_card_authenticationRequiredChargeDeclinedInsufficientFunds",
      confirm: true,
    });
    expect(pi.body.status).toBe("requires_action");
    const done = await api<Json>(ctx.app, "POST", `/_stripe/simulate/payment_intents/${pi.body.id}/authenticate`, {
      result: "succeed",
    });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("requires_payment_method");
    expect(done.body.last_payment_error).toMatchObject({ code: "card_declined", decline_code: "insufficient_funds" });
    const charge = await api<Json>(ctx.app, "GET", `/v1/charges/${done.body.latest_charge}`);
    expect(charge.body.outcome.reason).toBe("insufficient_funds");
    expect(charge.body.payment_method_details.card.three_d_secure).toMatchObject({ result: "authenticated" });
  });

  it("asks for 3D Secure on-session and completes when the customer authenticates", async () => {
    const ctx = createTestApp({ webhook: true });
    const hooks = captureWebhooks();
    const pi = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 3000,
      currency: "eur",
      payment_method: "pm_card_authenticationRequired",
      confirm: true,
    });
    expect(pi.status).toBe(200);
    expect(pi.body.status).toBe("requires_action");
    expect(pi.body.next_action.type).toBe("use_stripe_sdk");
    expect(pi.body.next_action.use_stripe_sdk).toMatchObject({ type: "three_d_secure_redirect" });
    expect(pi.body.latest_charge).toBeNull();
    expect(types(hooks.events)).toEqual(["payment_intent.created", "payment_intent.requires_action"]);
    expect(hooks.ofType("payment_intent.requires_action")[0].data.object).toMatchObject({ status: "requires_action" });

    const done = await api<Json>(ctx.app, "POST", `/_stripe/simulate/payment_intents/${pi.body.id}/authenticate`, {
      result: "succeed",
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "succeeded", next_action: null, amount_received: 3000 });
    expect(done.body.latest_charge).toMatch(/^ch_/);

    const charged = hooks.ofType("charge.succeeded");
    expect(charged).toHaveLength(1);
    expect(charged[0].request).toEqual({ id: null, idempotency_key: null });
    expect((charged[0].data.object as Json).payment_method_details.card.three_d_secure).toMatchObject({
      result: "authenticated",
    });
    expect(hooks.ofType("payment_intent.succeeded")).toHaveLength(1);
  });

  it("fails the payment when the customer fails 3D Secure", async () => {
    const ctx = createTestApp({ webhook: true });
    const pi = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 3000,
      currency: "eur",
      payment_method: "pm_card_authenticationRequired",
      confirm: true,
    });
    const hooks = captureWebhooks();
    const done = await api<Json>(ctx.app, "POST", `/_stripe/simulate/payment_intents/${pi.body.id}/authenticate`, {
      result: "fail",
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "requires_payment_method", payment_method: null, next_action: null });
    expect(done.body.last_payment_error).toMatchObject({
      type: "invalid_request_error",
      code: "payment_intent_authentication_failure",
      payment_method: { object: "payment_method" },
    });
    expect(types(hooks.events)).toEqual(["payment_intent.payment_failed"]);
    const charges = await api<{ data: Json[] }>(ctx.app, "GET", `/v1/charges?payment_intent=${pi.body.id}`);
    expect(charges.body.data).toHaveLength(0);
  });

  it("returns authentication_required for an off-session charge on a 3DS card", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId, pmId } = await customerWithCard(ctx, "pm_card_authenticationRequired");
    const hooks = captureWebhooks();
    const res = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 2500,
      currency: "eur",
      customer: customerId,
      payment_method: pmId,
      confirm: true,
      off_session: true,
    });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({
      type: "card_error",
      code: "authentication_required",
      decline_code: "authentication_required",
      payment_intent: { status: "requires_payment_method" },
    });
    const piId = res.body.error.payment_intent.id as string;
    const pi = await api<Json>(ctx.app, "GET", `/v1/payment_intents/${piId}`);
    expect(pi.body.status).toBe("requires_payment_method");
    expect(pi.body.last_payment_error.code).toBe("authentication_required");
    expect(types(hooks.events)).toEqual(
      expect.arrayContaining(["payment_intent.created", "charge.failed", "payment_intent.payment_failed"]),
    );
  });

  it("charges 3155 off-session without authentication but asks on-session", async () => {
    const ctx = createTestApp();
    const { customerId, pmId } = await customerWithCard(ctx, "pm_card_authenticationRequiredOnSetup");
    const off = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "eur",
      customer: customerId,
      payment_method: pmId,
      confirm: true,
      off_session: true,
    });
    expect(off.body.status).toBe("succeeded");
    const on = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "eur",
      customer: customerId,
      payment_method: pmId,
      confirm: true,
    });
    expect(on.body.status).toBe("requires_action");
  });

  it("returns to requires_confirmation after 3D Secure when confirmation is manual", async () => {
    const ctx = createTestApp();
    const pi = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 700,
      currency: "eur",
      payment_method: "pm_card_authenticationRequired",
      confirmation_method: "manual",
      confirm: true,
    });
    expect(pi.body.status).toBe("requires_action");
    const authed = await api<Json>(ctx.app, "POST", `/_stripe/simulate/payment_intents/${pi.body.id}/authenticate`, {});
    expect(authed.body.status).toBe("requires_confirmation");
    const confirmed = await api<Json>(ctx.app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`, {});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("succeeded");
  });

  it("rejects authenticate for intents that are not waiting on the customer", async () => {
    const ctx = createTestApp();
    const pi = await api<Json>(ctx.app, "POST", "/v1/payment_intents", { amount: 700, currency: "usd" });
    const wrong = await api<Json>(ctx.app, "POST", `/_stripe/simulate/payment_intents/${pi.body.id}/authenticate`, {});
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("payment_intent_unexpected_state");
    const missing = await api<Json>(ctx.app, "POST", "/_stripe/simulate/payment_intents/pi_missing/authenticate", {});
    expect(missing.status).toBe(404);
    const actionable = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 700,
      currency: "usd",
      payment_method: "pm_card_authenticationRequired",
      confirm: true,
    });
    const bad = await api<Json>(
      ctx.app,
      "POST",
      `/_stripe/simulate/payment_intents/${actionable.body.id}/authenticate`,
      { result: "maybe" },
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.param).toBe("result");
  });

  it("saves the card to the customer with setup_future_usage", async () => {
    const ctx = createTestApp({ webhook: true });
    const customer = await api<Json>(ctx.app, "POST", "/v1/customers", { email: "save@example.com" });
    const hooks = captureWebhooks();
    const pi = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 1200,
      currency: "usd",
      customer: customer.body.id,
      payment_method: "pm_card_visa",
      setup_future_usage: "off_session",
      confirm: true,
    });
    expect(pi.body.status).toBe("succeeded");
    expect(pi.body.setup_future_usage).toBe("off_session");
    const pm = await api<Json>(ctx.app, "GET", `/v1/payment_methods/${pi.body.payment_method}`);
    expect(pm.body.customer).toBe(customer.body.id);
    expect(hooks.ofType("payment_method.attached")).toHaveLength(1);

    const reused = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 300,
      currency: "usd",
      customer: customer.body.id,
      payment_method: pi.body.payment_method,
      confirm: true,
      off_session: true,
    });
    expect(reused.body.status).toBe("succeeded");
  });

  it("does not let an unattached card be used twice", async () => {
    const ctx = createTestApp();
    const first = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 300,
      currency: "usd",
      payment_method: "pm_card_visa",
      confirm: true,
    });
    expect(first.body.status).toBe("succeeded");
    const second = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 300,
      currency: "usd",
      payment_method: first.body.payment_method,
    });
    expect(second.status).toBe(400);
    expect(second.body.error.message).toMatch(/may not be used again/);
  });

  it("still confirms an intent without a payment method as if pm_card_visa were used", async () => {
    const ctx = createTestApp();
    const pi = await api<Json>(ctx.app, "POST", "/v1/payment_intents", { amount: 800, currency: "usd" });
    const confirmed = await api<Json>(ctx.app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`, {});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("succeeded");
    expect(confirmed.body.payment_method).toMatch(/^pm_/);
    expect(confirmed.body.latest_charge).toMatch(/^ch_/);
  });

  it("records the cancellation reason and time", async () => {
    const ctx = createTestApp();
    const pi = await api<Json>(ctx.app, "POST", "/v1/payment_intents", { amount: 800, currency: "usd" });
    const canceled = await api<Json>(ctx.app, "POST", `/v1/payment_intents/${pi.body.id}/cancel`, {
      cancellation_reason: "requested_by_customer",
    });
    expect(canceled.body).toMatchObject({ status: "canceled", cancellation_reason: "requested_by_customer" });
    expect(typeof canceled.body.canceled_at).toBe("number");
  });
});
