import type { RouteContext } from "@emulators/core";
import { getPolarStore } from "../store.js";
import { generateUuid } from "../helpers.js";
import { formatCheckout } from "../formatters.js";

export function checkoutRoutes({ app, store, webhooks }: RouteContext): void {
  const ps = getPolarStore(store);

  app.post("/api/v1/checkouts/custom", async (c) => {
    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty
    }

    const productId = body.product_id;
    if (!productId) {
      return c.json({ error: "Missing product_id" }, 400);
    }

    const prod = ps.products.findOneBy("polar_id", productId);
    const orgId = prod ? prod.organization_id : "default_org";

    const checkoutId = generateUuid();
    const checkout = ps.checkouts.insert({
      polar_id: checkoutId,
      url: `https://polar.sh/checkout/${checkoutId}`,
      status: "open",
      product_id: productId,
      organization_id: orgId,
      customer_email: body.customer_email || undefined,
    });

    await webhooks.dispatch(
      "checkout.created",
      undefined,
      {
        type: "checkout.created",
        data: formatCheckout(checkout),
      },
      "polar"
    );

    return c.json(formatCheckout(checkout), 201);
  });

  app.get("/api/v1/checkouts/custom/:id", (c) => {
    const id = c.req.param("id");
    const checkout = ps.checkouts.findOneBy("polar_id", id);
    if (!checkout) {
      return c.json({ error: "Checkout not found" }, 404);
    }
    return c.json(formatCheckout(checkout), 200);
  });
}
