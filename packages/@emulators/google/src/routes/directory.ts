import type { RouteContext } from "@emulators/core";
import { googleApiError } from "../helpers.js";
import { requireGoogleAuth } from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

export function directoryRoutes({ app, store }: RouteContext): void {
  const gs = getGoogleStore(store);
  app.get("/admin/directory/v1/customer/:customer/resources/buildings/:buildingId", (c) => {
    const email = requireGoogleAuth(c);
    if (email instanceof Response) return email;
    const building = gs.directoryBuildings
      .findBy("user_email", email)
      .find((item) => item.buildingId === c.req.param("buildingId"));
    if (c.req.param("customer") !== "my_customer" || !building) {
      return googleApiError(c, 404, "Building not found.", "notFound", "NOT_FOUND");
    }
    const { id: _id, created_at: _created, updated_at: _updated, user_email: _email, ...fields } = building;
    return c.json({ ...fields, kind: "admin#directory#resources#buildings#Building" });
  });
  for (const resourceType of ["buildings", "calendars"] as const) {
    app.get(`/admin/directory/v1/customer/:customer/resources/${resourceType}`, (c) => {
      const email = requireGoogleAuth(c);
      if (email instanceof Response) return email;
      if (c.req.param("customer") !== "my_customer") {
        return googleApiError(c, 404, "Customer not found.", "notFound", "NOT_FOUND");
      }
      const limit = Number(c.req.query("maxResults") ?? 100);
      const offset = Number(c.req.query("pageToken") ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) {
        return googleApiError(c, 400, "Invalid pagination.", "invalidArgument", "INVALID_ARGUMENT");
      }
      const records =
        resourceType === "buildings"
          ? gs.directoryBuildings.findBy("user_email", email)
          : gs.directoryCalendarResources.findBy("user_email", email);
      const items = records.slice(offset, offset + limit).map((record) => {
        const { id: _id, created_at: _created, updated_at: _updated, user_email: _email, ...fields } = record;
        return {
          ...fields,
          kind:
            resourceType === "buildings"
              ? "admin#directory#resources#buildings#Building"
              : "admin#directory#resources#calendars#CalendarResource",
        };
      });
      return c.json({
        kind:
          resourceType === "buildings"
            ? "admin#directory#resources#buildings#Buildings"
            : "admin#directory#resources#calendars#CalendarResources",
        [resourceType === "buildings" ? "buildings" : "items"]: items,
        ...(offset + limit < records.length ? { nextPageToken: String(offset + limit) } : {}),
      });
    });
  }
}
