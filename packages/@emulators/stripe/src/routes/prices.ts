import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeId, parseStripeBody, stripeError, stripeList, expandedJson, readBool } from "../helpers.js";
import { formatPrice, stripeExpandResolver } from "../formatters.js";
import { eventBatch } from "../events.js";

export function priceRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);

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
      active: readBool(body.active) ?? true,
      metadata: (body.metadata as Record<string, string>) ?? {},
    });

    const ev = eventBatch(ctx, c);
    ev.emit("price.created", formatPrice(price));
    await ev.commit();

    return expandedJson(c, formatPrice(price), expand, body);
  });

  app.get("/v1/prices/:id", (c) => {
    const price = ss.prices.findOneBy("stripe_id", c.req.param("id"));
    if (!price)
      return stripeError(c, 404, "invalid_request_error", `No such price: '${c.req.param("id")}'`, "resource_missing");
    return expandedJson(c, formatPrice(price), expand);
  });

  app.get("/v1/prices", (c) => {
    let items = ss.prices.all();
    const productId = c.req.query("product");
    const active = c.req.query("active");
    if (productId) items = items.filter((p) => p.product_id === productId);
    if (active !== undefined) items = items.filter((p) => p.active === (active === "true"));
    return stripeList(c, items, "/v1/prices", formatPrice, { expand });
  });
}
