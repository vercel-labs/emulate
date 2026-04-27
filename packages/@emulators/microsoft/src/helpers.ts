import { randomBytes, randomUUID } from "crypto";
import type { Context } from "hono";
import type {
  MicrosoftCalendar,
  MicrosoftCalendarEvent,
  MicrosoftDriveItem,
  MicrosoftMailFolder,
  MicrosoftMasterCategory,
  MicrosoftMessage,
  MicrosoftMessageAttachment,
  MicrosoftMessageRule,
  MicrosoftSubscription,
  MicrosoftUser,
} from "./entities.js";
import type { MicrosoftStore } from "./store.js";

/** Default tenant ID used when none is configured */
export const DEFAULT_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

export const WELL_KNOWN_FOLDERS = {
  inbox: "Inbox",
  sentitems: "Sent Items",
  drafts: "Drafts",
  archive: "Archive",
  deleteditems: "Deleted Items",
  junkemail: "Junk Email",
} as const;

export const OUTLOOK_COLORS = [
  "preset0",
  "preset1",
  "preset2",
  "preset3",
  "preset4",
  "preset5",
  "preset6",
  "preset7",
  "preset8",
  "preset9",
] as const;

type GraphRecipient = { emailAddress: { address: string; name?: string } };

type RecipientInput = { address: string; name?: string | null };

export interface MicrosoftMessageInput {
  microsoft_id?: string;
  conversation_id?: string;
  conversation_index?: string;
  internet_message_id?: string;
  user_email: string;
  subject?: string;
  body_content?: string;
  body_content_type?: "text" | "html";
  from?: RecipientInput | null;
  sender?: RecipientInput | null;
  to_recipients?: RecipientInput[];
  cc_recipients?: RecipientInput[];
  bcc_recipients?: RecipientInput[];
  reply_to?: RecipientInput[];
  received_date_time?: string;
  sent_date_time?: string | null;
  is_draft?: boolean;
  is_read?: boolean;
  importance?: "low" | "normal" | "high";
  categories?: string[];
  parent_folder_id: string;
  in_reply_to_microsoft_id?: string | null;
  web_link_base: string;
}

export interface MicrosoftDriveItemInput {
  microsoft_id?: string;
  user_email: string;
  name: string;
  parent_microsoft_id?: string | null;
  is_folder: boolean;
  mime_type?: string | null;
  size?: number;
  content_bytes?: string | null;
  web_url_base: string;
}

export interface UploadSessionRecord {
  sessionId: string;
  userEmail: string;
  messageId: string;
  attachmentName: string;
  contentType: string;
  totalSize: number;
  uploadedBytes: number;
  contentChunks: Buffer[];
}

/**
 * Generate a Microsoft-style object ID (UUID v4 format).
 */
export function generateOid(): string {
  return randomUUID();
}

export function generateMicrosoftId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString("base64url")}`;
}

export function generateConversationId(): string {
  return randomBytes(16).toString("hex");
}

export function generateConversationIndex(): string {
  return randomBytes(12).toString("base64");
}

export function generateInternetMessageId(domain = "emulate.microsoft.local"): string {
  return `<${randomBytes(12).toString("hex")}@${domain}>`;
}

export function getAuthenticatedEmail(c: Context): string | null {
  const authUser = c.get("authUser");
  return authUser?.login ?? null;
}

export function microsoftGraphError(c: Context, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status as 400 | 401 | 403 | 404 | 409 | 416);
}

export function requireMicrosoftAuth(c: Context): string | Response {
  const email = getAuthenticatedEmail(c);
  if (!email) {
    return microsoftGraphError(c, 401, "InvalidAuthenticationToken", "Authentication required.");
  }
  return email;
}

export function getMicrosoftUserByEmail(ms: MicrosoftStore, email: string): MicrosoftUser | undefined {
  return ms.users.findOneBy("email", email);
}

export function ensureDefaultFolders(
  ms: MicrosoftStore,
  userEmail: string,
): Record<keyof typeof WELL_KNOWN_FOLDERS, MicrosoftMailFolder> {
  const result = {} as Record<keyof typeof WELL_KNOWN_FOLDERS, MicrosoftMailFolder>;

  for (const [wellKnownName, displayName] of Object.entries(WELL_KNOWN_FOLDERS) as Array<
    [keyof typeof WELL_KNOWN_FOLDERS, string]
  >) {
    const existing = ms.mailFolders
      .findBy("user_email", userEmail)
      .find((folder) => folder.well_known_name === wellKnownName);

    result[wellKnownName] =
      existing ??
      ms.mailFolders.insert({
        microsoft_id: wellKnownName,
        user_email: userEmail,
        display_name: displayName,
        parent_folder_id: null,
        child_folder_count: 0,
        well_known_name: wellKnownName,
        is_hidden: false,
      });
  }

  return result;
}

export function getFolderByIdOrWellKnownName(
  ms: MicrosoftStore,
  userEmail: string,
  value: string,
): MicrosoftMailFolder | undefined {
  return ms.mailFolders
    .findBy("user_email", userEmail)
    .find((folder) => folder.microsoft_id === value || folder.well_known_name === value);
}

export function listChildFolders(
  ms: MicrosoftStore,
  userEmail: string,
  parentFolderId: string | null,
): MicrosoftMailFolder[] {
  return ms.mailFolders
    .findBy("user_email", userEmail)
    .filter((folder) => folder.parent_folder_id === parentFolderId)
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
}

export function createMailFolderRecord(
  ms: MicrosoftStore,
  input: {
    user_email: string;
    display_name: string;
    parent_folder_id?: string | null;
    well_known_name?: string | null;
    microsoft_id?: string;
  },
): MicrosoftMailFolder {
  const existing = ms.mailFolders
    .findBy("user_email", input.user_email)
    .find(
      (folder) =>
        (input.microsoft_id && folder.microsoft_id === input.microsoft_id) ||
        (!!input.well_known_name && folder.well_known_name === input.well_known_name),
    );
  if (existing) return existing;

  const folder = ms.mailFolders.insert({
    microsoft_id: input.microsoft_id ?? generateMicrosoftId("fld"),
    user_email: input.user_email,
    display_name: input.display_name,
    parent_folder_id: input.parent_folder_id ?? null,
    child_folder_count: 0,
    well_known_name: input.well_known_name ?? null,
    is_hidden: false,
  });

  if (folder.parent_folder_id) {
    const parent = ms.mailFolders.findOneBy("microsoft_id", folder.parent_folder_id);
    if (parent) {
      ms.mailFolders.update(parent.id, {
        child_folder_count: listChildFolders(ms, input.user_email, parent.microsoft_id).length,
      });
    }
  }

  return folder;
}

export function createCategoryRecord(
  ms: MicrosoftStore,
  input: { user_email: string; display_name: string; color?: string; microsoft_id?: string },
): MicrosoftMasterCategory {
  const existing = ms.categories
    .findBy("user_email", input.user_email)
    .find((category) => category.display_name.toLowerCase() === input.display_name.toLowerCase());
  if (existing) return existing;

  return ms.categories.insert({
    microsoft_id: input.microsoft_id ?? generateMicrosoftId("cat"),
    user_email: input.user_email,
    display_name: input.display_name,
    color: input.color ?? OUTLOOK_COLORS[0],
  });
}

export function createCalendarRecord(
  ms: MicrosoftStore,
  input: {
    user_email: string;
    name: string;
    color?: string | null;
    is_default_calendar?: boolean;
    can_edit?: boolean;
    owner_name?: string | null;
    owner_address?: string | null;
    microsoft_id?: string;
  },
): MicrosoftCalendar {
  const existing = ms.calendars.findBy("user_email", input.user_email).find((calendar) => {
    if (input.microsoft_id) return calendar.microsoft_id === input.microsoft_id;
    if (input.is_default_calendar) return calendar.microsoft_id === "primary";
    return calendar.name.toLowerCase() === input.name.toLowerCase();
  });
  if (existing) return existing;

  return ms.calendars.insert({
    microsoft_id: input.microsoft_id ?? (input.is_default_calendar ? "primary" : generateMicrosoftId("cal")),
    user_email: input.user_email,
    name: input.name,
    color: input.color ?? "auto",
    is_default_calendar: input.is_default_calendar ?? false,
    can_edit: input.can_edit ?? true,
    owner_name: input.owner_name ?? null,
    owner_address: input.owner_address ?? input.user_email,
  });
}

export function createCalendarEventRecord(
  ms: MicrosoftStore,
  input: {
    user_email: string;
    calendar_microsoft_id: string;
    subject: string;
    start_date_time: string;
    end_date_time: string;
    body_preview?: string;
    is_all_day?: boolean;
    show_as?: MicrosoftCalendarEvent["show_as"];
    location_display_name?: string | null;
    web_link?: string | null;
    online_meeting_join_url?: string | null;
    online_meeting_url?: string | null;
    attendees?: RecipientInput[];
    microsoft_id?: string;
  },
): MicrosoftCalendarEvent {
  const existing = input.microsoft_id ? ms.calendarEvents.findOneBy("microsoft_id", input.microsoft_id) : undefined;
  if (existing) return existing;

  return ms.calendarEvents.insert({
    microsoft_id: input.microsoft_id ?? generateMicrosoftId("evt"),
    calendar_microsoft_id: input.calendar_microsoft_id,
    user_email: input.user_email,
    subject: input.subject,
    body_preview: input.body_preview ?? input.subject,
    start_date_time: input.start_date_time,
    end_date_time: input.end_date_time,
    is_all_day: input.is_all_day ?? false,
    show_as: input.show_as ?? "busy",
    location_display_name: input.location_display_name ?? null,
    web_link: input.web_link ?? null,
    online_meeting_join_url: input.online_meeting_join_url ?? null,
    online_meeting_url: input.online_meeting_url ?? null,
    attendees: normalizeRecipients(input.attendees),
  });
}

export function createDriveItemRecord(ms: MicrosoftStore, input: MicrosoftDriveItemInput): MicrosoftDriveItem {
  const existing = input.microsoft_id ? ms.driveItems.findOneBy("microsoft_id", input.microsoft_id) : undefined;
  if (existing) return existing;

  const microsoftId = input.microsoft_id ?? generateMicrosoftId(input.is_folder ? "drvfld" : "drv");
  return ms.driveItems.insert({
    microsoft_id: microsoftId,
    user_email: input.user_email,
    name: input.name,
    parent_microsoft_id: input.parent_microsoft_id ?? null,
    is_folder: input.is_folder,
    mime_type: input.is_folder ? null : (input.mime_type ?? "application/octet-stream"),
    size: input.is_folder ? 0 : (input.size ?? byteLengthFromBase64(input.content_bytes ?? "")),
    web_url: buildDriveItemWebUrl(input.web_url_base, microsoftId),
    created_date_time: new Date().toISOString(),
    last_modified_date_time: new Date().toISOString(),
    content_bytes: input.is_folder ? null : (input.content_bytes ?? null),
    deleted: false,
  });
}

export function createMessageRecord(ms: MicrosoftStore, input: MicrosoftMessageInput): MicrosoftMessage {
  const existing = input.microsoft_id ? ms.messages.findOneBy("microsoft_id", input.microsoft_id) : undefined;
  if (existing) return existing;

  const now = new Date().toISOString();
  const subject = input.subject ?? "";
  const bodyContent = input.body_content ?? "";
  const messageId = input.microsoft_id ?? generateMicrosoftId("msg");
  const conversationId = input.conversation_id ?? generateConversationId();

  const message = ms.messages.insert({
    microsoft_id: messageId,
    conversation_id: conversationId,
    conversation_index: input.conversation_index ?? generateConversationIndex(),
    internet_message_id: input.internet_message_id ?? generateInternetMessageId(),
    user_email: input.user_email,
    subject,
    body_preview: buildBodyPreview(bodyContent),
    body_content_type: input.body_content_type ?? "html",
    body_content: bodyContent,
    from_name: input.from?.name ?? null,
    from_address: input.from?.address ?? null,
    sender_name: (input.sender ?? input.from)?.name ?? null,
    sender_address: (input.sender ?? input.from)?.address ?? null,
    to_recipients: normalizeRecipients(input.to_recipients),
    cc_recipients: normalizeRecipients(input.cc_recipients),
    bcc_recipients: normalizeRecipients(input.bcc_recipients),
    reply_to: normalizeRecipients(input.reply_to),
    received_date_time: input.received_date_time ?? now,
    sent_date_time: input.sent_date_time ?? (input.is_draft ? null : (input.received_date_time ?? now)),
    created_date_time: now,
    last_modified_date_time: now,
    is_draft: input.is_draft ?? false,
    is_read: input.is_read ?? false,
    importance: input.importance ?? "normal",
    categories: input.categories ?? [],
    parent_folder_id: input.parent_folder_id,
    has_attachments: false,
    web_link: buildMessageWebLink(input.web_link_base, messageId),
    in_reply_to_microsoft_id: input.in_reply_to_microsoft_id ?? null,
  });

  return message;
}

export function upsertMessageAttachment(
  ms: MicrosoftStore,
  input: {
    user_email: string;
    message_microsoft_id: string;
    name: string;
    content_type: string;
    content_bytes: string;
    size?: number;
    is_inline?: boolean;
    content_id?: string | null;
    microsoft_id?: string;
  },
): MicrosoftMessageAttachment {
  const existing = input.microsoft_id ? ms.attachments.findOneBy("microsoft_id", input.microsoft_id) : undefined;
  const attachment = existing
    ? ms.attachments.update(existing.id, {
        name: input.name,
        content_type: input.content_type,
        content_bytes: input.content_bytes,
        size: input.size ?? byteLengthFromBase64(input.content_bytes),
        is_inline: input.is_inline ?? false,
        content_id: input.content_id ?? null,
      })!
    : ms.attachments.insert({
        microsoft_id: input.microsoft_id ?? generateMicrosoftId("att"),
        message_microsoft_id: input.message_microsoft_id,
        user_email: input.user_email,
        name: input.name,
        content_type: input.content_type,
        size: input.size ?? byteLengthFromBase64(input.content_bytes),
        content_bytes: input.content_bytes,
        is_inline: input.is_inline ?? false,
        content_id: input.content_id ?? null,
      });

  const message = ms.messages.findOneBy("microsoft_id", input.message_microsoft_id);
  if (message && !message.has_attachments) {
    ms.messages.update(message.id, { has_attachments: true });
  }

  return attachment;
}

export function buildMessageWebLink(baseUrl: string, messageId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/mail/deeplink/compose/${messageId}`;
}

export function buildDriveItemWebUrl(baseUrl: string, driveItemId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/drive/items/${driveItemId}`;
}

export function buildBodyPreview(content: string): string {
  return content
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

export function normalizeRecipients(
  recipients: Array<RecipientInput | null | undefined> | null | undefined,
): Array<{ name?: string | null; address: string }> {
  return (recipients ?? [])
    .filter((recipient): recipient is RecipientInput => Boolean(recipient?.address))
    .map((recipient) => ({
      address: recipient.address.trim(),
      name: recipient.name ?? undefined,
    }));
}

export function toGraphRecipients(recipients: Array<{ name?: string | null; address: string }>): GraphRecipient[] {
  return recipients.map((recipient) => ({
    emailAddress: {
      address: recipient.address,
      ...(recipient.name ? { name: recipient.name } : {}),
    },
  }));
}

export function formatFolderResource(
  ms: MicrosoftStore,
  folder: MicrosoftMailFolder,
  userEmail: string,
): Record<string, unknown> {
  const children = listChildFolders(ms, userEmail, folder.microsoft_id);
  return {
    id: folder.microsoft_id,
    displayName: folder.display_name,
    childFolderCount: children.length,
    wellKnownName: folder.well_known_name ?? undefined,
    isHidden: folder.is_hidden,
    childFolders: children.map((child) => formatFolderResource(ms, child, userEmail)),
  };
}

export function formatCategoryResource(category: MicrosoftMasterCategory): Record<string, unknown> {
  return {
    id: category.microsoft_id,
    displayName: category.display_name,
    color: category.color,
  };
}

export function formatRuleResource(rule: MicrosoftMessageRule): Record<string, unknown> {
  return {
    id: rule.microsoft_id,
    displayName: rule.display_name,
    sequence: rule.sequence,
    isEnabled: rule.is_enabled,
    conditions: rule.conditions,
    actions: rule.actions,
  };
}

export function formatSubscriptionResource(subscription: MicrosoftSubscription): Record<string, unknown> {
  return {
    id: subscription.microsoft_id,
    changeType: subscription.change_type,
    notificationUrl: subscription.notification_url,
    resource: subscription.resource,
    expirationDateTime: subscription.expiration_date_time,
    clientState: subscription.client_state ?? undefined,
  };
}

export function formatCalendarResource(calendar: MicrosoftCalendar): Record<string, unknown> {
  return {
    id: calendar.microsoft_id,
    name: calendar.name,
    color: calendar.color ?? undefined,
    isDefaultCalendar: calendar.is_default_calendar,
    canEdit: calendar.can_edit,
    owner: {
      name: calendar.owner_name ?? undefined,
      address: calendar.owner_address ?? undefined,
    },
  };
}

export function formatCalendarEventResource(event: MicrosoftCalendarEvent): Record<string, unknown> {
  return {
    id: event.microsoft_id,
    subject: event.subject,
    bodyPreview: event.body_preview,
    start: { dateTime: event.start_date_time },
    end: { dateTime: event.end_date_time },
    showAs: event.show_as,
    isAllDay: event.is_all_day,
    location: { displayName: event.location_display_name ?? undefined },
    webLink: event.web_link ?? undefined,
    onlineMeeting: event.online_meeting_join_url ? { joinUrl: event.online_meeting_join_url } : undefined,
    onlineMeetingUrl: event.online_meeting_url ?? undefined,
    attendees: event.attendees.map((attendee) => ({
      emailAddress: {
        address: attendee.address,
        ...(attendee.name ? { name: attendee.name } : {}),
      },
    })),
  };
}

export function formatDriveItemResource(
  item: MicrosoftDriveItem,
  parent?: MicrosoftDriveItem | null,
): Record<string, unknown> {
  const parentPath = parent ? `/drive/root:/${buildDrivePath(parent)}` : "/drive/root:";

  return {
    id: item.microsoft_id,
    name: item.name,
    webUrl: item.web_url,
    size: item.size,
    createdDateTime: item.created_date_time,
    lastModifiedDateTime: item.last_modified_date_time,
    parentReference: item.parent_microsoft_id ? { id: item.parent_microsoft_id, path: parentPath } : undefined,
    folder: item.is_folder ? {} : undefined,
    file: !item.is_folder ? { mimeType: item.mime_type ?? "application/octet-stream" } : undefined,
    deleted: item.deleted ? {} : undefined,
  };
}

export function formatAttachmentResource(attachment: MicrosoftMessageAttachment): Record<string, unknown> {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    id: attachment.microsoft_id,
    name: attachment.name,
    contentType: attachment.content_type,
    size: attachment.size,
    contentBytes: attachment.content_bytes,
    isInline: attachment.is_inline,
    contentId: attachment.content_id ?? undefined,
  };
}

export function formatMessageResource(ms: MicrosoftStore, message: MicrosoftMessage): Record<string, unknown> {
  const attachments = ms.attachments
    .findBy("message_microsoft_id", message.microsoft_id)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    id: message.microsoft_id,
    conversationId: message.conversation_id,
    conversationIndex: message.conversation_index,
    internetMessageId: message.internet_message_id,
    subject: message.subject,
    bodyPreview: message.body_preview,
    from: formatSender(message.from_name, message.from_address),
    sender: formatSender(message.sender_name, message.sender_address),
    toRecipients: toGraphRecipients(message.to_recipients),
    ccRecipients: toGraphRecipients(message.cc_recipients),
    bccRecipients: toGraphRecipients(message.bcc_recipients),
    replyTo: toGraphRecipients(message.reply_to),
    receivedDateTime: message.received_date_time,
    sentDateTime: message.sent_date_time ?? undefined,
    createdDateTime: message.created_date_time,
    lastModifiedDateTime: message.last_modified_date_time,
    isDraft: message.is_draft,
    isRead: message.is_read,
    importance: message.importance,
    categories: message.categories,
    parentFolderId: message.parent_folder_id,
    hasAttachments: message.has_attachments,
    body: {
      contentType: message.body_content_type === "html" ? "html" : "text",
      content: message.body_content,
    },
    attachments: attachments.map(formatAttachmentResource),
    webLink: message.web_link,
  };
}

function formatSender(name: string | null, address: string | null): Record<string, unknown> | null {
  if (!address) return null;
  return {
    emailAddress: {
      address,
      ...(name ? { name } : {}),
    },
  };
}

export function buildDrivePath(item: MicrosoftDriveItem, items?: MicrosoftDriveItem[]): string {
  const allItems = items ?? [];
  const byId = new Map(allItems.map((entry) => [entry.microsoft_id, entry]));
  const segments = [item.name];
  let current = item.parent_microsoft_id ? byId.get(item.parent_microsoft_id) : undefined;
  while (current) {
    segments.unshift(current.name);
    current = current.parent_microsoft_id ? byId.get(current.parent_microsoft_id) : undefined;
  }
  return segments.join("/");
}

export function updateMessage(
  ms: MicrosoftStore,
  message: MicrosoftMessage,
  patch: Partial<MicrosoftMessage>,
): MicrosoftMessage {
  return ms.messages.update(message.id, {
    ...patch,
    body_preview: patch.body_content
      ? buildBodyPreview(patch.body_content)
      : (patch.body_preview ?? message.body_preview),
    last_modified_date_time: new Date().toISOString(),
  })!;
}

export function moveMessage(
  ms: MicrosoftStore,
  message: MicrosoftMessage,
  destinationFolderId: string,
): MicrosoftMessage {
  const destination = ms.mailFolders.findOneBy("microsoft_id", destinationFolderId);
  if (!destination) {
    throw new Error(`Destination folder not found: ${destinationFolderId}`);
  }

  return updateMessage(ms, message, {
    parent_folder_id: destination.microsoft_id,
    is_draft: destination.well_known_name === "drafts",
    is_read: destination.well_known_name === "sentitems" ? true : message.is_read,
  });
}

export function createReplyDraft(
  ms: MicrosoftStore,
  baseUrl: string,
  userEmail: string,
  original: MicrosoftMessage,
  options: { replyAll?: boolean } = {},
): MicrosoftMessage {
  const folders = ensureDefaultFolders(ms, userEmail);
  const userRecipient = { address: userEmail };

  const toRecipients = options.replyAll
    ? dedupeRecipients([
        ...(original.from_address ? [{ address: original.from_address, name: original.from_name ?? undefined }] : []),
        ...original.to_recipients.filter((recipient) => recipient.address !== userEmail),
        ...original.cc_recipients.filter((recipient) => recipient.address !== userEmail),
      ])
    : original.from_address
      ? [{ address: original.from_address, name: original.from_name ?? undefined }]
      : [];

  const subject = original.subject.toLowerCase().startsWith("re:") ? original.subject : `Re: ${original.subject}`;

  return createMessageRecord(ms, {
    user_email: userEmail,
    conversation_id: original.conversation_id,
    subject,
    body_content: "",
    body_content_type: "html",
    from: userRecipient,
    sender: userRecipient,
    to_recipients: toRecipients,
    cc_recipients: options.replyAll
      ? original.cc_recipients.filter((recipient) => recipient.address !== userEmail)
      : [],
    reply_to: [],
    received_date_time: new Date().toISOString(),
    sent_date_time: null,
    is_draft: true,
    is_read: true,
    parent_folder_id: folders.drafts.microsoft_id,
    in_reply_to_microsoft_id: original.microsoft_id,
    web_link_base: baseUrl,
  });
}

export function seedDefaultMailbox(ms: MicrosoftStore, baseUrl: string, userEmail: string): void {
  const folders = ensureDefaultFolders(ms, userEmail);
  const scoped = userEmail.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  createCategoryRecord(ms, {
    user_email: userEmail,
    display_name: "Follow Up",
    color: OUTLOOK_COLORS[4],
  });
  createCalendarRecord(ms, {
    user_email: userEmail,
    name: "Calendar",
    color: "auto",
    is_default_calendar: true,
    owner_address: userEmail,
  });
  const teamCalendar = createCalendarRecord(ms, {
    user_email: userEmail,
    name: "Team Calendar",
    color: "lightBlue",
    owner_name: "Test User",
    owner_address: userEmail,
  });
  createCalendarEventRecord(ms, {
    user_email: userEmail,
    calendar_microsoft_id: "primary",
    subject: "Inbox Zero planning",
    body_preview: "Review inbox automation and calendar coverage.",
    start_date_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    end_date_time: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
    location_display_name: "Teams",
    web_link: `${baseUrl}/calendar/events/evt_primary`,
    online_meeting_join_url: `${baseUrl}/meet/inbox-zero-planning`,
    attendees: [
      { address: userEmail, name: "Test User" },
      { address: "teammate@example.com", name: "Teammate" },
    ],
  });
  createCalendarEventRecord(ms, {
    user_email: userEmail,
    calendar_microsoft_id: teamCalendar.microsoft_id,
    subject: "Focus block",
    body_preview: "Reserved for triage.",
    start_date_time: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    end_date_time: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    show_as: "busy",
    web_link: `${baseUrl}/calendar/events/evt_team`,
  });

  const invoicesFolder = createDriveItemRecord(ms, {
    user_email: userEmail,
    name: "Invoices",
    parent_microsoft_id: null,
    is_folder: true,
    web_url_base: baseUrl,
  });
  createDriveItemRecord(ms, {
    user_email: userEmail,
    name: "March-Invoice.pdf",
    parent_microsoft_id: invoicesFolder.microsoft_id,
    is_folder: false,
    mime_type: "application/pdf",
    content_bytes: Buffer.from("invoice-pdf-data", "utf8").toString("base64"),
    web_url_base: baseUrl,
  });

  const welcome = createMessageRecord(ms, {
    microsoft_id: `${scoped}_msg_welcome`,
    conversation_id: `${scoped}_conv_welcome`,
    user_email: userEmail,
    subject: "Welcome to the Outlook emulator",
    body_content:
      "<p>Your Microsoft OAuth flow is ready, with Outlook mail, calendar, and OneDrive surfaces available locally.</p>",
    body_content_type: "html",
    from: { address: "welcome@example.com", name: "Welcome Team" },
    sender: { address: "welcome@example.com", name: "Welcome Team" },
    to_recipients: [{ address: userEmail }],
    received_date_time: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    is_draft: false,
    is_read: false,
    categories: [],
    parent_folder_id: folders.inbox.microsoft_id,
    web_link_base: baseUrl,
  });

  const planning = createMessageRecord(ms, {
    microsoft_id: `${scoped}_msg_planning`,
    conversation_id: `${scoped}_conv_planning`,
    user_email: userEmail,
    subject: "Can you share your availability tomorrow?",
    body_content: "<p>Could you send over some times that work tomorrow afternoon?</p><p>I can do 1pm or 4pm UTC.</p>",
    body_content_type: "html",
    from: { address: "alex@example.com", name: "Alex" },
    sender: { address: "alex@example.com", name: "Alex" },
    to_recipients: [{ address: userEmail }],
    received_date_time: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    is_draft: false,
    is_read: false,
    categories: ["Follow Up"],
    parent_folder_id: folders.inbox.microsoft_id,
    web_link_base: baseUrl,
  });

  upsertMessageAttachment(ms, {
    user_email: userEmail,
    message_microsoft_id: planning.microsoft_id,
    name: "agenda.txt",
    content_type: "text/plain",
    content_bytes: Buffer.from("Draft agenda", "utf8").toString("base64"),
  });

  createMessageRecord(ms, {
    microsoft_id: `${scoped}_msg_sent`,
    conversation_id: `${scoped}_conv_sent`,
    user_email: userEmail,
    subject: "Re: Nightly build status",
    body_content: "<p>Looks good. I’ll review it after lunch.</p>",
    body_content_type: "html",
    from: { address: userEmail, name: "Test User" },
    sender: { address: userEmail, name: "Test User" },
    to_recipients: [{ address: "builds@example.com", name: "Build Bot" }],
    received_date_time: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    is_draft: false,
    is_read: true,
    categories: [],
    parent_folder_id: folders.sentitems.microsoft_id,
    web_link_base: baseUrl,
  });

  createMessageRecord(ms, {
    microsoft_id: `${scoped}_msg_draft`,
    conversation_id: `${scoped}_conv_draft`,
    user_email: userEmail,
    subject: "Draft follow-up",
    body_content: "<p>Sharing a quick follow-up on the action items.</p>",
    body_content_type: "html",
    from: { address: userEmail, name: "Test User" },
    sender: { address: userEmail, name: "Test User" },
    to_recipients: [{ address: "someone@example.com", name: "Someone" }],
    received_date_time: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    is_draft: true,
    is_read: true,
    categories: [],
    parent_folder_id: folders.drafts.microsoft_id,
    web_link_base: baseUrl,
  });

  upsertMessageAttachment(ms, {
    user_email: userEmail,
    message_microsoft_id: welcome.microsoft_id,
    name: "welcome.pdf",
    content_type: "application/pdf",
    content_bytes: Buffer.from("welcome-pdf", "utf8").toString("base64"),
  });
}

export function dedupeRecipients(recipients: RecipientInput[]): RecipientInput[] {
  const seen = new Set<string>();
  return recipients.filter((recipient) => {
    const key = recipient.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function byteLengthFromBase64(contentBytes: string): number {
  if (!contentBytes) return 0;
  return Buffer.from(contentBytes, "base64").byteLength;
}

function parseQuotedValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
}

function splitTopLevel(expression: string, separator: " and " | " or "): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let last = 0;

  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if ((char === "'" || char === '"') && expression[index - 1] !== "\\") {
      quote = quote === char ? null : quote ? quote : (char as "'" | '"');
      continue;
    }
    if (quote) continue;
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth === 0 && expression.slice(index, index + separator.length) === separator) {
      parts.push(expression.slice(last, index).trim());
      last = index + separator.length;
      index += separator.length - 1;
    }
  }

  parts.push(expression.slice(last).trim());
  return parts.filter(Boolean);
}

function stripWrappingParens(value: string): string {
  let output = value.trim();
  while (output.startsWith("(") && output.endsWith(")")) {
    output = output.slice(1, -1).trim();
  }
  return output;
}

function messageField(message: MicrosoftMessage, field: string): string | boolean | null {
  switch (field) {
    case "conversationId":
      return message.conversation_id;
    case "parentFolderId":
      return message.parent_folder_id;
    case "receivedDateTime":
      return message.received_date_time;
    case "subject":
      return message.subject;
    case "hasAttachments":
      return message.has_attachments;
    case "isRead":
      return message.is_read;
    case "from/emailAddress/address":
      return message.from_address;
    default:
      return null;
  }
}

export function filterMessages(
  messages: MicrosoftMessage[],
  filterExpression: string | null | undefined,
): MicrosoftMessage[] {
  if (!filterExpression) return messages;

  return messages.filter((message) => evaluateMessageFilter(message, stripWrappingParens(filterExpression)));
}

function evaluateMessageFilter(message: MicrosoftMessage, expression: string): boolean {
  const orParts = splitTopLevel(expression, " or ");
  if (orParts.length > 1) {
    return orParts.some((part) => evaluateMessageFilter(message, stripWrappingParens(part)));
  }

  const andParts = splitTopLevel(expression, " and ");
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateMessageFilter(message, stripWrappingParens(part)));
  }

  const containsMatch = expression.match(/^contains\(([^,]+),\s*('(?:[^']|'')*')\)$/);
  if (containsMatch) {
    const field = containsMatch[1]?.trim() ?? "";
    const value = parseQuotedValue(containsMatch[2] ?? "").toLowerCase();
    return String(messageField(message, field) ?? "")
      .toLowerCase()
      .includes(value);
  }

  const categoriesAnyMatch = expression.match(/^categories\/any\(\w+:\w+\s+eq\s+('(?:[^']|'')*')\)$/);
  if (categoriesAnyMatch) {
    const value = parseQuotedValue(categoriesAnyMatch[1] ?? "").toLowerCase();
    return message.categories.some((category) => category.toLowerCase() === value);
  }

  const compareMatch = expression.match(/^([A-Za-z0-9/]+)\s+(eq|ne|gt|ge|lt|le)\s+(.+)$/);
  if (!compareMatch) return true;

  const [, field, operator, rawValue] = compareMatch;
  const actual = messageField(message, field ?? "");
  const expected = rawValue === "true" ? true : rawValue === "false" ? false : parseQuotedValue(rawValue);

  if (typeof actual === "boolean" || typeof expected === "boolean") {
    if (operator === "eq") return actual === expected;
    if (operator === "ne") return actual !== expected;
    return false;
  }

  const actualText = String(actual ?? "");
  const expectedText = String(expected ?? "");

  if (field === "receivedDateTime") {
    const actualTime = Date.parse(actualText);
    const expectedTime = Date.parse(expectedText);
    if (Number.isNaN(actualTime) || Number.isNaN(expectedTime)) return true;
    if (operator === "gt") return actualTime > expectedTime;
    if (operator === "ge") return actualTime >= expectedTime;
    if (operator === "lt") return actualTime < expectedTime;
    if (operator === "le") return actualTime <= expectedTime;
  }

  if (operator === "eq") return actualText === expectedText;
  if (operator === "ne") return actualText !== expectedText;
  return true;
}

export function searchMessages(
  messages: MicrosoftMessage[],
  searchExpression: string | null | undefined,
): MicrosoftMessage[] {
  if (!searchExpression) return messages;

  const raw = parseQuotedValue(searchExpression);
  const [field, ...rest] = raw.split(":");
  if (rest.length > 0 && field.toLowerCase() === "participants") {
    const value = rest.join(":").toLowerCase();
    return messages.filter((message) => {
      const recipients = [
        ...(message.from_address ? [message.from_address] : []),
        ...message.to_recipients.map((recipient) => recipient.address),
        ...message.cc_recipients.map((recipient) => recipient.address),
      ];
      return recipients.some((recipient) => recipient.toLowerCase().includes(value));
    });
  }

  const text = raw.toLowerCase();
  return messages.filter((message) =>
    [
      message.subject,
      message.body_preview,
      message.body_content,
      message.from_address ?? "",
      ...message.to_recipients.map((recipient) => recipient.address),
      ...message.cc_recipients.map((recipient) => recipient.address),
      message.internet_message_id,
    ]
      .join(" ")
      .toLowerCase()
      .includes(text),
  );
}

export function sortMessages(
  messages: MicrosoftMessage[],
  orderByExpression: string | null | undefined,
): MicrosoftMessage[] {
  if (!orderByExpression) return messages;
  const [field, direction] = orderByExpression.trim().split(/\s+/);
  const desc = (direction ?? "asc").toLowerCase() === "desc";
  return [...messages].sort((a, b) => {
    const left = field === "receivedDateTime" ? Date.parse(a.received_date_time) : 0;
    const right = field === "receivedDateTime" ? Date.parse(b.received_date_time) : 0;
    return desc ? right - left : left - right;
  });
}

export function filterDriveItems(
  items: MicrosoftDriveItem[],
  filterExpression: string | null | undefined,
): MicrosoftDriveItem[] {
  if (!filterExpression) return items;
  if (filterExpression.trim() === "folder ne null") {
    return items.filter((item) => item.is_folder && !item.deleted);
  }
  return items;
}

export function paginateResults<T>(
  items: T[],
  top: number | null | undefined,
  skip: number,
): { items: T[]; nextSkip: number | null } {
  const limit = top && top > 0 ? top : items.length;
  const page = items.slice(skip, skip + limit);
  const nextSkip = skip + limit < items.length ? skip + limit : null;
  return { items: page, nextSkip };
}

export function parsePositiveInt(value: string | null | undefined, fallback = 0): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
}
