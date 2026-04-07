import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeId, parseStripeBody, stripeError } from "../helpers.js";

export function customerSessionRoutes({ app, store }: RouteContext): void {
  const ss = getStripeStore(store);

  app.post("/v1/customer_sessions", async (c) => {
    const body = await parseStripeBody(c);
    if (!body.customer)
      return stripeError(c, 400, "invalid_request_error", "Missing required param: customer.", undefined, "customer");

    const customer = ss.customers.findOneBy("stripe_id", body.customer as string);
    if (!customer)
      return stripeError(c, 400, "invalid_request_error", `No such customer: '${body.customer}'`, "resource_missing", "customer");

    return c.json({
      object: "customer_session" as const,
      client_secret: stripeId("cuss_secret"),
      components: (body.components as Record<string, unknown>) ?? {},
      created: Math.floor(Date.now() / 1000),
      customer: customer.stripe_id,
      expires_at: Math.floor(Date.now() / 1000) + 1800,
      livemode: false,
    }, 200);
  });
}
