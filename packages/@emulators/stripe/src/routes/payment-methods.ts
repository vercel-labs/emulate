import type { RouteContext } from "@emulators/core";
import { stripeError } from "../helpers.js";
import { getStripeStore } from "../store.js";

export function paymentMethodRoutes({ app, store }: RouteContext): void {
  const ss = getStripeStore(store);

  app.get("/v1/payment_methods", (c) => {
    const customerId = c.req.query("customer");
    if (customerId && !ss.customers.findOneBy("stripe_id", customerId)) {
      return stripeError(c, 400, "invalid_request_error", `No such customer: '${customerId}'`, "resource_missing", "customer");
    }

    return c.json({
      object: "list" as const,
      url: "/v1/payment_methods",
      has_more: false,
      data: [],
    }, 200);
  });
}
