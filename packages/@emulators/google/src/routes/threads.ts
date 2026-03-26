import type { RouteContext } from "@emulators/core";
import {
  applyLabelMutation,
  deleteMessage,
  findMissingLabelIds,
  formatThreadResource,
  getThreadMessages,
  googleApiError,
  groupThreads,
  listMessagesForUser,
  markMessageModified,
  normalizeLimit,
  parseBooleanParam,
  parseFormat,
  parseOffset,
  trashLabelIds,
  untrashLabelIds,
} from "../helpers.js";
import { requireGmailUser, parseGoogleBody, getStringArray } from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

export function threadRoutes({ app, store }: RouteContext): void {
  const gs = getGoogleStore(store);

  app.get("/gmail/v1/users/:userId/threads", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const url = new URL(c.req.url);
    const threads = groupThreads(
      listMessagesForUser(gs, authEmail, {
        labelIds: url.searchParams.getAll("labelIds"),
        query: url.searchParams.get("q")?.trim() ?? undefined,
        includeSpamTrash: parseBooleanParam(url.searchParams.get("includeSpamTrash")),
      }),
    );

    const offset = parseOffset(url.searchParams.get("pageToken"));
    const limit = normalizeLimit(url.searchParams.get("maxResults"), 100, 500);
    const page = threads.slice(offset, offset + limit);
    const nextPageToken = offset + limit < threads.length ? String(offset + limit) : undefined;

    return c.json({
      threads: page.map((thread) => ({
        id: thread.id,
        snippet: thread.snippet,
        historyId: thread.historyId,
      })),
      nextPageToken,
      resultSizeEstimate: threads.length,
    });
  });

  app.get("/gmail/v1/users/:userId/threads/:id", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const url = new URL(c.req.url);
    const messages = getThreadMessages(gs, authEmail, c.req.param("id"), {
      includeSpamTrash: parseBooleanParam(url.searchParams.get("includeSpamTrash")),
    });

    if (messages.length === 0) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    return c.json(
      formatThreadResource(
        gs,
        messages,
        parseFormat(url.searchParams.get("format")),
        url.searchParams.getAll("metadataHeaders"),
      ),
    );
  });

  app.post("/gmail/v1/users/:userId/threads/:id/modify", async (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const messages = getThreadMessages(gs, authEmail, c.req.param("id"), { includeSpamTrash: true });
    if (messages.length === 0) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const body = await parseGoogleBody(c);
    const addLabelIds = getStringArray(body, "addLabelIds");
    const removeLabelIds = getStringArray(body, "removeLabelIds");
    const missingLabelIds = findMissingLabelIds(gs, authEmail, [...addLabelIds, ...removeLabelIds]);
    if (missingLabelIds.length > 0) {
      return googleApiError(c, 400, `Invalid label IDs: ${missingLabelIds.join(", ")}`, "invalidArgument", "INVALID_ARGUMENT");
    }

    const updated = messages.map((message) =>
      markMessageModified(
        gs,
        message,
        applyLabelMutation(message.label_ids, addLabelIds, removeLabelIds),
      ),
    );

    return c.json(formatThreadResource(gs, updated, "full"));
  });

  app.post("/gmail/v1/users/:userId/threads/:id/trash", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const messages = getThreadMessages(gs, authEmail, c.req.param("id"), { includeSpamTrash: true });
    if (messages.length === 0) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const updated = messages.map((message) => markMessageModified(gs, message, trashLabelIds(message.label_ids)));
    return c.json(formatThreadResource(gs, updated, "full"));
  });

  app.post("/gmail/v1/users/:userId/threads/:id/untrash", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const messages = getThreadMessages(gs, authEmail, c.req.param("id"), { includeSpamTrash: true });
    if (messages.length === 0) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const updated = messages.map((message) => markMessageModified(gs, message, untrashLabelIds(message.label_ids)));
    return c.json(formatThreadResource(gs, updated, "full"));
  });

  app.delete("/gmail/v1/users/:userId/threads/:id", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const messages = getThreadMessages(gs, authEmail, c.req.param("id"), { includeSpamTrash: true });
    if (messages.length === 0) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    for (const message of messages) {
      deleteMessage(gs, message);
    }

    return c.body(null, 204);
  });
}
