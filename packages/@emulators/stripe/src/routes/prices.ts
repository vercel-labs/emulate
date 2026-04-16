import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import {
  stripeId,
  toUnixTimestamp,
  parseStripeBody,
  stripeError,
  stripeList,
  applyExpand,
  parseExpand,
} from "../helpers.js";
import type { StripePrice, StripeProduct } from "../entities.js";

function formatPrice(p: StripePrice) {
  return {
    id: p.stripe_id,
    object: "price",
    product: p.product_id,
    currency: p.currency,
    unit_amount: p.unit_amount,
    type: p.type,
    active: p.active,
    metadata: p.metadata,
    created: toUnixTimestamp(p.created_at),
    livemode: false,
  };
}

function formatProduct(p: StripeProduct) {
  return {
    id: p.stripe_id,
    object: "product",
    name: p.name,
    active: p.active,
    created: toUnixTimestamp(p.created_at),
    livemode: false,
  };
}

export function priceRoutes({ app, store, webhooks }: RouteContext): void {
  const ss = getStripeStore(store);

  const expandResolvers = {
    product: (id: string) => {
      const prod = ss.products.findOneBy("stripe_id", id);
      return prod ? formatProduct(prod) : undefined;
    },
  };

  app.post("/v1/prices", async (c) => {
    const body = await parseStripeBody(c);
    if (!body.currency || !body.product) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "Missing required param: currency and product are required.",
        undefined,
        "currency",
      );
    }
    if (!ss.products.findOneBy("stripe_id", body.product as string)) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `No such product: '${body.product}'`,
        "resource_missing",
        "product",
      );
    }
    const price = ss.prices.insert({
      stripe_id: stripeId("price"),
      product_id: body.product as string,
      currency: (body.currency as string).toLowerCase(),
      unit_amount: (body.unit_amount as number) ?? null,
      type: body.recurring ? "recurring" : "one_time",
      active: (body.active as boolean) ?? true,
      metadata: (body.metadata as Record<string, string>) ?? {},
    });

    await webhooks.dispatch(
      "price.created",
      undefined,
      { type: "price.created", data: { object: formatPrice(price) } },
      "stripe",
    );

    return c.json(formatPrice(price), 200);
  });

  app.get("/v1/prices/:id", (c) => {
    const price = ss.prices.findOneBy("stripe_id", c.req.param("id"));
    if (!price)
      return stripeError(c, 404, "invalid_request_error", `No such price: '${c.req.param("id")}'`, "resource_missing");
    const expand = parseExpand(c);
    const result = applyExpand(formatPrice(price), expand, expandResolvers);
    return c.json(result);
  });

  app.get("/v1/prices", (c) => {
    let items = ss.prices.all();
    const productId = c.req.query("product");
    const active = c.req.query("active");
    if (productId) items = items.filter((p) => p.product_id === productId);
    if (active !== undefined) items = items.filter((p) => p.active === (active === "true"));
    return stripeList(c, items, "/v1/prices", formatPrice);
  });
}
