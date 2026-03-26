import type { RouteContext } from "@emulators/core";
import {
  createFilterRecord,
  findMatchingFilter,
  findMissingLabelIds,
  formatFilterResource,
  formatForwardingAddressResource,
  formatSendAsResource,
  getFilterById,
  googleApiError,
  listFiltersForUser,
  listForwardingAddressesForUser,
  listSendAsForUser,
} from "../helpers.js";
import { getRecord, getString, getStringArray, parseGoogleBody, requireGmailUser } from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

export function settingsRoutes({ app, store }: RouteContext): void {
  const gs = getGoogleStore(store);

  app.get("/gmail/v1/users/:userId/settings/filters", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    return c.json({
      filter: listFiltersForUser(gs, authEmail).map((filter) => formatFilterResource(filter)),
    });
  });

  app.post("/gmail/v1/users/:userId/settings/filters", async (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const body = await parseGoogleBody(c);
    const criteria = getRecord(body, "criteria") ?? {};
    const action = getRecord(body, "action") ?? {};
    const criteriaFrom = getString(criteria, "from") ?? null;
    const addLabelIds = getStringArray(action, "addLabelIds");
    const removeLabelIds = getStringArray(action, "removeLabelIds");

    if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
      return googleApiError(c, 400, "Filter actions are required.", "invalidArgument", "INVALID_ARGUMENT");
    }

    const missingLabelIds = findMissingLabelIds(gs, authEmail, [...addLabelIds, ...removeLabelIds]);
    if (missingLabelIds.length > 0) {
      return googleApiError(c, 400, `Invalid label IDs: ${missingLabelIds.join(", ")}`, "invalidArgument", "INVALID_ARGUMENT");
    }

    if (
      findMatchingFilter(gs, {
        user_email: authEmail,
        criteria_from: criteriaFrom,
        add_label_ids: addLabelIds,
        remove_label_ids: removeLabelIds,
      })
    ) {
      return googleApiError(c, 400, "Filter already exists", "failedPrecondition", "FAILED_PRECONDITION");
    }

    const filter = createFilterRecord(gs, {
      user_email: authEmail,
      criteria_from: criteriaFrom,
      add_label_ids: addLabelIds,
      remove_label_ids: removeLabelIds,
    });

    return c.json(formatFilterResource(filter));
  });

  app.delete("/gmail/v1/users/:userId/settings/filters/:id", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const filter = getFilterById(gs, authEmail, c.req.param("id"));
    if (!filter) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    gs.filters.delete(filter.id);
    return c.body(null, 204);
  });

  app.get("/gmail/v1/users/:userId/settings/forwardingAddresses", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    return c.json({
      forwardingAddresses: listForwardingAddressesForUser(gs, authEmail).map((entry) =>
        formatForwardingAddressResource(entry),
      ),
    });
  });

  app.get("/gmail/v1/users/:userId/settings/sendAs", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    return c.json({
      sendAs: listSendAsForUser(gs, authEmail).map((entry) => formatSendAsResource(entry)),
    });
  });
}
