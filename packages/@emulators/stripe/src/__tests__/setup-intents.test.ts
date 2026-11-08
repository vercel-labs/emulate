import { describe, it, expect, afterEach, vi } from "vitest";
import Stripe from "stripe";
import { createTestApp, captureWebhooks, sdk, api, type TestApp } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

async function newCustomer(ctx: TestApp): Promise<string> {
  const customer = await api<Json>(ctx.app, "POST", "/v1/customers", { email: "saver@example.com" });
  return customer.body.id as string;
}

async function customerCards(ctx: TestApp, customerId: string): Promise<Json[]> {
  const listed = await api<{ data: Json[] }>(ctx.app, "GET", `/v1/customers/${customerId}/payment_methods`);
  return listed.body.data;
}

function typesOf(events: Stripe.Event[]): string[] {
  return events.map((e) => e.type);
}

describe("SetupIntent object", () => {
  it("renders every field Stripe returns, in reference order", async () => {
    const ctx = createTestApp({ webhook: true });
    const hooks = captureWebhooks();
    const si = await api<Json>(ctx.app, "POST", "/v1/setup_intents", {});
    expect(si.status).toBe(200);
    expect(Object.keys(si.body)).toEqual([
      "id",
      "object",
      "application",
      "automatic_payment_methods",
      "cancellation_reason",
      "client_secret",
      "created",
      "customer",
      "description",
      "excluded_payment_method_types",
      "flow_directions",
      "last_setup_error",
      "latest_attempt",
      "livemode",
      "mandate",
      "metadata",
      "next_action",
      "on_behalf_of",
      "payment_method",
      "payment_method_configuration_details",
      "payment_method_options",
      "payment_method_types",
      "single_use_mandate",
      "status",
      "usage",
    ]);
    expect(si.body).toMatchObject({
      object: "setup_intent",
      cancellation_reason: null,
      customer: null,
      flow_directions: null,
      last_setup_error: null,
      latest_attempt: null,
      livemode: false,
      mandate: null,
      metadata: {},
      next_action: null,
      payment_method: null,
      payment_method_options: {
        card: { mandate_options: null, network: null, request_three_d_secure: "automatic" },
      },
      payment_method_types: ["card"],
      single_use_mandate: null,
      status: "requires_payment_method",
      usage: "off_session",
    });
    expect(si.body.id).toMatch(/^seti_[A-Za-z0-9]+$/);
    expect(si.body.client_secret).toMatch(new RegExp(`^${si.body.id}_secret_[A-Za-z0-9]+$`));
    expect(typesOf(hooks.events)).toEqual(["setup_intent.created"]);
  });

  it("validates customer and usage", async () => {
    const { app } = createTestApp();
    const missing = await api<Json>(app, "POST", "/v1/setup_intents", { customer: "cus_nope" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ code: "resource_missing", param: "customer" });

    const badUsage = await api<Json>(app, "POST", "/v1/setup_intents", { usage: "sometimes" });
    expect(badUsage.status).toBe(400);
    expect(badUsage.body.error.param).toBe("usage");

    const onSession = await api<Json>(app, "POST", "/v1/setup_intents", { usage: "on_session" });
    expect(onSession.body.usage).toBe("on_session");
  });

  it("returns 404 for an unknown SetupIntent", async () => {
    const { app } = createTestApp();
    const res = await api<Json>(app, "GET", "/v1/setup_intents/seti_nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ type: "invalid_request_error", code: "resource_missing" });
  });
});

describe("Confirming a SetupIntent", () => {
  it("saves pm_card_visa to the customer in one create call through stripe-node", async () => {
    const ctx = createTestApp({ webhook: true });
    const stripe = sdk(ctx.app);
    const customer = await stripe.customers.create({ email: "sdk-setup@example.com" });
    const hooks = captureWebhooks();

    const si = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method: "pm_card_visa",
      confirm: true,
    });
    expect(si.status).toBe("succeeded");
    expect(si.payment_method).toMatch(/^pm_[A-Za-z0-9]+$/);
    expect(si.payment_method).not.toBe("pm_card_visa");

    const cards = await stripe.customers.listPaymentMethods(customer.id);
    expect(cards.data.map((pm) => pm.id)).toEqual([si.payment_method]);

    const seen = typesOf(hooks.events);
    expect(seen).toEqual(
      expect.arrayContaining(["setup_intent.created", "payment_method.attached", "setup_intent.succeeded"]),
    );
    expect(seen.indexOf("setup_intent.created")).toBeLessThan(seen.indexOf("payment_method.attached"));
    expect(seen.indexOf("payment_method.attached")).toBeLessThan(seen.indexOf("setup_intent.succeeded"));
    const attached = hooks.ofType("payment_method.attached")[0].data.object as Stripe.PaymentMethod;
    expect(attached).toMatchObject({ id: si.payment_method, customer: customer.id });
    const succeeded = hooks.ofType("setup_intent.succeeded")[0].data.object as Stripe.SetupIntent;
    expect(succeeded).toMatchObject({ id: si.id, status: "succeeded", payment_method: si.payment_method });

    const retrieved = await stripe.setupIntents.retrieve(si.id, { expand: ["payment_method"] });
    expect((retrieved.payment_method as Stripe.PaymentMethod).customer).toBe(customer.id);
  });

  it("confirms in two steps and accepts the payment method on update or confirm", async () => {
    const ctx = createTestApp();
    const customerId = await newCustomer(ctx);
    const created = await api<Json>(ctx.app, "POST", "/v1/setup_intents", { customer: customerId });
    expect(created.body.status).toBe("requires_payment_method");

    const noCard = await api<Json>(ctx.app, "POST", `/v1/setup_intents/${created.body.id}/confirm`, {});
    expect(noCard.status).toBe(400);
    expect(noCard.body.error.code).toBe("setup_intent_unexpected_state");

    const updated = await api<Json>(ctx.app, "POST", `/v1/setup_intents/${created.body.id}`, {
      payment_method: "pm_card_mastercard",
      metadata: { plan: "pro" },
    });
    expect(updated.body).toMatchObject({ status: "requires_confirmation", metadata: { plan: "pro" } });

    const confirmed = await api<Json>(ctx.app, "POST", `/v1/setup_intents/${created.body.id}/confirm`, {});
    expect(confirmed.body.status).toBe("succeeded");
    expect(confirmed.body.payment_method).toBe(updated.body.payment_method);
    expect((await customerCards(ctx, customerId)).map((pm) => pm.id)).toEqual([updated.body.payment_method]);

    const again = await api<Json>(ctx.app, "POST", `/v1/setup_intents/${created.body.id}/confirm`, {});
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("setup_intent_unexpected_state");

    const second = await api<Json>(ctx.app, "POST", "/v1/setup_intents", { customer: customerId });
    const direct = await api<Json>(ctx.app, "POST", `/v1/setup_intents/${second.body.id}/confirm`, {
      payment_method: "pm_card_amex",
    });
    expect(direct.body.status).toBe("succeeded");
    expect(await customerCards(ctx, customerId)).toHaveLength(2);
  });

  it("does not send payment_method.attached for a card the customer already has", async () => {
    const ctx = createTestApp({ webhook: true });
    const customerId = await newCustomer(ctx);
    const pm = await api<Json>(ctx.app, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: customerId });
    const hooks = captureWebhooks();
    const si = await api<Json>(ctx.app, "POST", "/v1/setup_intents", {
      customer: customerId,
      payment_method: pm.body.id,
      confirm: true,
    });
    expect(si.body).toMatchObject({ status: "succeeded", payment_method: pm.body.id });
    expect(typesOf(hooks.events)).toEqual(["setup_intent.created", "setup_intent.succeeded"]);
  });

  it("leaves the card unattached without a customer, so it can be attached later", async () => {
    const ctx = createTestApp();
    const si = await api<Json>(ctx.app, "POST", "/v1/setup_intents", { payment_method: "pm_card_visa", confirm: true });
    expect(si.body).toMatchObject({ status: "succeeded", customer: null });
    const pm = await api<Json>(ctx.app, "GET", `/v1/payment_methods/${si.body.payment_method}`);
    expect(pm.body.customer).toBeNull();

    const customerId = await newCustomer(ctx);
    const attached = await api<Json>(ctx.app, "POST", `/v1/payment_methods/${si.body.payment_method}/attach`, {
      customer: customerId,
    });
    expect(attached.status).toBe(200);
    expect(attached.body.customer).toBe(customerId);
  });

  it("sets up 0341 successfully, since only its charges are declined", async () => {
    const ctx = createTestApp();
    const customerId = await newCustomer(ctx);
    const si = await api<Json>(ctx.app, "POST", "/v1/setup_intents", {
      customer: customerId,
      payment_method: "pm_card_chargeCustomerFail",
      confirm: true,
    });
    expect(si.status).toBe(200);
    expect(si.body.status).toBe("succeeded");
    const cards = await customerCards(ctx, customerId);
    expect(cards.map((pm) => pm.card.last4)).toEqual(["0341"]);
  });
});

describe("SetupIntent declines", () => {
  it("returns a 402 card_error for an issuer decline and sends setup_intent.setup_failed", async () => {
    const ctx = createTestApp({ webhook: true });
    const customerId = await newCustomer(ctx);
    const hooks = captureWebhooks();
    const res = await api<Json>(ctx.app, "POST", "/v1/setup_intents", {
      customer: customerId,
      payment_method: "pm_card_chargeDeclined",
      confirm: true,
    });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({
      type: "card_error",
      code: "card_declined",
      decline_code: "generic_decline",
      doc_url: "https://docs.stripe.com/error-codes/card-declined",
      message: "Your card was declined.",
      payment_method: { object: "payment_method", customer: null },
      setup_intent: { object: "setup_intent", status: "requires_payment_method", payment_method: null },
    });
    expect(res.body.error.charge).toBeUndefined();

    const siId = res.body.error.setup_intent.id as string;
    const si = await api<Json>(ctx.app, "GET", `/v1/setup_intents/${siId}`);
    expect(si.body.status).toBe("requires_payment_method");
    expect(si.body.last_setup_error).toMatchObject({
      type: "card_error",
      code: "card_declined",
      decline_code: "generic_decline",
      payment_method: { card: { last4: "0002" } },
    });
    expect(await customerCards(ctx, customerId)).toHaveLength(0);
    expect(typesOf(hooks.events)).toEqual(
      expect.arrayContaining(["setup_intent.created", "setup_intent.setup_failed"]),
    );
    expect(typesOf(hooks.events)).not.toContain("payment_method.attached");
    const failed = hooks.ofType("setup_intent.setup_failed")[0].data.object as Stripe.SetupIntent;
    expect(failed.last_setup_error?.code).toBe("card_declined");
  });

  it("raises the decline as a StripeCardError in stripe-node", async () => {
    const { app } = createTestApp();
    const stripe = sdk(app);
    const customer = await stripe.customers.create({ email: "declined@example.com" });
    const error = await stripe.setupIntents
      .create({ customer: customer.id, payment_method: "pm_card_chargeDeclinedInsufficientFunds", confirm: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Stripe.errors.StripeCardError);
    expect((error as Stripe.errors.StripeCardError).decline_code).toBe("insufficient_funds");
  });

  it("clears the last error once a working card is confirmed", async () => {
    const ctx = createTestApp();
    const customerId = await newCustomer(ctx);
    const res = await api<Json>(ctx.app, "POST", "/v1/setup_intents", {
      customer: customerId,
      payment_method: "pm_card_chargeDeclined",
      confirm: true,
    });
    const siId = res.body.error.setup_intent.id as string;
    const retry = await api<Json>(ctx.app, "POST", `/v1/setup_intents/${siId}/confirm`, {
      payment_method: "pm_card_visa",
    });
    expect(retry.body).toMatchObject({ status: "succeeded", last_setup_error: null });
  });
});

describe("SetupIntent 3D Secure", () => {
  it("asks 3155 for authentication, then saves it for off-session payments", async () => {
    const ctx = createTestApp({ webhook: true });
    const customerId = await newCustomer(ctx);
    const hooks = captureWebhooks();
    const si = await api<Json>(ctx.app, "POST", "/v1/setup_intents", {
      customer: customerId,
      payment_method: "pm_card_authenticationRequiredOnSetup",
      confirm: true,
    });
    expect(si.status).toBe(200);
    expect(si.body.status).toBe("requires_action");
    expect(si.body.next_action).toMatchObject({
      type: "use_stripe_sdk",
      use_stripe_sdk: {
        type: "three_d_secure_redirect",
        stripe_js: `http://localhost:14000/_stripe/simulate/setup_intents/${si.body.id}/authenticate`,
      },
    });
    expect(si.body.payment_method).toMatch(/^pm_/);
    expect(await customerCards(ctx, customerId)).toHaveLength(0);
    expect(typesOf(hooks.events)).toEqual(["setup_intent.created", "setup_intent.requires_action"]);

    const done = await api<Json>(ctx.app, "POST", `/_stripe/simulate/setup_intents/${si.body.id}/authenticate`, {
      result: "succeed",
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "succeeded", next_action: null, payment_method: si.body.payment_method });
    expect((await customerCards(ctx, customerId)).map((pm) => pm.id)).toEqual([si.body.payment_method]);
    const seen = typesOf(hooks.events);
    expect(seen.indexOf("payment_method.attached")).toBeLessThan(seen.indexOf("setup_intent.succeeded"));
    const succeeded = hooks.ofType("setup_intent.succeeded")[0];
    expect(succeeded.request).toEqual({ id: null, idempotency_key: null });

    const pi = await api<Json>(ctx.app, "POST", "/v1/payment_intents", {
      amount: 1500,
      currency: "eur",
      customer: customerId,
      payment_method: si.body.payment_method,
      confirm: true,
      off_session: true,
    });
    expect(pi.status).toBe(200);
    expect(pi.body.status).toBe("succeeded");
  });

  it("asks 3184 for authentication as well", async () => {
    const ctx = createTestApp();
    const customerId = await newCustomer(ctx);
    const si = await api<Json>(ctx.app, "POST", "/v1/setup_intents", {
      customer: customerId,
      payment_method: "pm_card_authenticationRequired",
      confirm: true,
    });
    expect(si.body.status).toBe("requires_action");
  });

  it("fails the setup when the customer fails authentication", async () => {
    const ctx = createTestApp({ webhook: true });
    const customerId = await newCustomer(ctx);
    const si = await api<Json>(ctx.app, "POST", "/v1/setup_intents", {
      customer: customerId,
      payment_method: "pm_card_authenticationRequiredOnSetup",
      confirm: true,
    });
    const hooks = captureWebhooks();
    const failed = await api<Json>(ctx.app, "POST", `/_stripe/simulate/setup_intents/${si.body.id}/authenticate`, {
      result: "fail",
    });
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({
      status: "requires_payment_method",
      payment_method: null,
      next_action: null,
      last_setup_error: {
        type: "invalid_request_error",
        code: "setup_intent_authentication_failure",
        doc_url: "https://docs.stripe.com/error-codes/setup-intent-authentication-failure",
        payment_method: { id: si.body.payment_method },
      },
    });
    expect(typesOf(hooks.events)).toEqual(["setup_intent.setup_failed"]);
    expect(await customerCards(ctx, customerId)).toHaveLength(0);
  });

  it("rejects authenticate for intents that are not waiting on the customer", async () => {
    const ctx = createTestApp();
    const si = await api<Json>(ctx.app, "POST", "/v1/setup_intents", {});
    const res = await api<Json>(ctx.app, "POST", `/_stripe/simulate/setup_intents/${si.body.id}/authenticate`, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("setup_intent_unexpected_state");

    const missing = await api<Json>(ctx.app, "POST", "/_stripe/simulate/setup_intents/seti_nope/authenticate", {});
    expect(missing.status).toBe(404);

    const bad = await api<Json>(ctx.app, "POST", `/_stripe/simulate/setup_intents/${si.body.id}/authenticate`, {
      result: "maybe",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.param).toBe("result");
  });
});

describe("Canceling and listing SetupIntents", () => {
  it("cancels with a reason and refuses to cancel a succeeded intent", async () => {
    const ctx = createTestApp({ webhook: true });
    const hooks = captureWebhooks();
    const si = await api<Json>(ctx.app, "POST", "/v1/setup_intents", { payment_method: "pm_card_visa" });
    const canceled = await api<Json>(ctx.app, "POST", `/v1/setup_intents/${si.body.id}/cancel`, {
      cancellation_reason: "abandoned",
    });
    expect(canceled.body).toMatchObject({ status: "canceled", cancellation_reason: "abandoned" });
    expect(typesOf(hooks.events)).toEqual(["setup_intent.created", "setup_intent.canceled"]);

    const badReason = await api<Json>(ctx.app, "POST", "/v1/setup_intents", {});
    const rejected = await api<Json>(ctx.app, "POST", `/v1/setup_intents/${badReason.body.id}/cancel`, {
      cancellation_reason: "bored",
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.param).toBe("cancellation_reason");

    const done = await api<Json>(ctx.app, "POST", "/v1/setup_intents", {
      payment_method: "pm_card_visa",
      confirm: true,
    });
    const refused = await api<Json>(ctx.app, "POST", `/v1/setup_intents/${done.body.id}/cancel`, {});
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("setup_intent_unexpected_state");

    const confirmCanceled = await api<Json>(ctx.app, "POST", `/v1/setup_intents/${si.body.id}/confirm`, {});
    expect(confirmCanceled.status).toBe(400);
    expect(confirmCanceled.body.error.code).toBe("setup_intent_unexpected_state");
  });

  it("lists SetupIntents newest first, filtered by customer and payment method", async () => {
    const ctx = createTestApp();
    const stripe = sdk(ctx.app);
    const customerId = await newCustomer(ctx);
    const first = await stripe.setupIntents.create({ customer: customerId });
    const second = await stripe.setupIntents.create({ customer: customerId, payment_method: "pm_card_visa" });
    await stripe.setupIntents.create({});

    const forCustomer = await stripe.setupIntents.list({ customer: customerId });
    expect(forCustomer.data.map((si) => si.id)).toEqual([second.id, first.id]);

    const forCard = await stripe.setupIntents.list({ payment_method: second.payment_method as string });
    expect(forCard.data.map((si) => si.id)).toEqual([second.id]);

    const all = await stripe.setupIntents.list({ limit: 2 });
    expect(all.data).toHaveLength(2);
    expect(all.has_more).toBe(true);
  });
});
