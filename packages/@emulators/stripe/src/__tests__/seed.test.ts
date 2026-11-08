import { describe, it, expect, afterEach, vi } from "vitest";
import { Store } from "@emulators/core";
import { createTestApp, captureWebhooks, api, sdk } from "./support.js";
import { seedFromConfig, stripePlugin, type StripeSeedConfig } from "../index.js";
import { getStripeStore } from "../store.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

const DAY = 86400;
const T = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);

const PLANS: StripeSeedConfig = {
  products: [{ id: "prod_pro", name: "Pro Plan" }],
  prices: [
    { id: "price_pro", product: "Pro Plan", currency: "usd", unit_amount: 2000, recurring: { interval: "month" } },
  ],
};

describe("seeded customers", () => {
  it("attaches a seeded card and makes it the invoice default", async () => {
    const ctx = createTestApp({
      seed: {
        customers: [
          {
            id: "cus_seeded",
            email: "seeded@example.com",
            payment_method: "pm_card_visa",
            invoice_settings: { default_payment_method: "pm_card_visa" },
          },
        ],
      },
    });

    const cards = await api<Json>(ctx.app, "GET", "/v1/payment_methods?customer=cus_seeded&type=card");
    expect(cards.status).toBe(200);
    expect(cards.body.data).toHaveLength(1);
    const [card] = cards.body.data;
    expect(card.id).toMatch(/^pm_/);
    expect(card.id).not.toBe("pm_card_visa");
    expect(card).toMatchObject({ object: "payment_method", customer: "cus_seeded", type: "card" });
    expect(card.card).toMatchObject({ brand: "visa", last4: "4242" });

    const customer = await api<Json>(ctx.app, "GET", "/v1/customers/cus_seeded");
    expect(customer.body.invoice_settings.default_payment_method).toBe(card.id);
  });

  it("attaches a card without making it the default, as POST /v1/customers does", async () => {
    const ctx = createTestApp({ seed: { customers: [{ id: "cus_seeded", payment_method: "pm_card_mastercard" }] } });
    const cards = await api<Json>(ctx.app, "GET", "/v1/customers/cus_seeded/payment_methods");
    expect(cards.body.data.map((pm: Json) => pm.card.last4)).toEqual(["4444"]);
    const customer = await api<Json>(ctx.app, "GET", "/v1/customers/cus_seeded");
    expect(customer.body.invoice_settings.default_payment_method).toBeNull();
  });

  it("subscribes a seeded customer with its default card and no further setup", async () => {
    const ctx = createTestApp({
      webhook: true,
      seed: {
        ...PLANS,
        customers: [
          {
            id: "cus_seeded",
            payment_method: "pm_card_visa",
            invoice_settings: { default_payment_method: "pm_card_visa" },
          },
        ],
      },
    });
    const hooks = captureWebhooks();
    const sub = await sdk(ctx.app).subscriptions.create({ customer: "cus_seeded", items: [{ price: "price_pro" }] });
    expect(sub.status).toBe("active");
    expect(hooks.ofType("invoice.paid")).toHaveLength(1);
  });

  it("refuses a default payment method that is not the seeded card", () => {
    const store = new Store();
    stripePlugin.seed?.(store, "http://localhost:14000");
    expect(() =>
      seedFromConfig(store, "http://localhost:14000", {
        customers: [{ id: "cus_bad", invoice_settings: { default_payment_method: "pm_card_visa" } }],
      }),
    ).toThrow(/cus_bad.*invoice_settings\[default_payment_method\]/);
    expect(() =>
      seedFromConfig(store, "http://localhost:14000", {
        customers: [{ id: "cus_declined", payment_method: "pm_card_visa_chargeDeclined" }],
      }),
    ).toThrow(/cus_declined.*declined/);
  });

  it("puts a seeded customer on a seeded test clock", async () => {
    const ctx = createTestApp({
      webhook: true,
      seed: {
        ...PLANS,
        test_clocks: [{ id: "clock_seeded", frozen_time: T, name: "Renewals" }],
        customers: [
          {
            id: "cus_clocked",
            test_clock: "clock_seeded",
            payment_method: "pm_card_visa",
            invoice_settings: { default_payment_method: "pm_card_visa" },
          },
        ],
      },
    });

    const clock = await api<Json>(ctx.app, "GET", "/v1/test_helpers/test_clocks/clock_seeded");
    expect(clock.status).toBe(200);
    expect(clock.body).toMatchObject({
      object: "test_helpers.test_clock",
      frozen_time: T,
      name: "Renewals",
      status: "ready",
    });
    const customer = await api<Json>(ctx.app, "GET", "/v1/customers/cus_clocked");
    expect(customer.body).toMatchObject({ test_clock: "clock_seeded", created: T });
    const cards = await api<Json>(ctx.app, "GET", "/v1/payment_methods?customer=cus_clocked&type=card");
    expect(cards.body.data[0].created).toBe(T);

    const sub = await api<Json>(ctx.app, "POST", "/v1/subscriptions", {
      customer: "cus_clocked",
      items: [{ price: "price_pro" }],
    });
    expect(sub.body).toMatchObject({ status: "active", test_clock: "clock_seeded", start_date: T });

    const hooks = captureWebhooks();
    const renewal = sub.body.items.data[0].current_period_end as number;
    await api(ctx.app, "POST", "/v1/test_helpers/test_clocks/clock_seeded/advance", { frozen_time: renewal + DAY });
    expect(hooks.ofType("invoice.paid").map((e) => (e.data.object as Json).billing_reason)).toEqual([
      "subscription_cycle",
    ]);
  });

  it("names a seeded clock by name, and refuses an unknown clock", () => {
    const store = new Store();
    seedFromConfig(store, "http://localhost:14000", {
      test_clocks: [{ frozen_time: T, name: "Named" }],
      customers: [{ id: "cus_named", test_clock: "Named" }],
    });
    const ss = getStripeStore(store);
    const [clock] = ss.testClocks.all();
    expect(clock.stripe_id).toMatch(/^clock_/);
    expect(ss.customers.findOneBy("stripe_id", "cus_named")?.test_clock).toBe(clock.stripe_id);
    expect(() =>
      seedFromConfig(new Store(), "http://localhost:14000", {
        customers: [{ id: "cus_lost", test_clock: "clock_missing" }],
      }),
    ).toThrow(/No such test_clock: 'clock_missing'/);
  });

  it("seeds the same config twice without a second card, clock or customer", async () => {
    const seed: StripeSeedConfig = {
      test_clocks: [{ id: "clock_seeded", frozen_time: T }],
      customers: [
        {
          id: "cus_seeded",
          email: "seeded@example.com",
          test_clock: "clock_seeded",
          payment_method: "pm_card_visa",
          invoice_settings: { default_payment_method: "pm_card_visa" },
        },
      ],
    };
    const ctx = createTestApp({ seed });
    seedFromConfig(ctx.store, "http://localhost:14000", seed);
    const cards = await api<Json>(ctx.app, "GET", "/v1/payment_methods?customer=cus_seeded&type=card");
    expect(cards.body.data).toHaveLength(1);
    const clocks = await api<Json>(ctx.app, "GET", "/v1/test_helpers/test_clocks");
    expect(clocks.body.data.map((c: Json) => c.id)).toEqual(["clock_seeded"]);
    const customers = await api<Json>(ctx.app, "GET", "/v1/customers?test_clock=clock_seeded");
    expect(customers.body.data).toHaveLength(1);
  });
});
