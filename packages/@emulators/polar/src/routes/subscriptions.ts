import type { RouteContext } from "@emulators/core";
import { getPolarStore } from "../store.js";
import { formatSubscription } from "../formatters.js";

export function subscriptionRoutes({ app, store }: RouteContext): void {
  const ps = getPolarStore(store);

  app.get("/v1/subscriptions", (c) => {
    const subs = ps.subscriptions.all();
    return c.json({
      items: subs.map(formatSubscription),
      pagination: {
        total_count: subs.length,
        max_page: 1,
      }
    }, 200);
  });
}
