import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeId, toUnixTimestamp, parseStripeBody, stripeError, stripeList } from "../helpers.js";
import type { StripeProduct } from "../entities.js";

function formatProduct(p: StripeProduct) {
  return {
    id: p.stripe_id,
    object: "product",
    name: p.name,
    description: p.description,
    active: p.active,
    metadata: p.metadata,
    created: toUnixTimestamp(p.created_at),
    livemode: false,
  };
}

export function productRoutes({ app, store, webhooks }: RouteContext): void {
  const ss = getStripeStore(store);

  app.post("/v1/products", async (c) => {
    const body = await parseStripeBody(c);
    if (!body.name)
      return stripeError(c, 400, "invalid_request_error", "Missing required param: name.", undefined, "name");
    const product = ss.products.insert({
      stripe_id: stripeId("prod"),
      name: body.name as string,
      description: (body.description as string) ?? null,
      active: (body.active as boolean) ?? true,
      metadata: (body.metadata as Record<string, string>) ?? {},
    });

    await webhooks.dispatch(
      "product.created",
      undefined,
      { type: "product.created", data: { object: formatProduct(product) } },
      "stripe",
    );

    return c.json(formatProduct(product), 200);
  });

  app.get("/v1/products/:id", (c) => {
    const product = ss.products.findOneBy("stripe_id", c.req.param("id"));
    if (!product)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such product: '${c.req.param("id")}'`,
        "resource_missing",
      );
    return c.json(formatProduct(product));
  });

  app.get("/v1/products", (c) => {
    let items = ss.products.all();
    const active = c.req.query("active");
    if (active !== undefined) items = items.filter((p) => p.active === (active === "true"));
    return stripeList(c, items, "/v1/products", formatProduct);
  });
}
