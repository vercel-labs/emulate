import { describe, it, expect } from "vitest";
import Stripe from "stripe";
import { createTestApp, api, sdk, type TestApp } from "./support.js";

type Json = Record<string, any>;

/** The JSON a stripe-node object was parsed from. */
function wire<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value));
}

async function subscribedCustomer(ctx: TestApp) {
  const customer = await api<Json>(ctx.app, "POST", "/v1/customers", {
    email: "entitled@example.com",
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" },
  });
  const price = await api<Json>(ctx.app, "POST", "/v1/prices", {
    product_data: { name: "Pro" },
    currency: "usd",
    unit_amount: 2000,
    recurring: { interval: "month" },
  });
  const subscribe = () =>
    api<Json>(ctx.app, "POST", "/v1/subscriptions", { customer: customer.body.id, items: [{ price: price.body.id }] });
  return { customerId: customer.body.id as string, subscribe };
}

describe("includable customer fields", () => {
  it("leaves the includable fields out unless they are expanded", async () => {
    const ctx = createTestApp();
    const { customerId } = await subscribedCustomer(ctx);
    const res = await api<Json>(ctx.app, "GET", `/v1/customers/${customerId}`);
    for (const key of ["subscriptions", "sources", "tax_ids", "cash_balance", "invoice_credit_balance"]) {
      expect(res.body).not.toHaveProperty(key);
    }
  });

  it("expands the customer's current subscriptions, newest first, without the canceled ones", async () => {
    const ctx = createTestApp();
    const { customerId, subscribe } = await subscribedCustomer(ctx);
    const first = await subscribe();
    const canceled = await subscribe();
    await api(ctx.app, "DELETE", `/v1/subscriptions/${canceled.body.id}`);
    const latest = await subscribe();

    const customer = wire(await sdk(ctx.app).customers.retrieve(customerId, { expand: ["subscriptions"] }));
    expect(customer.subscriptions).toMatchObject({
      object: "list",
      has_more: false,
      total_count: 2,
      url: `/v1/customers/${customerId}/subscriptions`,
    });
    expect(customer.subscriptions.data.map((s: Json) => s.id)).toEqual([latest.body.id, first.body.id]);
    const own = await api<Json>(ctx.app, "GET", `/v1/subscriptions/${first.body.id}`);
    expect(customer.subscriptions.data[1]).toEqual(own.body);
  });

  it("expands subscriptions on every customer of a list, and nests further expansions", async () => {
    const ctx = createTestApp();
    const { customerId, subscribe } = await subscribedCustomer(ctx);
    const sub = await subscribe();

    const list = await sdk(ctx.app).customers.list({
      email: "entitled@example.com",
      expand: ["data.subscriptions.data.latest_invoice"],
    });
    const [customer] = wire(list).data;
    expect(customer.id).toBe(customerId);
    expect(customer.subscriptions.data[0]).toMatchObject({
      id: sub.body.id,
      status: "active",
      latest_invoice: { object: "invoice", id: sub.body.latest_invoice, status: "paid" },
    });

    const empty = await api<Json>(ctx.app, "POST", "/v1/customers", { email: "nobody@example.com" });
    const none = await api<Json>(ctx.app, "GET", `/v1/customers/${empty.body.id}?expand[]=subscriptions`);
    expect(none.body.subscriptions).toEqual({
      object: "list",
      data: [],
      has_more: false,
      total_count: 0,
      url: `/v1/customers/${empty.body.id}/subscriptions`,
    });
  });

  it("expands sources, tax_ids, cash_balance and invoice_credit_balance", async () => {
    const ctx = createTestApp();
    const { customerId } = await subscribedCustomer(ctx);
    const customer = wire(
      await sdk(ctx.app).customers.retrieve(customerId, {
        expand: ["sources", "tax_ids", "cash_balance", "invoice_credit_balance"],
      }),
    ) as Stripe.Customer & Json;
    expect(customer.sources).toEqual({
      object: "list",
      data: [],
      has_more: false,
      total_count: 0,
      url: `/v1/customers/${customerId}/sources`,
    });
    expect(customer.tax_ids).toEqual({
      object: "list",
      data: [],
      has_more: false,
      total_count: 0,
      url: `/v1/customers/${customerId}/tax_ids`,
    });
    expect(customer.cash_balance).toEqual({
      object: "cash_balance",
      available: null,
      customer: customerId,
      customer_account: null,
      livemode: false,
      settings: { reconciliation_mode: "automatic", using_merchant_default: true },
    });
    expect(customer.invoice_credit_balance).toEqual({});
  });

  it("expands subscriptions in the response of a customer update", async () => {
    const ctx = createTestApp();
    const { customerId, subscribe } = await subscribedCustomer(ctx);
    const sub = await subscribe();
    const updated = await api<Json>(ctx.app, "POST", `/v1/customers/${customerId}`, {
      name: "Renamed",
      expand: ["subscriptions"],
    });
    expect(updated.body.name).toBe("Renamed");
    expect(updated.body.subscriptions.data.map((s: Json) => s.id)).toEqual([sub.body.id]);
  });
});
