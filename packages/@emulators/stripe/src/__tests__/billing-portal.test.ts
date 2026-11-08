import { describe, it, expect, afterEach, vi } from "vitest";
import type Stripe from "stripe";
import { createTestApp, captureWebhooks, api, sdk, base, type TestApp } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

const DAY = 86400;
const HOUR = 3600;
const T = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);

function obj(event: Stripe.Event): Json {
  return event.data.object as unknown as Json;
}

function wire<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

/** Submit a hosted page form the way a browser does. */
async function submit(ctx: TestApp, url: string, fields: Record<string, string> = {}) {
  return ctx.app.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

async function monthlyPrice(ctx: TestApp, name = "Pro Plan") {
  const product = await api<Json>(ctx.app, "POST", "/v1/products", { name });
  const price = await api<Json>(ctx.app, "POST", "/v1/prices", {
    product: product.body.id,
    currency: "usd",
    unit_amount: 2000,
    recurring: { interval: "month" },
  });
  expect(price.status).toBe(200);
  return price.body.id as string;
}

/** A customer with a default card and an active monthly subscription. */
async function subscribed(ctx: TestApp) {
  const customer = await api<Json>(ctx.app, "POST", "/v1/customers", {
    email: "portal@example.com",
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" },
  });
  expect(customer.status).toBe(200);
  const sub = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
    customer: customer.body.id,
    items: [{ price: await monthlyPrice(ctx) }],
  });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  expect(sub.body.status).toBe("active");
  return { customer: customer.body, sub: sub.body };
}

async function portal(ctx: TestApp, params: Json) {
  const res = await api<Json>(ctx.app, "POST", "/v1/billing_portal/sessions", params);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function getSub(ctx: TestApp, id: string) {
  return (await api<Json>(ctx.app, "GET", `/v1/subscriptions/${id}`)).body;
}

const HOMEPAGE_FLOW = { hosted_confirmation: null, redirect: null, type: "portal_homepage" };

describe("POST /v1/billing_portal/sessions", () => {
  it("creates a session on the default configuration and serves its page", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customer, sub } = await subscribed(ctx);
    const stripe = sdk(ctx.app);
    const hooks = captureWebhooks();

    const session = wire(
      await stripe.billingPortal.sessions.create({ customer: customer.id, return_url: "https://app.example/account" }),
    );
    expect(Object.keys(session)).toEqual([
      "id",
      "object",
      "after_expiration",
      "configuration",
      "created",
      "customer",
      "customer_account",
      "flow",
      "livemode",
      "locale",
      "on_behalf_of",
      "return_url",
      "url",
    ]);
    expect(session.id).toMatch(/^bps_[A-Za-z0-9]+$/);
    expect(session).toMatchObject({
      object: "billing_portal.session",
      after_expiration: null,
      customer: customer.id,
      customer_account: null,
      flow: null,
      livemode: false,
      locale: null,
      on_behalf_of: null,
      return_url: "https://app.example/account",
      url: `${base}/billing_portal/${session.id}`,
    });
    expect(session.configuration).toMatch(/^bpc_[A-Za-z0-9]+$/);
    expect(session.created).toEqual(expect.any(Number));

    const created = hooks.ofType("billing_portal.session.created");
    expect(created).toHaveLength(1);
    expect(obj(created[0])).toEqual(session);
    expect(created[0].request?.id).toMatch(/^req_/);

    const page = await ctx.app.request(session.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Pro Plan");
    expect(html).toContain(sub.id);
    expect(html).toContain("https://app.example/account");

    const sameConfig = wire(await stripe.billingPortal.sessions.create({ customer: customer.id }));
    expect(sameConfig.configuration).toBe(session.configuration);
    expect(sameConfig.return_url).toBeNull();
  });

  it("lists the default configuration and expands it on the session", async () => {
    const ctx = createTestApp();
    const { customer } = await subscribed(ctx);
    const stripe = sdk(ctx.app);

    const list = wire(await stripe.billingPortal.configurations.list());
    expect(list).toMatchObject({ object: "list", url: "/v1/billing_portal/configurations", has_more: false });
    expect(list.data).toHaveLength(1);
    const config = list.data[0];
    expect(config.id).toMatch(/^bpc_/);
    expect(config).toMatchObject({
      object: "billing_portal.configuration",
      active: true,
      application: null,
      business_profile: { headline: null, privacy_policy_url: null, terms_of_service_url: null },
      default_return_url: null,
      is_default: true,
      livemode: false,
      login_page: { enabled: false, url: null },
      metadata: {},
      name: null,
    });
    expect(config.features).toMatchObject({
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true, payment_method_configuration: null },
      subscription_cancel: { enabled: true, mode: "at_period_end", proration_behavior: "none" },
      subscription_update: { enabled: true, proration_behavior: "none" },
    });
    expect(config.features.subscription_cancel.cancellation_reason.options).toContain("too_expensive");

    const retrieved = wire(await stripe.billingPortal.configurations.retrieve(config.id));
    expect(retrieved).toEqual(config);

    const session = wire(
      await stripe.billingPortal.sessions.create({ customer: customer.id, expand: ["configuration"] }),
    );
    expect(session.configuration).toEqual(config);

    const unknown = await api<Json>(ctx.app, "POST", "/v1/billing_portal/sessions", {
      customer: customer.id,
      configuration: "bpc_missing",
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({ code: "resource_missing", param: "configuration" });
    const missingConfig = await api<Json>(ctx.app, "GET", "/v1/billing_portal/configurations/bpc_missing");
    expect(missingConfig.status).toBe(404);
  });

  it("requires an existing customer", async () => {
    const ctx = createTestApp();
    const missing = await api<Json>(ctx.app, "POST", "/v1/billing_portal/sessions", {
      return_url: "https://app.example",
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "parameter_missing",
      param: "customer",
    });

    const unknown = await api<Json>(ctx.app, "POST", "/v1/billing_portal/sessions", { customer: "cus_missing" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "resource_missing",
      param: "customer",
      message: "No such customer: 'cus_missing'",
    });

    const { customer } = await subscribed(ctx);
    const badLocale = await api<Json>(ctx.app, "POST", "/v1/billing_portal/sessions", {
      customer: customer.id,
      locale: "xx",
    });
    expect(badLocale.status).toBe(400);
    expect(badLocale.body.error.param).toBe("locale");
    const locale = await portal(ctx, { customer: customer.id, locale: "fr" });
    expect(locale.locale).toBe("fr");

    const notFound = await ctx.app.request(`${base}/billing_portal/bps_missing`);
    expect(notFound.status).toBe(404);
  });

  it("rejects return URLs that are not http or https", async () => {
    const ctx = createTestApp();
    const { customer } = await subscribed(ctx);
    for (const url of ["not a url", "javascript:alert(1)", "/relative"]) {
      const res = await api<Json>(ctx.app, "POST", "/v1/billing_portal/sessions", {
        customer: customer.id,
        return_url: url,
      });
      expect(res.status, url).toBe(400);
      expect(res.body.error).toMatchObject({
        type: "invalid_request_error",
        message: "Not a valid URL",
        param: "return_url",
      });
    }

    const redirect = await api<Json>(ctx.app, "POST", "/v1/billing_portal/sessions", {
      customer: customer.id,
      flow_data: {
        type: "payment_method_update",
        after_completion: { type: "redirect", redirect: { return_url: "javascript:alert(1)" } },
      },
    });
    expect(redirect.status).toBe(400);
    expect(redirect.body.error).toMatchObject({
      message: "Not a valid URL",
      param: "flow_data[after_completion][redirect][return_url]",
    });

    const ok = await portal(ctx, { customer: customer.id, return_url: "http://localhost:3000/account" });
    expect(ok.return_url).toBe("http://localhost:3000/account");
  });
});

describe("flow_data", () => {
  it("echoes a payment_method_update flow and shows only that step", async () => {
    const ctx = createTestApp();
    const { customer, sub } = await subscribed(ctx);
    const stripe = sdk(ctx.app);

    const session = wire(
      await stripe.billingPortal.sessions.create({
        customer: customer.id,
        flow_data: { type: "payment_method_update" },
      }),
    );
    expect(session.flow).toEqual({
      after_completion: HOMEPAGE_FLOW,
      customer_update: null,
      subscription_cancel: null,
      subscription_pause: null,
      subscription_update: null,
      subscription_update_confirm: null,
      type: "payment_method_update",
    });

    const html = await (await ctx.app.request(session.url)).text();
    expect(html).toContain("Update payment method");
    expect(html.split("3D Secure is approved automatically.")).toHaveLength(2);
    expect(html).not.toContain(sub.id);

    // Completing the flow goes back to the homepage, which lists the subscription.
    const done = await submit(ctx, `${session.url}/payment_method`, { payment_method: "pm_card_mastercard" });
    expect(done.status).toBe(303);
    expect(done.headers.get("Location")).toBe(session.url);
    expect(await (await ctx.app.request(session.url)).text()).toContain(sub.id);
  });

  it("validates a subscription_cancel flow and redirects after it", async () => {
    const ctx = createTestApp();
    const { customer, sub } = await subscribed(ctx);

    const missing = await api<Json>(ctx.app, "POST", "/v1/billing_portal/sessions", {
      customer: customer.id,
      flow_data: { type: "subscription_cancel" },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({
      code: "parameter_missing",
      param: "flow_data[subscription_cancel][subscription]",
    });
    const unknown = await api<Json>(ctx.app, "POST", "/v1/billing_portal/sessions", {
      customer: customer.id,
      flow_data: { type: "subscription_cancel", subscription_cancel: { subscription: "sub_missing" } },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({
      code: "resource_missing",
      param: "flow_data[subscription_cancel][subscription]",
    });
    const noRedirectUrl = await api<Json>(ctx.app, "POST", "/v1/billing_portal/sessions", {
      customer: customer.id,
      flow_data: {
        type: "subscription_cancel",
        subscription_cancel: { subscription: sub.id },
        after_completion: { type: "redirect" },
      },
    });
    expect(noRedirectUrl.status).toBe(400);
    expect(noRedirectUrl.body.error.param).toBe("flow_data[after_completion][redirect][return_url]");
    const badType = await api<Json>(ctx.app, "POST", "/v1/billing_portal/sessions", {
      customer: customer.id,
      flow_data: { type: "teleport" },
    });
    expect(badType.status).toBe(400);
    expect(badType.body.error.param).toBe("flow_data[type]");

    const session = await portal(ctx, {
      customer: customer.id,
      flow_data: {
        type: "subscription_cancel",
        subscription_cancel: { subscription: sub.id },
        after_completion: { type: "redirect", redirect: { return_url: "https://app.example/bye" } },
      },
    });
    expect(session.flow).toEqual({
      after_completion: {
        hosted_confirmation: null,
        redirect: { return_url: "https://app.example/bye" },
        type: "redirect",
      },
      customer_update: null,
      subscription_cancel: { retention: null, subscription: sub.id },
      subscription_pause: null,
      subscription_update: null,
      subscription_update_confirm: null,
      type: "subscription_cancel",
    });

    const canceled = await submit(ctx, `${session.url}/subscriptions/${sub.id}/cancel`, { feedback: "unused" });
    expect(canceled.status).toBe(303);
    expect(canceled.headers.get("Location")).toBe("https://app.example/bye");
    expect((await getSub(ctx, sub.id)).cancel_at_period_end).toBe(true);
  });

  it("echoes a subscription_update flow", async () => {
    const ctx = createTestApp();
    const { customer, sub } = await subscribed(ctx);
    const session = await portal(ctx, {
      customer: customer.id,
      flow_data: {
        type: "subscription_update",
        subscription_update: { subscription: sub.id },
        after_completion: { type: "hosted_confirmation", hosted_confirmation: { custom_message: "Thanks!" } },
      },
    });
    expect(session.flow).toMatchObject({
      type: "subscription_update",
      subscription_update: { subscription: sub.id },
      after_completion: {
        type: "hosted_confirmation",
        hosted_confirmation: { custom_message: "Thanks!" },
        redirect: null,
      },
    });
  });
});

describe("portal actions", () => {
  it("cancels at period end with feedback, then renews", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customer, sub } = await subscribed(ctx);
    const session = await portal(ctx, { customer: customer.id });
    const hooks = captureWebhooks();

    const res = await submit(ctx, `${session.url}/subscriptions/${sub.id}/cancel`, {
      feedback: "too_expensive",
      comment: "Cheaper elsewhere",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(session.url);

    const scheduled = await getSub(ctx, sub.id);
    const periodEnd = scheduled.items.data[0].current_period_end;
    expect(scheduled).toMatchObject({
      status: "active",
      cancel_at_period_end: true,
      cancel_at: periodEnd,
      cancellation_details: {
        reason: "cancellation_requested",
        feedback: "too_expensive",
        comment: "Cheaper elsewhere",
      },
    });
    expect(scheduled.canceled_at).toEqual(expect.any(Number));

    const updated = hooks.ofType("customer.subscription.updated");
    expect(updated).toHaveLength(1);
    expect(obj(updated[0])).toMatchObject({ id: sub.id, cancel_at_period_end: true });
    expect(updated[0].data.previous_attributes).toMatchObject({ cancel_at_period_end: false, cancel_at: null });
    expect(updated[0].request).toEqual({ id: null, idempotency_key: null });

    const page = await (await ctx.app.request(session.url)).text();
    expect(page).toContain("Renew");

    const again = await submit(ctx, `${session.url}/subscriptions/${sub.id}/cancel`, {});
    expect(again.status).toBe(400);

    const renewed = await submit(ctx, `${session.url}/subscriptions/${sub.id}/renew`);
    expect(renewed.status).toBe(303);
    const after = await getSub(ctx, sub.id);
    expect(after).toMatchObject({
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      cancellation_details: { reason: null, feedback: null, comment: null },
    });
    const renewal = hooks.ofType("customer.subscription.updated")[1];
    expect(renewal.data.previous_attributes).toMatchObject({ cancel_at_period_end: true });
  });

  it("refuses to act on another customer's subscription", async () => {
    const ctx = createTestApp();
    const first = await subscribed(ctx);
    const second = await subscribed(ctx);
    const session = await portal(ctx, { customer: first.customer.id });
    const res = await submit(ctx, `${session.url}/subscriptions/${second.sub.id}/cancel`, {});
    expect(res.status).toBe(404);
    expect((await getSub(ctx, second.sub.id)).cancel_at_period_end).toBe(false);
  });

  it("saves a new card through a SetupIntent and makes it the default", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customer, sub } = await subscribed(ctx);
    const session = await portal(ctx, { customer: customer.id });
    const hooks = captureWebhooks();

    const res = await submit(ctx, `${session.url}/payment_method`, { payment_method: "pm_card_visa" });
    expect(res.status).toBe(303);

    const types = hooks.events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "setup_intent.created",
        "setup_intent.succeeded",
        "payment_method.attached",
        "customer.updated",
      ]),
    );
    expect(types.indexOf("setup_intent.created")).toBeLessThan(types.indexOf("setup_intent.succeeded"));
    expect(types.indexOf("setup_intent.succeeded")).toBeLessThan(types.indexOf("customer.updated"));

    const si = obj(hooks.ofType("setup_intent.succeeded")[0]);
    const pmId = si.payment_method as string;
    expect(pmId).toMatch(/^pm_/);
    expect(si).toMatchObject({ customer: customer.id, usage: "off_session", status: "succeeded" });
    expect(obj(hooks.ofType("payment_method.attached")[0]).id).toBe(pmId);

    const customerUpdated = hooks.ofType("customer.updated")[0];
    expect(obj(customerUpdated).invoice_settings.default_payment_method).toBe(pmId);
    expect(customerUpdated.data.previous_attributes).toEqual({
      invoice_settings: { default_payment_method: customer.invoice_settings.default_payment_method },
    });
    expect(customerUpdated.request).toEqual({ id: null, idempotency_key: null });

    // The subscription had no default of its own, so it is left alone.
    expect((await getSub(ctx, sub.id)).default_payment_method).toBeNull();
    const page = await (await ctx.app.request(session.url)).text();
    expect(page).toContain("4242");
  });

  it("removes a subscription's own default so it falls back to the new customer default", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customer } = await subscribed(ctx);
    const oldPm = customer.invoice_settings.default_payment_method as string;
    // As a Checkout-created subscription has: a default_payment_method of its own.
    const own = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: customer.id,
      items: [{ price: await monthlyPrice(ctx, "Team Plan") }],
      default_payment_method: oldPm,
    });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.default_payment_method).toBe(oldPm);
    const session = await portal(ctx, { customer: customer.id });
    const hooks = captureWebhooks();

    const res = await submit(ctx, `${session.url}/payment_method`, { payment_method: "pm_card_mastercard" });
    expect(res.status).toBe(303);

    const pmId = obj(hooks.ofType("setup_intent.succeeded")[0]).payment_method as string;
    expect(pmId).not.toBe(oldPm);
    const after = await getSub(ctx, own.body.id);
    expect(after.default_payment_method).toBeNull();
    expect(obj(hooks.ofType("customer.updated")[0]).invoice_settings.default_payment_method).toBe(pmId);

    const updated = hooks.ofType("customer.subscription.updated");
    expect(updated).toHaveLength(1);
    expect(obj(updated[0])).toMatchObject({ id: own.body.id, default_payment_method: null });
    expect(updated[0].data.previous_attributes).toEqual({ default_payment_method: oldPm });
    expect(updated[0].request).toEqual({ id: null, idempotency_key: null });
  });

  it("approves 3D Secure on the page and keeps the old default when a card declines", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customer } = await subscribed(ctx);
    const session = await portal(ctx, { customer: customer.id });
    const hooks = captureWebhooks();

    const secure = await submit(ctx, `${session.url}/payment_method`, {
      payment_method: "pm_card_authenticationRequiredOnSetup",
    });
    expect(secure.status).toBe(303);
    expect(hooks.ofType("setup_intent.requires_action")).toHaveLength(1);
    expect(hooks.ofType("setup_intent.succeeded")).toHaveLength(1);
    const secureDefault = (await api<Json>(ctx.app, "GET", `/v1/customers/${customer.id}`)).body.invoice_settings
      .default_payment_method;
    expect(secureDefault).toBe(obj(hooks.ofType("setup_intent.succeeded")[0]).payment_method);

    const declined = await submit(ctx, `${session.url}/payment_method`, { payment_method: "pm_card_chargeDeclined" });
    expect(declined.status).toBe(402);
    expect(await declined.text()).toContain("declined");
    expect(hooks.ofType("setup_intent.setup_failed")).toHaveLength(1);
    const after = (await api<Json>(ctx.app, "GET", `/v1/customers/${customer.id}`)).body;
    expect(after.invoice_settings.default_payment_method).toBe(secureDefault);
  });

  it("recovers a past_due subscription: new card, then pay the open invoice", async () => {
    const ctx = createTestApp({ webhook: true });
    const clock = (await api<Json>(ctx.app, "POST", "/v1/test_helpers/test_clocks", { frozen_time: T })).body;
    const customer = (
      await api<Json>(ctx.app, "POST", "/v1/customers", {
        email: "late@example.com",
        test_clock: clock.id,
        payment_method: "pm_card_chargeCustomerFail",
        invoice_settings: { default_payment_method: "pm_card_chargeCustomerFail" },
      })
    ).body;
    const sub = (
      await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
        customer: customer.id,
        items: [{ price: await monthlyPrice(ctx) }],
        trial_period_days: 7,
      })
    ).body;
    const advanced = await api<Json>(ctx.app, "POST", `/v1/test_helpers/test_clocks/${clock.id}/advance`, {
      frozen_time: T + 7 * DAY + HOUR,
    });
    expect(advanced.status).toBe(200);
    const pastDue = await getSub(ctx, sub.id);
    expect(pastDue.status).toBe("past_due");
    const invoiceId = pastDue.latest_invoice as string;

    const session = await portal(ctx, { customer: customer.id });
    const page = await (await ctx.app.request(session.url)).text();
    expect(page).toContain(invoiceId);
    expect(page).toContain("past_due");

    const hooks = captureWebhooks();
    expect((await submit(ctx, `${session.url}/payment_method`, { payment_method: "pm_card_visa" })).status).toBe(303);
    const paid = await submit(ctx, `${session.url}/invoices/${invoiceId}/pay`);
    expect(paid.status).toBe(303);

    expect(hooks.ofType("invoice.paid")).toHaveLength(1);
    expect(obj(hooks.ofType("invoice.paid")[0]).id).toBe(invoiceId);
    expect((await getSub(ctx, sub.id)).status).toBe("active");
    const invoice = (await api<Json>(ctx.app, "GET", `/v1/invoices/${invoiceId}`)).body;
    expect(invoice.status).toBe("paid");
    const paidAgain = await submit(ctx, `${session.url}/invoices/${invoiceId}/pay`);
    expect(paidAgain.status).toBe(400);
  });
});

describe("hosted invoice page", () => {
  /** An open send_invoice invoice for 2000 usd, for a customer with no card. */
  async function openInvoice(ctx: TestApp) {
    const customer = (await api<Json>(ctx.app, "POST", "/v1/customers", { email: "payer@example.com" })).body;
    const draft = await api<Json>(ctx.app, "POST", "/v1/invoices", {
      customer: customer.id,
      collection_method: "send_invoice",
      days_until_due: 30,
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    const item = await api<Json>(ctx.app, "POST", "/v1/invoiceitems", {
      customer: customer.id,
      invoice: draft.body.id,
      amount: 2000,
      currency: "usd",
      description: "Consulting",
    });
    expect(item.status).toBe(200);
    const open = await api<Json>(ctx.app, "POST", `/v1/invoices/${draft.body.id}/finalize`);
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect(open.body.status).toBe("open");
    return { customer, invoice: open.body };
  }

  it("pays an open invoice with the selected test card", async () => {
    const ctx = createTestApp({ webhook: true });
    const { invoice } = await openInvoice(ctx);
    expect(invoice.invoice_pdf).toBe(invoice.hosted_invoice_url);

    const page = await ctx.app.request(invoice.hosted_invoice_url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(invoice.number);
    expect(html).toContain("Consulting");
    expect(html).toContain("$20.00");
    expect(html).toContain('name="payment_method"');
    expect(html).toContain("pm_card_visa");
    expect(html.split("3D Secure is approved automatically.")).toHaveLength(2);

    const hooks = captureWebhooks();
    const declined = await submit(ctx, `${invoice.hosted_invoice_url}/pay`, {
      payment_method: "pm_card_chargeDeclined",
    });
    expect(declined.status).toBe(402);
    expect(await declined.text()).toContain("declined");
    expect((await api<Json>(ctx.app, "GET", `/v1/invoices/${invoice.id}`)).body.status).toBe("open");
    expect(hooks.ofType("invoice.payment_failed")).toHaveLength(1);

    const paid = await submit(ctx, `${invoice.hosted_invoice_url}/pay`, {
      payment_method: "pm_card_authenticationRequired",
    });
    expect(paid.status).toBe(303);
    expect(paid.headers.get("Location")).toBe(invoice.hosted_invoice_url);
    const after = (await api<Json>(ctx.app, "GET", `/v1/invoices/${invoice.id}`)).body;
    expect(after).toMatchObject({ status: "paid", amount_paid: 2000, amount_remaining: 0 });
    expect(hooks.ofType("invoice.paid")).toHaveLength(1);
    expect(hooks.ofType("invoice.paid")[0].request).toEqual({ id: null, idempotency_key: null });

    const paidPage = await (await ctx.app.request(invoice.hosted_invoice_url)).text();
    expect(paidPage).toContain("Paid");
    expect(paidPage).not.toContain('name="payment_method"');
    const twice = await submit(ctx, `${invoice.hosted_invoice_url}/pay`, { payment_method: "pm_card_visa" });
    expect(twice.status).toBe(400);
  });

  it("answers 404 for drafts and unknown invoices", async () => {
    const ctx = createTestApp();
    const customer = (await api<Json>(ctx.app, "POST", "/v1/customers", { email: "draft@example.com" })).body;
    const draft = (await api<Json>(ctx.app, "POST", "/v1/invoices", { customer: customer.id })).body;
    expect(draft.hosted_invoice_url).toBeNull();
    expect((await ctx.app.request(`${base}/invoice/${draft.id}`)).status).toBe(404);
    expect((await ctx.app.request(`${base}/invoice/in_missing`)).status).toBe(404);
  });
});
