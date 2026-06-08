import type { RouteContext } from "@emulators/core";
import { getPolarStore } from "../store.js";

export function productRoutes({ app, store }: RouteContext): void {
  const polar = getPolarStore(store);

  app.get("/v1/products", (c) => {
    const org_id = c.req.query("organization_id");
    let products = polar.products.all();
    if (org_id) {
      products = products.filter(p => p.organization_id === org_id);
    }
    return c.json({
      items: products,
      pagination: {
        total_count: products.length,
        max_page: 1,
      }
    });
  });

  app.get("/v1/products/:id", (c) => {
    const id = c.req.param("id");
    const product = polar.products.findOneBy("polar_id", id);
    if (!product) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json(product);
  });
}
