import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeError, stripeList, parseStripeQuery, readStringList, readBool } from "../helpers.js";
import { formatEvent } from "../events.js";

/** `type` accepts `*` as a wildcard, for example `customer.*`. */
function typeMatcher(pattern: string): (type: string) => boolean {
  if (!pattern.includes("*")) return (type) => type === pattern;
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
  return (type) => regex.test(type);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function eventRoutes({ app, store }: RouteContext): void {
  const ss = getStripeStore(store);

  app.get("/v1/events/:id", (c) => {
    const event = ss.events.findOneBy("stripe_id", c.req.param("id"));
    if (!event)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such event: '${c.req.param("id")}'`,
        "resource_missing",
        "id",
      );
    return c.json(formatEvent(event));
  });

  app.get("/v1/events", (c) => {
    const query = parseStripeQuery(c);
    let items = ss.events.all();

    const type = typeof query.type === "string" && query.type !== "" ? query.type : undefined;
    if (type) {
      const matches = typeMatcher(type);
      items = items.filter((e) => matches(e.type));
    }

    const types = readStringList(query.types);
    if (types.length > 0) {
      const matchers = types.map(typeMatcher);
      items = items.filter((e) => matchers.some((matches) => matches(e.type)));
    }

    const deliverySuccess = readBool(query.delivery_success);
    if (deliverySuccess !== undefined) {
      items = items.filter((e) => (e.pending_webhooks === 0) === deliverySuccess);
    }

    return stripeList(c, items, "/v1/events", formatEvent, { created: (e) => e.created });
  });
}
