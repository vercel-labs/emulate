import type { RouteContext } from "@emulators/core";
import type { Context } from "hono";
import {
  createDraftMessage,
  deleteDraftMessage,
  formatDraftResource,
  getDraftById,
  getDraftMessage,
  googleApiError,
  listDraftsForUser,
  normalizeLimit,
  parseFormat,
  parseOffset,
  sendDraftMessage,
  updateDraftMessage,
} from "../helpers.js";
import { getRecord, getString, parseGoogleBody, parseMessageInputFromBody, requireGmailUser } from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

export function draftRoutes({ app, store }: RouteContext): void {
  const gs = getGoogleStore(store);

  const createHandler = async (c: Context) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const body = await parseGoogleBody(c);
    const messageBody = getRecord(body, "message") ?? body;

    try {
      const { draft } = createDraftMessage(gs, {
        user_email: authEmail,
        ...parseMessageInputFromBody(messageBody, { from: authEmail }),
      });

      return c.json(formatDraftResource(gs, draft, "full"));
    } catch {
      return googleApiError(
        c,
        400,
        "Invalid raw MIME message payload.",
        "invalidArgument",
        "INVALID_ARGUMENT",
      );
    }
  };

  const sendHandler = async (c: Context) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const body = await parseGoogleBody(c);
    const draftId = getString(body, "id") ?? getString(getRecord(body, "draft") ?? {}, "id");
    if (!draftId) {
      return googleApiError(c, 400, "Draft ID is required.", "invalidArgument", "INVALID_ARGUMENT");
    }

    const draft = getDraftById(gs, authEmail, draftId);
    if (!draft) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const message = sendDraftMessage(gs, draft);
    if (!message) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    return c.json({
      id: message.gmail_id,
      threadId: message.thread_id,
      labelIds: message.label_ids,
      snippet: message.snippet,
      historyId: message.history_id,
      internalDate: message.internal_date,
    });
  };

  app.get("/gmail/v1/users/:userId/drafts", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const drafts = listDraftsForUser(gs, authEmail);
    const url = new URL(c.req.url);
    const offset = parseOffset(url.searchParams.get("pageToken"));
    const limit = normalizeLimit(url.searchParams.get("maxResults"), 100, 500);
    const page = drafts.slice(offset, offset + limit);
    const nextPageToken = offset + limit < drafts.length ? String(offset + limit) : undefined;

    return c.json({
      drafts: page.map((draft) => {
        const resource = formatDraftResource(gs, draft, "minimal") as {
          id: string;
          message?: { id: string; threadId: string };
        };
        return {
          id: resource.id,
          message: resource.message
            ? {
                id: resource.message.id,
                threadId: resource.message.threadId,
              }
            : undefined,
        };
      }),
      nextPageToken,
      resultSizeEstimate: drafts.length,
    });
  });

  app.post("/gmail/v1/users/:userId/drafts", createHandler);
  app.post("/upload/gmail/v1/users/:userId/drafts", createHandler);

  app.get("/gmail/v1/users/:userId/drafts/:id", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const draft = getDraftById(gs, authEmail, c.req.param("id"));
    if (!draft) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }
    if (!getDraftMessage(gs, draft)) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const url = new URL(c.req.url);
    return c.json(
      formatDraftResource(
        gs,
        draft,
        parseFormat(url.searchParams.get("format")),
        url.searchParams.getAll("metadataHeaders"),
      ),
    );
  });

  app.put("/gmail/v1/users/:userId/drafts/:id", async (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const draft = getDraftById(gs, authEmail, c.req.param("id"));
    if (!draft) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const body = await parseGoogleBody(c);
    const messageBody = getRecord(body, "message") ?? body;

    try {
      const updated = updateDraftMessage(gs, draft, parseMessageInputFromBody(messageBody));

      if (!updated) {
        return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
      }

      return c.json(formatDraftResource(gs, updated.draft, "full"));
    } catch {
      return googleApiError(
        c,
        400,
        "Invalid raw MIME message payload.",
        "invalidArgument",
        "INVALID_ARGUMENT",
      );
    }
  });

  app.post("/gmail/v1/users/:userId/drafts/send", sendHandler);
  app.post("/upload/gmail/v1/users/:userId/drafts/send", sendHandler);

  app.delete("/gmail/v1/users/:userId/drafts/:id", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const draft = getDraftById(gs, authEmail, c.req.param("id"));
    if (!draft) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    deleteDraftMessage(gs, draft);
    return c.body(null, 204);
  });
}
