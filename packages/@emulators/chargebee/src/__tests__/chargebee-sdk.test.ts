import { beforeEach, describe, expect, it } from "vitest";
import Chargebee from "chargebee";
import {
  DEFAULT_ADDON_PRICE_ID,
  DEFAULT_API_KEY,
  DEFAULT_CUSTOMER_ID,
  DEFAULT_PLAN_MONTHLY_PRICE_ID,
} from "../index.js";
import { createChargebeeTestApp, type ChargebeeTestApp } from "./helpers.js";

function createClient(ctx: ChargebeeTestApp) {
  return new Chargebee({
    site: "localhost",
    apiKey: DEFAULT_API_KEY,
    protocol: "http",
    hostSuffix: "",
    port: 4314,
    httpClient: {
      makeApiRequest: (request: Request) => ctx.app.request(request),
    },
  } as ConstructorParameters<typeof Chargebee>[0]);
}

describe("Chargebee Node SDK against the emulator", () => {
  let ctx: ChargebeeTestApp;
  let chargebee: Chargebee;

  beforeEach(() => {
    ctx = createChargebeeTestApp();
    chargebee = createClient(ctx);
  });

  it("creates and lists customers with filters", async () => {
    const created = await chargebee.customer.create({
      first_name: "SDK",
      last_name: "User",
      email: "sdk@example.com",
      cf_company: "cmp_sdk",
    } as Record<string, unknown>);
    expect(created.customer.email).toBe("sdk@example.com");
    expect((created.customer as Record<string, unknown>).cf_company).toBe("cmp_sdk");

    const listed = await chargebee.customer.list({ email: { is: "sdk@example.com" }, limit: 10 });
    expect(listed.list).toHaveLength(1);
    expect(listed.list[0].customer.id).toBe(created.customer.id);

    const retrieved = await chargebee.customer.retrieve(created.customer.id);
    expect(retrieved.customer.first_name).toBe("SDK");
  });

  it("lists catalog and creates subscriptions", async () => {
    const prices = await chargebee.itemPrice.list({ item_type: { is: "plan" }, limit: 100 });
    expect(prices.list.map((row) => row.item_price.id)).toContain(DEFAULT_PLAN_MONTHLY_PRICE_ID);

    const result = await chargebee.subscription.createWithItems(DEFAULT_CUSTOMER_ID, {
      subscription_items: [
        { item_price_id: DEFAULT_PLAN_MONTHLY_PRICE_ID },
        { item_price_id: DEFAULT_ADDON_PRICE_ID, quantity: 4 },
      ],
    });
    expect(result.subscription.status).toBe("active");
    expect(result.subscription.subscription_items).toHaveLength(2);
    expect(result.invoice?.status).toBe("paid");
    expect(result.invoice?.total).toBe(4000);

    const subscriptions = await chargebee.subscription.list({ customer_id: { is: DEFAULT_CUSTOMER_ID } });
    expect(subscriptions.list.length).toBe(2);

    const invoices = await chargebee.invoice.list({ subscription_id: { is: result.subscription.id } });
    expect(invoices.list).toHaveLength(1);

    const updated = await chargebee.subscription.updateForItems(result.subscription.id, {
      subscription_items: [{ item_price_id: DEFAULT_ADDON_PRICE_ID, quantity: 6 }],
    });
    expect(
      updated.subscription.subscription_items?.find((item) => item.item_price_id === DEFAULT_ADDON_PRICE_ID)?.quantity,
    ).toBe(6);

    const cancelled = await chargebee.subscription.cancelForItems(result.subscription.id, { end_of_term: true });
    expect(cancelled.subscription.status).toBe("non_renewing");
    const restored = await chargebee.subscription.removeScheduledCancellation(result.subscription.id);
    expect(restored.subscription.status).toBe("active");
  });

  it("surfaces Chargebee errors", async () => {
    await expect(chargebee.customer.retrieve("missing")).rejects.toMatchObject({
      api_error_code: "resource_not_found",
      http_status_code: 404,
    });
  });

  it("supports the time machine helpers", async () => {
    const before = await chargebee.subscription.retrieve("local-subscription");
    const result = await chargebee.timeMachine.travelForward("delorean", {
      destination_time: (before.subscription.current_term_end ?? 0) + 60,
    });
    expect(result.time_machine.time_travel_status).toBe("succeeded");
    const after = await chargebee.subscription.retrieve("local-subscription");
    expect(after.subscription.current_term_start).toBe(before.subscription.current_term_end);
  });
});
