import { describe, it, expect, afterEach, vi } from "vitest";
import { getStripeStore } from "../store.js";
import { TEST_CARDS, testCardByPaymentMethod, testCardByNumber, rawNumberError } from "../test-cards.js";
import { createTestApp, captureWebhooks, api, base, sdk, API_KEY } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

async function form(app: ReturnType<typeof createTestApp>["app"], path: string, fields: Record<string, string>) {
  const res = await app.request(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

async function newCustomer(app: ReturnType<typeof createTestApp>["app"], body: Record<string, unknown> = {}) {
  const res = await api<Json>(app, "POST", "/v1/customers", { name: "Jane", ...body });
  return res.body;
}

describe("Stripe test cards", () => {
  it("covers the documented magic ids with their brand and last4", () => {
    expect(testCardByPaymentMethod("pm_card_visa")).toMatchObject({ brand: "visa", last4: "4242", funding: "credit" });
    expect(testCardByPaymentMethod("pm_card_visa_debit")).toMatchObject({ funding: "debit", last4: "5556" });
    expect(testCardByPaymentMethod("pm_card_mastercard")).toMatchObject({ brand: "mastercard", last4: "4444" });
    expect(testCardByPaymentMethod("pm_card_amex")).toMatchObject({
      brand: "amex",
      display_brand: "american_express",
      last4: "0005",
    });
    expect(testCardByPaymentMethod("pm_card_chargeCustomerFail")).toMatchObject({
      attach: "succeed",
      charge: "decline",
      last4: "0341",
    });
    expect(testCardByPaymentMethod("pm_card_authenticationRequired")).toMatchObject({
      authentication: "always",
      last4: "3184",
    });
    expect(testCardByPaymentMethod("pm_card_authenticationRequiredOnSetup")).toMatchObject({
      authentication: "on_setup",
      last4: "3155",
    });
    expect(testCardByPaymentMethod("pm_card_authenticationRequiredChargeDeclinedInsufficientFunds")).toMatchObject({
      charge: "decline",
      decline: { decline_code: "insufficient_funds" },
    });
    for (const id of [
      "pm_card_chargeDeclined",
      "pm_card_visa_chargeDeclined",
      "pm_card_visa_chargeDeclinedInsufficientFunds",
      "pm_card_chargeDeclinedExpiredCard",
      "pm_card_chargeDeclinedIncorrectCvc",
      "pm_card_chargeDeclinedProcessingError",
      "pm_card_visa_chargeDeclinedLostCard",
      "pm_card_visa_chargeDeclinedStolenCard",
      "pm_card_visa_chargeDeclinedVelocityLimitExceeded",
    ]) {
      expect(testCardByPaymentMethod(id)?.attach, id).toBe("decline");
    }
  });

  it("gives every card a stable 16 character fingerprint", () => {
    const fingerprints = new Set(TEST_CARDS.map((c) => c.fingerprint));
    expect(fingerprints.size).toBe(TEST_CARDS.length);
    for (const c of TEST_CARDS) expect(c.fingerprint).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(testCardByNumber("4242 4242 4242 4242")?.fingerprint).toBe(
      testCardByPaymentMethod("pm_card_visa")?.fingerprint,
    );
  });

  it("rejects numbers that fail Luhn or are not test cards", () => {
    expect(rawNumberError("4242424242424242")).toBeUndefined();
    expect(rawNumberError("4242424242424241")).toMatchObject({ code: "incorrect_number", param: "number" });
    expect(rawNumberError("4111111111111111")).toMatchObject({
      code: "card_declined",
      decline_code: "test_mode_live_card",
    });
  });
});

describe("Stripe payment methods", () => {
  it("attaching pm_card_visa clones it into a new pm_ owned by the customer", async () => {
    const { app } = createTestApp({ webhook: true });
    const cust = await newCustomer(app);
    const hooks = captureWebhooks();

    const res = await api<Json>(app, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: cust.id });
    expect(res.status).toBe(200);
    const pm = res.body;
    expect(pm.id).toMatch(/^pm_[A-Za-z0-9]{24}$/);
    expect(pm.id).not.toBe("pm_card_visa");
    expect(pm.object).toBe("payment_method");
    expect(pm.type).toBe("card");
    expect(pm.customer).toBe(cust.id);
    expect(pm.allow_redisplay).toBe("unspecified");
    expect(pm.livemode).toBe(false);
    expect(pm.metadata).toEqual({});
    expect(Object.keys(pm)).toEqual([
      "id",
      "object",
      "allow_redisplay",
      "billing_details",
      "card",
      "created",
      "customer",
      "livemode",
      "metadata",
      "type",
    ]);
    expect(pm.billing_details).toEqual({
      address: { city: null, country: null, line1: null, line2: null, postal_code: null, state: null },
      email: null,
      name: null,
      phone: null,
    });
    expect(pm.card).toMatchObject({
      brand: "visa",
      checks: { address_line1_check: null, address_postal_code_check: null, cvc_check: "pass" },
      country: "US",
      display_brand: "visa",
      funding: "credit",
      generated_from: null,
      last4: "4242",
      networks: { available: ["visa"], preferred: null },
      regulated_status: "unregulated",
      three_d_secure_usage: { supported: true },
      wallet: null,
    });
    expect(pm.card.exp_month).toBeGreaterThanOrEqual(1);
    expect(pm.card.exp_year).toBeGreaterThan(new Date().getUTCFullYear());
    expect(pm.card.fingerprint).toMatch(/^[A-Za-z0-9]{16}$/);

    expect(hooks.events.map((e) => e.type)).toEqual(["payment_method.attached"]);
    expect((hooks.events[0].data.object as Json).id).toBe(pm.id);
    expect((hooks.events[0].data.object as Json).customer).toBe(cust.id);

    const list = await api<Json>(app, "GET", `/v1/payment_methods?customer=${cust.id}&type=card`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((p: Json) => p.id)).toEqual([pm.id]);

    const other = await api<Json>(app, "GET", `/v1/payment_methods?customer=${cust.id}&type=us_bank_account`);
    expect(other.body.data).toEqual([]);

    const fetched = await api<Json>(app, "GET", `/v1/payment_methods/${pm.id}`);
    expect(fetched.body).toEqual(pm);
  });

  it("works through stripe-node", async () => {
    const { app } = createTestApp();
    const stripe = sdk(app);
    const customer = await stripe.customers.create({ email: "sdk@example.com" });
    const pm = await stripe.paymentMethods.attach("pm_card_mastercard", { customer: customer.id });
    expect(pm.card?.brand).toBe("mastercard");

    const listed = await stripe.paymentMethods.list({ customer: customer.id, type: "card" });
    expect(listed.data.map((p) => p.id)).toEqual([pm.id]);
    const viaCustomer = await stripe.customers.listPaymentMethods(customer.id);
    expect(viaCustomer.data.map((p) => p.id)).toEqual([pm.id]);

    const updated = await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: pm.id },
      expand: ["invoice_settings.default_payment_method"],
    });
    const expanded = updated.invoice_settings.default_payment_method as { id: string; object: string };
    expect(expanded.id).toBe(pm.id);
    expect(expanded.object).toBe("payment_method");

    const detached = await stripe.paymentMethods.detach(pm.id);
    expect(detached.customer).toBeNull();
  });

  it("refuses to attach an issuer decline card and stores nothing", async () => {
    const { app, store } = createTestApp({ webhook: true });
    const cust = await newCustomer(app);
    const hooks = captureWebhooks();

    const res = await api<Json>(app, "POST", "/v1/payment_methods/pm_card_chargeDeclined/attach", {
      customer: cust.id,
    });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({
      type: "card_error",
      code: "card_declined",
      decline_code: "generic_decline",
      message: "Your card was declined.",
      doc_url: "https://docs.stripe.com/error-codes/card-declined",
    });
    expect(getStripeStore(store).paymentMethods.all()).toHaveLength(0);
    expect(hooks.deliveries).toHaveLength(0);

    const list = await api<Json>(app, "GET", `/v1/payment_methods?customer=${cust.id}&type=card`);
    expect(list.body.data).toEqual([]);
  });

  it("attaches the decline after attaching card 0341", async () => {
    const { app } = createTestApp();
    const cust = await newCustomer(app);
    const res = await api<Json>(app, "POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", {
      customer: cust.id,
    });
    expect(res.status).toBe(200);
    expect(res.body.card.last4).toBe("0341");
    expect(res.body.customer).toBe(cust.id);
  });

  it("rejects attaching to a missing customer", async () => {
    const { app } = createTestApp();
    const missing = await api<Json>(app, "POST", "/v1/payment_methods/pm_card_visa/attach", {});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ type: "invalid_request_error", param: "customer" });

    const unknown = await api<Json>(app, "POST", "/v1/payment_methods/pm_card_visa/attach", {
      customer: "cus_missing",
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({ code: "resource_missing", param: "customer" });

    const noPm = await api<Json>(app, "POST", "/v1/payment_methods/pm_nope/attach", { customer: "cus_missing" });
    expect(noPm.status).toBe(404);
    expect(noPm.body.error).toMatchObject({ code: "resource_missing", message: "No such PaymentMethod: 'pm_nope'" });
  });

  it("detaches permanently", async () => {
    const { app } = createTestApp({ webhook: true });
    const cust = await newCustomer(app);
    const attached = await api<Json>(app, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: cust.id });
    const hooks = captureWebhooks();

    const res = await api<Json>(app, "POST", `/v1/payment_methods/${attached.body.id}/detach`);
    expect(res.status).toBe(200);
    expect(res.body.customer).toBeNull();
    expect(res.body.id).toBe(attached.body.id);

    const detachedEvents = hooks.ofType("payment_method.detached");
    expect(detachedEvents).toHaveLength(1);
    expect((detachedEvents[0].data.object as Json).customer).toBeNull();
    expect(detachedEvents[0].data.previous_attributes).toEqual({ customer: cust.id });

    const again = await api<Json>(app, "POST", `/v1/payment_methods/${attached.body.id}/attach`, {
      customer: cust.id,
    });
    expect(again.status).toBe(400);
    expect(again.body.error.type).toBe("invalid_request_error");

    const twice = await api<Json>(app, "POST", `/v1/payment_methods/${attached.body.id}/detach`);
    expect(twice.status).toBe(400);

    const list = await api<Json>(app, "GET", `/v1/payment_methods?customer=${cust.id}&type=card`);
    expect(list.body.data).toEqual([]);
  });

  it("refuses to attach a payment method that belongs to another customer", async () => {
    const { app } = createTestApp();
    const a = await newCustomer(app);
    const b = await newCustomer(app);
    const pm = await api<Json>(app, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: a.id });
    const res = await api<Json>(app, "POST", `/v1/payment_methods/${pm.body.id}/attach`, { customer: b.id });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("The payment method you provided has already been attached to a customer.");
  });

  it("creates card payment methods from tokens and test numbers", async () => {
    const { app } = createTestApp();
    const fromToken = await form(app, "/v1/payment_methods", { type: "card", "card[token]": "tok_visa" });
    expect(fromToken.status).toBe(200);
    expect(fromToken.body.customer).toBeNull();
    expect(fromToken.body.card).toMatchObject({ brand: "visa", last4: "4242" });
    expect(fromToken.body.card.checks.cvc_check).toBeNull();

    const fromNumber = await form(app, "/v1/payment_methods", {
      type: "card",
      "card[number]": "5555555555554444",
      "card[exp_month]": "4",
      "card[exp_year]": "2031",
      "card[cvc]": "123",
      "billing_details[name]": "Jenny Rosen",
      "billing_details[address][country]": "US",
      "metadata[order]": "42",
    });
    expect(fromNumber.status).toBe(200);
    expect(fromNumber.body.card).toMatchObject({
      brand: "mastercard",
      last4: "4444",
      exp_month: 4,
      exp_year: 2031,
      checks: { cvc_check: "unchecked" },
    });
    expect(fromNumber.body.billing_details.name).toBe("Jenny Rosen");
    expect(fromNumber.body.billing_details.address.country).toBe("US");
    expect(fromNumber.body.billing_details.address.city).toBeNull();
    expect(fromNumber.body.metadata).toEqual({ order: "42" });

    const declined = await form(app, "/v1/payment_methods", {
      type: "card",
      "card[number]": "4000000000000002",
      "card[exp_month]": "4",
      "card[exp_year]": "2031",
    });
    expect(declined.status).toBe(200);
    expect(declined.body.card.last4).toBe("0002");

    const live = await form(app, "/v1/payment_methods", {
      type: "card",
      "card[number]": "4111111111111111",
      "card[exp_month]": "4",
      "card[exp_year]": "2031",
    });
    expect(live.status).toBe(402);
    expect(live.body.error).toMatchObject({ type: "card_error", decline_code: "test_mode_live_card" });

    const badNumber = await form(app, "/v1/payment_methods", {
      type: "card",
      "card[number]": "4242424242424241",
      "card[exp_month]": "4",
      "card[exp_year]": "2031",
    });
    expect(badNumber.status).toBe(402);
    expect(badNumber.body.error).toMatchObject({ type: "card_error", code: "incorrect_number", param: "number" });

    const badToken = await form(app, "/v1/payment_methods", { type: "card", "card[token]": "tok_nope" });
    expect(badToken.status).toBe(400);
    expect(badToken.body.error).toMatchObject({ code: "resource_missing", message: "No such token: 'tok_nope'" });

    const noType = await form(app, "/v1/payment_methods", { "card[token]": "tok_visa" });
    expect(noType.status).toBe(400);
    expect(noType.body.error.param).toBe("type");
  });

  it("a created decline card refuses to attach and stays unattached", async () => {
    const { app } = createTestApp();
    const cust = await newCustomer(app);
    const created = await form(app, "/v1/payment_methods", { type: "card", "card[token]": "tok_chargeDeclined" });
    const res = await api<Json>(app, "POST", `/v1/payment_methods/${created.body.id}/attach`, { customer: cust.id });
    expect(res.status).toBe(402);
    expect(res.body.error.decline_code).toBe("generic_decline");
    const after = await api<Json>(app, "GET", `/v1/payment_methods/${created.body.id}`);
    expect(after.body.customer).toBeNull();
  });

  it("updates metadata and billing details of an attached card", async () => {
    const { app } = createTestApp({ webhook: true });
    const cust = await newCustomer(app);
    const pm = await api<Json>(app, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: cust.id });
    const hooks = captureWebhooks();

    const res = await api<Json>(app, "POST", `/v1/payment_methods/${pm.body.id}`, {
      metadata: { plan: "pro" },
      billing_details: { email: "jenny@example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.body.metadata).toEqual({ plan: "pro" });
    expect(res.body.billing_details.email).toBe("jenny@example.com");

    const updated = hooks.ofType("payment_method.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0].data.previous_attributes).toEqual({
      billing_details: { email: null },
      metadata: { plan: null },
    });
  });

  it("refuses to update a payment method that is not attached", async () => {
    const { app } = createTestApp();
    const created = await form(app, "/v1/payment_methods", { type: "card", "card[token]": "tok_visa" });
    const res = await api<Json>(app, "POST", `/v1/payment_methods/${created.body.id}`, { metadata: { a: "b" } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("You must save this PaymentMethod to a customer before you can update it.");
  });

  it("returns 404 for an unknown payment method", async () => {
    const { app } = createTestApp();
    const res = await api<Json>(app, "GET", "/v1/payment_methods/pm_missing");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "resource_missing", message: "No such PaymentMethod: 'pm_missing'" });
  });
});

describe("Stripe customers and payment methods", () => {
  it("renders the always-present customer fields", async () => {
    const { app } = createTestApp();
    const cust = await newCustomer(app);
    expect(cust).toMatchObject({
      address: null,
      balance: 0,
      currency: null,
      default_source: null,
      delinquent: false,
      invoice_settings: { custom_fields: null, default_payment_method: null, footer: null, rendering_options: null },
      next_invoice_sequence: 1,
      phone: null,
      preferred_locales: [],
      shipping: null,
      tax_exempt: "none",
      test_clock: null,
    });
    expect(cust.invoice_prefix).toMatch(/^[A-Z0-9]{8}$/);
    expect(Object.keys(cust)).toEqual([
      "id",
      "object",
      "address",
      "balance",
      "created",
      "currency",
      "default_source",
      "delinquent",
      "description",
      "email",
      "invoice_prefix",
      "invoice_settings",
      "livemode",
      "metadata",
      "name",
      "next_invoice_sequence",
      "phone",
      "preferred_locales",
      "shipping",
      "tax_exempt",
      "test_clock",
    ]);

    const fetched = await api<Json>(app, "GET", `/v1/customers/${cust.id}`);
    expect(fetched.body.invoice_prefix).toBe(cust.invoice_prefix);
  });

  it("gives seeded customers a stable invoice prefix", async () => {
    const { app } = createTestApp({ seed: { customers: [{ id: "cus_seeded", email: "s@example.com" }] } });
    const first = await api<Json>(app, "GET", "/v1/customers/cus_seeded");
    const second = await api<Json>(app, "GET", "/v1/customers/cus_seeded");
    expect(first.body.invoice_prefix).toMatch(/^[A-Z0-9]{8}$/);
    expect(second.body.invoice_prefix).toBe(first.body.invoice_prefix);
  });

  it("creates a customer with a default payment method in one call", async () => {
    const { app } = createTestApp({ webhook: true });
    const hooks = captureWebhooks();
    const res = await form(app, "/v1/customers", {
      email: "one@example.com",
      payment_method: "pm_card_visa",
      "invoice_settings[default_payment_method]": "pm_card_visa",
    });
    expect(res.status).toBe(200);
    const pmId = res.body.invoice_settings.default_payment_method;
    expect(pmId).toMatch(/^pm_[A-Za-z0-9]{24}$/);

    const pm = await api<Json>(app, "GET", `/v1/payment_methods/${pmId}`);
    expect(pm.body.customer).toBe(res.body.id);

    const types = hooks.events.map((e) => e.type);
    expect(types).toContain("customer.created");
    expect(types).toContain("payment_method.attached");
    expect(types.indexOf("customer.created")).toBeLessThan(types.indexOf("payment_method.attached"));
  });

  it("refuses a decline card at customer creation and stores no customer", async () => {
    const { app, store } = createTestApp();
    const before = getStripeStore(store).customers.all().length;
    const res = await api<Json>(app, "POST", "/v1/customers", { payment_method: "pm_card_chargeDeclined" });
    expect(res.status).toBe(402);
    expect(res.body.error.decline_code).toBe("generic_decline");
    expect(getStripeStore(store).customers.all()).toHaveLength(before);
  });

  it("emits customer.updated when the default payment method changes", async () => {
    const { app } = createTestApp({ webhook: true });
    const cust = await newCustomer(app);
    const pm = await api<Json>(app, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: cust.id });
    const hooks = captureWebhooks();

    const res = await api<Json>(app, "POST", `/v1/customers/${cust.id}`, {
      invoice_settings: { default_payment_method: pm.body.id },
    });
    expect(res.status).toBe(200);
    expect(res.body.invoice_settings.default_payment_method).toBe(pm.body.id);

    const updated = hooks.ofType("customer.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0].data.previous_attributes).toEqual({ invoice_settings: { default_payment_method: null } });
  });

  it("rejects a default payment method that is not attached to the customer", async () => {
    const { app } = createTestApp();
    const a = await newCustomer(app);
    const b = await newCustomer(app);
    const pm = await api<Json>(app, "POST", "/v1/payment_methods/pm_card_visa/attach", { customer: a.id });

    for (const id of [pm.body.id, "pm_missing"]) {
      const res = await api<Json>(app, "POST", `/v1/customers/${b.id}`, {
        invoice_settings: { default_payment_method: id },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        type: "invalid_request_error",
        param: "invoice_settings[default_payment_method]",
      });
    }

    const atCreate = await api<Json>(app, "POST", "/v1/customers", {
      invoice_settings: { default_payment_method: pm.body.id },
    });
    expect(atCreate.status).toBe(400);
    expect(atCreate.body.error.param).toBe("invoice_settings[default_payment_method]");
  });

  it("clears the default when it is unset or detached", async () => {
    const { app } = createTestApp({ webhook: true });
    const cust = await newCustomer(app, { payment_method: "pm_card_visa" });
    const pm = (await api<Json>(app, "GET", `/v1/payment_methods?customer=${cust.id}&type=card`)).body.data[0];
    await api<Json>(app, "POST", `/v1/customers/${cust.id}`, { invoice_settings: { default_payment_method: pm.id } });

    const cleared = await api<Json>(app, "POST", `/v1/customers/${cust.id}`, {
      invoice_settings: { default_payment_method: "" },
    });
    expect(cleared.body.invoice_settings.default_payment_method).toBeNull();

    await api<Json>(app, "POST", `/v1/customers/${cust.id}`, { invoice_settings: { default_payment_method: pm.id } });
    const hooks = captureWebhooks();
    await api<Json>(app, "POST", `/v1/payment_methods/${pm.id}/detach`);
    const after = await api<Json>(app, "GET", `/v1/customers/${cust.id}`);
    expect(after.body.invoice_settings.default_payment_method).toBeNull();
    expect(hooks.ofType("customer.updated")[0]?.data.previous_attributes).toEqual({
      invoice_settings: { default_payment_method: pm.id },
    });
  });

  it("detaches a deleted customer's payment methods", async () => {
    const { app } = createTestApp();
    const cust = await newCustomer(app, { payment_method: "pm_card_visa" });
    const pm = (await api<Json>(app, "GET", `/v1/payment_methods?customer=${cust.id}&type=card`)).body.data[0];
    await api(app, "DELETE", `/v1/customers/${cust.id}`);
    const after = await api<Json>(app, "GET", `/v1/payment_methods/${pm.id}`);
    expect(after.body.customer).toBeNull();
  });
});
