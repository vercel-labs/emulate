import { describe, it, expect, afterEach, vi } from "vitest";
import Stripe from "stripe";
import { getStripeStore } from "../store.js";
import { seedFromConfig } from "../index.js";
import { priceAmount, priceBreakdown, transformedQuantity } from "../pricing.js";
import type { StripePrice } from "../entities.js";
import { createTestApp, captureWebhooks, api, sdk, type TestApp } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

/**
 * The JSON a stripe-node object was parsed from. stripe-node turns decimal strings into
 * Decimal objects, which serialize back to the wire string.
 */
function wire<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value));
}

/** The keys of the Price object, in the order of the API reference. */
const PRICE_KEYS = [
  "id",
  "object",
  "active",
  "billing_scheme",
  "created",
  "currency",
  "custom_unit_amount",
  "livemode",
  "lookup_key",
  "metadata",
  "nickname",
  "product",
  "recurring",
  "tax_behavior",
  "tiers_mode",
  "transform_quantity",
  "type",
  "unit_amount",
  "unit_amount_decimal",
];

const PRODUCT_KEYS = [
  "id",
  "object",
  "active",
  "created",
  "default_price",
  "description",
  "images",
  "marketing_features",
  "livemode",
  "metadata",
  "name",
  "package_dimensions",
  "shippable",
  "statement_descriptor",
  "tax_code",
  "unit_label",
  "updated",
  "url",
];

async function product(ctx: TestApp, name = "Pro") {
  const res = await api<Json>(ctx.app, "POST", "/v1/products", { name });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

const GRADUATED_TIERS = [
  { up_to: 1000, unit_amount: 0 },
  { up_to: "inf", unit_amount: 2 },
];

describe("recurring prices", () => {
  it("creates a monthly price with the reference shape", async () => {
    const ctx = createTestApp();
    const prod = await product(ctx);
    const price = await sdk(ctx.app).prices.create({
      product: prod,
      currency: "usd",
      unit_amount: 1000,
      recurring: { interval: "month" },
    });
    expect(Object.keys(price)).toEqual(PRICE_KEYS);
    expect(wire(price)).toMatchObject({
      object: "price",
      active: true,
      billing_scheme: "per_unit",
      currency: "usd",
      custom_unit_amount: null,
      livemode: false,
      lookup_key: null,
      metadata: {},
      nickname: null,
      product: prod,
      tax_behavior: "unspecified",
      tiers_mode: null,
      transform_quantity: null,
      type: "recurring",
      unit_amount: 1000,
      unit_amount_decimal: "1000",
    });
    expect(price.recurring).toEqual({
      interval: "month",
      interval_count: 1,
      meter: null,
      trial_period_days: null,
      usage_type: "licensed",
    });
    expect(price.id).toMatch(/^price_/);
  });

  it("keeps one-time prices without recurring", async () => {
    const ctx = createTestApp();
    const prod = await product(ctx);
    const res = await api<Json>(ctx.app, "POST", "/v1/prices", { product: prod, currency: "USD", unit_amount: 500 });
    expect(res.body).toMatchObject({ type: "one_time", recurring: null, currency: "usd", billing_scheme: "per_unit" });
  });

  it("stores interval_count, nickname, lookup_key, tax_behavior and transform_quantity", async () => {
    const ctx = createTestApp();
    const prod = await product(ctx);
    const price = await sdk(ctx.app).prices.create({
      product: prod,
      currency: "usd",
      unit_amount: 2500,
      recurring: { interval: "month", interval_count: 3 },
      nickname: "Quarterly",
      lookup_key: "pro_quarterly",
      tax_behavior: "exclusive",
      transform_quantity: { divide_by: 5, round: "up" },
      metadata: { tier: "pro" },
    });
    expect(price.recurring?.interval_count).toBe(3);
    expect(price).toMatchObject({
      nickname: "Quarterly",
      lookup_key: "pro_quarterly",
      tax_behavior: "exclusive",
      transform_quantity: { divide_by: 5, round: "up" },
      metadata: { tier: "pro" },
    });
  });

  it("rejects an unknown interval with param recurring[interval]", async () => {
    const ctx = createTestApp();
    const prod = await product(ctx);
    const res = await api<Json>(ctx.app, "POST", "/v1/prices", {
      product: prod,
      currency: "usd",
      unit_amount: 1000,
      recurring: { interval: "fortnight" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ type: "invalid_request_error", param: "recurring[interval]" });
  });

  it("rejects intervals longer than three years", async () => {
    const ctx = createTestApp();
    const prod = await product(ctx);
    const tooLong = await api<Json>(ctx.app, "POST", "/v1/prices", {
      product: prod,
      currency: "usd",
      unit_amount: 1000,
      recurring: { interval: "month", interval_count: 37 },
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.param).toBe("recurring[interval_count]");
    const threeYears = await api<Json>(ctx.app, "POST", "/v1/prices", {
      product: prod,
      currency: "usd",
      unit_amount: 1000,
      recurring: { interval: "week", interval_count: 156 },
    });
    expect(threeYears.status).toBe(200);
  });

  it("rejects metered prices without a meter, and meters that do not exist", async () => {
    const ctx = createTestApp();
    const prod = await product(ctx);
    const noMeter = await api<Json>(ctx.app, "POST", "/v1/prices", {
      product: prod,
      currency: "usd",
      unit_amount: 5,
      recurring: { interval: "month", usage_type: "metered" },
    });
    expect(noMeter.status).toBe(400);
    expect(noMeter.body.error.param).toBe("recurring[meter]");
    const unknownMeter = await api<Json>(ctx.app, "POST", "/v1/prices", {
      product: prod,
      currency: "usd",
      unit_amount: 5,
      recurring: { interval: "month", usage_type: "metered", meter: "mtr_missing" },
    });
    expect(unknownMeter.status).toBe(400);
    expect(unknownMeter.body.error).toMatchObject({ code: "resource_missing", param: "recurring[meter]" });
  });

  it("stores active=false from a form body as false, for prices and products", async () => {
    const ctx = createTestApp();
    const stripe = sdk(ctx.app);
    const prod = await stripe.products.create({ name: "Archived", active: false });
    expect(prod.active).toBe(false);
    const price = await stripe.prices.create({ product: prod.id, currency: "usd", unit_amount: 100, active: false });
    expect(price.active).toBe(false);
    expect(getStripeStore(ctx.store).prices.findOneBy("stripe_id", price.id)?.active).toBe(false);

    const inactive = await stripe.prices.list({ active: false });
    expect(inactive.data.map((p) => p.id)).toEqual([price.id]);
    const inactiveProducts = await stripe.products.list({ active: false });
    expect(inactiveProducts.data.map((p) => p.id)).toEqual([prod.id]);
    const activeProducts = await stripe.products.list({ active: true });
    expect(activeProducts.data.some((p) => p.id === prod.id)).toBe(false);
  });

  it("handles unit_amount_decimal", async () => {
    const ctx = createTestApp();
    const prod = await product(ctx);
    const fractional = await api<Json>(ctx.app, "POST", "/v1/prices", {
      product: prod,
      currency: "usd",
      unit_amount_decimal: "12.50",
    });
    expect(fractional.body).toMatchObject({ unit_amount: null, unit_amount_decimal: "12.5" });
    const whole = await api<Json>(ctx.app, "POST", "/v1/prices", {
      product: prod,
      currency: "usd",
      unit_amount_decimal: "300",
    });
    expect(whole.body).toMatchObject({ unit_amount: 300, unit_amount_decimal: "300" });
    const both = await api<Json>(ctx.app, "POST", "/v1/prices", {
      product: prod,
      currency: "usd",
      unit_amount: 300,
      unit_amount_decimal: "300",
    });
    expect(both.status).toBe(400);
  });

  it("creates the product from product_data", async () => {
    const ctx = createTestApp();
    const res = await api<Json>(ctx.app, "POST", "/v1/prices", {
      currency: "usd",
      unit_amount: 1000,
      recurring: { interval: "month" },
      product_data: { name: "Gold Plan", unit_label: "seat" },
    });
    expect(res.status).toBe(200);
    expect(res.body.product).toMatch(/^prod_/);
    const prod = await api<Json>(ctx.app, "GET", `/v1/products/${res.body.product}`);
    expect(prod.body).toMatchObject({ name: "Gold Plan", unit_label: "seat", active: true });
  });

  it("emits product.created before price.created for product_data", async () => {
    const ctx = createTestApp({ webhook: true });
    const hooks = captureWebhooks();
    await api<Json>(ctx.app, "POST", "/v1/prices", {
      currency: "usd",
      unit_amount: 1000,
      product_data: { name: "Gold Plan" },
    });
    expect(hooks.events.map((e) => e.type)).toEqual(["product.created", "price.created"]);
  });

  it("expands product to exactly what GET /v1/products/:id returns", async () => {
    const ctx = createTestApp();
    const stripe = sdk(ctx.app);
    const prod = await stripe.products.create({ name: "Pro", description: "Everything", metadata: { a: "1" } });
    expect(Object.keys(prod)).toEqual(PRODUCT_KEYS);
    expect(prod).toMatchObject({
      default_price: null,
      images: [],
      marketing_features: [],
      package_dimensions: null,
      shippable: null,
      statement_descriptor: null,
      tax_code: null,
      unit_label: null,
      url: null,
    });
    expect(prod.updated).toBe(prod.created);
    const price = await stripe.prices.create({ product: prod.id, currency: "usd", unit_amount: 100 });
    const expanded = await stripe.prices.retrieve(price.id, { expand: ["product"] });
    const fetched = await stripe.products.retrieve(prod.id);
    expect(expanded.product).toEqual(fetched);
  });
});

describe("tiered prices", () => {
  it("hides tiers unless expanded, and renders the inf tier with up_to null", async () => {
    const ctx = createTestApp();
    const stripe = sdk(ctx.app);
    const prod = await product(ctx);
    const price = await stripe.prices.create({
      product: prod,
      currency: "usd",
      billing_scheme: "tiered",
      tiers_mode: "graduated",
      recurring: { interval: "month" },
      tiers: [
        { up_to: 1000, unit_amount: 0 },
        { up_to: "inf", unit_amount_decimal: Stripe.Decimal.from("2.5"), flat_amount: 500 },
      ],
    });
    expect(price).not.toHaveProperty("tiers");
    expect(price).toMatchObject({
      billing_scheme: "tiered",
      tiers_mode: "graduated",
      unit_amount: null,
      unit_amount_decimal: null,
    });

    const expanded = await stripe.prices.retrieve(price.id, { expand: ["tiers"] });
    expect(wire(expanded).tiers).toEqual([
      { flat_amount: null, flat_amount_decimal: null, unit_amount: 0, unit_amount_decimal: "0", up_to: 1000 },
      { flat_amount: 500, flat_amount_decimal: "500", unit_amount: null, unit_amount_decimal: "2.5", up_to: null },
    ]);

    const listed = await stripe.prices.list({ expand: ["data.tiers"] });
    expect(listed.data[0].tiers).toHaveLength(2);
  });

  it("returns null tiers and the primary currency option when a per-unit price expands them", async () => {
    const ctx = createTestApp();
    const prod = await product(ctx);
    const created = await api<Json>(ctx.app, "POST", "/v1/prices", {
      product: prod,
      currency: "eur",
      unit_amount: 900,
    });
    const res = await api<Json>(
      ctx.app,
      "GET",
      `/v1/prices/${created.body.id}?expand[]=tiers&expand[]=currency_options`,
    );
    expect(res.body.tiers).toBeNull();
    expect(res.body.currency_options).toEqual({
      eur: { custom_unit_amount: null, tax_behavior: "unspecified", unit_amount: 900, unit_amount_decimal: "900" },
    });
  });

  it("validates tiers", async () => {
    const ctx = createTestApp();
    const prod = await product(ctx);
    const create = (body: Json) =>
      api<Json>(ctx.app, "POST", "/v1/prices", { product: prod, currency: "usd", ...body });

    const noTiers = await create({ billing_scheme: "tiered", tiers_mode: "volume" });
    expect(noTiers.status).toBe(400);
    expect(noTiers.body.error.param).toBe("tiers");

    const noMode = await create({ billing_scheme: "tiered", tiers: GRADUATED_TIERS });
    expect(noMode.status).toBe(400);
    expect(noMode.body.error.param).toBe("tiers_mode");

    const lastNotInf = await create({
      billing_scheme: "tiered",
      tiers_mode: "volume",
      tiers: [
        { up_to: 10, unit_amount: 5 },
        { up_to: 20, unit_amount: 4 },
      ],
    });
    expect(lastNotInf.status).toBe(400);
    expect(lastNotInf.body.error.param).toBe("tiers");

    const notIncreasing = await create({
      billing_scheme: "tiered",
      tiers_mode: "volume",
      tiers: [
        { up_to: 20, unit_amount: 5 },
        { up_to: 10, unit_amount: 4 },
        { up_to: "inf", unit_amount: 3 },
      ],
    });
    expect(notIncreasing.status).toBe(400);

    const emptyTier = await create({
      billing_scheme: "tiered",
      tiers_mode: "volume",
      tiers: [{ up_to: "inf" }],
    });
    expect(emptyTier.status).toBe(400);

    const tiersWithoutScheme = await create({ tiers_mode: "volume", tiers: GRADUATED_TIERS, unit_amount: 1 });
    expect(tiersWithoutScheme.status).toBe(400);
    expect(tiersWithoutScheme.body.error.param).toBe("billing_scheme");

    const withTransform = await create({
      billing_scheme: "tiered",
      tiers_mode: "volume",
      tiers: GRADUATED_TIERS,
      transform_quantity: { divide_by: 10, round: "up" },
    });
    expect(withTransform.status).toBe(400);
    expect(withTransform.body.error.param).toBe("transform_quantity");

    const ok = await create({ billing_scheme: "tiered", tiers_mode: "volume", tiers: GRADUATED_TIERS });
    expect(ok.status).toBe(200);
  });
});

describe("listing and lookup keys", () => {
  async function catalog(ctx: TestApp) {
    const prod = await product(ctx);
    const stripe = sdk(ctx.app);
    const monthly = await stripe.prices.create({
      product: prod,
      currency: "usd",
      unit_amount: 1000,
      recurring: { interval: "month" },
      lookup_key: "pro_monthly",
    });
    const yearly = await stripe.prices.create({
      product: prod,
      currency: "usd",
      unit_amount: 10000,
      recurring: { interval: "year" },
      lookup_key: "pro_yearly",
    });
    const once = await stripe.prices.create({ product: prod, currency: "eur", unit_amount: 500 });
    return { stripe, monthly, yearly, once };
  }

  it("filters by lookup_keys[]", async () => {
    const ctx = createTestApp();
    const { stripe, monthly, yearly } = await catalog(ctx);
    const one = await stripe.prices.list({ lookup_keys: ["pro_monthly"] });
    expect(one.data.map((p) => p.id)).toEqual([monthly.id]);
    const both = await stripe.prices.list({ lookup_keys: ["pro_monthly", "pro_yearly", "missing"] });
    expect(both.data.map((p) => p.id).sort()).toEqual([monthly.id, yearly.id].sort());
  });

  it("filters by type, recurring[interval] and currency", async () => {
    const ctx = createTestApp();
    const { stripe, monthly, yearly, once } = await catalog(ctx);
    expect((await stripe.prices.list({ type: "one_time" })).data.map((p) => p.id)).toEqual([once.id]);
    expect((await stripe.prices.list({ type: "recurring" })).data.map((p) => p.id)).toEqual([yearly.id, monthly.id]);
    expect((await stripe.prices.list({ recurring: { interval: "year" } })).data.map((p) => p.id)).toEqual([yearly.id]);
    expect((await stripe.prices.list({ currency: "eur" })).data.map((p) => p.id)).toEqual([once.id]);
  });

  it("rejects a lookup_key already in use unless transfer_lookup_key is set", async () => {
    const ctx = createTestApp({ webhook: true });
    const { monthly } = await catalog(ctx);
    const prod = monthly.product as string;
    const taken = await api<Json>(ctx.app, "POST", "/v1/prices", {
      product: prod,
      currency: "usd",
      unit_amount: 1200,
      recurring: { interval: "month" },
      lookup_key: "pro_monthly",
    });
    expect(taken.status).toBe(400);
    expect(taken.body.error.param).toBe("lookup_key");

    const hooks = captureWebhooks();
    const moved = await api<Json>(ctx.app, "POST", "/v1/prices", {
      product: prod,
      currency: "usd",
      unit_amount: 1200,
      recurring: { interval: "month" },
      lookup_key: "pro_monthly",
      transfer_lookup_key: true,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.lookup_key).toBe("pro_monthly");
    const old = await api<Json>(ctx.app, "GET", `/v1/prices/${monthly.id}`);
    expect(old.body.lookup_key).toBeNull();
    const updated = hooks.ofType("price.updated");
    expect(updated).toHaveLength(1);
    expect((updated[0].data.object as Json).id).toBe(monthly.id);
    expect(updated[0].data.previous_attributes).toEqual({ lookup_key: "pro_monthly" });
    expect(hooks.events.map((e) => e.type)).toEqual(["price.updated", "price.created"]);
  });
});

function tieredPrice(tiersMode: "graduated" | "volume", tiers: StripePrice["tiers"]): StripePrice {
  return {
    id: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stripe_id: "price_test",
    product_id: "prod_test",
    currency: "usd",
    unit_amount: null,
    type: "recurring",
    active: true,
    metadata: {},
    billing_scheme: "tiered",
    tiers_mode: tiersMode,
    tiers,
  };
}

function perUnitPrice(unitAmountDecimal: string, transform?: StripePrice["transform_quantity"]): StripePrice {
  return {
    id: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stripe_id: "price_test",
    product_id: "prod_test",
    currency: "usd",
    unit_amount: Number.isInteger(Number(unitAmountDecimal)) ? Number(unitAmountDecimal) : null,
    unit_amount_decimal: unitAmountDecimal,
    type: "recurring",
    active: true,
    metadata: {},
    transform_quantity: transform,
  };
}

describe("pricing", () => {
  const graduated = tieredPrice("graduated", [{ up_to: 1000, unit_amount_decimal: "0" }, { unit_amount_decimal: "2" }]);

  it("prices graduated tiers per tier", () => {
    expect(priceAmount(graduated, 1500)).toBe(1000);
    expect(priceAmount(graduated, 1000)).toBe(0);
    expect(priceBreakdown(graduated, 1500)).toEqual([
      { tier: 0, kind: "unit", quantity: 1000, unit_amount_decimal: "0", amount: 0 },
      { tier: 1, kind: "unit", quantity: 500, unit_amount_decimal: "2", amount: 1000 },
    ]);
  });

  it("follows the documented flat rate examples", () => {
    const tiers: StripePrice["tiers"] = [
      { up_to: 5, unit_amount_decimal: "500", flat_amount_decimal: "1000" },
      { up_to: 10, unit_amount_decimal: "400", flat_amount_decimal: "2000" },
      { up_to: 15, unit_amount_decimal: "300", flat_amount_decimal: "3000" },
      { up_to: 20, unit_amount_decimal: "200", flat_amount_decimal: "4000" },
      { unit_amount_decimal: "100", flat_amount_decimal: "5000" },
    ];
    expect(priceAmount(tieredPrice("volume", tiers), 12)).toBe(6600);
    expect(priceAmount(tieredPrice("graduated", tiers), 12)).toBe(11100);
    // Stripe always bills the first tier's flat rate when the quantity is 0.
    expect(priceAmount(tieredPrice("volume", tiers), 0)).toBe(1000);
    expect(priceAmount(tieredPrice("graduated", tiers), 0)).toBe(1000);
    expect(priceBreakdown(tieredPrice("graduated", tiers), 6)).toEqual([
      { tier: 0, kind: "unit", quantity: 5, unit_amount_decimal: "500", amount: 2500 },
      { tier: 0, kind: "flat", quantity: 1, unit_amount_decimal: "1000", amount: 1000 },
      { tier: 1, kind: "unit", quantity: 1, unit_amount_decimal: "400", amount: 400 },
      { tier: 1, kind: "flat", quantity: 1, unit_amount_decimal: "2000", amount: 2000 },
    ]);
  });

  it("prices volume tiers at the tier the whole quantity falls in", () => {
    const volume = tieredPrice("volume", [
      { up_to: 5, unit_amount_decimal: "700" },
      { up_to: 10, unit_amount_decimal: "650" },
      { unit_amount_decimal: "600" },
    ]);
    expect(priceAmount(volume, 5)).toBe(3500);
    expect(priceAmount(volume, 6)).toBe(3900);
    expect(priceAmount(volume, 25)).toBe(15000);
    expect(priceBreakdown(volume, 6)).toEqual([
      { tier: 1, kind: "unit", quantity: 6, unit_amount_decimal: "650", amount: 3900 },
    ]);
  });

  it("prices per-unit amounts, with fractional unit amounts rounded once", () => {
    expect(priceAmount(perUnitPrice("1000"), 3)).toBe(3000);
    expect(priceAmount(perUnitPrice("0.5"), 3)).toBe(2);
    expect(priceBreakdown(perUnitPrice("1000"), 3)).toEqual([
      { kind: "unit", quantity: 3, unit_amount_decimal: "1000", amount: 3000 },
    ]);
  });

  it("applies transform_quantity with rounding", () => {
    const up = perUnitPrice("1000", { divide_by: 5, round: "up" });
    const down = perUnitPrice("1000", { divide_by: 5, round: "down" });
    expect(transformedQuantity(up, 7)).toBe(2);
    expect(transformedQuantity(down, 7)).toBe(1);
    expect(transformedQuantity(up, 10)).toBe(2);
    expect(transformedQuantity(up, 0)).toBe(0);
    expect(priceAmount(up, 7)).toBe(2000);
    expect(priceAmount(down, 7)).toBe(1000);
    expect(priceBreakdown(up, 7)).toEqual([{ kind: "unit", quantity: 7, unit_amount_decimal: "1000", amount: 2000 }]);
  });
});

describe("seeded prices", () => {
  it("creates a recurring price from the README's product key", () => {
    const ctx = createTestApp({
      seed: {
        products: [{ name: "Pro" }],
        prices: [
          { product: "Pro", currency: "usd", unit_amount: 2000, recurring: { interval: "month" }, lookup_key: "pro" },
          {
            product_name: "Pro",
            currency: "usd",
            billing_scheme: "tiered",
            tiers_mode: "graduated",
            recurring: { interval: "month" },
            tiers: [
              { up_to: 1000, unit_amount: 0 },
              { up_to: "inf", unit_amount: 2 },
            ],
          },
        ],
      },
    });
    const ss = getStripeStore(ctx.store);
    const pro = ss.products.all().find((p) => p.name === "Pro");
    const prices = ss.prices.findBy("product_id", pro!.stripe_id);
    expect(prices).toHaveLength(2);
    const monthly = prices.find((p) => p.lookup_key === "pro")!;
    expect(monthly).toMatchObject({ type: "recurring", unit_amount: 2000 });
    expect(monthly.recurring).toMatchObject({ interval: "month", interval_count: 1, usage_type: "licensed" });
    const tiered = prices.find((p) => p.billing_scheme === "tiered")!;
    expect(priceAmount(tiered, 1500)).toBe(1000);
  });

  it("serves seeded prices through the API", async () => {
    const ctx = createTestApp({
      seed: {
        products: [{ id: "prod_pro", name: "Pro" }],
        prices: [
          {
            id: "price_pro_monthly",
            product: "prod_pro",
            currency: "usd",
            unit_amount: 2000,
            recurring: { interval: "month" },
          },
        ],
      },
    });
    const res = await api<Json>(ctx.app, "GET", "/v1/prices/price_pro_monthly");
    expect(res.body).toMatchObject({ product: "prod_pro", type: "recurring", recurring: { interval: "month" } });
  });

  it("rejects an invalid seeded price", () => {
    expect(() =>
      seedFromConfig(createTestApp().store, "http://localhost", {
        products: [{ name: "Pro" }],
        prices: [{ product: "Pro", currency: "usd", unit_amount: 1, recurring: { interval: "fortnight" as "month" } }],
      }),
    ).toThrow(/recurring\[interval\]/);
  });
});

describe("stripe-node form encoding", () => {
  it("sends tiers as bracketed form fields that parse back into numbers", async () => {
    const ctx = createTestApp();
    const prod = await product(ctx);
    const price: Stripe.Price = await sdk(ctx.app).prices.create({
      product: prod,
      currency: "usd",
      billing_scheme: "tiered",
      tiers_mode: "volume",
      tiers: [
        { up_to: 5, unit_amount: 700, flat_amount_decimal: Stripe.Decimal.from("100") },
        { up_to: "inf", unit_amount: 600 },
      ],
      expand: ["tiers"],
    });
    expect(wire(price).tiers).toEqual([
      { flat_amount: 100, flat_amount_decimal: "100", unit_amount: 700, unit_amount_decimal: "700", up_to: 5 },
      { flat_amount: null, flat_amount_decimal: null, unit_amount: 600, unit_amount_decimal: "600", up_to: null },
    ]);
  });
});
