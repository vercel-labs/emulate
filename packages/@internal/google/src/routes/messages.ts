import type { RouteContext } from "@internal/core";
import type { Context } from "hono";
import {
  createStoredMessage,
  dedupeLabelIds,
  findMissingLabelIds,
  formatMessageResource,
  getMessageById,
  gmailError,
  listMessagesForUser,
  markMessageModified,
  normalizeLimit,
  parseBooleanParam,
  parseFormat,
  parseOffset,
  trashLabelIds,
  untrashLabelIds,
} from "../helpers.js";
import { requireGmailUser, parseGoogleBody, getStringArray, getString } from "../route-helpers.js";
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
        return gmailError(c, 400, `Invalid label IDs: ${missingLabelIds.join(", ")}`, "invalidArgument", "INVALID_ARGUMENT");
      }

      const raw = getString(body, "raw");
      const from = getString(body, "from") ?? (mode === "send" ? authEmail : undefined);
      const to = getString(body, "to");
      if (!raw && (!from || !to)) {
        return gmailError(
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
          raw,
          thread_id: getString(body, "threadId", "thread_id"),
          from,
          to,
          cc: getString(body, "cc") ?? null,
          bcc: getString(body, "bcc") ?? null,
          reply_to: getString(body, "replyTo", "reply_to") ?? null,
          subject: getString(body, "subject"),
          snippet: getString(body, "snippet"),
          body_text: getString(body, "body_text", "text") ?? null,
          body_html: getString(body, "body_html", "html") ?? null,
          label_ids: defaultLabelIds,
          date: getString(body, "date"),
          internal_date: getString(body, "internalDate", "internal_date"),
          message_id: getString(body, "messageId", "message_id"),
          references: getString(body, "references") ?? null,
          in_reply_to: getString(body, "inReplyTo", "in_reply_to") ?? null,
        });

        return c.json(formatMessageResource(message, "full"));
      } catch {
        return gmailError(
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
      return gmailError(c, 400, `Invalid label IDs: ${missingLabelIds.join(", ")}`, "invalidArgument", "INVALID_ARGUMENT");
    }

    for (const messageId of ids) {
      const message = getMessageById(gs, authEmail, messageId);
      if (!message) continue;

      markMessageModified(
        gs,
        message,
        message.label_ids.filter((labelId) => !removeLabelIds.includes(labelId)).concat(addLabelIds),
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
      if (message) gs.messages.delete(message.id);
    }

    return c.body(null, 204);
  });

  app.post("/gmail/v1/users/:userId/messages/import", createHandler("import"));
  app.post("/upload/gmail/v1/users/:userId/messages/import", createHandler("import"));
  app.post("/gmail/v1/users/:userId/messages/send", createHandler("send"));
  app.post("/upload/gmail/v1/users/:userId/messages/send", createHandler("send"));
  app.post("/gmail/v1/users/:userId/messages", createHandler("insert"));
  app.post("/upload/gmail/v1/users/:userId/messages", createHandler("insert"));

  app.get("/gmail/v1/users/:userId/messages/:id", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const message = getMessageById(gs, authEmail, c.req.param("id"));
    if (!message) {
      return gmailError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const url = new URL(c.req.url);
    return c.json(
      formatMessageResource(
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
      return gmailError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const body = await parseGoogleBody(c);
    const addLabelIds = getStringArray(body, "addLabelIds");
    const removeLabelIds = getStringArray(body, "removeLabelIds");
    const missingLabelIds = findMissingLabelIds(gs, authEmail, [...addLabelIds, ...removeLabelIds]);
    if (missingLabelIds.length > 0) {
      return gmailError(c, 400, `Invalid label IDs: ${missingLabelIds.join(", ")}`, "invalidArgument", "INVALID_ARGUMENT");
    }

    const updated = markMessageModified(
      gs,
      message,
      message.label_ids.filter((labelId) => !removeLabelIds.includes(labelId)).concat(addLabelIds),
    );
    return c.json(formatMessageResource(updated, "full"));
  });

  app.post("/gmail/v1/users/:userId/messages/:id/trash", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const message = getMessageById(gs, authEmail, c.req.param("id"));
    if (!message) {
      return gmailError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    return c.json(formatMessageResource(markMessageModified(gs, message, trashLabelIds(message.label_ids)), "full"));
  });

  app.post("/gmail/v1/users/:userId/messages/:id/untrash", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const message = getMessageById(gs, authEmail, c.req.param("id"));
    if (!message) {
      return gmailError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    return c.json(formatMessageResource(markMessageModified(gs, message, untrashLabelIds(message.label_ids)), "full"));
  });

  app.delete("/gmail/v1/users/:userId/messages/:id", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const message = getMessageById(gs, authEmail, c.req.param("id"));
    if (!message) {
      return gmailError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    gs.messages.delete(message.id);
    return c.body(null, 204);
  });
}
