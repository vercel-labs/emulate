import type { RouteContext } from "@emulators/core";
import { getPolarStore } from "../store.js";
import { polarId } from "../helpers.js";

export function checkoutRoutes({ app, store, baseUrl }: RouteContext): void {
  const polar = getPolarStore(store);

  app.post("/v1/checkouts", async (c) => {
    const body = await c.req.json();
    const product_id = body.product_id;
    
    // Find product to ensure it exists
    const product = polar.products.findOneBy("polar_id", product_id);
    if (!product) {
      return c.json({ error: "Product not found" }, 404);
    }

    const checkout = polar.checkouts.insert({
      polar_id: polarId("ch"),
      status: "open",
      payment_processor: "stripe",
      client_secret: `secret_${polarId("cs")}`,
      url: `${baseUrl}/checkout/${polarId("ch")}`,
      success_url: body.success_url ?? `${baseUrl}/success`,
      embed_origin: body.embed_origin ?? null,
      organization_id: product.organization_id,
      product_id: product.polar_id,
      price_id: body.price_id ?? "",
      customer_id: null,
      customer_name: body.customer_name ?? null,
      customer_email: body.customer_email ?? null,
      metadata: body.metadata ?? {},
    });

    return c.json(checkout, 201);
  });

  app.get("/v1/checkouts/:id", (c) => {
    const id = c.req.param("id");
    const checkout = polar.checkouts.findOneBy("polar_id", id);
    if (!checkout) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json(checkout);
  });
}
