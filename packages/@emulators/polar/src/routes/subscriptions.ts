import type { RouteContext } from "@emulators/core";
import { getPolarStore } from "../store.js";
import { polarId } from "../helpers.js";

export function subscriptionRoutes({ app, store }: RouteContext): void {
  const polar = getPolarStore(store);

  app.get("/v1/subscriptions", (c) => {
    const org_id = c.req.query("organization_id");
    let subs = polar.subscriptions.all();
    if (org_id) {
      subs = subs.filter(s => s.organization_id === org_id);
    }
    return c.json({
      items: subs,
      pagination: {
        total_count: subs.length,
        max_page: 1,
      }
    });
  });

  app.get("/v1/subscriptions/:id", (c) => {
    const id = c.req.param("id");
    const sub = polar.subscriptions.findOneBy("polar_id", id);
    if (!sub) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json(sub);
  });
}
