import { describe, it, expect, afterEach, vi } from "vitest";
import Stripe from "stripe";
import { createTestApp, captureWebhooks, sdk, api, base, type TestApp } from "./support.js";
import { getStripeStore } from "../store.js";
import { eventBatch } from "../events.js";
import { DRAFT_FINALIZE_DELAY, payInvoice } from "../invoicing.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

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

/** A customer whose invoice default payment method is `card`. */
async function customerWithCard(ctx: TestApp, card = "pm_card_visa") {
  const customer = await api<Json>(ctx.app, "POST", "/v1/customers", { email: "billing@example.com", name: "Bill" });
  const pm = await api<Json>(ctx.app, "POST", `/v1/payment_methods/${card}/attach`, { customer: customer.body.id });
  expect(pm.status).toBe(200);
  await api(ctx.app, "POST", `/v1/customers/${customer.body.id}`, {
    invoice_settings: { default_payment_method: pm.body.id },
  });
  return { customerId: customer.body.id as string, pmId: pm.body.id as string };
}

async function priceOf(ctx: TestApp, unitAmount: number) {
  const product = await api<Json>(ctx.app, "POST", "/v1/products", { name: "Widget" });
  const price = await api<Json>(ctx.app, "POST", "/v1/prices", {
    product: product.body.id,
    currency: "usd",
    unit_amount: unitAmount,
  });
  return { productId: product.body.id as string, priceId: price.body.id as string };
}

/** A draft invoice with one invoice item for `unitAmount` x `quantity`. */
async function draftInvoice(ctx: TestApp, customerId: string, unitAmount = 2000, quantity = 1) {
  const { productId, priceId } = await priceOf(ctx, unitAmount);
  const invoice = await api<Json>(ctx.app, "POST", "/v1/invoices", { customer: customerId });
  expect(invoice.status).toBe(200);
  const item = await api<Json>(ctx.app, "POST", "/v1/invoiceitems", {
    customer: customerId,
    invoice: invoice.body.id,
    pricing: { price: priceId },
    quantity,
  });
  expect(item.status).toBe(200);
  const draft = await api<Json>(ctx.app, "GET", `/v1/invoices/${invoice.body.id}`);
  return { invoice: draft.body, item: item.body, priceId, productId };
}

describe("Invoice object", () => {
  it("renders a draft with its invoice item line and no pre-basil fields", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customerWithCard(ctx);
    const hooks = captureWebhooks();
    const { invoice, item, priceId, productId } = await draftInvoice(ctx, customerId, 1500, 2);

    expect(invoice.id).toMatch(/^in_[A-Za-z0-9]+$/);
    expect(invoice).toMatchObject({
      object: "invoice",
      status: "draft",
      number: null,
      customer: customerId,
      customer_email: "billing@example.com",
      customer_name: "Bill",
      currency: "usd",
      billing_reason: "manual",
      collection_method: "charge_automatically",
      auto_advance: false,
      attempt_count: 0,
      attempted: false,
      amount_due: 3000,
      amount_paid: 0,
      amount_remaining: 3000,
      subtotal: 3000,
      total: 3000,
      parent: null,
      customer_account: null,
      hosted_invoice_url: null,
      invoice_pdf: null,
      ending_balance: null,
      effective_at: null,
      next_payment_attempt: null,
      test_clock: null,
      total_taxes: [],
      total_pretax_credit_amounts: [],
      status_transitions: { finalized_at: null, marked_uncollectible_at: null, paid_at: null, voided_at: null },
    });
    for (const legacy of ["subscription", "payment_intent", "charge", "paid", "payments", "confirmation_secret"]) {
      expect(invoice).not.toHaveProperty(legacy);
    }
    expect(invoice).not.toHaveProperty("status_details");
    expect(invoice.lines).toMatchObject({
      object: "list",
      has_more: false,
      total_count: 1,
      url: `/v1/invoices/${invoice.id}/lines`,
    });

    const line = invoice.lines.data[0];
    expect(line.id).toMatch(/^il_[A-Za-z0-9]+$/);
    expect(line).toMatchObject({
      object: "line_item",
      amount: 3000,
      currency: "usd",
      description: "Widget",
      discountable: true,
      invoice: invoice.id,
      parent: {
        type: "invoice_item_details",
        invoice_item_details: {
          invoice_item: item.id,
          proration: false,
          proration_details: { credited_items: null },
          subscription: null,
        },
      },
      pricing: {
        type: "price_details",
        price_details: { price: priceId, product: productId },
        unit_amount_decimal: "1500",
      },
      quantity: 2,
      quantity_decimal: "2",
      subtotal: 3000,
    });

    expect(item.id).toMatch(/^ii_[A-Za-z0-9]+$/);
    expect(item).toMatchObject({ object: "invoiceitem", amount: 3000, invoice: invoice.id, parent: null });
    expect(types(hooks.events)).toContain("invoice.created");
    expect(types(hooks.events)).toContain("invoiceitem.created");
  });

  it("keeps the documented key order", async () => {
    const ctx = createTestApp();
    const { customerId } = await customerWithCard(ctx);
    const { invoice } = await draftInvoice(ctx, customerId);
    expect(Object.keys(invoice)).toEqual([
      "id",
      "object",
      "account_country",
      "account_name",
      "account_tax_ids",
      "amount_due",
      "amount_paid",
      "amount_overpaid",
      "amount_remaining",
      "amount_shipping",
      "application",
      "attempt_count",
      "attempted",
      "auto_advance",
      "automatic_tax",
      "automatically_finalizes_at",
      "billing_reason",
      "collection_method",
      "created",
      "currency",
      "custom_fields",
      "customer",
      "customer_account",
      "customer_address",
      "customer_email",
      "customer_name",
      "customer_phone",
      "customer_shipping",
      "customer_tax_exempt",
      "customer_tax_ids",
      "default_payment_method",
      "default_source",
      "default_tax_rates",
      "description",
      "discounts",
      "due_date",
      "effective_at",
      "ending_balance",
      "footer",
      "from_invoice",
      "hosted_invoice_url",
      "invoice_pdf",
      "issuer",
      "last_finalization_error",
      "latest_revision",
      "lines",
      "livemode",
      "metadata",
      "next_payment_attempt",
      "number",
      "on_behalf_of",
      "parent",
      "payment_settings",
      "period_end",
      "period_start",
      "post_payment_credit_notes_amount",
      "pre_payment_credit_notes_amount",
      "receipt_number",
      "rendering",
      "shipping_cost",
      "shipping_details",
      "starting_balance",
      "statement_descriptor",
      "status",
      "status_transitions",
      "subtotal",
      "subtotal_excluding_tax",
      "test_clock",
      "threshold_reason",
      "total",
      "total_discount_amounts",
      "total_excluding_tax",
      "total_pretax_credit_amounts",
      "total_taxes",
      "transfer_data",
      "webhooks_delivered_at",
    ]);
  });

  it("leaves pending invoice items out unless pending_invoice_items_behavior=include", async () => {
    const ctx = createTestApp();
    const { customerId } = await customerWithCard(ctx);
    const { priceId } = await priceOf(ctx, 700);
    const pending = await api<Json>(ctx.app, "POST", "/v1/invoiceitems", {
      customer: customerId,
      pricing: { price: priceId },
    });
    expect(pending.body.invoice).toBeNull();

    const empty = await api<Json>(ctx.app, "POST", "/v1/invoices", { customer: customerId });
    expect(empty.body.lines.total_count).toBe(0);
    expect(empty.body.total).toBe(0);

    const included = await api<Json>(ctx.app, "POST", "/v1/invoices", {
      customer: customerId,
      pending_invoice_items_behavior: "include",
    });
    expect(included.body.lines.total_count).toBe(1);
    expect(included.body.total).toBe(700);
    const item = await api<Json>(ctx.app, "GET", `/v1/invoiceitems/${pending.body.id}`);
    expect(item.body.invoice).toBe(included.body.id);
  });

  it("rejects an unknown customer", async () => {
    const ctx = createTestApp();
    const res = await api<Json>(ctx.app, "POST", "/v1/invoices", { customer: "cus_missing" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "resource_missing", param: "customer" });
    const missing = await api<Json>(ctx.app, "GET", "/v1/invoices/in_missing");
    expect(missing.status).toBe(404);
  });
});

describe("finalizing", () => {
  it("numbers the invoice, opens it and creates its default payment", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customerWithCard(ctx);
    const { invoice } = await draftInvoice(ctx, customerId);
    const hooks = captureWebhooks();
    const customer = await api<Json>(ctx.app, "GET", `/v1/customers/${customerId}`);

    const res = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoice.id}/finalize`, {
      expand: ["payments", "confirmation_secret"],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "open",
      number: `${customer.body.invoice_prefix}-0001`,
      ending_balance: 0,
      automatically_finalizes_at: null,
    });
    expect(res.body.status_transitions.finalized_at).toEqual(expect.any(Number));
    expect(res.body.effective_at).toBe(res.body.status_transitions.finalized_at);
    expect(res.body.hosted_invoice_url).toMatch(new RegExp(`/invoice/${invoice.id}$`));
    expect(res.body.invoice_pdf).toEqual(expect.any(String));
    expect(res.body.invoice_pdf).toBe(res.body.hosted_invoice_url);
    const hosted = await ctx.app.request(res.body.hosted_invoice_url);
    expect(hosted.status).toBe(200);

    expect(res.body.payments.total_count).toBe(1);
    const payment = res.body.payments.data[0];
    expect(payment.id).toMatch(/^inpay_[A-Za-z0-9]+$/);
    expect(payment).toMatchObject({
      object: "invoice_payment",
      amount_paid: null,
      amount_requested: 2000,
      currency: "usd",
      invoice: invoice.id,
      is_default: true,
      status: "open",
      payment: { type: "payment_intent", payment_intent: expect.stringMatching(/^pi_/) },
      status_transitions: { canceled_at: null, paid_at: null },
    });
    const pi = await api<Json>(ctx.app, "GET", `/v1/payment_intents/${payment.payment.payment_intent}`);
    expect(pi.body).toMatchObject({ amount: 2000, customer: customerId, status: "requires_payment_method" });
    expect(res.body.confirmation_secret).toEqual({ client_secret: pi.body.client_secret, type: "payment_intent" });

    expectInOrder(hooks.events, ["payment_intent.created", "invoice.finalized"]);
    const after = await api<Json>(ctx.app, "GET", `/v1/customers/${customerId}`);
    expect(after.body.next_invoice_sequence).toBe(2);

    const again = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoice.id}/finalize`);
    expect(again.status).toBe(400);
  });

  it("marks a $0 invoice paid at once without a PaymentIntent", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customerWithCard(ctx);
    const draft = await api<Json>(ctx.app, "POST", "/v1/invoices", { customer: customerId });
    const hooks = captureWebhooks();

    const res = await api<Json>(ctx.app, "POST", `/v1/invoices/${draft.body.id}/finalize`, { expand: ["payments"] });
    expect(res.body).toMatchObject({ status: "paid", amount_due: 0, amount_paid: 0, attempted: false });
    expect(res.body.payments.total_count).toBe(0);
    expect(types(hooks.events)).toEqual(expect.arrayContaining(["invoice.finalized", "invoice.paid"]));
    expect(types(hooks.events)).not.toContain("invoice.payment_succeeded");
    expect(types(hooks.events).some((t) => t.startsWith("payment_intent."))).toBe(false);
  });
});

describe("paying", () => {
  it("charges the customer's default card", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId, pmId } = await customerWithCard(ctx);
    const { invoice } = await draftInvoice(ctx, customerId);
    await api(ctx.app, "POST", `/v1/invoices/${invoice.id}/finalize`);
    const hooks = captureWebhooks();

    const res = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoice.id}/pay`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "paid",
      amount_paid: 2000,
      amount_remaining: 0,
      attempted: true,
      attempt_count: 1,
      auto_advance: false,
    });
    expect(res.body.status_transitions.paid_at).toEqual(expect.any(Number));

    expectInOrder(hooks.events, [
      "charge.succeeded",
      "invoice.paid",
      "invoice.payment_succeeded",
      "invoice_payment.paid",
    ]);
    expect(types(hooks.events)).toContain("payment_intent.succeeded");
    expect(types(hooks.events)).toContain("invoice.updated");
    const charge = hooks.ofType("charge.succeeded")[0].data.object as Json;
    expect(charge).toMatchObject({ amount: 2000, customer: customerId, payment_method: pmId });
    const paid = hooks.ofType("invoice_payment.paid")[0].data.object as Json;
    expect(paid).toMatchObject({ status: "paid", amount_paid: 2000, invoice: invoice.id });

    const again = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoice.id}/pay`);
    expect(again.status).toBe(400);
  });

  it("finalizes a draft first, so finalized_at equals paid_at", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customerWithCard(ctx);
    const { invoice } = await draftInvoice(ctx, customerId);
    const hooks = captureWebhooks();

    const res = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoice.id}/pay`);
    expect(res.body.status).toBe("paid");
    expect(res.body.number).toEqual(expect.any(String));
    expect(res.body.status_transitions.finalized_at).toBe(res.body.status_transitions.paid_at);
    expectInOrder(hooks.events, ["invoice.finalized", "charge.succeeded", "invoice.paid"]);
  });

  it("leaves the invoice open when the card declines", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customerWithCard(ctx, "pm_card_chargeCustomerFail");
    const { invoice } = await draftInvoice(ctx, customerId);
    await api(ctx.app, "POST", `/v1/invoices/${invoice.id}/finalize`);
    const hooks = captureWebhooks();

    const res = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoice.id}/pay`);
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ type: "card_error", code: "card_declined" });

    const after = await api<Json>(ctx.app, "GET", `/v1/invoices/${invoice.id}`);
    expect(after.body).toMatchObject({ status: "open", attempt_count: 1, attempted: true, amount_paid: 0 });
    expectInOrder(hooks.events, ["charge.failed", "invoice.updated", "invoice.payment_failed"]);
    const updated = hooks.ofType("invoice.updated")[0];
    expect(updated.data.previous_attributes).toMatchObject({ attempt_count: 0, attempted: false });

    // A manual attempt is not an automatic payment failure, so the customer is not delinquent.
    const customer = await api<Json>(ctx.app, "GET", `/v1/customers/${customerId}`);
    expect(customer.body.delinquent).toBe(false);
  });

  it("counts only the first manual attempt in attempt_count", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customerWithCard(ctx, "pm_card_chargeCustomerFail");
    const { invoice } = await draftInvoice(ctx, customerId);
    await api(ctx.app, "POST", `/v1/invoices/${invoice.id}/finalize`);

    expect((await api(ctx.app, "POST", `/v1/invoices/${invoice.id}/pay`)).status).toBe(402);
    const hooks = captureWebhooks();
    expect((await api(ctx.app, "POST", `/v1/invoices/${invoice.id}/pay`)).status).toBe(402);
    const second = await api<Json>(ctx.app, "GET", `/v1/invoices/${invoice.id}`);
    expect(second.body).toMatchObject({ status: "open", attempt_count: 1, attempted: true });
    expect(types(hooks.events)).toContain("invoice.payment_failed");

    const paid = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoice.id}/pay`, {
      payment_method: "pm_card_visa",
    });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: "paid", attempt_count: 1 });
  });

  it("makes the customer delinquent when an automatic attempt fails, and counts each retry", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customerWithCard(ctx, "pm_card_chargeCustomerFail");
    const { invoice } = await draftInvoice(ctx, customerId);
    await api(ctx.app, "POST", `/v1/invoices/${invoice.id}/finalize`);
    const ss = getStripeStore(ctx.store);
    const hooks = captureWebhooks();

    for (let attempt = 1; attempt <= 2; attempt++) {
      const ev = eventBatch(ctx);
      const stored = ss.invoices.findOneBy("stripe_id", invoice.id)!;
      const result = payInvoice({ store: ctx.store, baseUrl: base }, ev, stored, { automatic: true });
      await ev.commit();
      expect(result.ok).toBe(false);
      expect(ss.invoices.findOneBy("stripe_id", invoice.id)!.attempt_count).toBe(attempt);
    }

    const delinquency = hooks.ofType("customer.updated");
    expect(delinquency).toHaveLength(1);
    expect(delinquency[0].data.object).toMatchObject({ id: customerId, delinquent: true });
    expect(delinquency[0].data.previous_attributes).toEqual({ delinquent: false });
    expectInOrder(hooks.events, ["invoice.payment_failed", "customer.updated", "invoice.payment_failed"]);
    const customer = await api<Json>(ctx.app, "GET", `/v1/customers/${customerId}`);
    expect(customer.body.delinquent).toBe(true);
  });

  it("asks for authentication, then pays once the customer authenticates", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customerWithCard(ctx, "pm_card_authenticationRequired");
    const { invoice } = await draftInvoice(ctx, customerId);
    await api(ctx.app, "POST", `/v1/invoices/${invoice.id}/finalize`);
    const hooks = captureWebhooks();

    const res = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoice.id}/pay`);
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: "invoice_payment_intent_requires_action" });

    const open = await api<Json>(ctx.app, "GET", `/v1/invoices/${invoice.id}`, undefined, {});
    expect(open.body.status).toBe("open");
    const withPayments = await sdk(ctx.app).invoices.retrieve(invoice.id, {
      expand: ["payments.data.payment.payment_intent"],
    });
    const pi = withPayments.payments!.data[0].payment.payment_intent as Stripe.PaymentIntent;
    expect(pi.status).toBe("requires_action");
    expectInOrder(hooks.events, ["invoice.payment_action_required", "invoice.payment_failed"]);
    expect(types(hooks.events)).not.toContain("charge.failed");

    const auth = await api<Json>(ctx.app, "POST", `/_stripe/simulate/payment_intents/${pi.id}/authenticate`, {
      result: "succeed",
    });
    expect(auth.body.status).toBe("succeeded");
    const paid = await api<Json>(ctx.app, "GET", `/v1/invoices/${invoice.id}`);
    expect(paid.body).toMatchObject({ status: "paid", amount_paid: 2000 });
    expectInOrder(hooks.events, ["invoice.payment_failed", "charge.succeeded", "invoice.paid"]);
    const paidEvent = hooks.ofType("invoice.paid")[0];
    expect(paidEvent.request).toEqual({ id: null, idempotency_key: null });
  });

  it("charges an explicit payment_method and records paid_out_of_band without a charge", async () => {
    const ctx = createTestApp({ webhook: true });
    const customer = await api<Json>(ctx.app, "POST", "/v1/customers", { email: "nocard@example.com" });
    const { invoice } = await draftInvoice(ctx, customer.body.id);

    const noCard = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoice.id}/pay`);
    expect(noCard.status).toBe(400);
    expect(noCard.body.error).toMatchObject({ type: "invalid_request_error", code: "resource_missing" });

    const paid = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoice.id}/pay`, {
      payment_method: "pm_card_mastercard",
    });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe("paid");

    const second = await draftInvoice(ctx, customer.body.id);
    await api(ctx.app, "POST", `/v1/invoices/${second.invoice.id}/finalize`);
    const hooks = captureWebhooks();
    const oob = await api<Json>(ctx.app, "POST", `/v1/invoices/${second.invoice.id}/pay`, {
      paid_out_of_band: "true",
      expand: ["amount_paid_off_stripe", "payments"],
    });
    expect(oob.body).toMatchObject({ status: "paid", amount_paid: 2000, amount_paid_off_stripe: 2000 });
    expect(oob.body.payments.data[0].status).toBe("canceled");
    expect(types(hooks.events)).toContain("invoice.paid");
    expect(types(hooks.events)).toContain("payment_intent.canceled");
    expect(types(hooks.events)).not.toContain("invoice.payment_succeeded");
    expect(types(hooks.events)).not.toContain("charge.succeeded");
  });

  it("refuses to cancel the PaymentIntent of an invoice directly", async () => {
    const ctx = createTestApp();
    const { customerId } = await customerWithCard(ctx);
    const { invoice } = await draftInvoice(ctx, customerId);
    const open = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoice.id}/finalize`, { expand: ["payments"] });
    const piId = open.body.payments.data[0].payment.payment_intent;
    const cancel = await api<Json>(ctx.app, "POST", `/v1/payment_intents/${piId}/cancel`);
    expect(cancel.status).toBe(400);
  });
});

describe("status transitions", () => {
  it("voids open invoices only", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customerWithCard(ctx);
    const first = await draftInvoice(ctx, customerId);
    const open = await api<Json>(ctx.app, "POST", `/v1/invoices/${first.invoice.id}/finalize`, {
      expand: ["payments"],
    });
    const hooks = captureWebhooks();

    const voided = await api<Json>(ctx.app, "POST", `/v1/invoices/${first.invoice.id}/void`, {
      expand: ["payments"],
    });
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe("void");
    expect(voided.body.status_transitions.voided_at).toEqual(expect.any(Number));
    expect(voided.body.payments.data[0].status).toBe("canceled");
    expect(types(hooks.events)).toContain("invoice.voided");
    const pi = await api<Json>(
      ctx.app,
      "GET",
      `/v1/payment_intents/${open.body.payments.data[0].payment.payment_intent}`,
    );
    expect(pi.body.status).toBe("canceled");

    const second = await draftInvoice(ctx, customerId);
    await api(ctx.app, "POST", `/v1/invoices/${second.invoice.id}/pay`);
    const paidVoid = await api<Json>(ctx.app, "POST", `/v1/invoices/${second.invoice.id}/void`);
    expect(paidVoid.status).toBe(400);

    const third = await draftInvoice(ctx, customerId);
    const draftVoid = await api<Json>(ctx.app, "POST", `/v1/invoices/${third.invoice.id}/void`);
    expect(draftVoid.status).toBe(400);
  });

  it("marks an open invoice uncollectible, which can still be paid", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customerWithCard(ctx);
    const { invoice } = await draftInvoice(ctx, customerId);
    await api(ctx.app, "POST", `/v1/invoices/${invoice.id}/finalize`);
    const ss = getStripeStore(ctx.store);
    const stored = ss.customers.findOneBy("stripe_id", customerId)!;
    ss.customers.update(stored.id, { delinquent: true });
    const hooks = captureWebhooks();

    const res = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoice.id}/mark_uncollectible`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("uncollectible");
    expect(res.body.status_details).toEqual({ uncollectible: { reason: "user_forgiven" } });
    expect(res.body.status_transitions.marked_uncollectible_at).toEqual(expect.any(Number));
    expect(types(hooks.events)).toContain("invoice.marked_uncollectible");
    const delinquency = hooks.ofType("customer.updated")[0];
    expect(delinquency.data.object).toMatchObject({ delinquent: false });
    expect(delinquency.data.previous_attributes).toEqual({ delinquent: true });

    const paid = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoice.id}/pay`);
    expect(paid.body.status).toBe("paid");
    expect(paid.body).not.toHaveProperty("status_details");
  });

  it("deletes drafts only", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customerWithCard(ctx);
    const { invoice, item } = await draftInvoice(ctx, customerId);
    const hooks = captureWebhooks();

    const deleted = await api<Json>(ctx.app, "DELETE", `/v1/invoices/${invoice.id}`);
    expect(deleted.body).toEqual({ id: invoice.id, object: "invoice", deleted: true });
    expect(types(hooks.events)).toContain("invoice.deleted");
    expect((await api(ctx.app, "GET", `/v1/invoices/${invoice.id}`)).status).toBe(404);
    expect((await api(ctx.app, "GET", `/v1/invoiceitems/${item.id}`)).status).toBe(404);

    const open = await draftInvoice(ctx, customerId);
    await api(ctx.app, "POST", `/v1/invoices/${open.invoice.id}/finalize`);
    const refused = await api<Json>(ctx.app, "DELETE", `/v1/invoices/${open.invoice.id}`);
    expect(refused.status).toBe(400);
  });

  it("updates editable fields and sends invoice.updated with the old values", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customerWithCard(ctx);
    const { invoice } = await draftInvoice(ctx, customerId);
    const hooks = captureWebhooks();

    const res = await api<Json>(ctx.app, "POST", `/v1/invoices/${invoice.id}`, {
      description: "Consulting",
      metadata: { order: "42" },
      auto_advance: "true",
    });
    expect(res.body).toMatchObject({ description: "Consulting", metadata: { order: "42" }, auto_advance: true });
    expect(res.body.automatically_finalizes_at).toBe(invoice.created + DRAFT_FINALIZE_DELAY);
    const updated = hooks.ofType("invoice.updated")[0];
    expect(updated.data.previous_attributes).toMatchObject({
      description: null,
      metadata: { order: null },
      auto_advance: false,
    });
  });
});

describe("listing", () => {
  it("retrieves through stripe-node with nested expansion and filters lists", async () => {
    const ctx = createTestApp();
    const { customerId } = await customerWithCard(ctx);
    const other = await customerWithCard(ctx);
    const paid = await draftInvoice(ctx, customerId);
    await api(ctx.app, "POST", `/v1/invoices/${paid.invoice.id}/pay`);
    const draft = await draftInvoice(ctx, customerId);
    await draftInvoice(ctx, other.customerId);

    const stripe = sdk(ctx.app);
    const retrieved = await stripe.invoices.retrieve(paid.invoice.id, {
      expand: ["payments.data.payment.payment_intent", "customer"],
    });
    const payment = retrieved.payments!.data[0];
    const pi = payment.payment.payment_intent as Stripe.PaymentIntent;
    expect(pi.object).toBe("payment_intent");
    expect(pi.status).toBe("succeeded");
    expect((retrieved.customer as Stripe.Customer).id).toBe(customerId);

    const mine = await stripe.invoices.list({ customer: customerId });
    expect(mine.data.map((i) => i.id)).toEqual([draft.invoice.id, paid.invoice.id]);
    const drafts = await stripe.invoices.list({ customer: customerId, status: "draft" });
    expect(drafts.data.map((i) => i.id)).toEqual([draft.invoice.id]);

    const payments = await stripe.invoicePayments.list({ invoice: paid.invoice.id });
    expect(payments.data).toHaveLength(1);
    const byIntent = await stripe.invoicePayments.list({
      payment: { type: "payment_intent", payment_intent: pi.id },
    });
    expect(byIntent.data.map((p) => p.id)).toEqual([payment.id]);
    const one = await stripe.invoicePayments.retrieve(payment.id);
    expect(one.status).toBe("paid");
    const none = await stripe.invoicePayments.list({ invoice: paid.invoice.id, status: "open" });
    expect(none.data).toHaveLength(0);
  });

  it("paginates lines in order", async () => {
    const ctx = createTestApp();
    const { customerId } = await customerWithCard(ctx);
    const invoice = await api<Json>(ctx.app, "POST", "/v1/invoices", { customer: customerId });
    const ids: string[] = [];
    for (const amount of [100, 200, 300]) {
      const item = await api<Json>(ctx.app, "POST", "/v1/invoiceitems", {
        customer: customerId,
        invoice: invoice.body.id,
        amount,
        currency: "usd",
        description: `Item ${amount}`,
      });
      ids.push(item.body.id);
    }

    const first = await api<Json>(ctx.app, "GET", `/v1/invoices/${invoice.body.id}/lines?limit=2`);
    expect(first.body).toMatchObject({ object: "list", has_more: true, url: `/v1/invoices/${invoice.body.id}/lines` });
    expect(first.body.data.map((l: Json) => l.parent.invoice_item_details.invoice_item)).toEqual(ids.slice(0, 2));
    const next = await api<Json>(
      ctx.app,
      "GET",
      `/v1/invoices/${invoice.body.id}/lines?limit=2&starting_after=${first.body.data[1].id}`,
    );
    expect(next.body.has_more).toBe(false);
    expect(next.body.data.map((l: Json) => l.amount)).toEqual([300]);
    expect(next.body.data[0]).toMatchObject({ description: "Item 300", pricing: null, quantity: 1 });

    const lines = await sdk(ctx.app).invoices.listLineItems(invoice.body.id, { limit: 10 });
    expect(lines.data).toHaveLength(3);
  });
});

describe("invoice items", () => {
  it("creates, updates and deletes items on a draft", async () => {
    const ctx = createTestApp({ webhook: true });
    const { customerId } = await customerWithCard(ctx);
    const { invoice, item } = await draftInvoice(ctx, customerId);
    const hooks = captureWebhooks();

    const updated = await api<Json>(ctx.app, "POST", `/v1/invoiceitems/${item.id}`, {
      quantity: 3,
      metadata: { note: "x" },
    });
    expect(updated.body).toMatchObject({ amount: 6000, quantity: 3, metadata: { note: "x" } });
    const reloaded = await api<Json>(ctx.app, "GET", `/v1/invoices/${invoice.id}`);
    expect(reloaded.body.total).toBe(6000);
    expect(reloaded.body.lines.data[0].quantity).toBe(3);

    const listed = await api<Json>(ctx.app, "GET", `/v1/invoiceitems?customer=${customerId}`);
    expect(listed.body.data.map((i: Json) => i.id)).toEqual([item.id]);

    const deleted = await api<Json>(ctx.app, "DELETE", `/v1/invoiceitems/${item.id}`);
    expect(deleted.body).toEqual({ id: item.id, object: "invoiceitem", deleted: true });
    expect(types(hooks.events)).toContain("invoiceitem.deleted");
    const emptied = await api<Json>(ctx.app, "GET", `/v1/invoices/${invoice.id}`);
    expect(emptied.body.lines.total_count).toBe(0);
  });

  it("validates the customer, the price and the invoice", async () => {
    const ctx = createTestApp();
    const { customerId } = await customerWithCard(ctx);
    const missingCustomer = await api<Json>(ctx.app, "POST", "/v1/invoiceitems", { amount: 100, currency: "usd" });
    expect(missingCustomer.status).toBe(400);
    expect(missingCustomer.body.error.param).toBe("customer");

    const noAmount = await api<Json>(ctx.app, "POST", "/v1/invoiceitems", { customer: customerId });
    expect(noAmount.status).toBe(400);

    const badPrice = await api<Json>(ctx.app, "POST", "/v1/invoiceitems", {
      customer: customerId,
      pricing: { price: "price_missing" },
    });
    expect(badPrice.status).toBe(400);
    expect(badPrice.body.error.code).toBe("resource_missing");

    const { invoice, item } = await draftInvoice(ctx, customerId);
    await api(ctx.app, "POST", `/v1/invoices/${invoice.id}/finalize`);
    const late = await api<Json>(ctx.app, "POST", "/v1/invoiceitems", {
      customer: customerId,
      invoice: invoice.id,
      amount: 100,
      currency: "usd",
    });
    expect(late.status).toBe(400);
    expect(late.body.error.code).toBe("invoice_not_editable");
    const locked = await api<Json>(ctx.app, "DELETE", `/v1/invoiceitems/${item.id}`);
    expect(locked.status).toBe(400);
  });
});
