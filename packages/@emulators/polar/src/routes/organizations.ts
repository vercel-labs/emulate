import type { RouteContext } from "@emulators/core";
import { getPolarStore } from "../store.js";

export function organizationRoutes({ app, store }: RouteContext): void {
  const polar = getPolarStore(store);

  app.get("/v1/organizations", (c) => {
    const orgs = polar.organizations.all();
    return c.json({
      items: orgs,
      pagination: {
        total_count: orgs.length,
        max_page: 1,
      }
    });
  });

  app.get("/v1/organizations/:id", (c) => {
    const id = c.req.param("id");
    const org = polar.organizations.findOneBy("polar_id", id);
    if (!org) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json(org);
  });
}
