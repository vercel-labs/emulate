import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DECLINED_TEST_CARD_NUMBER,
  DEFAULT_ADDON_PRICE_ID,
  DEFAULT_API_KEY,
  DEFAULT_CHARGE_PRICE_ID,
  DEFAULT_COUPON_ID,
  DEFAULT_CUSTOMER_ID,
  DEFAULT_PLAN_MONTHLY_PRICE_ID,
  DEFAULT_SUBSCRIPTION_ID,
} from "../index.js";
import {
  api,
  basicAuth,
  chargebeeTestBaseUrl,
  createChargebeeTestApp,
  eventTypes,
  form,
  type ChargebeeTestApp,
} from "./helpers.js";

const MONTH_SECONDS = 32 * 86400;

async function createCustomer(app: ChargebeeTestApp["app"], overrides: Record<string, string> = {}) {
  const res = await api(app, "POST", "/customers", {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane@example.com",
    company: "Acme",
    "card[number]": "4111111111111111",
    "card[expiry_month]": 12,
    "card[expiry_year]": 2035,
    ...overrides,
  });
  expect(res.status).toBe(200);
  return res.body.customer as { id: string; [key: string]: unknown };
}

describe("Chargebee plugin", () => {
  let ctx: ChargebeeTestApp;

  beforeEach(() => {
    ctx = createChargebeeTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("authentication", () => {
    it("rejects requests without a valid API key", async () => {
      const missing = await ctx.app.request(`${chargebeeTestBaseUrl}/api/v2/customers`);
      expect(missing.status).toBe(401);
      const body = (await missing.json()) as { api_error_code: string; http_status_code: number };
      expect(body.api_error_code).toBe("api_authentication_failed");
      expect(body.http_status_code).toBe(401);

      const wrong = await api(ctx.app, "GET", "/customers", undefined, "not_a_key");
      expect(wrong.status).toBe(401);
    });

    it("accepts the seeded API key as the Basic auth username", async () => {
      const res = await ctx.app.request(`${chargebeeTestBaseUrl}/api/v2/customers`, {
        headers: { Authorization: basicAuth(DEFAULT_API_KEY) },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("customers", () => {
    it("creates, retrieves, updates, and lists customers with Chargebee shapes", async () => {
      const customer = await createCustomer(ctx.app, { "billing_address[city]": "Paris", cf_company: "cmp_123" });
      expect(customer.object).toBe("customer");
      expect(customer.email).toBe("jane@example.com");
      expect(customer.card_status).toBe("valid");
      expect(customer.cf_company).toBe("cmp_123");
      expect((customer.billing_address as { city: string }).city).toBe("Paris");

      const fetched = await api(ctx.app, "GET", `/customers/${customer.id}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.customer.id).toBe(customer.id);
      expect(fetched.body.card.masked_number).toBe("************1111");

      const updated = await api(ctx.app, "POST", `/customers/${customer.id}`, {
        company: "Acme Corp",
        cf_grade: "gold",
      });
      expect(updated.body.customer.company).toBe("Acme Corp");
      expect(updated.body.customer.cf_company).toBe("cmp_123");
      expect(updated.body.customer.cf_grade).toBe("gold");

      const byEmail = await api(ctx.app, "GET", "/customers?email[is]=jane%40example.com");
      expect(byEmail.body.list).toHaveLength(1);
      expect(byEmail.body.list[0].customer.id).toBe(customer.id);

      const byCustomField = await api(ctx.app, "GET", "/customers?cf_company[is]=cmp_123");
      expect(byCustomField.body.list.map((row: any) => row.customer.id)).toEqual([customer.id]);

      const none = await api(ctx.app, "GET", "/customers?email[is]=nobody%40example.com");
      expect(none.body.list).toHaveLength(0);
    });

    it("paginates with limit and next_offset", async () => {
      for (const name of ["a", "b", "c"]) {
        await api(ctx.app, "POST", "/customers", { first_name: name, email: `${name}@example.com` });
      }
      const first = await api(ctx.app, "GET", "/customers?limit=2&sort_by[asc]=created_at");
      expect(first.body.list).toHaveLength(2);
      expect(first.body.next_offset).toBeDefined();
      const second = await api(
        ctx.app,
        "GET",
        `/customers?limit=2&sort_by[asc]=created_at&offset=${encodeURIComponent(first.body.next_offset)}`,
      );
      expect(second.body.list.length).toBeGreaterThanOrEqual(1);
      expect(second.body.list[0].customer.id).not.toBe(first.body.list[0].customer.id);
    });

    it("returns Chargebee-format errors", async () => {
      const missing = await api(ctx.app, "GET", "/customers/does_not_exist");
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({
        api_error_code: "resource_not_found",
        type: "invalid_request",
        http_status_code: 404,
      });

      const duplicate = await api(ctx.app, "POST", "/customers", { id: DEFAULT_CUSTOMER_ID });
      expect(duplicate.status).toBe(400);
      expect(duplicate.body.api_error_code).toBe("duplicate_entry");
    });

    it("deletes a customer and its subscriptions", async () => {
      const res = await api(ctx.app, "POST", `/customers/${DEFAULT_CUSTOMER_ID}/delete`);
      expect(res.status).toBe(200);
      expect(res.body.customer.deleted).toBe(true);
      expect((await api(ctx.app, "GET", `/customers/${DEFAULT_CUSTOMER_ID}`)).status).toBe(404);
      expect((await api(ctx.app, "GET", `/subscriptions/${DEFAULT_SUBSCRIPTION_ID}`)).status).toBe(404);
      const events = await api(ctx.app, "GET", "/events?event_type[is]=customer_deleted");
      expect(events.body.list).toHaveLength(1);
    });

    it("supports account hierarchy relationships", async () => {
      const parent = await createCustomer(ctx.app, { email: "parent@example.com" });
      const child = await createCustomer(ctx.app, { email: "child@example.com" });
      const linked = await api(ctx.app, "POST", `/customers/${child.id}/relationships`, {
        parent_id: parent.id,
        payment_owner_id: parent.id,
        invoice_owner_id: parent.id,
      });
      expect(linked.status).toBe(200);
      expect(linked.body.customer.relationship).toMatchObject({ parent_id: parent.id, root_id: parent.id });

      const hierarchy = await api(ctx.app, "GET", `/customers/${child.id}/hierarchy`);
      expect(hierarchy.body.hierarchies).toHaveLength(2);
      expect(hierarchy.body.hierarchies[0]).toMatchObject({ customer_id: parent.id, children_ids: [child.id] });

      const children = await api(ctx.app, "GET", `/customers?relationship[parent_id][is]=${parent.id}`);
      expect(children.body.list.map((row: any) => row.customer.id)).toEqual([child.id]);
    });
  });

  describe("catalog", () => {
    it("creates item families, items, and item prices with generated ids", async () => {
      const family = await api(ctx.app, "POST", "/item_families", { name: "Widgets" });
      expect(family.body.item_family.id).toBe("widgets");

      const item = await api(ctx.app, "POST", "/items", {
        id: "widget",
        name: "Widget",
        type: "plan",
        item_family_id: "widgets",
      });
      expect(item.body.item).toMatchObject({ id: "widget", type: "plan", status: "active", object: "item" });

      const price = await api(ctx.app, "POST", "/item_prices", {
        item_id: "widget",
        name: "Widget Monthly",
        pricing_model: "per_unit",
        price: 1500,
        currency_code: "eur",
        period: 1,
        period_unit: "month",
        trial_period: 14,
        trial_period_unit: "day",
      });
      expect(price.status).toBe(200);
      expect(price.body.item_price).toMatchObject({
        id: "widget-EUR-Monthly",
        item_type: "plan",
        currency_code: "EUR",
        price: 1500,
        period_unit: "month",
        object: "item_price",
      });

      const plans = await api(ctx.app, "GET", "/item_prices?item_type[is]=plan&currency_code[is]=EUR");
      expect(plans.body.list.map((row: any) => row.item_price.id)).toEqual(["widget-EUR-Monthly"]);

      const applicable = await api(
        ctx.app,
        "GET",
        `/item_prices/${DEFAULT_PLAN_MONTHLY_PRICE_ID}/applicable_item_prices`,
      );
      expect(applicable.body.list.map((row: any) => row.item_price.id).sort()).toEqual(
        [DEFAULT_ADDON_PRICE_ID, DEFAULT_CHARGE_PRICE_ID].sort(),
      );
    });

    it("seeds the default catalog and subscription", async () => {
      const prices = await api(ctx.app, "GET", "/item_prices?limit=100");
      expect(prices.body.list.map((row: any) => row.item_price.id)).toContain(DEFAULT_PLAN_MONTHLY_PRICE_ID);

      const sub = await api(ctx.app, "GET", `/subscriptions/${DEFAULT_SUBSCRIPTION_ID}`);
      expect(sub.body.subscription.status).toBe("active");
      expect(sub.body.customer.id).toBe(DEFAULT_CUSTOMER_ID);

      const invoices = await api(ctx.app, "GET", `/invoices?subscription_id[is]=${DEFAULT_SUBSCRIPTION_ID}`);
      expect(invoices.body.list).toHaveLength(1);
      expect(invoices.body.list[0].invoice).toMatchObject({ status: "paid", total: 2000, amount_paid: 2000 });
    });
  });

  describe("subscriptions", () => {
    it("creates an active subscription, invoices it, and collects payment", async () => {
      const customer = await createCustomer(ctx.app);
      const res = await api(ctx.app, "POST", `/customers/${customer.id}/subscription_for_items`, {
        id: "sub_test",
        "subscription_items[item_price_id][0]": DEFAULT_PLAN_MONTHLY_PRICE_ID,
        "subscription_items[item_price_id][1]": DEFAULT_ADDON_PRICE_ID,
        "subscription_items[quantity][1]": 3,
        "subscription_items[item_price_id][2]": DEFAULT_CHARGE_PRICE_ID,
        cf_grade: "gold",
      });
      expect(res.status).toBe(200);
      expect(res.body.subscription).toMatchObject({
        id: "sub_test",
        status: "active",
        customer_id: customer.id,
        currency_code: "USD",
        billing_period: 1,
        billing_period_unit: "month",
        cf_grade: "gold",
        object: "subscription",
      });
      expect(res.body.subscription.subscription_items).toHaveLength(3);
      expect(res.body.subscription.mrr).toBe(3500);
      expect(res.body.invoice).toMatchObject({
        status: "paid",
        recurring: true,
        first_invoice: true,
        sub_total: 8400,
        total: 8400,
        amount_paid: 8400,
        amount_due: 0,
      });
      expect(res.body.invoice.line_items.map((line: any) => line.entity_type).sort()).toEqual(
        ["addon_item_price", "charge_item_price", "plan_item_price"].sort(),
      );

      const transactions = await api(ctx.app, "GET", `/transactions?subscription_id[is]=sub_test`);
      expect(transactions.body.list).toHaveLength(1);
      expect(transactions.body.list[0].transaction).toMatchObject({ type: "payment", status: "success", amount: 8400 });

      const events = await api(ctx.app, "GET", "/events?limit=100");
      const types = eventTypes(events.body.list);
      expect(types).toContain("subscription_created");
      expect(types).toContain("invoice_generated");
      expect(types).toContain("payment_succeeded");

      const listed = await api(
        ctx.app,
        "GET",
        `/subscriptions?customer_id[is]=${customer.id}&item_price_id[is]=${DEFAULT_ADDON_PRICE_ID}`,
      );
      expect(listed.body.list.map((row: any) => row.subscription.id)).toEqual(["sub_test"]);
    });

    it("rejects auto-collected subscriptions when the customer has no payment method", async () => {
      const customer = await api(ctx.app, "POST", "/customers", { email: "nocard@example.com" });
      const res = await api(ctx.app, "POST", `/customers/${customer.body.customer.id}/subscription_for_items`, {
        "subscription_items[item_price_id][0]": DEFAULT_PLAN_MONTHLY_PRICE_ID,
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ type: "payment", api_error_code: "payment_method_not_present" });
    });

    it("leaves offline invoices in payment_due and records payments", async () => {
      const customer = await api(ctx.app, "POST", "/customers", {
        email: "offline@example.com",
        auto_collection: "off",
      });
      const res = await api(ctx.app, "POST", `/customers/${customer.body.customer.id}/subscription_for_items`, {
        "subscription_items[item_price_id][0]": DEFAULT_PLAN_MONTHLY_PRICE_ID,
      });
      expect(res.status).toBe(200);
      expect(res.body.invoice.status).toBe("payment_due");
      expect(res.body.subscription.due_invoices_count).toBe(1);

      const paid = await api(ctx.app, "POST", `/invoices/${res.body.invoice.id}/record_payment`, {
        "transaction[amount]": 2000,
        "transaction[payment_method]": "bank_transfer",
        "transaction[reference_number]": "WIRE-1",
      });
      expect(paid.status).toBe(200);
      expect(paid.body.invoice.status).toBe("paid");
      expect(paid.body.transaction).toMatchObject({
        payment_method: "bank_transfer",
        reference_number: "WIRE-1",
        gateway: "not_applicable",
      });
    });

    it("records failed payments for the declined test card", async () => {
      const customer = await createCustomer(ctx.app, {
        "card[number]": DECLINED_TEST_CARD_NUMBER,
        email: "declined@example.com",
      });
      const res = await api(ctx.app, "POST", `/customers/${customer.id}/subscription_for_items`, {
        "subscription_items[item_price_id][0]": DEFAULT_PLAN_MONTHLY_PRICE_ID,
      });
      expect(res.status).toBe(200);
      expect(res.body.subscription.status).toBe("active");
      expect(res.body.invoice).toMatchObject({ status: "payment_due", dunning_status: "in_progress" });
      const events = await api(ctx.app, "GET", "/events?event_type[is]=payment_failed");
      expect(events.body.list).toHaveLength(1);
      expect(events.body.list[0].event.content.transaction.status).toBe("failure");
    });

    it("applies coupons to the first invoice", async () => {
      const customer = await createCustomer(ctx.app);
      const res = await api(ctx.app, "POST", `/customers/${customer.id}/subscription_for_items`, {
        "subscription_items[item_price_id][0]": DEFAULT_PLAN_MONTHLY_PRICE_ID,
        "coupon_ids[0]": DEFAULT_COUPON_ID,
      });
      expect(res.status).toBe(200);
      expect(res.body.invoice.discounts).toEqual([
        expect.objectContaining({ amount: 200, entity_type: "document_level_coupon", entity_id: DEFAULT_COUPON_ID }),
      ]);
      expect(res.body.invoice.total).toBe(1800);
      expect(res.body.subscription.coupons[0]).toMatchObject({ coupon_id: DEFAULT_COUPON_ID, applied_count: 1 });
      const coupon = await api(ctx.app, "GET", `/coupons/${DEFAULT_COUPON_ID}`);
      expect(coupon.body.coupon.redemptions).toBe(1);
    });

    it("handles trials and activation through the time machine", async () => {
      await api(ctx.app, "POST", `/item_prices/${DEFAULT_PLAN_MONTHLY_PRICE_ID}`, {
        trial_period: 14,
        trial_period_unit: "day",
      });
      const customer = await createCustomer(ctx.app);
      const res = await api(ctx.app, "POST", `/customers/${customer.id}/subscription_for_items`, {
        "subscription_items[item_price_id][0]": DEFAULT_PLAN_MONTHLY_PRICE_ID,
      });
      expect(res.body.subscription.status).toBe("in_trial");
      expect(res.body.subscription.trial_end).toBeGreaterThan(res.body.subscription.trial_start);
      expect(res.body.invoice).toBeUndefined();

      const travel = await api(ctx.app, "POST", "/time_machines/delorean/travel_forward", {
        destination_time: res.body.subscription.trial_end + 60,
      });
      expect(travel.status).toBe(200);
      expect(travel.body.time_machine.time_travel_status).toBe("succeeded");

      const activated = await api(ctx.app, "GET", `/subscriptions/${res.body.subscription.id}`);
      expect(activated.body.subscription.status).toBe("active");
      expect(activated.body.subscription.current_term_start).toBe(res.body.subscription.trial_end);
      const invoices = await api(ctx.app, "GET", `/invoices?subscription_id[is]=${res.body.subscription.id}`);
      expect(invoices.body.list).toHaveLength(1);
      expect(invoices.body.list[0].invoice.status).toBe("paid");
      const events = await api(ctx.app, "GET", "/events?event_type[is]=subscription_activated");
      expect(events.body.list).toHaveLength(1);
      expect(events.body.list[0].event.source).toBe("scheduled_job");
    });

    it("renews subscriptions when time travels past the term end", async () => {
      const before = await api(ctx.app, "GET", `/subscriptions/${DEFAULT_SUBSCRIPTION_ID}`);
      const termEnd = before.body.subscription.current_term_end as number;
      await api(ctx.app, "POST", "/time_machines/delorean/travel_forward", { destination_time: termEnd + 3600 });

      const after = await api(ctx.app, "GET", `/subscriptions/${DEFAULT_SUBSCRIPTION_ID}`);
      expect(after.body.subscription.current_term_start).toBe(termEnd);
      expect(after.body.subscription.next_billing_at).toBeGreaterThan(termEnd);
      const invoices = await api(
        ctx.app,
        "GET",
        `/invoices?subscription_id[is]=${DEFAULT_SUBSCRIPTION_ID}&sort_by[asc]=date`,
      );
      expect(invoices.body.list).toHaveLength(2);
      expect(invoices.body.list[1].invoice).toMatchObject({ status: "paid", first_invoice: false, total: 2000 });
      const renewed = await api(ctx.app, "GET", "/events?event_type[is]=subscription_renewed");
      expect(renewed.body.list).toHaveLength(1);

      const machine = await api(ctx.app, "GET", "/time_machines/delorean");
      expect(machine.body.time_machine.destination_time).toBeGreaterThanOrEqual(termEnd + 3600);
    });

    it("prorates immediate changes and schedules end-of-term changes", async () => {
      const changed = await api(ctx.app, "POST", `/subscriptions/${DEFAULT_SUBSCRIPTION_ID}/update_for_items`, {
        "subscription_items[item_price_id][0]": DEFAULT_ADDON_PRICE_ID,
        "subscription_items[quantity][0]": 2,
      });
      expect(changed.status).toBe(200);
      expect(changed.body.subscription.subscription_items).toHaveLength(2);
      expect(changed.body.invoice).toBeDefined();
      expect(changed.body.invoice.line_items[0].description).toContain("Prorated Charges");
      expect(changed.body.invoice.total).toBeGreaterThan(0);
      expect(changed.body.invoice.total).toBeLessThanOrEqual(1000);
      expect(changed.body.invoice.status).toBe("paid");

      const scheduled = await api(ctx.app, "POST", `/subscriptions/${DEFAULT_SUBSCRIPTION_ID}/update_for_items`, {
        "subscription_items[item_price_id][0]": DEFAULT_PLAN_MONTHLY_PRICE_ID,
        "subscription_items[item_price_id][1]": DEFAULT_ADDON_PRICE_ID,
        "subscription_items[quantity][1]": 5,
        replace_items_list: true,
        end_of_term: true,
      });
      expect(scheduled.body.subscription.has_scheduled_changes).toBe(true);
      const withChanges = await api(
        ctx.app,
        "GET",
        `/subscriptions/${DEFAULT_SUBSCRIPTION_ID}/retrieve_with_scheduled_changes`,
      );
      expect(withChanges.body.subscription.subscription_items[1].quantity).toBe(5);
      const removed = await api(ctx.app, "POST", `/subscriptions/${DEFAULT_SUBSCRIPTION_ID}/remove_scheduled_changes`);
      expect(removed.body.subscription.has_scheduled_changes).toBe(false);
    });

    it("schedules, removes, and performs cancellations with credits", async () => {
      const scheduled = await api(ctx.app, "POST", `/subscriptions/${DEFAULT_SUBSCRIPTION_ID}/cancel_for_items`, {
        end_of_term: true,
      });
      expect(scheduled.body.subscription.status).toBe("non_renewing");
      expect(scheduled.body.subscription.cancelled_at).toBe(scheduled.body.subscription.current_term_end);

      const restored = await api(
        ctx.app,
        "POST",
        `/subscriptions/${DEFAULT_SUBSCRIPTION_ID}/remove_scheduled_cancellation`,
      );
      expect(restored.body.subscription.status).toBe("active");

      const cancelled = await api(ctx.app, "POST", `/subscriptions/${DEFAULT_SUBSCRIPTION_ID}/cancel_for_items`, {
        credit_option_for_current_term_charges: "full",
        cancel_reason_code: "Churn",
      });
      expect(cancelled.body.subscription.status).toBe("cancelled");
      expect(cancelled.body.subscription.cancel_reason_code).toBe("Churn");
      expect(cancelled.body.credit_notes).toHaveLength(1);
      expect(cancelled.body.credit_notes[0]).toMatchObject({ type: "refundable", status: "refund_due", total: 2000 });

      const notes = await api(ctx.app, "GET", `/customers/${DEFAULT_CUSTOMER_ID}/credit_notes`);
      expect(notes.body.list).toHaveLength(1);
      const customer = await api(ctx.app, "GET", `/customers/${DEFAULT_CUSTOMER_ID}`);
      expect(customer.body.customer.refundable_credits).toBe(2000);

      const reactivated = await api(ctx.app, "POST", `/subscriptions/${DEFAULT_SUBSCRIPTION_ID}/reactivate`);
      expect(reactivated.body.subscription.status).toBe("active");
      expect(reactivated.body.invoice.status).toBe("paid");
      const types = eventTypes((await api(ctx.app, "GET", "/events?limit=100")).body.list);
      expect(types).toEqual(
        expect.arrayContaining([
          "subscription_cancellation_scheduled",
          "subscription_scheduled_cancellation_removed",
          "subscription_cancelled",
          "credit_note_created",
          "subscription_reactivated",
        ]),
      );
    });

    it("pauses and resumes subscriptions", async () => {
      const paused = await api(ctx.app, "POST", `/subscriptions/${DEFAULT_SUBSCRIPTION_ID}/pause`, {
        pause_option: "immediately",
      });
      expect(paused.body.subscription.status).toBe("paused");
      const resumed = await api(ctx.app, "POST", `/subscriptions/${DEFAULT_SUBSCRIPTION_ID}/resume`, {
        resume_option: "immediately",
      });
      expect(resumed.body.subscription.status).toBe("active");
      expect(resumed.body.invoice).toBeDefined();
    });

    it("imports subscriptions without invoicing", async () => {
      const res = await api(ctx.app, "POST", `/customers/${DEFAULT_CUSTOMER_ID}/import_for_items`, {
        id: "imported",
        status: "active",
        "subscription_items[item_price_id][0]": DEFAULT_PLAN_MONTHLY_PRICE_ID,
        current_term_start: 1_700_000_000,
        current_term_end: 1_702_592_000,
        cf_billing: "legacy",
      });
      expect(res.status).toBe(200);
      expect(res.body.subscription).toMatchObject({
        id: "imported",
        status: "active",
        current_term_end: 1_702_592_000,
        cf_billing: "legacy",
      });
      expect(res.body.invoice).toBeUndefined();
      const events = await api(ctx.app, "GET", "/events?event_type[is]=subscription_created");
      expect(events.body.list).toHaveLength(0);
    });

    it("creates a customer and subscription together with create_with_items", async () => {
      const res = await api(ctx.app, "POST", "/subscriptions/create_with_items", {
        "customer[email]": "bundle@example.com",
        "customer[first_name]": "Bundle",
        "card[number]": "4111111111111111",
        "subscription_items[item_price_id][0]": DEFAULT_PLAN_MONTHLY_PRICE_ID,
      });
      expect(res.status).toBe(200);
      expect(res.body.customer.email).toBe("bundle@example.com");
      expect(res.body.subscription.status).toBe("active");
      expect(res.body.invoice.status).toBe("paid");
    });
  });

  describe("estimates", () => {
    it("estimates new subscriptions and renewals", async () => {
      const estimate = await api(ctx.app, "POST", "/estimates/create_subscription_for_items", {
        "subscription_items[item_price_id][0]": DEFAULT_PLAN_MONTHLY_PRICE_ID,
        "subscription_items[item_price_id][1]": DEFAULT_ADDON_PRICE_ID,
        "subscription_items[quantity][1]": 2,
        "coupon_ids[0]": DEFAULT_COUPON_ID,
      });
      expect(estimate.status).toBe(200);
      expect(estimate.body.estimate.invoice_estimate).toMatchObject({
        sub_total: 3000,
        total: 2700,
        object: "invoice_estimate",
      });
      expect(estimate.body.estimate.next_invoice_estimate.total).toBe(3000);

      const renewal = await api(ctx.app, "GET", `/subscriptions/${DEFAULT_SUBSCRIPTION_ID}/renewal_estimate`);
      expect(renewal.body.estimate.invoice_estimate.total).toBe(2000);
      const subscriptions = await api(ctx.app, "GET", "/subscriptions");
      expect(subscriptions.body.list).toHaveLength(1);
    });
  });

  describe("invoices", () => {
    it("creates one-off invoices and serves PDFs", async () => {
      const res = await api(ctx.app, "POST", "/invoices/create_for_charge_items_and_charges", {
        customer_id: DEFAULT_CUSTOMER_ID,
        "item_prices[item_price_id][0]": DEFAULT_CHARGE_PRICE_ID,
        "charges[amount][0]": 1000,
        "charges[description][0]": "Consulting",
      });
      expect(res.status).toBe(200);
      expect(res.body.invoice).toMatchObject({ recurring: false, total: 5900, status: "paid" });

      const pdf = await api(ctx.app, "POST", `/invoices/${res.body.invoice.id}/pdf`);
      expect(pdf.body.download.mime_type).toBe("application/pdf");
      const file = await ctx.app.request(pdf.body.download.download_url);
      expect(file.status).toBe(200);
      expect(file.headers.get("Content-Type")).toBe("application/pdf");
      expect((await file.text()).startsWith("%PDF-1.4")).toBe(true);
    });

    it("voids, refunds, and lists invoices", async () => {
      const customer = await api(ctx.app, "POST", "/customers", { email: "void@example.com", auto_collection: "off" });
      const sub = await api(ctx.app, "POST", `/customers/${customer.body.customer.id}/subscription_for_items`, {
        "subscription_items[item_price_id][0]": DEFAULT_PLAN_MONTHLY_PRICE_ID,
      });
      const voided = await api(ctx.app, "POST", `/invoices/${sub.body.invoice.id}/void`, {
        void_reason_code: "duplicate",
      });
      expect(voided.body.invoice).toMatchObject({ status: "voided", void_reason_code: "duplicate" });

      const seeded = await api(ctx.app, "GET", `/customers/${DEFAULT_CUSTOMER_ID}/invoices`);
      const refunded = await api(ctx.app, "POST", `/invoices/${seeded.body.list[0].invoice.id}/refund`, {
        refund_amount: 500,
      });
      expect(refunded.status).toBe(200);
      expect(refunded.body.transaction).toMatchObject({ type: "refund", amount: 500 });
      expect(refunded.body.credit_note).toMatchObject({ type: "refundable", status: "refunded", amount_refunded: 500 });

      const byStatus = await api(ctx.app, "GET", "/invoices?status[in]=%5B%22voided%22%5D");
      expect(byStatus.body.list.map((row: any) => row.invoice.id)).toEqual([sub.body.invoice.id]);
    });
  });

  describe("payment sources", () => {
    it("adds and removes cards", async () => {
      const customer = await api(ctx.app, "POST", "/customers", { email: "cards@example.com" });
      const customerId = customer.body.customer.id as string;
      const created = await api(ctx.app, "POST", "/payment_sources/create_card", {
        customer_id: customerId,
        "card[number]": "5555555555554444",
        "card[expiry_month]": 1,
        "card[expiry_year]": 2031,
      });
      expect(created.status).toBe(200);
      expect(created.body.payment_source).toMatchObject({ type: "card", status: "valid", object: "payment_source" });
      expect(created.body.payment_source.card).toMatchObject({ brand: "mastercard", last4: "4444" });
      expect(created.body.customer.primary_payment_source_id).toBe(created.body.payment_source.id);

      const listed = await api(ctx.app, "GET", `/payment_sources?customer_id[is]=${customerId}`);
      expect(listed.body.list).toHaveLength(1);

      const deleted = await api(ctx.app, "POST", `/payment_sources/${created.body.payment_source.id}/delete`);
      expect(deleted.body.payment_source.deleted).toBe(true);
      expect(deleted.body.customer.card_status).toBe("no_card");
      const types = eventTypes((await api(ctx.app, "GET", "/events?limit=100")).body.list);
      expect(types).toEqual(
        expect.arrayContaining(["payment_source_added", "payment_source_deleted", "card_added", "card_deleted"]),
      );
    });
  });

  describe("hosted pages and portal", () => {
    it("completes a checkout_new_for_items hosted page", async () => {
      const page = await api(ctx.app, "POST", "/hosted_pages/checkout_new_for_items", {
        "subscription_items[item_price_id][0]": DEFAULT_PLAN_MONTHLY_PRICE_ID,
        "customer[email]": "checkout@example.com",
        "customer[first_name]": "Check",
        redirect_url: "http://localhost:3000/thanks",
        cancel_url: "http://localhost:3000/cancel",
      });
      expect(page.status).toBe(200);
      expect(page.body.hosted_page).toMatchObject({ type: "checkout_new", state: "created", object: "hosted_page" });
      expect(page.body.hosted_page.url).toBe(`${chargebeeTestBaseUrl}/pages/v3/${page.body.hosted_page.id}/`);

      const html = await ctx.app.request(page.body.hosted_page.url);
      expect(html.status).toBe(200);
      expect(await html.text()).toContain("Pro Plan");

      const complete = await ctx.app.request(`${chargebeeTestBaseUrl}/pages/v3/${page.body.hosted_page.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ email: "checkout@example.com" }),
      });
      expect(complete.status).toBe(302);
      const location = new URL(complete.headers.get("Location")!);
      expect(location.origin + location.pathname).toBe("http://localhost:3000/thanks");
      expect(location.searchParams.get("id")).toBe(page.body.hosted_page.id);
      expect(location.searchParams.get("state")).toBe("succeeded");

      const retrieved = await api(ctx.app, "GET", `/hosted_pages/${page.body.hosted_page.id}`);
      expect(retrieved.body.hosted_page.state).toBe("succeeded");
      expect(retrieved.body.hosted_page.content.customer.email).toBe("checkout@example.com");
      expect(retrieved.body.hosted_page.content.subscription.status).toBe("active");
      expect(retrieved.body.hosted_page.content.invoice.status).toBe("paid");

      const acknowledged = await api(ctx.app, "POST", `/hosted_pages/${page.body.hosted_page.id}/acknowledge`);
      expect(acknowledged.body.hosted_page.state).toBe("acknowledged");
    });

    it("creates portal sessions with a working access URL", async () => {
      const session = await api(ctx.app, "POST", "/portal_sessions", {
        "customer[id]": DEFAULT_CUSTOMER_ID,
        redirect_url: "http://localhost:3000/account",
      });
      expect(session.status).toBe(200);
      expect(session.body.portal_session).toMatchObject({
        status: "created",
        customer_id: DEFAULT_CUSTOMER_ID,
        object: "portal_session",
      });
      expect(session.body.portal_session.linked_customers[0]).toMatchObject({
        has_payment_method: true,
        has_active_subscription: true,
      });

      const portal = await ctx.app.request(session.body.portal_session.access_url);
      expect(portal.status).toBe(200);
      const text = await portal.text();
      expect(text).toContain("Test Customer");
      expect(text).toContain(DEFAULT_SUBSCRIPTION_ID);

      const activated = await api(ctx.app, "POST", `/portal_sessions/${session.body.portal_session.id}/activate`, {
        token: session.body.portal_session.token,
      });
      expect(activated.body.portal_session.status).toBe("activated");
      const loggedOut = await api(ctx.app, "POST", `/portal_sessions/${session.body.portal_session.id}/logout`);
      expect(loggedOut.body.portal_session.status).toBe("logged_out");
    });

    it("serves the inspector", async () => {
      const res = await ctx.app.request(`${chargebeeTestBaseUrl}/?tab=subscriptions`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(DEFAULT_SUBSCRIPTION_ID);
    });
  });

  describe("webhooks", () => {
    it("delivers Chargebee-shaped events with Basic auth", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);
      const seeded = createChargebeeTestApp({
        webhooks: [
          {
            url: "https://hooks.example/chargebee",
            events: ["customer_created"],
            username: "hook",
            password: "secret",
          },
        ],
      });

      const res = await api(seeded.app, "POST", "/customers", { email: "hooked@example.com" });
      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe("https://hooks.example/chargebee");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("hook:secret").toString("base64")}`);
      expect(headers["X-GitHub-Event"]).toBeUndefined();
      const payload = JSON.parse((init as RequestInit).body as string);
      expect(payload).toMatchObject({ object: "event", api_version: "v2", event_type: "customer_created" });
      expect(payload.id).toMatch(/^ev_/);
      expect(payload.content.customer.email).toBe("hooked@example.com");

      const events = await api(seeded.app, "GET", `/events/${payload.id}`);
      expect(events.body.event.webhook_status).toBe("succeeded");
    });

    it("marks failed deliveries", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
      const seeded = createChargebeeTestApp({ webhooks: [{ url: "https://down.example/hook" }] });
      const res = await api(seeded.app, "POST", "/customers", { email: "down@example.com" });
      expect(res.status).toBe(200);
      const events = await api(seeded.app, "GET", "/events?event_type[is]=customer_created");
      expect(events.body.list[0].event.webhook_status).toBe("failed");
    });
  });

  describe("time machine", () => {
    it("starts afresh by clearing site data", async () => {
      const res = await api(ctx.app, "POST", "/time_machines/delorean/start_afresh", { genesis_time: 1_700_000_000 });
      expect(res.status).toBe(200);
      expect(res.body.time_machine.genesis_time).toBe(1_700_000_000);
      const customers = await api(ctx.app, "GET", "/customers");
      expect(customers.body.list).toHaveLength(0);
      const machine = await api(ctx.app, "GET", "/time_machines/delorean");
      expect(machine.body.time_machine.destination_time).toBeGreaterThanOrEqual(1_700_000_000);
      expect(machine.body.time_machine.destination_time).toBeLessThan(1_700_000_000 + MONTH_SECONDS);
    });
  });
});
