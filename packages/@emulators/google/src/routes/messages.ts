import type { RouteContext } from "@emulators/core";
import type { Context } from "hono";
import {
  applyLabelMutation,
  createStoredMessage,
  deleteMessage,
  dedupeLabelIds,
  findMissingLabelIds,
  formatMessageResource,
  getAttachmentById,
  getMessageById,
  googleApiError,
  listMessagesForUser,
  markMessageModified,
  normalizeLimit,
  parseBooleanParam,
  parseFormat,
  parseOffset,
  trashLabelIds,
  untrashLabelIds,
} from "../helpers.js";
import { getStringArray, parseGoogleBody, parseMessageInputFromBody, requireGmailUser } from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

export function messageRoutes({ app, store }: RouteContext): void {
  const gs = getGoogleStore(store);

  const createHandler =
    (mode: "insert" | "import" | "send") =>
    async (c: Context) => {
      const authEmail = requireGmailUser(c);
      if (authEmail instanceof Response) return authEmail;

      const body = await parseGoogleBody(c);
      const labelIds = getStringArray(body, "labelIds");
      const defaultLabelIds =
        mode === "send"
          ? dedupeLabelIds([...labelIds, "SENT"])
          : labelIds.length > 0
            ? labelIds
            : mode === "import"
              ? ["INBOX", "UNREAD"]
              : [];

      const missingLabelIds = findMissingLabelIds(gs, authEmail, defaultLabelIds);
      if (missingLabelIds.length > 0) {
        return googleApiError(c, 400, `Invalid label IDs: ${missingLabelIds.join(", ")}`, "invalidArgument", "INVALID_ARGUMENT");
      }

      const messageInput = parseMessageInputFromBody(body, {
        from: mode === "send" ? authEmail : undefined,
      });
      if (!messageInput.raw && (!messageInput.from || !messageInput.to)) {
        return googleApiError(
          c,
          400,
          "A raw MIME message or explicit from/to fields are required.",
          "invalidArgument",
          "INVALID_ARGUMENT",
        );
      }

      try {
        const message = createStoredMessage(gs, {
          user_email: authEmail,
          ...messageInput,
          label_ids: defaultLabelIds,
        });

        return c.json(formatMessageResource(gs, message, "full"));
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

  app.get("/gmail/v1/users/:userId/messages", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const url = new URL(c.req.url);
    const messages = listMessagesForUser(gs, authEmail, {
      labelIds: url.searchParams.getAll("labelIds"),
      query: url.searchParams.get("q")?.trim() ?? undefined,
      includeSpamTrash: parseBooleanParam(url.searchParams.get("includeSpamTrash")),
    });

    const offset = parseOffset(url.searchParams.get("pageToken"));
    const limit = normalizeLimit(url.searchParams.get("maxResults"), 100, 500);
    const page = messages.slice(offset, offset + limit);
    const nextPageToken = offset + limit < messages.length ? String(offset + limit) : undefined;

    return c.json({
      messages: page.map((message) => ({
        id: message.gmail_id,
        threadId: message.thread_id,
      })),
      nextPageToken,
      resultSizeEstimate: messages.length,
    });
  });

  app.post("/gmail/v1/users/:userId/messages/batchModify", async (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const body = await parseGoogleBody(c);
    const ids = getStringArray(body, "ids");
    const addLabelIds = getStringArray(body, "addLabelIds");
    const removeLabelIds = getStringArray(body, "removeLabelIds");

    const missingLabelIds = findMissingLabelIds(gs, authEmail, [...addLabelIds, ...removeLabelIds]);
    if (missingLabelIds.length > 0) {
      return googleApiError(c, 400, `Invalid label IDs: ${missingLabelIds.join(", ")}`, "invalidArgument", "INVALID_ARGUMENT");
    }

    for (const messageId of ids) {
      const message = getMessageById(gs, authEmail, messageId);
      if (!message) continue;

      markMessageModified(
        gs,
        message,
        applyLabelMutation(message.label_ids, addLabelIds, removeLabelIds),
      );
    }

    return c.body(null, 204);
  });

  app.post("/gmail/v1/users/:userId/messages/batchDelete", async (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const body = await parseGoogleBody(c);
    const ids = getStringArray(body, "ids");

    for (const messageId of ids) {
      const message = getMessageById(gs, authEmail, messageId);
      if (message) deleteMessage(gs, message);
    }

    return c.body(null, 204);
  });

  app.post("/gmail/v1/users/:userId/messages/import", createHandler("import"));
  app.post("/upload/gmail/v1/users/:userId/messages/import", createHandler("import"));
  app.post("/gmail/v1/users/:userId/messages/send", createHandler("send"));
  app.post("/upload/gmail/v1/users/:userId/messages/send", createHandler("send"));
  app.post("/gmail/v1/users/:userId/messages", createHandler("insert"));
  app.post("/upload/gmail/v1/users/:userId/messages", createHandler("insert"));

  app.get("/gmail/v1/users/:userId/messages/:messageId/attachments/:id", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const message = getMessageById(gs, authEmail, c.req.param("messageId"));
    if (!message) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const attachment = getAttachmentById(gs, authEmail, message.gmail_id, c.req.param("id"));
    if (!attachment) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    return c.json({
      attachmentId: attachment.gmail_id,
      size: attachment.size,
      data: attachment.data,
    });
  });

  app.get("/gmail/v1/users/:userId/messages/:id", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const message = getMessageById(gs, authEmail, c.req.param("id"));
    if (!message) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const url = new URL(c.req.url);
    return c.json(
      formatMessageResource(
        gs,
        message,
        parseFormat(url.searchParams.get("format")),
        url.searchParams.getAll("metadataHeaders"),
      ),
    );
  });

  app.post("/gmail/v1/users/:userId/messages/:id/modify", async (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const message = getMessageById(gs, authEmail, c.req.param("id"));
    if (!message) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const body = await parseGoogleBody(c);
    const addLabelIds = getStringArray(body, "addLabelIds");
    const removeLabelIds = getStringArray(body, "removeLabelIds");
    const missingLabelIds = findMissingLabelIds(gs, authEmail, [...addLabelIds, ...removeLabelIds]);
    if (missingLabelIds.length > 0) {
      return googleApiError(c, 400, `Invalid label IDs: ${missingLabelIds.join(", ")}`, "invalidArgument", "INVALID_ARGUMENT");
    }

    const updated = markMessageModified(
      gs,
      message,
      applyLabelMutation(message.label_ids, addLabelIds, removeLabelIds),
    );
    return c.json(formatMessageResource(gs, updated, "full"));
  });

  app.post("/gmail/v1/users/:userId/messages/:id/trash", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const message = getMessageById(gs, authEmail, c.req.param("id"));
    if (!message) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    return c.json(formatMessageResource(gs, markMessageModified(gs, message, trashLabelIds(message.label_ids)), "full"));
  });

  app.post("/gmail/v1/users/:userId/messages/:id/untrash", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const message = getMessageById(gs, authEmail, c.req.param("id"));
    if (!message) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    return c.json(formatMessageResource(gs, markMessageModified(gs, message, untrashLabelIds(message.label_ids)), "full"));
  });

  app.delete("/gmail/v1/users/:userId/messages/:id", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const message = getMessageById(gs, authEmail, c.req.param("id"));
    if (!message) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    deleteMessage(gs, message);
    return c.body(null, 204);
  });
}
