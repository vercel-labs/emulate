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
  seedSendAsEntry,
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
      return googleApiError(
        c,
        400,
        `Invalid label IDs: ${missingLabelIds.join(", ")}`,
        "invalidArgument",
        "INVALID_ARGUMENT",
      );
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

  // Real Gmail leaves a new alias pending until its owner confirms it; the
  // emulator accepts it at once unless the request asks for "pending".
  app.post("/gmail/v1/users/:userId/settings/sendAs", async (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const body = await parseGoogleBody(c);
    const sendAsEmail = getString(body, "sendAsEmail");
    if (!sendAsEmail) {
      return googleApiError(c, 400, "sendAsEmail is required.", "invalidArgument", "INVALID_ARGUMENT");
    }
    const exists = listSendAsForUser(gs, authEmail).some(
      (entry) => entry.send_as_email.toLowerCase() === sendAsEmail.toLowerCase(),
    );
    if (exists) {
      return googleApiError(c, 409, "Send-as alias already exists.", "duplicate", "ALREADY_EXISTS");
    }

    const entry = seedSendAsEntry(gs, {
      user_email: authEmail,
      send_as_email: sendAsEmail,
      display_name: getString(body, "displayName") ?? null,
      signature: getString(body, "signature") ?? "",
      is_default: body.isDefault === true,
      verification_status: getString(body, "verificationStatus") === "pending" ? "pending" : "accepted",
    });
    return c.json(formatSendAsResource(entry));
  });

  app.delete("/gmail/v1/users/:userId/settings/sendAs/:sendAsEmail", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const sendAsEmail = decodeURIComponent(c.req.param("sendAsEmail")).toLowerCase();
    const entry = listSendAsForUser(gs, authEmail).find((item) => item.send_as_email.toLowerCase() === sendAsEmail);
    if (!entry) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }
    if (entry.is_default || entry.send_as_email.toLowerCase() === authEmail.toLowerCase()) {
      return googleApiError(
        c,
        400,
        "The primary or default send-as address cannot be deleted.",
        "invalidArgument",
        "INVALID_ARGUMENT",
      );
    }

    gs.sendAs.delete(entry.id);
    return c.body(null, 204);
  });
}
