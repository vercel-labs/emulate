import type { RouteContext } from "@emulators/core";
import {
  createCalendarEventRecord,
  createCategoryRecord,
  createDriveItemRecord,
  createMailFolderRecord,
  createMessageRecord,
  createReplyDraft,
  ensureDefaultFolders,
  filterDriveItems,
  filterMessages,
  formatAttachmentResource,
  formatCalendarEventResource,
  formatCalendarResource,
  formatCategoryResource,
  formatDriveItemResource,
  formatFolderResource,
  formatMessageResource,
  formatRuleResource,
  formatSubscriptionResource,
  generateMicrosoftId,
  getFolderByIdOrWellKnownName,
  getMicrosoftUserByEmail,
  microsoftGraphError,
  moveMessage,
  OUTLOOK_COLORS,
  paginateResults,
  parsePositiveInt,
  searchMessages,
  sortMessages,
  type UploadSessionRecord,
  updateMessage,
  upsertMessageAttachment,
  dedupeRecipients,
} from "../helpers.js";
import { getMicrosoftStore } from "../store.js";
import { parseJsonBody } from "../route-helpers.js";

const DEFAULT_ATTACHMENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2P8z8DwHwAFgwJ/lxux1QAAAABJRU5ErkJggg==",
  "base64",
);

type DriveUploadSessionRecord = {
  sessionId: string;
  userEmail: string;
  parentId: string | null;
  fileName: string;
  contentType: string;
  totalSize: number;
  uploadedBytes: number;
  contentChunks: Buffer[];
};

function finalizeUploadedContent(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("base64");
}

function getUploadSessions(ctx: RouteContext): Map<string, UploadSessionRecord> {
  let sessions = ctx.store.getData<Map<string, UploadSessionRecord>>("microsoft.uploadSessions");
  if (!sessions) {
    sessions = new Map();
    ctx.store.setData("microsoft.uploadSessions", sessions);
  }
  return sessions;
}

function getDriveUploadSessions(ctx: RouteContext): Map<string, DriveUploadSessionRecord> {
  let sessions = ctx.store.getData<Map<string, DriveUploadSessionRecord>>("microsoft.driveUploadSessions");
  if (!sessions) {
    sessions = new Map();
    ctx.store.setData("microsoft.driveUploadSessions", sessions);
  }
  return sessions;
}

function requireAuthEmail(ctx: RouteContext, c: any): string | Response {
  const authUser = c.get("authUser");
  const email = authUser?.login ?? null;
  if (!email) {
    return microsoftGraphError(c, 401, "InvalidAuthenticationToken", "Authentication required.");
  }
  const user = getMicrosoftUserByEmail(getMicrosoftStore(ctx.store), email);
  if (!user) {
    return microsoftGraphError(c, 404, "Request_ResourceNotFound", "User not found.");
  }
  ensureDefaultFolders(getMicrosoftStore(ctx.store), email);
  return email;
}

function buildNextLink(currentUrl: string, nextSkip: number): string {
  const url = new URL(currentUrl);
  url.searchParams.set("$skip", String(nextSkip));
  // Return a Graph-relative path so SDK clients can keep using their configured
  // base URL and auth middleware when following @odata.nextLink.
  return `${url.pathname}${url.search}`;
}

function getTopAndSkip(c: any) {
  return {
    top: parsePositiveInt(c.req.query("$top"), 10),
    skip: parsePositiveInt(c.req.query("$skip"), 0),
  };
}

function resolveMessage(ctx: RouteContext, userEmail: string, messageId: string) {
  const ms = getMicrosoftStore(ctx.store);
  return ms.messages.findBy("user_email", userEmail).find((message) => message.microsoft_id === messageId);
}

function resolveFolder(ctx: RouteContext, userEmail: string, folderId: string) {
  return getFolderByIdOrWellKnownName(getMicrosoftStore(ctx.store), userEmail, folderId);
}

function resolveCalendar(ctx: RouteContext, userEmail: string, calendarId: string) {
  const ms = getMicrosoftStore(ctx.store);
  if (calendarId === "primary") {
    return ms.calendars.findBy("user_email", userEmail).find((entry) => entry.is_default_calendar) ?? null;
  }
  return ms.calendars.findBy("user_email", userEmail).find((entry) => entry.microsoft_id === calendarId) ?? null;
}

function resolveCalendarEvent(ctx: RouteContext, userEmail: string, eventId: string) {
  const ms = getMicrosoftStore(ctx.store);
  return ms.calendarEvents.findBy("user_email", userEmail).find((entry) => entry.microsoft_id === eventId) ?? null;
}

function patchMessageFromBody(ctx: RouteContext, messageId: string, body: Record<string, unknown>) {
  const ms = getMicrosoftStore(ctx.store);
  const message = ms.messages.findOneBy("microsoft_id", messageId);
  if (!message) return null;

  const patch: Record<string, unknown> = {};
  if (typeof body.subject === "string") patch.subject = body.subject;
  const bodyRecord = body.body;
  if (bodyRecord && typeof bodyRecord === "object" && !Array.isArray(bodyRecord)) {
    const graphBody = bodyRecord as Record<string, unknown>;
    if (typeof graphBody.content === "string") patch.body_content = graphBody.content;
    if (graphBody.contentType === "text" || graphBody.contentType === "html") {
      patch.body_content_type = graphBody.contentType;
    }
  }
  if (Array.isArray(body.categories)) {
    patch.categories = body.categories.filter((value): value is string => typeof value === "string");
  }
  if (typeof body.isRead === "boolean") patch.is_read = body.isRead;
  if (body.importance === "low" || body.importance === "normal" || body.importance === "high") {
    patch.importance = body.importance;
  }
  if (Array.isArray(body.toRecipients)) {
    patch.to_recipients = extractRecipients(body.toRecipients);
  }
  if (Array.isArray(body.ccRecipients)) {
    patch.cc_recipients = extractRecipients(body.ccRecipients);
  }
  if (Array.isArray(body.bccRecipients)) {
    patch.bcc_recipients = extractRecipients(body.bccRecipients);
  }
  if (Array.isArray(body.replyTo)) {
    patch.reply_to = extractRecipients(body.replyTo);
  }
  if (body.from && typeof body.from === "object" && !Array.isArray(body.from)) {
    const emailAddress = (body.from as Record<string, unknown>).emailAddress;
    if (emailAddress && typeof emailAddress === "object" && !Array.isArray(emailAddress)) {
      patch.from_address =
        typeof (emailAddress as Record<string, unknown>).address === "string"
          ? (emailAddress as Record<string, unknown>).address
          : message.from_address;
      patch.from_name =
        typeof (emailAddress as Record<string, unknown>).name === "string"
          ? (emailAddress as Record<string, unknown>).name
          : message.from_name;
      patch.sender_address = patch.from_address;
      patch.sender_name = patch.from_name;
    }
  }

  return updateMessage(ms, message, patch as any);
}

export function graphRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  app.get("/v1.0/me/photo/$value", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    return c.body(DEFAULT_ATTACHMENT_PNG, 200, {
      "Content-Type": "image/png",
      "Content-Length": String(DEFAULT_ATTACHMENT_PNG.length),
    });
  });

  app.get("/v1.0/me/messages", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;

    const ms = getMicrosoftStore(ctx.store);
    const { top, skip } = getTopAndSkip(c);
    const filtered = sortMessages(
      searchMessages(
        filterMessages(ms.messages.findBy("user_email", authEmail), c.req.query("$filter")),
        c.req.query("$search"),
      ),
      c.req.query("$orderby"),
    );
    const { items, nextSkip } = paginateResults(filtered, top, skip);

    return c.json({
      value: items.map((message) => formatMessageResource(ms, message)),
      ...(nextSkip != null ? { "@odata.nextLink": buildNextLink(c.req.url, nextSkip) } : {}),
    });
  });

  app.get("/v1.0/me/mailFolders/:folderId/messages", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;

    const folder = resolveFolder(ctx, authEmail, c.req.param("folderId"));
    if (!folder) return microsoftGraphError(c, 404, "ErrorFolderNotFound", "Folder not found.");

    const ms = getMicrosoftStore(ctx.store);
    const { top, skip } = getTopAndSkip(c);
    const filtered = sortMessages(
      searchMessages(
        filterMessages(
          ms.messages
            .findBy("user_email", authEmail)
            .filter((message) => message.parent_folder_id === folder.microsoft_id),
          c.req.query("$filter"),
        ),
        c.req.query("$search"),
      ),
      c.req.query("$orderby"),
    );
    const { items, nextSkip } = paginateResults(filtered, top, skip);

    return c.json({
      value: items.map((message) => formatMessageResource(ms, message)),
      ...(nextSkip != null ? { "@odata.nextLink": buildNextLink(c.req.url, nextSkip) } : {}),
    });
  });

  app.post("/v1.0/me/messages", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const folders = ensureDefaultFolders(ms, authEmail);
    const body = await parseJsonBody(c);
    const created = createMessageRecord(ms, {
      user_email: authEmail,
      subject: typeof body.subject === "string" ? body.subject : "",
      body_content:
        body.body &&
        typeof body.body === "object" &&
        !Array.isArray(body.body) &&
        typeof (body.body as Record<string, unknown>).content === "string"
          ? ((body.body as Record<string, unknown>).content as string)
          : "",
      body_content_type:
        body.body &&
        typeof body.body === "object" &&
        !Array.isArray(body.body) &&
        (body.body as Record<string, unknown>).contentType === "text"
          ? "text"
          : "html",
      from: { address: authEmail, name: getMicrosoftUserByEmail(ms, authEmail)?.name },
      sender: { address: authEmail, name: getMicrosoftUserByEmail(ms, authEmail)?.name },
      to_recipients: extractRecipients(body.toRecipients),
      cc_recipients: extractRecipients(body.ccRecipients),
      bcc_recipients: extractRecipients(body.bccRecipients),
      reply_to: extractRecipients(body.replyTo),
      is_draft: true,
      is_read: true,
      parent_folder_id: folders.drafts.microsoft_id,
      web_link_base: ctx.baseUrl,
    });
    return c.json(formatMessageResource(ms, created), 201);
  });

  app.post("/v1.0/me/sendMail", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const folders = ensureDefaultFolders(ms, authEmail);
    const body = await parseJsonBody(c);
    const messageRecord =
      body.message && typeof body.message === "object" && !Array.isArray(body.message)
        ? (body.message as Record<string, unknown>)
        : body;

    createMessageRecord(ms, {
      user_email: authEmail,
      subject: typeof messageRecord.subject === "string" ? messageRecord.subject : "",
      body_content:
        messageRecord.body &&
        typeof messageRecord.body === "object" &&
        !Array.isArray(messageRecord.body) &&
        typeof (messageRecord.body as Record<string, unknown>).content === "string"
          ? ((messageRecord.body as Record<string, unknown>).content as string)
          : "",
      body_content_type:
        messageRecord.body &&
        typeof messageRecord.body === "object" &&
        !Array.isArray(messageRecord.body) &&
        (messageRecord.body as Record<string, unknown>).contentType === "text"
          ? "text"
          : "html",
      from: { address: authEmail, name: getMicrosoftUserByEmail(ms, authEmail)?.name },
      sender: { address: authEmail, name: getMicrosoftUserByEmail(ms, authEmail)?.name },
      to_recipients: extractRecipients(messageRecord.toRecipients),
      cc_recipients: extractRecipients(messageRecord.ccRecipients),
      bcc_recipients: extractRecipients(messageRecord.bccRecipients),
      reply_to: extractRecipients(messageRecord.replyTo),
      is_draft: false,
      is_read: true,
      parent_folder_id: folders.sentitems.microsoft_id,
      web_link_base: ctx.baseUrl,
    });

    return c.body(null, 202);
  });

  app.get("/v1.0/me/messages/:messageId", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const message = resolveMessage(ctx, authEmail, c.req.param("messageId"));
    if (!message) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Message not found.");
    return c.json(formatMessageResource(ms, message));
  });

  app.patch("/v1.0/me/messages/:messageId", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const body = await parseJsonBody(c);
    const updated = patchMessageFromBody(ctx, c.req.param("messageId"), body);
    if (!updated || updated.user_email !== authEmail) {
      return microsoftGraphError(c, 404, "ErrorItemNotFound", "Message not found.");
    }
    return c.json(formatMessageResource(getMicrosoftStore(ctx.store), updated));
  });

  app.delete("/v1.0/me/messages/:messageId", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const message = resolveMessage(ctx, authEmail, c.req.param("messageId"));
    if (!message) return c.body(null, 204);
    const deletedItems = ensureDefaultFolders(ms, authEmail).deleteditems;
    moveMessage(ms, message, deletedItems.microsoft_id);
    return c.body(null, 204);
  });

  app.post("/v1.0/me/messages/:messageId/send", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const folders = ensureDefaultFolders(ms, authEmail);
    const message = resolveMessage(ctx, authEmail, c.req.param("messageId"));
    if (!message) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Message not found.");
    const updated = updateMessage(ms, message, {
      is_draft: false,
      is_read: true,
      parent_folder_id: folders.sentitems.microsoft_id,
      sent_date_time: new Date().toISOString(),
      received_date_time: new Date().toISOString(),
    });
    return c.json(formatMessageResource(ms, updated));
  });

  app.post("/v1.0/me/messages/:messageId/createReply", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const message = resolveMessage(ctx, authEmail, c.req.param("messageId"));
    if (!message) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Message not found.");
    updateMessage(ms, message, { is_read: true });
    const draft = createReplyDraft(ms, ctx.baseUrl, authEmail, message, { replyAll: false });
    return c.json(formatMessageResource(ms, draft), 201);
  });

  app.post("/v1.0/me/messages/:messageId/createReplyAll", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const message = resolveMessage(ctx, authEmail, c.req.param("messageId"));
    if (!message) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Message not found.");
    updateMessage(ms, message, { is_read: true });
    const draft = createReplyDraft(ms, ctx.baseUrl, authEmail, message, { replyAll: true });
    return c.json(formatMessageResource(ms, draft), 201);
  });

  app.post("/v1.0/me/messages/:messageId/reply", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const original = resolveMessage(ctx, authEmail, c.req.param("messageId"));
    if (!original) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Message not found.");
    const folders = ensureDefaultFolders(ms, authEmail);
    const body = await parseJsonBody(c);
    const comment = typeof body.comment === "string" ? body.comment : "";
    updateMessage(ms, original, { is_read: true });
    createMessageRecord(ms, {
      user_email: authEmail,
      conversation_id: original.conversation_id,
      subject: original.subject.toLowerCase().startsWith("re:") ? original.subject : `Re: ${original.subject}`,
      body_content: comment,
      body_content_type: "html",
      from: { address: authEmail, name: getMicrosoftUserByEmail(ms, authEmail)?.name },
      sender: { address: authEmail, name: getMicrosoftUserByEmail(ms, authEmail)?.name },
      to_recipients: original.from_address
        ? [{ address: original.from_address, name: original.from_name ?? undefined }]
        : [],
      is_draft: false,
      is_read: true,
      parent_folder_id: folders.sentitems.microsoft_id,
      in_reply_to_microsoft_id: original.microsoft_id,
      web_link_base: ctx.baseUrl,
    });
    return c.body(null, 202);
  });

  app.post("/v1.0/me/messages/:messageId/replyAll", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const original = resolveMessage(ctx, authEmail, c.req.param("messageId"));
    if (!original) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Message not found.");
    const folders = ensureDefaultFolders(ms, authEmail);
    const body = await parseJsonBody(c);
    const comment = typeof body.comment === "string" ? body.comment : "";
    updateMessage(ms, original, { is_read: true });
    const recipients = [
      ...(original.from_address ? [{ address: original.from_address, name: original.from_name ?? undefined }] : []),
      ...original.to_recipients.filter((recipient) => recipient.address !== authEmail),
      ...original.cc_recipients.filter((recipient) => recipient.address !== authEmail),
    ];
    createMessageRecord(ms, {
      user_email: authEmail,
      conversation_id: original.conversation_id,
      subject: original.subject.toLowerCase().startsWith("re:") ? original.subject : `Re: ${original.subject}`,
      body_content: comment,
      body_content_type: "html",
      from: { address: authEmail, name: getMicrosoftUserByEmail(ms, authEmail)?.name },
      sender: { address: authEmail, name: getMicrosoftUserByEmail(ms, authEmail)?.name },
      to_recipients: dedupeRecipients(recipients),
      cc_recipients: [],
      is_draft: false,
      is_read: true,
      parent_folder_id: folders.sentitems.microsoft_id,
      in_reply_to_microsoft_id: original.microsoft_id,
      web_link_base: ctx.baseUrl,
    });
    return c.body(null, 202);
  });

  app.post("/v1.0/me/messages/:messageId/forward", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const original = resolveMessage(ctx, authEmail, c.req.param("messageId"));
    if (!original) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Message not found.");
    const folders = ensureDefaultFolders(ms, authEmail);
    const body = await parseJsonBody(c);
    const messageRecord =
      body.message && typeof body.message === "object" && !Array.isArray(body.message)
        ? (body.message as Record<string, unknown>)
        : body;
    createMessageRecord(ms, {
      user_email: authEmail,
      conversation_id: generateMicrosoftId("conv"),
      subject: typeof messageRecord.subject === "string" ? messageRecord.subject : `Fwd: ${original.subject}`,
      body_content:
        messageRecord.body &&
        typeof messageRecord.body === "object" &&
        !Array.isArray(messageRecord.body) &&
        typeof (messageRecord.body as Record<string, unknown>).content === "string"
          ? ((messageRecord.body as Record<string, unknown>).content as string)
          : "",
      body_content_type: "html",
      from: { address: authEmail, name: getMicrosoftUserByEmail(ms, authEmail)?.name },
      sender: { address: authEmail, name: getMicrosoftUserByEmail(ms, authEmail)?.name },
      to_recipients: extractRecipients(messageRecord.toRecipients),
      cc_recipients: extractRecipients(messageRecord.ccRecipients),
      bcc_recipients: extractRecipients(messageRecord.bccRecipients),
      is_draft: false,
      is_read: true,
      parent_folder_id: folders.sentitems.microsoft_id,
      web_link_base: ctx.baseUrl,
    });
    return c.json({}, 202);
  });

  app.post("/v1.0/me/messages/:messageId/move", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const body = await parseJsonBody(c);
    const destinationId = typeof body.destinationId === "string" ? body.destinationId : "";
    if (!destinationId) {
      return microsoftGraphError(c, 400, "InvalidRequest", "destinationId is required.");
    }
    const ms = getMicrosoftStore(ctx.store);
    const message = resolveMessage(ctx, authEmail, c.req.param("messageId"));
    if (!message) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Message not found.");
    try {
      const moved = moveMessage(ms, message, destinationId);
      return c.json(formatMessageResource(ms, moved));
    } catch {
      return microsoftGraphError(c, 404, "ErrorItemNotFound", "Destination folder not found.");
    }
  });

  app.get("/v1.0/me/messages/:messageId/attachments/:attachmentId", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const attachment = ms.attachments
      .findBy("user_email", authEmail)
      .find(
        (entry) =>
          entry.message_microsoft_id === c.req.param("messageId") && entry.microsoft_id === c.req.param("attachmentId"),
      );
    if (!attachment) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Attachment not found.");
    return c.json(formatAttachmentResource(attachment));
  });

  app.get("/v1.0/me/messages/:messageId/attachments", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const message = resolveMessage(ctx, authEmail, c.req.param("messageId"));
    if (!message) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Message not found.");
    return c.json({
      value: ms.attachments.findBy("message_microsoft_id", message.microsoft_id).map(formatAttachmentResource),
    });
  });

  app.post("/v1.0/me/messages/:messageId/attachments", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const message = resolveMessage(ctx, authEmail, c.req.param("messageId"));
    if (!message) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Message not found.");
    const body = await parseJsonBody(c);
    const attachment = upsertMessageAttachment(ms, {
      user_email: authEmail,
      message_microsoft_id: message.microsoft_id,
      name: typeof body.name === "string" ? body.name : "attachment.bin",
      content_type: typeof body.contentType === "string" ? body.contentType : "application/octet-stream",
      content_bytes: typeof body.contentBytes === "string" ? body.contentBytes : "",
    });
    return c.json(formatAttachmentResource(attachment), 201);
  });

  app.post("/v1.0/me/messages/:messageId/attachments/createUploadSession", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const message = resolveMessage(ctx, authEmail, c.req.param("messageId"));
    if (!message) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Message not found.");
    const body = await parseJsonBody(c);
    const attachmentItem =
      body.AttachmentItem && typeof body.AttachmentItem === "object" && !Array.isArray(body.AttachmentItem)
        ? (body.AttachmentItem as Record<string, unknown>)
        : {};
    const sessionId = generateMicrosoftId("upload");
    getUploadSessions(ctx).set(sessionId, {
      sessionId,
      userEmail: authEmail,
      messageId: message.microsoft_id,
      attachmentName: typeof attachmentItem.name === "string" ? attachmentItem.name : "attachment.bin",
      contentType:
        typeof attachmentItem.contentType === "string" ? attachmentItem.contentType : "application/octet-stream",
      totalSize: typeof attachmentItem.size === "number" ? attachmentItem.size : 0,
      uploadedBytes: 0,
      contentChunks: [],
    });
    return c.json({
      uploadUrl: `${ctx.baseUrl}/upload/microsoft/v1.0/messages/${message.microsoft_id}/attachments/sessions/${sessionId}`,
      expirationDateTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      nextExpectedRanges: ["0-"],
    });
  });

  app.get("/upload/microsoft/v1.0/messages/:messageId/attachments/sessions/:sessionId", (c) => {
    const session = getUploadSessions(ctx).get(c.req.param("sessionId"));
    if (!session || session.messageId !== c.req.param("messageId")) {
      return c.body(null, 404);
    }
    return c.json({
      nextExpectedRanges: [`${session.uploadedBytes}-`],
    });
  });

  app.put("/upload/microsoft/v1.0/messages/:messageId/attachments/sessions/:sessionId", async (c) => {
    const session = getUploadSessions(ctx).get(c.req.param("sessionId"));
    if (!session || session.messageId !== c.req.param("messageId")) {
      return c.body(null, 404);
    }
    const range = c.req.header("Content-Range") ?? "";
    const match = range.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/);
    if (!match) {
      return microsoftGraphError(c, 400, "InvalidRequest", "Content-Range header is required.");
    }
    const [, startText, endText, totalText] = match;
    const start = Number.parseInt(startText, 10);
    const end = Number.parseInt(endText, 10);
    const total = Number.parseInt(totalText, 10);
    if (start !== session.uploadedBytes) {
      return c.json({ nextExpectedRanges: [`${session.uploadedBytes}-`] }, 416);
    }
    const chunk = Buffer.from(await c.req.arrayBuffer());
    const updatedBytes = end + 1;
    session.contentChunks.push(chunk);
    session.totalSize = total;
    session.uploadedBytes = updatedBytes;
    getUploadSessions(ctx).set(session.sessionId, session);

    if (updatedBytes >= total) {
      const ms = getMicrosoftStore(ctx.store);
      const attachment = upsertMessageAttachment(ms, {
        user_email: session.userEmail,
        message_microsoft_id: session.messageId,
        name: session.attachmentName,
        content_type: session.contentType,
        size: total,
        content_bytes: finalizeUploadedContent(session.contentChunks),
      });
      getUploadSessions(ctx).delete(session.sessionId);
      return c.json(formatAttachmentResource(attachment), 201);
    }

    return c.json(
      {
        nextExpectedRanges: [`${updatedBytes}-`],
      },
      202,
    );
  });

  app.get("/v1.0/me/mailFolders", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const filter = c.req.query("$filter");
    const folders = filter
      ? ensureDefaultFolders(ms, authEmail) &&
        ms.mailFolders.findBy("user_email", authEmail).filter((folder) => {
          const match = filter.match(/^displayName eq '(.+)'$/);
          if (!match) return true;
          return folder.display_name === match[1]?.replace(/''/g, "'");
        })
      : ms.mailFolders.findBy("user_email", authEmail).filter((folder) => folder.parent_folder_id === null);

    return c.json({
      value: folders.map((folder) => formatFolderResource(ms, folder, authEmail)),
    });
  });

  app.post("/v1.0/me/mailFolders", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const body = await parseJsonBody(c);
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!displayName) {
      return microsoftGraphError(c, 400, "InvalidRequest", "displayName is required.");
    }
    const existing = ms.mailFolders
      .findBy("user_email", authEmail)
      .find((folder) => folder.parent_folder_id === null && folder.display_name === displayName);
    if (existing) {
      return microsoftGraphError(c, 409, "ErrorFolderExists", "A folder with that name already exists.");
    }
    const created = createMailFolderRecord(ms, { user_email: authEmail, display_name: displayName });
    return c.json(formatFolderResource(ms, created, authEmail), 201);
  });

  app.get("/v1.0/me/mailFolders/:folderId", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const folder = resolveFolder(ctx, authEmail, c.req.param("folderId"));
    if (!folder) return microsoftGraphError(c, 404, "ErrorFolderNotFound", "Folder not found.");
    return c.json(formatFolderResource(ms, folder, authEmail));
  });

  app.get("/v1.0/me/mailFolders/:folderId/childFolders", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const folder = resolveFolder(ctx, authEmail, c.req.param("folderId"));
    if (!folder) return microsoftGraphError(c, 404, "ErrorFolderNotFound", "Folder not found.");
    const children = ms.mailFolders
      .findBy("user_email", authEmail)
      .filter((entry) => entry.parent_folder_id === folder.microsoft_id);
    return c.json({
      value: children.map((child) => formatFolderResource(ms, child, authEmail)),
    });
  });

  app.get("/v1.0/me/calendar", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const calendar = resolveCalendar(ctx, authEmail, "primary");
    if (!calendar) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Calendar not found.");
    return c.json(formatCalendarResource(calendar));
  });

  app.get("/v1.0/me/outlook/masterCategories", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    return c.json({
      value: ms.categories.findBy("user_email", authEmail).map(formatCategoryResource),
    });
  });

  app.post("/v1.0/me/outlook/masterCategories", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const body = await parseJsonBody(c);
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!displayName) return microsoftGraphError(c, 400, "InvalidRequest", "displayName is required.");
    const existing = ms.categories
      .findBy("user_email", authEmail)
      .find((category) => category.display_name.toLowerCase() === displayName.toLowerCase());
    if (existing) {
      return microsoftGraphError(c, 409, "ErrorAlreadyExists", "Category already exists.");
    }
    const color =
      typeof body.color === "string" && OUTLOOK_COLORS.includes(body.color as any)
        ? (body.color as string)
        : OUTLOOK_COLORS[0];
    const created = createCategoryRecord(ms, { user_email: authEmail, display_name: displayName, color });
    return c.json(formatCategoryResource(created), 201);
  });

  app.get("/v1.0/me/outlook/masterCategories/:categoryId", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const category = ms.categories
      .findBy("user_email", authEmail)
      .find((entry) => entry.microsoft_id === c.req.param("categoryId"));
    if (!category) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Category not found.");
    return c.json(formatCategoryResource(category));
  });

  app.delete("/v1.0/me/outlook/masterCategories/:categoryId", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const category = ms.categories
      .findBy("user_email", authEmail)
      .find((entry) => entry.microsoft_id === c.req.param("categoryId"));
    if (!category) return c.body(null, 204);
    ms.categories.delete(category.id);
    return c.body(null, 204);
  });

  app.get("/v1.0/me/mailFolders/inbox/messageRules", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    return c.json({
      value: ms.messageRules.findBy("user_email", authEmail).map(formatRuleResource),
    });
  });

  app.post("/v1.0/me/mailFolders/inbox/messageRules", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const body = await parseJsonBody(c);
    const displayName = typeof body.displayName === "string" ? body.displayName : "Rule";
    const existing = ms.messageRules.findBy("user_email", authEmail).find((rule) => rule.display_name === displayName);
    if (existing) {
      return microsoftGraphError(c, 409, "ErrorAlreadyExists", "Rule already exists.");
    }
    const created = ms.messageRules.insert({
      microsoft_id: generateMicrosoftId("rule"),
      user_email: authEmail,
      display_name: displayName,
      sequence: typeof body.sequence === "number" ? body.sequence : 1,
      is_enabled: body.isEnabled !== false,
      conditions:
        body.conditions && typeof body.conditions === "object" && !Array.isArray(body.conditions)
          ? {
              senderContains: Array.isArray((body.conditions as Record<string, unknown>).senderContains)
                ? ((body.conditions as Record<string, unknown>).senderContains as unknown[]).filter(
                    (value): value is string => typeof value === "string",
                  )
                : undefined,
            }
          : {},
      actions:
        body.actions && typeof body.actions === "object" && !Array.isArray(body.actions)
          ? {
              moveToFolder:
                typeof (body.actions as Record<string, unknown>).moveToFolder === "string"
                  ? ((body.actions as Record<string, unknown>).moveToFolder as string)
                  : undefined,
              markAsRead:
                typeof (body.actions as Record<string, unknown>).markAsRead === "boolean"
                  ? ((body.actions as Record<string, unknown>).markAsRead as boolean)
                  : undefined,
              assignCategories: Array.isArray((body.actions as Record<string, unknown>).assignCategories)
                ? ((body.actions as Record<string, unknown>).assignCategories as unknown[]).filter(
                    (value): value is string => typeof value === "string",
                  )
                : undefined,
            }
          : {},
    });
    return c.json(formatRuleResource(created), 201);
  });

  app.patch("/v1.0/me/mailFolders/inbox/messageRules/:ruleId", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const existing = ms.messageRules
      .findBy("user_email", authEmail)
      .find((rule) => rule.microsoft_id === c.req.param("ruleId"));
    if (!existing) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Rule not found.");
    const body = await parseJsonBody(c);
    const updated = ms.messageRules.update(existing.id, {
      display_name: typeof body.displayName === "string" ? body.displayName : existing.display_name,
      sequence: typeof body.sequence === "number" ? body.sequence : existing.sequence,
      is_enabled: typeof body.isEnabled === "boolean" ? body.isEnabled : existing.is_enabled,
      conditions:
        body.conditions && typeof body.conditions === "object" && !Array.isArray(body.conditions)
          ? {
              senderContains: Array.isArray((body.conditions as Record<string, unknown>).senderContains)
                ? ((body.conditions as Record<string, unknown>).senderContains as unknown[]).filter(
                    (value): value is string => typeof value === "string",
                  )
                : existing.conditions.senderContains,
            }
          : existing.conditions,
      actions:
        body.actions && typeof body.actions === "object" && !Array.isArray(body.actions)
          ? {
              moveToFolder:
                typeof (body.actions as Record<string, unknown>).moveToFolder === "string"
                  ? ((body.actions as Record<string, unknown>).moveToFolder as string)
                  : existing.actions.moveToFolder,
              markAsRead:
                typeof (body.actions as Record<string, unknown>).markAsRead === "boolean"
                  ? ((body.actions as Record<string, unknown>).markAsRead as boolean)
                  : existing.actions.markAsRead,
              assignCategories: Array.isArray((body.actions as Record<string, unknown>).assignCategories)
                ? ((body.actions as Record<string, unknown>).assignCategories as unknown[]).filter(
                    (value): value is string => typeof value === "string",
                  )
                : existing.actions.assignCategories,
            }
          : existing.actions,
    })!;
    return c.json(formatRuleResource(updated));
  });

  app.delete("/v1.0/me/mailFolders/inbox/messageRules/:ruleId", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const existing = ms.messageRules
      .findBy("user_email", authEmail)
      .find((rule) => rule.microsoft_id === c.req.param("ruleId"));
    if (!existing) return c.body(null, 204);
    ms.messageRules.delete(existing.id);
    return c.body(null, 204);
  });

  app.post("/v1.0/subscriptions", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const body = await parseJsonBody(c);
    const subscription = ms.subscriptions.insert({
      microsoft_id: generateMicrosoftId("sub"),
      user_email: authEmail,
      change_type: typeof body.changeType === "string" ? body.changeType : "created,updated",
      notification_url: typeof body.notificationUrl === "string" ? body.notificationUrl : "",
      resource: typeof body.resource === "string" ? body.resource : "/me/messages",
      expiration_date_time:
        typeof body.expirationDateTime === "string"
          ? body.expirationDateTime
          : new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      client_state: typeof body.clientState === "string" ? body.clientState : null,
    });
    return c.json(formatSubscriptionResource(subscription), 201);
  });

  app.delete("/v1.0/subscriptions/:subscriptionId", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const subscription = ms.subscriptions
      .findBy("user_email", authEmail)
      .find((entry) => entry.microsoft_id === c.req.param("subscriptionId"));
    if (!subscription) return c.body(null, 204);
    ms.subscriptions.delete(subscription.id);
    return c.body(null, 204);
  });

  app.post("/v1.0/$batch", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const body = await parseJsonBody(c);
    const requests = Array.isArray(body.requests) ? body.requests : [];
    const ms = getMicrosoftStore(ctx.store);
    const responses = requests.map((request) => {
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        return { id: "unknown", status: 400, body: { error: { message: "Invalid batch request." } } };
      }
      const entry = request as Record<string, unknown>;
      const id = typeof entry.id === "string" ? entry.id : generateMicrosoftId("batch");
      const method = typeof entry.method === "string" ? entry.method.toUpperCase() : "";
      const url = typeof entry.url === "string" ? entry.url : "";
      if (method === "POST" && url.match(/^\/me\/messages\/[^/]+\/move$/)) {
        const messageId = url.split("/")[3] ?? "";
        const message = resolveMessage(ctx, authEmail, messageId);
        const destinationId =
          entry.body &&
          typeof entry.body === "object" &&
          !Array.isArray(entry.body) &&
          typeof (entry.body as Record<string, unknown>).destinationId === "string"
            ? ((entry.body as Record<string, unknown>).destinationId as string)
            : "";
        if (!message || !destinationId) {
          return { id, status: 404, body: { error: { message: "Message or destination not found." } } };
        }
        try {
          const moved = moveMessage(ms, message, destinationId);
          return { id, status: 200, body: formatMessageResource(ms, moved) };
        } catch {
          return { id, status: 404, body: { error: { message: "Destination folder not found." } } };
        }
      }
      return { id, status: 400, body: { error: { message: `Unsupported batch request: ${method} ${url}` } } };
    });

    return c.json({ responses });
  });

  app.get("/v1.0/me/calendars", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    return c.json({
      value: ms.calendars.findBy("user_email", authEmail).map(formatCalendarResource),
    });
  });

  app.get("/v1.0/me/calendars/:calendarId", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const calendar = resolveCalendar(ctx, authEmail, c.req.param("calendarId"));
    if (!calendar) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Calendar not found.");
    return c.json(formatCalendarResource(calendar));
  });

  app.get("/v1.0/me/events", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    return listCalendarEvents(ctx, c, authEmail, resolveCalendar(ctx, authEmail, "primary")?.microsoft_id ?? null);
  });

  app.get("/v1.0/me/calendar/events", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    return listCalendarEvents(ctx, c, authEmail, resolveCalendar(ctx, authEmail, "primary")?.microsoft_id ?? null);
  });

  app.post("/v1.0/me/calendar/events", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const calendar = resolveCalendar(ctx, authEmail, "primary");
    if (!calendar) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Calendar not found.");
    return createCalendarEventFromBody(ctx, c, authEmail, calendar.microsoft_id);
  });

  app.get("/v1.0/me/calendars/:calendarId/events", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const calendar = resolveCalendar(ctx, authEmail, c.req.param("calendarId"));
    if (!calendar) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Calendar not found.");
    return listCalendarEvents(ctx, c, authEmail, calendar.microsoft_id);
  });

  app.post("/v1.0/me/calendars/:calendarId/events", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const calendar = resolveCalendar(ctx, authEmail, c.req.param("calendarId"));
    if (!calendar) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Calendar not found.");
    return createCalendarEventFromBody(ctx, c, authEmail, calendar.microsoft_id);
  });

  app.get("/v1.0/me/events/:eventId", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const event = resolveCalendarEvent(ctx, authEmail, c.req.param("eventId"));
    if (!event) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Event not found.");
    return c.json(formatCalendarEventResource(event));
  });

  app.get("/v1.0/me/calendars/:calendarId/events/:eventId", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const calendar = resolveCalendar(ctx, authEmail, c.req.param("calendarId"));
    if (!calendar) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Calendar not found.");
    const event = resolveCalendarEvent(ctx, authEmail, c.req.param("eventId"));
    if (!event || event.calendar_microsoft_id !== calendar.microsoft_id) {
      return microsoftGraphError(c, 404, "ErrorItemNotFound", "Event not found.");
    }
    return c.json(formatCalendarEventResource(event));
  });

  app.patch("/v1.0/me/events/:eventId", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    return patchCalendarEventFromBody(ctx, c, authEmail, c.req.param("eventId"));
  });

  app.patch("/v1.0/me/calendars/:calendarId/events/:eventId", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const calendar = resolveCalendar(ctx, authEmail, c.req.param("calendarId"));
    if (!calendar) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Calendar not found.");
    const event = resolveCalendarEvent(ctx, authEmail, c.req.param("eventId"));
    if (!event || event.calendar_microsoft_id !== calendar.microsoft_id) {
      return microsoftGraphError(c, 404, "ErrorItemNotFound", "Event not found.");
    }
    return patchCalendarEventFromBody(ctx, c, authEmail, event.microsoft_id);
  });

  app.delete("/v1.0/me/events/:eventId", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const event = resolveCalendarEvent(ctx, authEmail, c.req.param("eventId"));
    if (!event) return c.body(null, 204);
    ms.calendarEvents.delete(event.id);
    return c.body(null, 204);
  });

  app.delete("/v1.0/me/calendars/:calendarId/events/:eventId", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const calendar = resolveCalendar(ctx, authEmail, c.req.param("calendarId"));
    if (!calendar) return c.body(null, 204);
    const event = resolveCalendarEvent(ctx, authEmail, c.req.param("eventId"));
    if (!event || event.calendar_microsoft_id !== calendar.microsoft_id) return c.body(null, 204);
    ms.calendarEvents.delete(event.id);
    return c.body(null, 204);
  });

  app.get("/v1.0/me/calendar/calendarView", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const { top, skip } = getTopAndSkip(c);
    const start = c.req.query("startDateTime");
    const end = c.req.query("endDateTime");
    const defaultCalendar = ms.calendars
      .findBy("user_email", authEmail)
      .find((calendar) => calendar.is_default_calendar);
    const events = ms.calendarEvents
      .findBy("user_email", authEmail)
      .filter((event) => !defaultCalendar || event.calendar_microsoft_id === defaultCalendar.microsoft_id)
      .filter((event) => matchesCalendarWindow(event.start_date_time, event.end_date_time, start, end))
      .sort((a, b) => Date.parse(a.start_date_time) - Date.parse(b.start_date_time));
    const { items, nextSkip } = paginateResults(events, top, skip);
    return c.json({
      value: items.map(formatCalendarEventResource),
      ...(nextSkip != null ? { "@odata.nextLink": buildNextLink(c.req.url, nextSkip) } : {}),
    });
  });

  app.get("/v1.0/me/calendars/:calendarId/calendarView", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const calendar = ms.calendars
      .findBy("user_email", authEmail)
      .find((entry) => entry.microsoft_id === c.req.param("calendarId"));
    if (!calendar) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Calendar not found.");
    const { top, skip } = getTopAndSkip(c);
    const start = c.req.query("startDateTime");
    const end = c.req.query("endDateTime");
    const events = ms.calendarEvents
      .findBy("user_email", authEmail)
      .filter((event) => event.calendar_microsoft_id === calendar.microsoft_id)
      .filter((event) => matchesCalendarWindow(event.start_date_time, event.end_date_time, start, end))
      .sort((a, b) => Date.parse(a.start_date_time) - Date.parse(b.start_date_time));
    const { items, nextSkip } = paginateResults(events, top, skip);
    return c.json({
      value: items.map(formatCalendarEventResource),
      ...(nextSkip != null ? { "@odata.nextLink": buildNextLink(c.req.url, nextSkip) } : {}),
    });
  });

  app.get("/v1.0/me/drive", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    return c.json({
      id: `drive_${authEmail}`,
      driveType: "personal",
      owner: {
        user: {
          email: authEmail,
          displayName: getMicrosoftUserByEmail(getMicrosoftStore(ctx.store), authEmail)?.name ?? authEmail,
        },
      },
    });
  });

  app.get("/v1.0/me/drive/root", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    return c.json({
      id: "root",
      name: "root",
      root: {},
    });
  });

  app.get("/v1.0/me/drive/root/children", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    return listDriveChildren(ctx, c, authEmail, null);
  });

  app.post("/v1.0/me/drive/root/children", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    return createDriveChild(ctx, c, authEmail, null);
  });

  app.get("/v1.0/me/drive/items/:itemId", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const item = ms.driveItems
      .findBy("user_email", authEmail)
      .find((entry) => entry.microsoft_id === c.req.param("itemId") && !entry.deleted);
    if (!item) return microsoftGraphError(c, 404, "itemNotFound", "Drive item not found.");
    const parent = item.parent_microsoft_id ? ms.driveItems.findOneBy("microsoft_id", item.parent_microsoft_id) : null;
    return c.json(formatDriveItemResource(item, parent));
  });

  app.patch("/v1.0/me/drive/items/:itemId", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const item = ms.driveItems
      .findBy("user_email", authEmail)
      .find((entry) => entry.microsoft_id === c.req.param("itemId") && !entry.deleted);
    if (!item) return microsoftGraphError(c, 404, "itemNotFound", "Drive item not found.");
    const body = await parseJsonBody(c);
    const parentReference =
      body.parentReference && typeof body.parentReference === "object" && !Array.isArray(body.parentReference)
        ? (body.parentReference as Record<string, unknown>)
        : undefined;
    const targetParentId =
      parentReference && "id" in parentReference
        ? typeof parentReference.id === "string"
          ? parentReference.id
          : null
        : item.parent_microsoft_id;
    const updated = ms.driveItems.update(item.id, {
      name: typeof body.name === "string" ? body.name : item.name,
      parent_microsoft_id: targetParentId ?? null,
      last_modified_date_time: new Date().toISOString(),
    })!;
    const parent = updated.parent_microsoft_id
      ? ms.driveItems.findOneBy("microsoft_id", updated.parent_microsoft_id)
      : null;
    return c.json(formatDriveItemResource(updated, parent));
  });

  app.get("/v1.0/me/drive/items/:itemId/children", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    return listDriveChildren(ctx, c, authEmail, c.req.param("itemId"));
  });

  app.post("/v1.0/me/drive/items/:itemId/children", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    return createDriveChild(ctx, c, authEmail, c.req.param("itemId"));
  });

  app.get("/v1.0/me/drive/items/:itemId/content", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const item = ms.driveItems
      .findBy("user_email", authEmail)
      .find((entry) => entry.microsoft_id === c.req.param("itemId") && !entry.deleted && !entry.is_folder);
    if (!item || !item.content_bytes) return c.body(null, 404);
    return c.body(Buffer.from(item.content_bytes, "base64"), 200, {
      "Content-Type": item.mime_type ?? "application/octet-stream",
      "Content-Length": String(item.size),
    });
  });

  app.delete("/v1.0/me/drive/items/:itemId", (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const ms = getMicrosoftStore(ctx.store);
    const item = ms.driveItems
      .findBy("user_email", authEmail)
      .find((entry) => entry.microsoft_id === c.req.param("itemId") && !entry.deleted);
    if (!item) return c.body(null, 204);
    ms.driveItems.update(item.id, {
      deleted: true,
      last_modified_date_time: new Date().toISOString(),
    });
    return c.body(null, 204);
  });

  app.put("/v1.0/me/drive/items/*", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const match = c.req.path.match(/^\/v1\.0\/me\/drive\/items\/([^/]+):\/(.+):\/content$/);
    if (!match) return microsoftGraphError(c, 404, "itemNotFound", "Drive upload route not found.");
    const [, parentId, encodedName] = match;
    const fileName = decodeURIComponent(encodedName);
    const contentType = c.req.header("Content-Type") ?? "application/octet-stream";
    const content = Buffer.from(await c.req.arrayBuffer()).toString("base64");
    const ms = getMicrosoftStore(ctx.store);
    const existing = ms.driveItems
      .findBy("user_email", authEmail)
      .find((item) => item.parent_microsoft_id === parentId && item.name === fileName && !item.deleted);
    const updated = existing
      ? ms.driveItems.update(existing.id, {
          content_bytes: content,
          mime_type: contentType,
          size: Buffer.from(content, "base64").byteLength,
          last_modified_date_time: new Date().toISOString(),
        })!
      : createDriveItemRecord(ms, {
          user_email: authEmail,
          name: fileName,
          parent_microsoft_id: parentId,
          is_folder: false,
          mime_type: contentType,
          content_bytes: content,
          web_url_base: ctx.baseUrl,
        });

    const parent = updated.parent_microsoft_id
      ? ms.driveItems.findOneBy("microsoft_id", updated.parent_microsoft_id)
      : null;
    return c.json(formatDriveItemResource(updated, parent));
  });

  app.post("/v1.0/me/drive/items/*", async (c) => {
    const authEmail = requireAuthEmail(ctx, c);
    if (authEmail instanceof Response) return authEmail;
    const match = c.req.path.match(/^\/v1\.0\/me\/drive\/items\/([^/]+):\/(.+):\/createUploadSession$/);
    if (!match) return microsoftGraphError(c, 404, "itemNotFound", "Drive upload session route not found.");
    const [, parentId, encodedName] = match;
    const body = await parseJsonBody(c);
    const itemBody =
      body.item && typeof body.item === "object" && !Array.isArray(body.item)
        ? (body.item as Record<string, unknown>)
        : {};
    const fileName = decodeURIComponent(encodedName);
    const contentType = "application/octet-stream";
    const sessionId = generateMicrosoftId("drive_upload");
    getDriveUploadSessions(ctx).set(sessionId, {
      sessionId,
      userEmail: authEmail,
      parentId,
      fileName,
      contentType,
      totalSize: typeof itemBody.fileSize === "number" ? itemBody.fileSize : 0,
      uploadedBytes: 0,
      contentChunks: [],
    });
    return c.json({
      uploadUrl: `${ctx.baseUrl}/upload/microsoft/v1.0/drive/sessions/${sessionId}`,
      expirationDateTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      nextExpectedRanges: ["0-"],
    });
  });

  app.get("/upload/microsoft/v1.0/drive/sessions/:sessionId", (c) => {
    const session = getDriveUploadSessions(ctx).get(c.req.param("sessionId"));
    if (!session) return c.body(null, 404);
    return c.json({
      nextExpectedRanges: [`${session.uploadedBytes}-`],
    });
  });

  app.put("/upload/microsoft/v1.0/drive/sessions/:sessionId", async (c) => {
    const session = getDriveUploadSessions(ctx).get(c.req.param("sessionId"));
    if (!session) return c.body(null, 404);
    const range = c.req.header("Content-Range") ?? "";
    const match = range.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/);
    if (!match) {
      return microsoftGraphError(c, 400, "InvalidRequest", "Content-Range header is required.");
    }
    const [, startText, endText, totalText] = match;
    const start = Number.parseInt(startText, 10);
    const end = Number.parseInt(endText, 10);
    const total = Number.parseInt(totalText, 10);
    if (start !== session.uploadedBytes) {
      return c.json({ nextExpectedRanges: [`${session.uploadedBytes}-`] }, 416);
    }
    const chunk = Buffer.from(await c.req.arrayBuffer());
    session.contentChunks.push(chunk);
    session.totalSize = total;
    session.uploadedBytes = end + 1;
    getDriveUploadSessions(ctx).set(session.sessionId, session);

    if (session.uploadedBytes >= total) {
      const ms = getMicrosoftStore(ctx.store);
      const created = createDriveItemRecord(ms, {
        user_email: session.userEmail,
        name: session.fileName,
        parent_microsoft_id: session.parentId,
        is_folder: false,
        mime_type: session.contentType,
        content_bytes: finalizeUploadedContent(session.contentChunks),
        web_url_base: ctx.baseUrl,
      });
      getDriveUploadSessions(ctx).delete(session.sessionId);
      const parent = created.parent_microsoft_id
        ? ms.driveItems.findOneBy("microsoft_id", created.parent_microsoft_id)
        : null;
      return c.json(formatDriveItemResource(created, parent), 201);
    }

    return c.json(
      {
        nextExpectedRanges: [`${session.uploadedBytes}-`],
      },
      202,
    );
  });
}

function extractRecipients(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((recipient) => (recipient && typeof recipient === "object" && !Array.isArray(recipient) ? recipient : null))
    .filter((recipient): recipient is Record<string, unknown> => Boolean(recipient))
    .map((recipient) => recipient.emailAddress)
    .filter(
      (emailAddress): emailAddress is Record<string, unknown> =>
        Boolean(emailAddress) && typeof emailAddress === "object",
    )
    .map((emailAddress) => ({
      address: typeof emailAddress.address === "string" ? emailAddress.address : "",
      name: typeof emailAddress.name === "string" ? emailAddress.name : undefined,
    }))
    .filter((recipient) => recipient.address);
}

function matchesCalendarWindow(
  startDateTime: string,
  endDateTime: string,
  windowStart: string | null | undefined,
  windowEnd: string | null | undefined,
) {
  const start = Date.parse(startDateTime);
  const end = Date.parse(endDateTime);
  const rangeStart = windowStart ? Date.parse(windowStart) : Number.NEGATIVE_INFINITY;
  const rangeEnd = windowEnd ? Date.parse(windowEnd) : Number.POSITIVE_INFINITY;
  return start < rangeEnd && end > rangeStart;
}

function listCalendarEvents(ctx: RouteContext, c: any, authEmail: string, calendarId: string | null) {
  const ms = getMicrosoftStore(ctx.store);
  const { top, skip } = getTopAndSkip(c);
  const events = ms.calendarEvents
    .findBy("user_email", authEmail)
    .filter((event) => !calendarId || event.calendar_microsoft_id === calendarId)
    .sort((a, b) => Date.parse(a.start_date_time) - Date.parse(b.start_date_time));
  const { items, nextSkip } = paginateResults(events, top, skip);
  return c.json({
    value: items.map(formatCalendarEventResource),
    ...(nextSkip != null ? { "@odata.nextLink": buildNextLink(c.req.url, nextSkip) } : {}),
  });
}

async function createCalendarEventFromBody(ctx: RouteContext, c: any, authEmail: string, calendarId: string) {
  const body = await parseJsonBody(c);
  const attendees = extractRecipients(body.attendees);
  const event = createCalendarEventRecord(getMicrosoftStore(ctx.store), {
    user_email: authEmail,
    calendar_microsoft_id: calendarId,
    subject: typeof body.subject === "string" ? body.subject : "",
    body_preview:
      typeof body.bodyPreview === "string" ? body.bodyPreview : typeof body.subject === "string" ? body.subject : "",
    start_date_time:
      body.start &&
      typeof body.start === "object" &&
      !Array.isArray(body.start) &&
      typeof (body.start as Record<string, unknown>).dateTime === "string"
        ? ((body.start as Record<string, unknown>).dateTime as string)
        : new Date().toISOString(),
    end_date_time:
      body.end &&
      typeof body.end === "object" &&
      !Array.isArray(body.end) &&
      typeof (body.end as Record<string, unknown>).dateTime === "string"
        ? ((body.end as Record<string, unknown>).dateTime as string)
        : new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    is_all_day: body.isAllDay === true,
    show_as:
      body.showAs === "free" ||
      body.showAs === "tentative" ||
      body.showAs === "busy" ||
      body.showAs === "oof" ||
      body.showAs === "workingElsewhere" ||
      body.showAs === "unknown"
        ? body.showAs
        : "busy",
    location_display_name:
      body.location &&
      typeof body.location === "object" &&
      !Array.isArray(body.location) &&
      typeof (body.location as Record<string, unknown>).displayName === "string"
        ? ((body.location as Record<string, unknown>).displayName as string)
        : null,
    web_link: typeof body.webLink === "string" ? body.webLink : null,
    online_meeting_join_url:
      body.onlineMeeting &&
      typeof body.onlineMeeting === "object" &&
      !Array.isArray(body.onlineMeeting) &&
      typeof (body.onlineMeeting as Record<string, unknown>).joinUrl === "string"
        ? ((body.onlineMeeting as Record<string, unknown>).joinUrl as string)
        : null,
    online_meeting_url: typeof body.onlineMeetingUrl === "string" ? body.onlineMeetingUrl : null,
    attendees,
  });
  return c.json(formatCalendarEventResource(event), 201);
}

async function patchCalendarEventFromBody(ctx: RouteContext, c: any, authEmail: string, eventId: string) {
  const ms = getMicrosoftStore(ctx.store);
  const event = resolveCalendarEvent(ctx, authEmail, eventId);
  if (!event) return microsoftGraphError(c, 404, "ErrorItemNotFound", "Event not found.");
  const body = await parseJsonBody(c);
  const updated = ms.calendarEvents.update(event.id, {
    subject: typeof body.subject === "string" ? body.subject : event.subject,
    body_preview: typeof body.bodyPreview === "string" ? body.bodyPreview : event.body_preview,
    start_date_time:
      body.start &&
      typeof body.start === "object" &&
      !Array.isArray(body.start) &&
      typeof (body.start as Record<string, unknown>).dateTime === "string"
        ? ((body.start as Record<string, unknown>).dateTime as string)
        : event.start_date_time,
    end_date_time:
      body.end &&
      typeof body.end === "object" &&
      !Array.isArray(body.end) &&
      typeof (body.end as Record<string, unknown>).dateTime === "string"
        ? ((body.end as Record<string, unknown>).dateTime as string)
        : event.end_date_time,
    is_all_day: typeof body.isAllDay === "boolean" ? body.isAllDay : event.is_all_day,
    show_as:
      body.showAs === "free" ||
      body.showAs === "tentative" ||
      body.showAs === "busy" ||
      body.showAs === "oof" ||
      body.showAs === "workingElsewhere" ||
      body.showAs === "unknown"
        ? body.showAs
        : event.show_as,
    location_display_name:
      body.location &&
      typeof body.location === "object" &&
      !Array.isArray(body.location) &&
      typeof (body.location as Record<string, unknown>).displayName === "string"
        ? ((body.location as Record<string, unknown>).displayName as string)
        : event.location_display_name,
    web_link: typeof body.webLink === "string" ? body.webLink : event.web_link,
    online_meeting_join_url:
      body.onlineMeeting &&
      typeof body.onlineMeeting === "object" &&
      !Array.isArray(body.onlineMeeting) &&
      typeof (body.onlineMeeting as Record<string, unknown>).joinUrl === "string"
        ? ((body.onlineMeeting as Record<string, unknown>).joinUrl as string)
        : event.online_meeting_join_url,
    online_meeting_url: typeof body.onlineMeetingUrl === "string" ? body.onlineMeetingUrl : event.online_meeting_url,
    attendees: Array.isArray(body.attendees) ? extractRecipients(body.attendees) : event.attendees,
  })!;
  return c.json(formatCalendarEventResource(updated));
}

function listDriveChildren(ctx: RouteContext, c: any, authEmail: string, parentId: string | null) {
  const ms = getMicrosoftStore(ctx.store);
  const { top, skip } = getTopAndSkip(c);
  const filtered = filterDriveItems(
    ms.driveItems
      .findBy("user_email", authEmail)
      .filter((item) => item.parent_microsoft_id === parentId && !item.deleted),
    c.req.query("$filter"),
  );
  const { items, nextSkip } = paginateResults(filtered, top || 200, skip);
  return c.json({
    value: items.map((item) =>
      formatDriveItemResource(
        item,
        item.parent_microsoft_id ? (ms.driveItems.findOneBy("microsoft_id", item.parent_microsoft_id) ?? null) : null,
      ),
    ),
    ...(nextSkip != null ? { "@odata.nextLink": buildNextLink(c.req.url, nextSkip) } : {}),
  });
}

async function createDriveChild(ctx: RouteContext, c: any, authEmail: string, parentId: string | null) {
  const ms = getMicrosoftStore(ctx.store);
  const body = await parseJsonBody(c);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return microsoftGraphError(c, 400, "invalidRequest", "name is required.");
  }
  const existing = ms.driveItems
    .findBy("user_email", authEmail)
    .find((item) => item.parent_microsoft_id === parentId && item.name === name && !item.deleted);

  if (existing) {
    if (body["@microsoft.graph.conflictBehavior"] === "rename") {
      const renamed = `${name} (${generateMicrosoftId("copy").slice(-4)})`;
      const created = createDriveItemRecord(ms, {
        user_email: authEmail,
        name: renamed,
        parent_microsoft_id: parentId,
        is_folder: Boolean(body.folder),
        web_url_base: ctx.baseUrl,
      });
      const parent = parentId ? (ms.driveItems.findOneBy("microsoft_id", parentId) ?? null) : null;
      return c.json(formatDriveItemResource(created, parent), 201);
    }
    return microsoftGraphError(c, 409, "nameAlreadyExists", "Drive item already exists.");
  }

  const created = createDriveItemRecord(ms, {
    user_email: authEmail,
    name,
    parent_microsoft_id: parentId,
    is_folder: Boolean(body.folder),
    web_url_base: ctx.baseUrl,
  });
  const parent = parentId ? (ms.driveItems.findOneBy("microsoft_id", parentId) ?? null) : null;
  return c.json(formatDriveItemResource(created, parent), 201);
}
