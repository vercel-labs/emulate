import { describe, it, expect, afterEach, vi } from "vitest";
import Stripe from "stripe";
import { createTestApp, captureWebhooks, api, base, sdk, type TestApp } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

const DAY = 86400;
const SUCCESS_URL = "https://shop.example/success?session_id={CHECKOUT_SESSION_ID}";

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

/** The non-includable keys of the Checkout Session object, in the order of the API reference. */
const CHECKOUT_SESSION_KEYS = [
  "id",
  "object",
  "adaptive_pricing",
  "after_expiration",
  "allow_promotion_codes",
  "allowed_payment_method_types",
  "amount_subtotal",
  "amount_total",
  "automatic_tax",
  "billing_address_collection",
  "branding_settings",
  "cancel_url",
  "client_reference_id",
  "client_secret",
  "collected_information",
  "consent",
  "consent_collection",
  "created",
  "currency",
  "currency_conversion",
  "custom_fields",
  "custom_text",
  "customer",
  "customer_account",
  "customer_creation",
  "customer_details",
  "customer_email",
  "discounts",
  "excluded_payment_method_types",
  "expires_at",
  "integration_identifier",
  "invoice",
  "invoice_creation",
  "livemode",
  "locale",
  "managed_payments",
  "marketing_attributions",
  "metadata",
  "mode",
  "name_collection",
  "origin_context",
  "payment_intent",
  "payment_link",
  "payment_method_collection",
  "payment_method_configuration_details",
  "payment_method_options",
  "payment_method_types",
  "payment_status",
  "permissions",
  "phone_number_collection",
  "presentment_details",
  "recovered_from",
  "redirect_on_completion",
  "return_url",
  "saved_payment_method_options",
  "setup_intent",
  "shipping_address_collection",
  "shipping_cost",
  "shipping_options",
  "status",
  "submit_type",
  "subscription",
  "success_url",
  "tax_id_collection",
  "total_details",
  "ui_mode",
  "url",
  "wallet_options",
];

async function price(
  ctx: TestApp,
  options: { unitAmount?: number; recurring?: boolean; interval?: string; intervalCount?: number } = {},
) {
  const product = await api<Json>(ctx.app, "POST", "/v1/products", { name: "Pro Plan" });
  const created = await api<Json>(ctx.app, "POST", "/v1/prices", {
    product: product.body.id,
    currency: "usd",
    unit_amount: options.unitAmount ?? 2000,
    ...(options.recurring !== false && {
      recurring: { interval: options.interval ?? "month", interval_count: options.intervalCount ?? 1 },
    }),
  });
  expect(created.status).toBe(200);
  return created.body.id as string;
}

async function session(ctx: TestApp, params: Json) {
  return api<Json>(ctx.app, "POST", "/v1/checkout/sessions", {
    success_url: SUCCESS_URL,
    cancel_url: "https://shop.example/cart",
    ...params,
  });
}

async function subscriptionSession(ctx: TestApp, params: Json = {}) {
  const priceId = await price(ctx);
  const created = await session(ctx, {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    ...params,
  });
  expect(created.status).toBe(200);
  return { priceId, session: created.body };
}

/** Submit the hosted checkout page with a test card, or with "none" for no card. */
async function complete(ctx: TestApp, id: string, paymentMethod?: string, email = "buyer@example.com") {
  const form = new URLSearchParams({ email });
  if (paymentMethod) form.set("payment_method", paymentMethod);
  return ctx.app.request(`${base}/checkout/${id}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

async function retrieve(ctx: TestApp, id: string, query = "") {
  return (await api<Json>(ctx.app, "GET", `/v1/checkout/sessions/${id}${query}`)).body;
}

describe("Creating a subscription-mode Checkout Session", () => {
  it("requires line_items", async () => {
    const ctx = createTestApp();
    const res = await session(ctx, { mode: "subscription" });
    expect(res.status).toBe(400);
    expect(res.body.error.param).toBe("line_items");
  });

  it("requires at least one recurring price", async () => {
    const ctx = createTestApp();
    const oneTime = await price(ctx, { recurring: false });
    const res = await session(ctx, { mode: "subscription", line_items: [{ price: oneTime, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.param).toBe("line_items");
    expect(res.body.error.message).toContain("recurring price");
  });

  it("rejects a recurring price in payment mode", async () => {
    const ctx = createTestApp();
    const recurring = await price(ctx);
    const res = await session(ctx, { mode: "payment", line_items: [{ price: recurring, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.param).toBe("line_items");
  });

  it("returns a cs_test_ session that expires after 24 hours, with amounts and Stripe's defaults", async () => {
    const ctx = createTestApp();
    const { session: s } = await subscriptionSession(ctx, { payment_method_types: ["card", "link"] });
    expect(s.id).toMatch(/^cs_test_/);
    expect(s.object).toBe("checkout.session");
    expect(s.expires_at).toBe(s.created + DAY);
    expect(s.mode).toBe("subscription");
    expect(s.status).toBe("open");
    expect(s.payment_status).toBe("unpaid");
    expect(s.amount_subtotal).toBe(2000);
    expect(s.amount_total).toBe(2000);
    expect(s.currency).toBe("usd");
    expect(s.payment_method_types).toEqual(["card"]);
    expect(s.payment_method_collection).toBe("always");
    expect(s.customer_creation).toBe("always");
    expect(s.ui_mode).toBe("hosted_page");
    expect(s.customer).toBeNull();
    expect(s.customer_details).toBeNull();
    expect(s.customer_email).toBeNull();
    expect(s.client_reference_id).toBeNull();
    expect(s.invoice).toBeNull();
    expect(s.subscription).toBeNull();
    expect(s.payment_intent).toBeNull();
    expect(s.setup_intent).toBeNull();
    expect(s.invoice_creation).toBeNull();
    expect(s.total_details).toEqual({ amount_discount: 0, amount_shipping: 0, amount_tax: 0 });
    expect(s.automatic_tax).toEqual({
      address_collection_precision: null,
      enabled: false,
      liability: null,
      provider: null,
      status: null,
    });
    expect(s.url).toBe(`${base}/checkout/${s.id}`);
    expect(s).not.toHaveProperty("line_items");
    expect(s).not.toHaveProperty("optional_items");
    expect(s).not.toHaveProperty("shipping_details");
    expect(Object.keys(s)).toEqual(CHECKOUT_SESSION_KEYS);
    expect(s).toMatchObject({
      allowed_payment_method_types: null,
      branding_settings: null,
      currency_conversion: null,
      excluded_payment_method_types: null,
      integration_identifier: null,
      managed_payments: null,
      marketing_attributions: null,
      name_collection: null,
      origin_context: null,
      permissions: null,
      redirect_on_completion: null,
      tax_id_collection: { enabled: false, required: "never" },
    });

    const expanded = await api<Json>(ctx.app, "GET", `/v1/checkout/sessions/${s.id}?expand[]=optional_items`);
    expect(expanded.body.optional_items).toBeNull();
  });

  it("charges nothing today during a trial", async () => {
    const ctx = createTestApp();
    const { session: s } = await subscriptionSession(ctx, { subscription_data: { trial_period_days: 7 } });
    expect(s.amount_subtotal).toBe(0);
    expect(s.amount_total).toBe(0);
  });

  it("stores client_reference_id and customer_email", async () => {
    const ctx = createTestApp();
    const { session: s } = await subscriptionSession(ctx, {
      client_reference_id: "user_42",
      customer_email: "prefill@example.com",
    });
    expect(s.client_reference_id).toBe("user_42");
    expect(s.customer_email).toBe("prefill@example.com");
  });

  it("validates the subscription params", async () => {
    const ctx = createTestApp();
    const priceId = await price(ctx);
    const customer = await api<Json>(ctx.app, "POST", "/v1/customers", { email: "a@example.com" });
    const items = [{ price: priceId, quantity: 1 }];

    const both = await session(ctx, {
      mode: "subscription",
      line_items: items,
      customer: customer.body.id,
      customer_email: "b@example.com",
    });
    expect(both.status).toBe(400);
    expect(both.body.error.message).toBe("You may only specify one of these parameters: customer, customer_email.");

    const creation = await session(ctx, { mode: "subscription", line_items: items, customer_creation: "always" });
    expect(creation.status).toBe(400);
    expect(creation.body.error.param).toBe("customer_creation");

    const collection = await session(ctx, {
      mode: "payment",
      line_items: [{ price: await price(ctx, { recurring: false }), quantity: 1 }],
      payment_method_collection: "if_required",
    });
    expect(collection.status).toBe(400);
    expect(collection.body.error.param).toBe("payment_method_collection");

    const zeroDays = await session(ctx, {
      mode: "subscription",
      line_items: items,
      subscription_data: { trial_period_days: 0 },
    });
    expect(zeroDays.status).toBe(400);
    expect(zeroDays.body.error.param).toBe("subscription_data[trial_period_days]");

    const soon = await session(ctx, {
      mode: "subscription",
      line_items: items,
      subscription_data: { trial_end: Math.floor(Date.now() / 1000) + 3600 },
    });
    expect(soon.status).toBe(400);
    expect(soon.body.error.param).toBe("subscription_data[trial_end]");

    const behaviour = await session(ctx, {
      mode: "subscription",
      line_items: items,
      subscription_data: { trial_settings: { end_behavior: { missing_payment_method: "explode" } } },
    });
    expect(behaviour.status).toBe(400);
    expect(behaviour.body.error.param).toBe("subscription_data[trial_settings][end_behavior][missing_payment_method]");
  });
});

describe("Completing a subscription-mode Checkout Session", () => {
  it("starts a 7 day trial with the card saved through a SetupIntent", async () => {
    const ctx = createTestApp({ webhook: true });
    const { session: s } = await subscriptionSession(ctx, { subscription_data: { trial_period_days: 7 } });
    const hooks = captureWebhooks();

    const res = await complete(ctx, s.id, "pm_card_visa");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`https://shop.example/success?session_id=${s.id}`);

    const done = await retrieve(ctx, s.id);
    expect(done.status).toBe("complete");
    expect(done.payment_status).toBe("paid");
    expect(done.url).toBeNull();
    expect(done.subscription).toMatch(/^sub_/);
    expect(done.invoice).toMatch(/^in_/);
    expect(done.customer).toMatch(/^cus_/);
    expect(done.payment_intent).toBeNull();
    expect(done.setup_intent).toBeNull();
    expect(done.customer_details).toMatchObject({ email: "buyer@example.com", tax_exempt: "none", tax_ids: [] });

    const sub = (await api<Json>(ctx.app, "GET", `/v1/subscriptions/${done.subscription}`)).body;
    expect(sub.status).toBe("trialing");
    expect(sub.customer).toBe(done.customer);
    expect(sub.latest_invoice).toBe(done.invoice);
    expect(sub.trial_end - sub.trial_start).toBe(7 * DAY);
    expect(sub.default_payment_method).toMatch(/^pm_/);
    const pm = (await api<Json>(ctx.app, "GET", `/v1/payment_methods/${sub.default_payment_method}`)).body;
    expect(pm.customer).toBe(done.customer);

    const customer = (await api<Json>(ctx.app, "GET", `/v1/customers/${done.customer}`)).body;
    expect(customer.email).toBe("buyer@example.com");
    expect(customer.invoice_settings.default_payment_method).toBeNull();

    const invoice = (await api<Json>(ctx.app, "GET", `/v1/invoices/${done.invoice}`)).body;
    expect(invoice.status).toBe("paid");
    expect(invoice.amount_paid).toBe(0);

    const seen = types(hooks.events);
    for (const type of [
      "customer.created",
      "setup_intent.created",
      "setup_intent.succeeded",
      "payment_method.attached",
      "customer.subscription.created",
      "invoice.paid",
    ]) {
      expect(seen).toContain(type);
    }
    expectInOrder(hooks.events, ["customer.created", "setup_intent.succeeded", "customer.subscription.created"]);
    expect(hooks.ofType("customer.subscription.created")[0].data.object).toMatchObject({ status: "trialing" });
    expect(seen.at(-1)).toBe("checkout.session.completed");
    const completed = hooks.ofType("checkout.session.completed")[0];
    expect(completed.request).toEqual({ id: null, idempotency_key: null });
    expect(completed.data.object).toMatchObject({ id: s.id, subscription: done.subscription, status: "complete" });
  });

  it("charges the first invoice at once without a trial", async () => {
    const ctx = createTestApp({ webhook: true });
    const { session: s } = await subscriptionSession(ctx, { metadata: { order: "7" } });
    const hooks = captureWebhooks();

    const res = await complete(ctx, s.id, "pm_card_visa");
    expect(res.status).toBe(302);

    const done = await retrieve(ctx, s.id, "?expand[]=invoice&expand[]=subscription");
    expect(done.payment_status).toBe("paid");
    expect(done.amount_total).toBe(2000);
    expect(done.subscription.status).toBe("active");
    expect(done.invoice.status).toBe("paid");
    expect(done.invoice.amount_paid).toBe(2000);

    const intents = (
      await api<Json>(ctx.app, "GET", `/v1/payment_intents?customer=${done.customer.id ?? done.customer}`)
    ).body;
    expect(intents.data).toHaveLength(1);
    expect(intents.data[0].status).toBe("succeeded");
    expect(intents.data[0].amount).toBe(2000);

    expectInOrder(hooks.events, [
      "customer.created",
      "payment_method.attached",
      "customer.subscription.created",
      "invoice.created",
      "invoice.finalized",
      "payment_intent.succeeded",
      "invoice.paid",
      "customer.subscription.updated",
      "checkout.session.completed",
    ]);
    expect(types(hooks.events).at(-1)).toBe("checkout.session.completed");
    expect(types(hooks.events)).not.toContain("setup_intent.created");
    expect(hooks.ofType("customer.subscription.updated")[0].data.previous_attributes).toMatchObject({
      status: "incomplete",
    });
  });

  it("uses an existing customer without touching its invoice settings", async () => {
    const ctx = createTestApp();
    const customer = await api<Json>(ctx.app, "POST", "/v1/customers", { email: "known@example.com" });
    const before = (await api<Json>(ctx.app, "GET", "/v1/customers")).body.data.length;
    const { session: s } = await subscriptionSession(ctx, { customer: customer.body.id });
    expect(s.customer).toBe(customer.body.id);
    expect(s.customer_creation).toBeNull();

    await complete(ctx, s.id, "pm_card_mastercard");
    const done = await retrieve(ctx, s.id);
    expect(done.customer).toBe(customer.body.id);
    expect(done.customer_details.email).toBe("known@example.com");
    const after = (await api<Json>(ctx.app, "GET", `/v1/customers/${customer.body.id}`)).body;
    expect(after.invoice_settings.default_payment_method).toBeNull();
    const customers = (await api<Json>(ctx.app, "GET", "/v1/customers")).body;
    expect(customers.data).toHaveLength(before);
  });

  it("passes subscription_data to the subscription", async () => {
    const ctx = createTestApp();
    const { session: s } = await subscriptionSession(ctx, {
      subscription_data: {
        description: "Team plan",
        metadata: { plan: "team" },
        trial_period_days: 14,
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
      },
    });
    await complete(ctx, s.id, "pm_card_visa");
    const done = await retrieve(ctx, s.id, "?expand[]=subscription");
    expect(done.subscription.description).toBe("Team plan");
    expect(done.subscription.metadata).toEqual({ plan: "team" });
    expect(done.subscription.trial_settings.end_behavior.missing_payment_method).toBe("cancel");
    expect(done.subscription.trial_end - done.subscription.trial_start).toBe(14 * DAY);
  });

  it("re-renders the page with 402 on a decline and persists nothing", async () => {
    const ctx = createTestApp({ webhook: true });
    const customer = await api<Json>(ctx.app, "POST", "/v1/customers", { email: "declined@example.com" });
    const { session: s } = await subscriptionSession(ctx, { customer: customer.body.id });
    const hooks = captureWebhooks();

    const res = await complete(ctx, s.id, "pm_card_chargeDeclined");
    expect(res.status).toBe(402);
    expect(await res.text()).toContain("Your card was declined.");

    const after = await retrieve(ctx, s.id);
    expect(after.status).toBe("open");
    expect(after.subscription).toBeNull();
    const subs = (await api<Json>(ctx.app, "GET", `/v1/subscriptions?status=all&customer=${customer.body.id}`)).body;
    expect(subs.data).toHaveLength(0);
    const pms = (await api<Json>(ctx.app, "GET", `/v1/payment_methods?customer=${customer.body.id}`)).body;
    expect(pms.data).toHaveLength(0);
    expect(hooks.events).toHaveLength(0);
  });

  it("rolls back the subscription and invoice when the first charge fails", async () => {
    const ctx = createTestApp({ webhook: true });
    const { session: s } = await subscriptionSession(ctx);
    const customersBefore = (await api<Json>(ctx.app, "GET", "/v1/customers")).body.data.length;
    const hooks = captureWebhooks();

    const res = await complete(ctx, s.id, "pm_card_chargeCustomerFail");
    expect(res.status).toBe(402);
    expect(await res.text()).toContain("Your card was declined.");

    expect((await retrieve(ctx, s.id)).status).toBe("open");
    expect((await api<Json>(ctx.app, "GET", "/v1/subscriptions?status=all")).body.data).toHaveLength(0);
    expect((await api<Json>(ctx.app, "GET", "/v1/invoices")).body.data).toHaveLength(0);
    expect((await api<Json>(ctx.app, "GET", "/v1/customers")).body.data).toHaveLength(customersBefore);
    expect(hooks.events).toHaveLength(0);

    const retry = await complete(ctx, s.id, "pm_card_visa");
    expect(retry.status).toBe(302);
    expect((await retrieve(ctx, s.id)).status).toBe("complete");
  });

  it("starts a trial with 0341, whose charges fail only later", async () => {
    const ctx = createTestApp();
    const { session: s } = await subscriptionSession(ctx, { subscription_data: { trial_period_days: 7 } });
    const res = await complete(ctx, s.id, "pm_card_chargeCustomerFail");
    expect(res.status).toBe(302);
    const done = await retrieve(ctx, s.id, "?expand[]=subscription");
    expect(done.subscription.status).toBe("trialing");
  });

  it("approves 3D Secure on the page, since the customer is present", async () => {
    const ctx = createTestApp();
    const trial = await subscriptionSession(ctx, { subscription_data: { trial_period_days: 7 } });
    expect((await complete(ctx, trial.session.id, "pm_card_authenticationRequiredOnSetup")).status).toBe(302);
    expect((await retrieve(ctx, trial.session.id, "?expand[]=subscription")).subscription.status).toBe("trialing");

    const paid = await subscriptionSession(ctx);
    expect((await complete(ctx, paid.session.id, "pm_card_authenticationRequired")).status).toBe(302);
    const done = await retrieve(ctx, paid.session.id, "?expand[]=subscription");
    expect(done.subscription.status).toBe("active");
    const charges = (await api<Json>(ctx.app, "GET", `/v1/charges?customer=${done.customer}`)).body;
    expect(charges.data[0].payment_method_details.card.three_d_secure).not.toBeNull();
  });

  it("starts a trial without a card when payment_method_collection is if_required", async () => {
    const ctx = createTestApp({ webhook: true });
    const { session: s } = await subscriptionSession(ctx, {
      payment_method_collection: "if_required",
      subscription_data: { trial_period_days: 7 },
    });
    expect(s.payment_method_collection).toBe("if_required");
    const page = await (await ctx.app.request(`${base}/checkout/${s.id}`)).text();
    expect(page).toContain('value="none"');
    const hooks = captureWebhooks();

    const res = await complete(ctx, s.id, "none");
    expect(res.status).toBe(302);
    const done = await retrieve(ctx, s.id, "?expand[]=subscription");
    expect(done.payment_status).toBe("paid");
    expect(done.subscription.status).toBe("trialing");
    expect(done.subscription.default_payment_method).toBeNull();
    const pms = (await api<Json>(ctx.app, "GET", `/v1/payment_methods?customer=${done.customer}`)).body;
    expect(pms.data).toHaveLength(0);
    expect(types(hooks.events)).not.toContain("setup_intent.created");
    expect(types(hooks.events).at(-1)).toBe("checkout.session.completed");
  });

  it("requires a card when an amount is due, even with if_required", async () => {
    const ctx = createTestApp();
    const { session: s } = await subscriptionSession(ctx, { payment_method_collection: "if_required" });
    const page = await (await ctx.app.request(`${base}/checkout/${s.id}`)).text();
    expect(page).not.toContain('value="none"');
    const res = await complete(ctx, s.id, "none");
    expect(res.status).toBe(400);
    expect((await retrieve(ctx, s.id)).status).toBe("open");
  });

  it("requires a card when payment_method_collection is always", async () => {
    const ctx = createTestApp();
    const { session: s } = await subscriptionSession(ctx, { subscription_data: { trial_period_days: 7 } });
    const res = await complete(ctx, s.id, "none");
    expect(res.status).toBe(400);
  });
});

describe("Checkout Session line items", () => {
  it("are includable and listable", async () => {
    const ctx = createTestApp();
    const { session: s, priceId } = await subscriptionSession(ctx);

    const expanded = await retrieve(ctx, s.id, "?expand[]=line_items");
    expect(expanded.line_items.object).toBe("list");
    expect(expanded.line_items.url).toBe(`/v1/checkout/sessions/${s.id}/line_items`);
    const [item] = expanded.line_items.data;
    expect(item).toEqual({
      id: expect.stringMatching(/^li_/),
      object: "item",
      amount_discount: 0,
      amount_subtotal: 2000,
      amount_tax: 0,
      amount_total: 2000,
      currency: "usd",
      description: "Pro Plan",
      price: expect.objectContaining({ id: priceId, object: "price" }),
      quantity: 1,
    });

    const listed = (await api<Json>(ctx.app, "GET", `/v1/checkout/sessions/${s.id}/line_items`)).body;
    expect(listed.object).toBe("list");
    expect(listed.data).toEqual([item]);
    expect(listed.has_more).toBe(false);
  });

  it("expand line_items and subscription through stripe-node", async () => {
    const ctx = createTestApp();
    const stripe = sdk(ctx.app);
    const priceId = await price(ctx);
    const created = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 2 }],
      success_url: "https://shop.example/ok",
      subscription_data: { trial_period_days: 7, metadata: { source: "sdk" } },
      expand: ["line_items"],
    });
    expect(created.id).toMatch(/^cs_test_/);
    expect(created.line_items?.data[0].quantity).toBe(2);

    await complete(ctx, created.id, "pm_card_visa");
    const done = await stripe.checkout.sessions.retrieve(created.id, { expand: ["line_items", "subscription"] });
    const sub = done.subscription as Stripe.Subscription;
    expect(sub.object).toBe("subscription");
    expect(sub.status).toBe("trialing");
    expect(sub.metadata).toEqual({ source: "sdk" });
    expect(sub.items.data[0].quantity).toBe(2);
    expect(done.line_items?.data).toHaveLength(1);

    const items = await stripe.checkout.sessions.listLineItems(created.id);
    expect(items.data[0].description).toBe("Pro Plan");
  });
});

describe("Hosted checkout page", () => {
  it("shows the billing interval and the test card choices", async () => {
    const ctx = createTestApp();
    const { session: s } = await subscriptionSession(ctx);
    const res = await ctx.app.request(`${base}/checkout/${s.id}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("/ month");
    expect(html).toContain('name="payment_method"');
    expect(html).toContain('value="pm_card_visa" selected');
    expect(html).toContain("pm_card_chargeDeclined");
  });

  it("describes a longer interval", async () => {
    const ctx = createTestApp();
    const priceId = await price(ctx, { interval: "month", intervalCount: 3 });
    const created = await session(ctx, { mode: "subscription", line_items: [{ price: priceId, quantity: 1 }] });
    const html = await (await ctx.app.request(`${base}/checkout/${created.body.id}`)).text();
    expect(html).toContain("every 3 months");
  });
});

describe("Completing a payment-mode Checkout Session", () => {
  it("charges a PaymentIntent and links it from the session", async () => {
    const ctx = createTestApp({ webhook: true });
    const oneTime = await price(ctx, { recurring: false, unitAmount: 1500 });
    const created = await session(ctx, { mode: "payment", line_items: [{ price: oneTime, quantity: 2 }] });
    expect(created.body.amount_total).toBe(3000);
    expect(created.body.customer_creation).toBe("if_required");
    expect(created.body.invoice_creation).toEqual({
      enabled: false,
      invoice_data: {
        account_tax_ids: null,
        custom_fields: null,
        description: null,
        footer: null,
        issuer: null,
        metadata: {},
        rendering_options: null,
      },
    });
    const hooks = captureWebhooks();

    expect((await complete(ctx, created.body.id, "pm_card_visa")).status).toBe(302);
    const done = await retrieve(ctx, created.body.id, "?expand[]=payment_intent");
    expect(done.payment_status).toBe("paid");
    expect(done.customer).toBeNull();
    expect(done.customer_details.email).toBe("buyer@example.com");
    expect(done.payment_intent.id).toMatch(/^pi_/);
    expect(done.payment_intent.status).toBe("succeeded");
    expect(done.payment_intent.amount).toBe(3000);
    expectInOrder(hooks.events, [
      "payment_intent.created",
      "payment_intent.succeeded",
      "charge.succeeded",
      "checkout.session.completed",
    ]);
    expect(types(hooks.events).at(-1)).toBe("checkout.session.completed");
  });

  it("creates a customer when customer_creation is always", async () => {
    const ctx = createTestApp();
    const oneTime = await price(ctx, { recurring: false });
    const created = await session(ctx, {
      mode: "payment",
      customer_creation: "always",
      line_items: [{ price: oneTime, quantity: 1 }],
    });
    await complete(ctx, created.body.id, "pm_card_visa");
    const done = await retrieve(ctx, created.body.id, "?expand[]=payment_intent");
    expect(done.customer).toMatch(/^cus_/);
    expect(done.payment_intent.customer).toBe(done.customer);
  });

  it("re-renders with 402 when the card is declined", async () => {
    const ctx = createTestApp();
    const oneTime = await price(ctx, { recurring: false });
    const created = await session(ctx, { mode: "payment", line_items: [{ price: oneTime, quantity: 1 }] });
    const res = await complete(ctx, created.body.id, "pm_card_chargeDeclined");
    expect(res.status).toBe(402);
    const after = await retrieve(ctx, created.body.id);
    expect(after.status).toBe("open");
    expect(after.payment_intent).toBeNull();
  });
});
