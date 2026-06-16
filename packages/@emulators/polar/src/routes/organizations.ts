import type { RouteContext } from "@emulators/core";
import { getPolarStore } from "../store.js";
import { formatOrganization } from "../formatters.js";

export function organizationRoutes({ app, store }: RouteContext): void {
  const ps = getPolarStore(store);

  app.get("/api/v1/organizations", (c) => {
    const orgs = ps.organizations.all();
    return c.json({
      items: orgs.map(formatOrganization),
      pagination: {
        total_count: orgs.length,
        max_page: 1,
      }
    }, 200);
  });
}
