import { formatEvent } from "../formatters.js";
import { chargebeeList, notFound } from "../helpers.js";
import { api, type ChargebeeRouteContext } from "../route-utils.js";

export function eventRoutes(rc: ChargebeeRouteContext): void {
  const { app, cs } = rc;

  app.get(
    "/api/v2/events",
    api(cs, (c) => chargebeeList(c, cs.events.all(), "event", (event) => ({ event: formatEvent(event) }))),
  );

  app.get(
    "/api/v2/events/:id",
    api(cs, (c) => {
      const event = cs.events.findOneBy("cb_id", c.req.param("id"));
      if (!event) return notFound(c);
      return c.json({ event: formatEvent(event) });
    }),
  );
}
