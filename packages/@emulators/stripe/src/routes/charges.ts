import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeError, stripeList, expandedJson, toUnixTimestamp } from "../helpers.js";
import { formatCharge, stripeExpandResolver } from "../formatters.js";

export function chargeRoutes({ app, store, baseUrl }: RouteContext): void {
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);

  app.get("/v1/charges/:id", (c) => {
    const charge = ss.charges.findOneBy("stripe_id", c.req.param("id"));
    if (!charge)
      return stripeError(c, 404, "invalid_request_error", `No such charge: '${c.req.param("id")}'`, "resource_missing");
    return expandedJson(c, formatCharge(charge), expand);
  });

  app.get("/v1/charges", (c) => {
    let items = ss.charges.all();
    const customerId = c.req.query("customer");
    const piId = c.req.query("payment_intent");
    if (customerId) items = items.filter((ch) => ch.customer_id === customerId);
    if (piId) items = items.filter((ch) => ch.payment_intent_id === piId);
    return stripeList(c, items, "/v1/charges", formatCharge, {
      created: (ch) => ch.created ?? toUnixTimestamp(ch.created_at),
      expand,
    });
  });
}
