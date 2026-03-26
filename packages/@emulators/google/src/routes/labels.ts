import type { RouteContext } from "@emulators/core";
import type { Context } from "hono";
import {
  createLabelRecord,
  findLabelById,
  findLabelByName,
  formatLabelResource,
  formatLabelResources,
  googleApiError,
  isSystemLabelId,
  listLabelsForUser,
  markMessageModified,
  updateLabelRecord,
} from "../helpers.js";
import { requireGmailUser, parseGoogleBody, getString } from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

export function labelRoutes({ app, store }: RouteContext): void {
  const gs = getGoogleStore(store);

  app.get("/gmail/v1/users/:userId/labels", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    return c.json({
      labels: formatLabelResources(gs, listLabelsForUser(gs, authEmail)),
    });
  });

  app.get("/gmail/v1/users/:userId/labels/:id", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const label = findLabelById(gs, authEmail, c.req.param("id"));
    if (!label) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    return c.json(formatLabelResource(gs, label));
  });

  app.post("/gmail/v1/users/:userId/labels", async (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const body = await parseGoogleBody(c);
    const name = getString(body, "name")?.trim();
    if (!name) {
      return googleApiError(c, 400, "Invalid label name", "invalidArgument", "INVALID_ARGUMENT");
    }

    if (findLabelByName(gs, authEmail, name)) {
      return googleApiError(
        c,
        400,
        "Label name exists or conflicts",
        "failedPrecondition",
        "FAILED_PRECONDITION",
      );
    }

    const color = body.color && typeof body.color === "object" && !Array.isArray(body.color)
      ? (body.color as Record<string, unknown>)
      : undefined;

    const label = createLabelRecord(gs, {
      user_email: authEmail,
      name,
      type: "user",
      message_list_visibility: getString(body, "messageListVisibility", "message_list_visibility") ?? "show",
      label_list_visibility: getString(body, "labelListVisibility", "label_list_visibility") ?? "labelShow",
      color_background:
        typeof color?.backgroundColor === "string"
          ? color.backgroundColor
          : getString(body, "color_background"),
      color_text:
        typeof color?.textColor === "string"
          ? color.textColor
          : getString(body, "color_text"),
    });

    return c.json(formatLabelResource(gs, label));
  });

  app.put("/gmail/v1/users/:userId/labels/:id", async (c) => {
    return saveLabel(c, gs, true);
  });

  app.patch("/gmail/v1/users/:userId/labels/:id", async (c) => {
    return saveLabel(c, gs, false);
  });

  app.delete("/gmail/v1/users/:userId/labels/:id", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const label = findLabelById(gs, authEmail, c.req.param("id"));
    if (!label) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    if (isSystemLabelId(label.gmail_id)) {
      return googleApiError(c, 400, "System labels cannot be deleted.", "invalidArgument", "INVALID_ARGUMENT");
    }

    for (const message of gs.messages.findBy("user_email", authEmail)) {
      if (!message.label_ids.includes(label.gmail_id)) continue;
      markMessageModified(
        gs,
        message,
        message.label_ids.filter((labelId) => labelId !== label.gmail_id),
      );
    }

    gs.labels.delete(label.id);
    return c.body(null, 204);
  });
}

async function saveLabel(
  c: Context,
  gs: ReturnType<typeof getGoogleStore>,
  replaceMissingFields: boolean,
) {
  const authEmail = requireGmailUser(c);
  if (authEmail instanceof Response) return authEmail;

  const label = findLabelById(gs, authEmail, c.req.param("id"));
  if (!label) {
    return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
  }

  if (isSystemLabelId(label.gmail_id)) {
    return googleApiError(c, 400, "System labels cannot be modified.", "invalidArgument", "INVALID_ARGUMENT");
  }

  const body = await parseGoogleBody(c);
  const name = getString(body, "name")?.trim();
  const color = body.color && typeof body.color === "object" && !Array.isArray(body.color)
    ? (body.color as Record<string, unknown>)
    : undefined;

  if (name) {
    const conflicting = findLabelByName(gs, authEmail, name);
    if (conflicting && conflicting.gmail_id !== label.gmail_id) {
      return googleApiError(
        c,
        400,
        "Label name exists or conflicts",
        "failedPrecondition",
        "FAILED_PRECONDITION",
      );
    }
  }

  const updated = updateLabelRecord(gs, label, {
    name: name ?? (replaceMissingFields ? label.name : undefined),
    message_list_visibility:
      getString(body, "messageListVisibility", "message_list_visibility") ??
      (replaceMissingFields ? "show" : undefined),
    label_list_visibility:
      getString(body, "labelListVisibility", "label_list_visibility") ??
      (replaceMissingFields ? "labelShow" : undefined),
    color_background:
      typeof color?.backgroundColor === "string"
        ? color.backgroundColor
        : getString(body, "color_background") ?? (replaceMissingFields ? null : undefined),
    color_text:
      typeof color?.textColor === "string"
        ? color.textColor
        : getString(body, "color_text") ?? (replaceMissingFields ? null : undefined),
  });

  return c.json(formatLabelResource(gs, updated));
}
