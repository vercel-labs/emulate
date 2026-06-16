import type { RouteContext } from "@emulators/core";
import { getPolarStore } from "../store.js";
import { formatProduct } from "../formatters.js";

export function productRoutes({ app, store }: RouteContext): void {
  const ps = getPolarStore(store);

  app.get("/api/v1/products", (c) => {
    const prods = ps.products.all();
    return c.json({
      items: prods.map(formatProduct),
      pagination: {
        total_count: prods.length,
        max_page: 1,
      }
    }, 200);
  });
}
