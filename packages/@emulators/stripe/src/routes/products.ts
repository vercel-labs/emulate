import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeId, parseStripeBody, stripeError, stripeList, readBool } from "../helpers.js";
import { formatProduct } from "../formatters.js";
import { eventBatch } from "../events.js";

export function productRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ss = getStripeStore(store);

  app.post("/v1/products", async (c) => {
    const body = await parseStripeBody(c);
    if (!body.name)
      return stripeError(c, 400, "invalid_request_error", "Missing required param: name.", undefined, "name");
    const product = ss.products.insert({
      stripe_id: stripeId("prod"),
      name: body.name as string,
      description: (body.description as string) ?? null,
      active: readBool(body.active) ?? true,
      metadata: (body.metadata as Record<string, string>) ?? {},
    });

    const ev = eventBatch(ctx, c);
    ev.emit("product.created", formatProduct(product));
    await ev.commit();

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
