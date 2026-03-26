import { randomBytes } from "crypto";
import type { Context } from "hono";
import type {
  GoogleAttachment,
  GoogleDraft,
  GoogleFilter,
  GoogleForwardingAddress,
  GoogleHistoryEvent,
  GoogleLabel,
  GoogleMessage,
  GoogleSendAs,
} from "./entities.js";
import type { GoogleStore } from "./store.js";

export type GmailMessageFormat = "full" | "metadata" | "minimal" | "raw";

export interface GoogleMessageInput {
  gmail_id?: string;
  thread_id?: string;
  user_email: string;
  raw?: string | null;
  from?: string;
  to?: string;
  cc?: string | null;
  bcc?: string | null;
  reply_to?: string | null;
  subject?: string;
  snippet?: string;
  body_text?: string | null;
  body_html?: string | null;
  label_ids?: string[];
  date?: string;
  internal_date?: string;
  message_id?: string;
  references?: string | null;
  in_reply_to?: string | null;
}

export interface GoogleLabelInput {
  gmail_id?: string;
  user_email: string;
  name: string;
  type?: "system" | "user";
  message_list_visibility?: string | null;
  label_list_visibility?: string | null;
  color_background?: string | null;
  color_text?: string | null;
}

export interface GoogleFilterInput {
  gmail_id?: string;
  user_email: string;
  criteria_from?: string | null;
  add_label_ids?: string[];
  remove_label_ids?: string[];
}

export const HISTORY_CHANGE_TYPES = new Set<GoogleHistoryEvent["change_type"]>([
  "messageAdded",
  "messageDeleted",
  "labelAdded",
  "labelRemoved",
]);

export function isHistoryChangeType(value: string): value is GoogleHistoryEvent["change_type"] {
  return HISTORY_CHANGE_TYPES.has(value as GoogleHistoryEvent["change_type"]);
}

export interface GmailHistoryListOptions {
  startHistoryId: string;
  historyTypes?: Array<GoogleHistoryEvent["change_type"]>;
  labelId?: string;
  maxResults?: number;
  pageToken?: string | null;
}

export interface RawAttachmentInput {
  filename: string;
  mime_type: string;
  content: Buffer | string;
  disposition?: "attachment" | "inline" | null;
  content_id?: string | null;
}

type ParsedRawMessage = {
  raw: string;
  from: string;
  to: string;
  cc: string | null;
  bcc: string | null;
  reply_to: string | null;
  subject: string;
  message_id: string | null;
  references: string | null;
  in_reply_to: string | null;
  date_header: string | null;
  body_text: string | null;
  body_html: string | null;
  attachments: ParsedAttachment[];
};

type ParsedAttachment = {
  filename: string;
  mime_type: string;
  disposition: string | null;
  content_id: string | null;
  transfer_encoding: string | null;
  data: string;
  size: number;
};

type ParsedMimeNode = {
  mimeType: string;
  filename: string;
  headers: Map<string, string>;
  body: Buffer | null;
  parts: ParsedMimeNode[];
  disposition: string | null;
  contentId: string | null;
  transferEncoding: string | null;
  charset: string | null;
};

type HeaderWithParams = {
  value: string;
  params: Record<string, string>;
};

type MessageHeader = {
  name: string;
  value: string;
};

const SYSTEM_LABELS: Array<{
  gmail_id: string;
  name: string;
  message_list_visibility: string | null;
  label_list_visibility: string | null;
}> = [
  { gmail_id: "INBOX", name: "INBOX", message_list_visibility: "show", label_list_visibility: "labelShow" },
  { gmail_id: "SENT", name: "SENT", message_list_visibility: "show", label_list_visibility: "labelShow" },
  { gmail_id: "UNREAD", name: "UNREAD", message_list_visibility: "show", label_list_visibility: "labelShow" },
  { gmail_id: "STARRED", name: "STARRED", message_list_visibility: "show", label_list_visibility: "labelShow" },
  { gmail_id: "IMPORTANT", name: "IMPORTANT", message_list_visibility: "show", label_list_visibility: "labelShow" },
  { gmail_id: "TRASH", name: "TRASH", message_list_visibility: "show", label_list_visibility: "labelShow" },
  { gmail_id: "SPAM", name: "SPAM", message_list_visibility: "show", label_list_visibility: "labelShow" },
  { gmail_id: "DRAFT", name: "DRAFT", message_list_visibility: "hide", label_list_visibility: "labelHide" },
  {
    gmail_id: "CATEGORY_PERSONAL",
    name: "CATEGORY_PERSONAL",
    message_list_visibility: "hide",
    label_list_visibility: "labelHide",
  },
  {
    gmail_id: "CATEGORY_SOCIAL",
    name: "CATEGORY_SOCIAL",
    message_list_visibility: "hide",
    label_list_visibility: "labelHide",
  },
  {
    gmail_id: "CATEGORY_PROMOTIONS",
    name: "CATEGORY_PROMOTIONS",
    message_list_visibility: "hide",
    label_list_visibility: "labelHide",
  },
  {
    gmail_id: "CATEGORY_UPDATES",
    name: "CATEGORY_UPDATES",
    message_list_visibility: "hide",
    label_list_visibility: "labelHide",
  },
  {
    gmail_id: "CATEGORY_FORUMS",
    name: "CATEGORY_FORUMS",
    message_list_visibility: "hide",
    label_list_visibility: "labelHide",
  },
];

const SYSTEM_LABEL_IDS = new Set(SYSTEM_LABELS.map((label) => label.gmail_id));

const LABEL_ALIASES: Record<string, string> = {
  inbox: "INBOX",
  sent: "SENT",
  draft: "DRAFT",
  drafts: "DRAFT",
  unread: "UNREAD",
  starred: "STARRED",
  important: "IMPORTANT",
  spam: "SPAM",
  trash: "TRASH",
  personal: "CATEGORY_PERSONAL",
  social: "CATEGORY_SOCIAL",
  promotions: "CATEGORY_PROMOTIONS",
  updates: "CATEGORY_UPDATES",
  forums: "CATEGORY_FORUMS",
};

export function generateUid(prefix = ""): string {
  const id = randomBytes(12).toString("base64url").slice(0, 20);
  return prefix ? `${prefix}_${id}` : id;
}

export function generateDraftId(): string {
  const entropy = randomBytes(4).readUInt32BE(0).toString();
  return `r-${Date.now()}${entropy}`;
}

export function generateHistoryId(): string {
  const entropy = randomBytes(3).readUIntBE(0, 3).toString().padStart(8, "0");
  return `${Date.now()}${entropy}`;
}

export function getAuthenticatedEmail(c: Context): string | null {
  const authUser = c.get("authUser");
  return authUser?.login ?? null;
}

export function matchesRequestedUser(userId: string, authEmail: string): boolean {
  return userId === "me" || userId === authEmail;
}

export function googleApiError(
  c: Context,
  code: number,
  message: string,
  reason: string,
  status: string,
) {
  return c.json(
    {
      error: {
        code,
        message,
        errors: [
          {
            message,
            domain: "global",
            reason,
          },
        ],
        status,
      },
    },
    code as 400 | 401 | 404,
  );
}

export function parseFormat(value: string | null): GmailMessageFormat {
  if (value === "metadata" || value === "minimal" || value === "raw") return value;
  return "full";
}

export function parseOffset(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

export function normalizeLimit(value: string | null | undefined, fallback: number, max = 500): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

export function parseBooleanParam(value: string | null | undefined): boolean {
  return value === "true" || value === "1";
}

export function ensureSystemLabels(gs: GoogleStore, userEmail: string): void {
  const existingIds = new Set(
    gs.labels.findBy("user_email", userEmail).map((row) => row.gmail_id),
  );

  for (const label of SYSTEM_LABELS) {
    if (existingIds.has(label.gmail_id)) continue;

    gs.labels.insert({
      gmail_id: label.gmail_id,
      user_email: userEmail,
      name: label.name,
      type: "system",
      message_list_visibility: label.message_list_visibility,
      label_list_visibility: label.label_list_visibility,
      color_background: null,
      color_text: null,
    });
  }
}

export function ensureCustomLabel(
  gs: GoogleStore,
  userEmail: string,
  labelId: string,
  name = labelId,
): GoogleLabel {
  ensureSystemLabels(gs, userEmail);

  const existing = findLabelById(gs, userEmail, labelId);
  if (existing) return existing;

  return gs.labels.insert({
    gmail_id: labelId,
    user_email: userEmail,
    name,
    type: "user",
    message_list_visibility: "show",
    label_list_visibility: "labelShow",
    color_background: null,
    color_text: null,
  });
}

export function createLabelRecord(gs: GoogleStore, input: GoogleLabelInput): GoogleLabel {
  ensureSystemLabels(gs, input.user_email);

  const labelId = input.gmail_id ?? `Label_${randomBytes(8).toString("hex")}`;

  return gs.labels.insert({
    gmail_id: labelId,
    user_email: input.user_email,
    name: input.name,
    type: input.type ?? "user",
    message_list_visibility: input.message_list_visibility ?? "show",
    label_list_visibility: input.label_list_visibility ?? "labelShow",
    color_background: input.color_background ?? null,
    color_text: input.color_text ?? null,
  });
}

export function updateLabelRecord(
  gs: GoogleStore,
  label: GoogleLabel,
  input: Partial<GoogleLabelInput>,
): GoogleLabel {
  return (
    gs.labels.update(label.id, {
      name: input.name !== undefined ? input.name : label.name,
      message_list_visibility:
        input.message_list_visibility !== undefined
          ? input.message_list_visibility
          : label.message_list_visibility,
      label_list_visibility:
        input.label_list_visibility !== undefined
          ? input.label_list_visibility
          : label.label_list_visibility,
      color_background:
        input.color_background !== undefined ? input.color_background : label.color_background,
      color_text: input.color_text !== undefined ? input.color_text : label.color_text,
    }) ?? label
  );
}

export function isSystemLabelId(labelId: string): boolean {
  return SYSTEM_LABEL_IDS.has(labelId);
}

export function findLabelById(gs: GoogleStore, userEmail: string, labelId: string): GoogleLabel | undefined {
  return gs.labels.findBy("user_email", userEmail).find((label) => label.gmail_id === labelId);
}

export function findLabelByName(gs: GoogleStore, userEmail: string, name: string): GoogleLabel | undefined {
  const normalized = name.trim().toLowerCase();
  return gs.labels.findBy("user_email", userEmail).find((label) => label.name.trim().toLowerCase() === normalized);
}

export function listLabelsForUser(gs: GoogleStore, userEmail: string): GoogleLabel[] {
  ensureSystemLabels(gs, userEmail);
  return gs.labels
    .findBy("user_email", userEmail)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "system" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

interface LabelStats {
  messagesTotal: number;
  messagesUnread: number;
  threadsTotal: Set<string>;
  threadsUnread: Set<string>;
}

function computeLabelStats(gs: GoogleStore, userEmail: string): Map<string, LabelStats> {
  const stats = new Map<string, LabelStats>();
  const messages = gs.messages.findBy("user_email", userEmail);
  const isUnread = (message: GoogleMessage) => message.label_ids.includes("UNREAD");

  for (const message of messages) {
    for (const labelId of message.label_ids) {
      let entry = stats.get(labelId);
      if (!entry) {
        entry = { messagesTotal: 0, messagesUnread: 0, threadsTotal: new Set(), threadsUnread: new Set() };
        stats.set(labelId, entry);
      }
      entry.messagesTotal++;
      entry.threadsTotal.add(message.thread_id);
      if (isUnread(message)) {
        entry.messagesUnread++;
        entry.threadsUnread.add(message.thread_id);
      }
    }
  }

  return stats;
}

function formatLabelWithStats(label: GoogleLabel, stats?: LabelStats) {
  return {
    id: label.gmail_id,
    name: label.name,
    type: label.type === "system" ? "system" : "user",
    messageListVisibility: label.message_list_visibility ?? undefined,
    labelListVisibility: label.label_list_visibility ?? undefined,
    messagesTotal: stats?.messagesTotal ?? 0,
    messagesUnread: stats?.messagesUnread ?? 0,
    threadsTotal: stats?.threadsTotal.size ?? 0,
    threadsUnread: stats?.threadsUnread.size ?? 0,
    color:
      label.color_background || label.color_text
        ? {
            backgroundColor: label.color_background ?? undefined,
            textColor: label.color_text ?? undefined,
          }
        : undefined,
  };
}

export function formatLabelResource(gs: GoogleStore, label: GoogleLabel) {
  const stats = computeLabelStats(gs, label.user_email);
  return formatLabelWithStats(label, stats.get(label.gmail_id));
}

export function formatLabelResources(gs: GoogleStore, labels: GoogleLabel[]) {
  if (labels.length === 0) return [];
  const stats = computeLabelStats(gs, labels[0].user_email);
  return labels.map((label) => formatLabelWithStats(label, stats.get(label.gmail_id)));
}

export function normalizeLabelQuery(value: string): string {
  const cleaned = cleanToken(value);
  const alias = LABEL_ALIASES[cleaned.toLowerCase()];
  return alias ?? cleaned;
}

export function findMissingLabelIds(gs: GoogleStore, userEmail: string, labelIds: string[]): string[] {
  ensureSystemLabels(gs, userEmail);
  return labelIds.filter((labelId) => !findLabelById(gs, userEmail, labelId));
}

export function dedupeLabelIds(labelIds: string[]): string[] {
  return [...new Set(labelIds.filter(Boolean))];
}

export function createStoredMessage(
  gs: GoogleStore,
  input: GoogleMessageInput,
  options?: {
    defaultLabelIds?: string[];
    createMissingCustomLabels?: boolean;
  },
): GoogleMessage {
  ensureSystemLabels(gs, input.user_email);

  const parsedRaw = input.raw ? parseRawMessage(input.raw) : null;
  const merged = {
    raw: input.raw ?? null,
    from: input.from ?? parsedRaw?.from ?? "",
    to: input.to ?? parsedRaw?.to ?? "",
    cc: input.cc ?? parsedRaw?.cc ?? null,
    bcc: input.bcc ?? parsedRaw?.bcc ?? null,
    reply_to: input.reply_to ?? parsedRaw?.reply_to ?? null,
    subject: input.subject ?? parsedRaw?.subject ?? "",
    body_text: input.body_text ?? parsedRaw?.body_text ?? null,
    body_html: input.body_html ?? parsedRaw?.body_html ?? null,
    message_id: input.message_id ?? parsedRaw?.message_id ?? null,
    references: input.references ?? parsedRaw?.references ?? null,
    in_reply_to: input.in_reply_to ?? parsedRaw?.in_reply_to ?? null,
    date_header: input.date ?? parsedRaw?.date_header ?? null,
  };

  const internalDateMs = resolveInternalDate(input.internal_date ?? input.date ?? parsedRaw?.date_header ?? undefined);
  const gmailId = input.gmail_id ?? generateUid("msg");
  const threadId = resolveThreadId(gs, input.user_email, input.thread_id, merged.in_reply_to, merged.references);
  const messageId = merged.message_id ?? `<${gmailId}@emulate.google.local>`;
  const baseLabelIds = dedupeLabelIds(input.label_ids ?? options?.defaultLabelIds ?? []);

  if (options?.createMissingCustomLabels) {
    for (const labelId of baseLabelIds.filter((labelId) => !isSystemLabelId(labelId))) {
      ensureCustomLabel(gs, input.user_email, labelId);
    }
  }

  const labelIds = applyFiltersToLabelIds(gs, input.user_email, merged.from, baseLabelIds);

  const snippet = (input.snippet?.trim() || deriveSnippet(merged.body_text ?? merged.body_html ?? merged.subject)) || merged.subject;
  const raw = merged.raw ?? buildRawMessage({
    from: merged.from,
    to: merged.to,
    cc: merged.cc,
    bcc: merged.bcc,
    reply_to: merged.reply_to,
    subject: merged.subject,
    body_text: merged.body_text,
    body_html: merged.body_html,
    message_id: messageId,
    references: merged.references,
    in_reply_to: merged.in_reply_to,
    date_header: new Date(internalDateMs).toUTCString(),
  });

  const historyId = generateHistoryId();
  const message = gs.messages.insert({
    gmail_id: gmailId,
    thread_id: threadId,
    user_email: input.user_email,
    history_id: historyId,
    internal_date: String(internalDateMs),
    raw,
    label_ids: labelIds,
    snippet,
    subject: merged.subject,
    from: merged.from,
    to: merged.to,
    cc: merged.cc,
    bcc: merged.bcc,
    reply_to: merged.reply_to,
    message_id: messageId,
    references: merged.references,
    in_reply_to: merged.in_reply_to,
    date_header: new Date(internalDateMs).toUTCString(),
    body_text: merged.body_text,
    body_html: merged.body_html,
  });

  replaceMessageAttachments(gs, message, parsedRaw?.attachments ?? []);
  recordHistoryEvents(gs, message.user_email, historyId, [
    {
      change_type: "messageAdded",
      message_gmail_id: message.gmail_id,
      thread_id: message.thread_id,
      label_ids: message.label_ids,
    },
  ]);
  syncDraftState(gs, message);
  return message;
}

export function updateStoredMessage(
  gs: GoogleStore,
  message: GoogleMessage,
  input: Partial<GoogleMessageInput>,
): GoogleMessage {
  const parsedRaw = input.raw ? parseRawMessage(input.raw) : null;
  const internalDateMs = resolveInternalDate(
    input.internal_date ?? input.date ?? parsedRaw?.date_header ?? Date.now().toString(),
  );
  const merged = {
    raw: input.raw ?? message.raw,
    from: input.from ?? parsedRaw?.from ?? message.from,
    to: input.to ?? parsedRaw?.to ?? message.to,
    cc: input.cc ?? parsedRaw?.cc ?? message.cc,
    bcc: input.bcc ?? parsedRaw?.bcc ?? message.bcc,
    reply_to: input.reply_to ?? parsedRaw?.reply_to ?? message.reply_to,
    subject: input.subject ?? parsedRaw?.subject ?? message.subject,
    body_text: input.body_text ?? parsedRaw?.body_text ?? message.body_text,
    body_html: input.body_html ?? parsedRaw?.body_html ?? message.body_html,
    message_id: input.message_id ?? parsedRaw?.message_id ?? message.message_id,
    references: input.references ?? parsedRaw?.references ?? message.references,
    in_reply_to: input.in_reply_to ?? parsedRaw?.in_reply_to ?? message.in_reply_to,
    date_header: input.date ?? parsedRaw?.date_header ?? message.date_header,
  };

  const snippet =
    (input.snippet?.trim() || deriveSnippet(merged.body_text ?? merged.body_html ?? merged.subject)) ||
    merged.subject;
  const labelIds = dedupeLabelIds(input.label_ids ?? message.label_ids);
  const raw = merged.raw ?? buildRawMessage({
    from: merged.from,
    to: merged.to,
    cc: merged.cc,
    bcc: merged.bcc,
    reply_to: merged.reply_to,
    subject: merged.subject,
    body_text: merged.body_text,
    body_html: merged.body_html,
    message_id: merged.message_id,
    references: merged.references,
    in_reply_to: merged.in_reply_to,
    date_header: new Date(internalDateMs).toUTCString(),
  });

  const updated = gs.messages.update(message.id, {
    thread_id: input.thread_id ?? message.thread_id,
    history_id: generateHistoryId(),
    internal_date: String(internalDateMs),
    raw,
    label_ids: labelIds,
    snippet,
    subject: merged.subject,
    from: merged.from,
    to: merged.to,
    cc: merged.cc,
    bcc: merged.bcc,
    reply_to: merged.reply_to,
    message_id: merged.message_id,
    references: merged.references,
    in_reply_to: merged.in_reply_to,
    date_header: new Date(internalDateMs).toUTCString(),
    body_text: merged.body_text,
    body_html: merged.body_html,
  }) ?? message;

  replaceMessageAttachments(gs, updated, parsedRaw?.attachments ?? []);
  syncDraftState(gs, updated);
  return updated;
}

export function getMessageById(gs: GoogleStore, userEmail: string, messageId: string): GoogleMessage | undefined {
  return gs.messages
    .findBy("user_email", userEmail)
    .find((message) => message.gmail_id === messageId);
}

export function getDraftById(gs: GoogleStore, userEmail: string, draftId: string): GoogleDraft | undefined {
  return gs.drafts
    .findBy("user_email", userEmail)
    .find((draft) => draft.gmail_id === draftId);
}

export function getDraftMessage(gs: GoogleStore, draft: GoogleDraft): GoogleMessage | undefined {
  return getMessageById(gs, draft.user_email, draft.message_gmail_id);
}

export function getAttachmentById(
  gs: GoogleStore,
  userEmail: string,
  messageId: string,
  attachmentId: string,
): GoogleAttachment | undefined {
  return gs.attachments
    .findBy("message_gmail_id", messageId)
    .find((attachment) => attachment.user_email === userEmail && attachment.gmail_id === attachmentId);
}

export function listDraftsForUser(gs: GoogleStore, userEmail: string): GoogleDraft[] {
  const drafts = gs.drafts.findBy("user_email", userEmail);
  const messageMap = new Map<string, GoogleMessage | undefined>();
  for (const draft of drafts) {
    messageMap.set(draft.gmail_id, getDraftMessage(gs, draft));
  }

  return drafts
    .filter((draft) => {
      const message = messageMap.get(draft.gmail_id);
      return Boolean(message && message.label_ids.includes("DRAFT") && !message.label_ids.includes("SENT"));
    })
    .sort((a, b) => {
      const aMessage = messageMap.get(a.gmail_id);
      const bMessage = messageMap.get(b.gmail_id);
      return Number(bMessage?.internal_date ?? 0) - Number(aMessage?.internal_date ?? 0);
    });
}

export function formatDraftResource(
  gs: GoogleStore,
  draft: GoogleDraft,
  format: GmailMessageFormat,
  metadataHeaders: string[] = [],
) {
  const message = getDraftMessage(gs, draft);
  if (!message) return { id: draft.gmail_id };

  return {
    id: draft.gmail_id,
    message: formatMessageResource(gs, message, format, metadataHeaders),
  };
}

export function createDraftMessage(
  gs: GoogleStore,
  input: GoogleMessageInput,
): { draft: GoogleDraft; message: GoogleMessage } {
  const message = createStoredMessage(gs, {
    ...input,
    label_ids: dedupeLabelIds([...(input.label_ids ?? []).filter((labelId) => labelId !== "SENT"), "DRAFT"]),
  });
  const draft = syncDraftState(gs, message)!;
  return { draft, message };
}

export function updateDraftMessage(
  gs: GoogleStore,
  draft: GoogleDraft,
  input: Partial<GoogleMessageInput>,
): { draft: GoogleDraft; message: GoogleMessage } | null {
  const message = getDraftMessage(gs, draft);
  if (!message) return null;

  const updated = updateStoredMessage(gs, message, {
    ...input,
    label_ids: dedupeLabelIds([...(message.label_ids ?? []).filter((labelId) => labelId !== "SENT"), "DRAFT"]),
  });

  return { draft: syncDraftState(gs, updated, draft.gmail_id) ?? draft, message: updated };
}

export function sendDraftMessage(
  gs: GoogleStore,
  draft: GoogleDraft,
): GoogleMessage | null {
  const message = getDraftMessage(gs, draft);
  if (!message) {
    gs.drafts.delete(draft.id);
    return null;
  }

  const sent = markMessageModified(
    gs,
    message,
    message.label_ids.filter((labelId) => labelId !== "DRAFT").concat("SENT"),
  );
  clearDraftRecordsForMessage(gs, message.user_email, message.gmail_id);
  return sent;
}

export function deleteDraftMessage(gs: GoogleStore, draft: GoogleDraft): boolean {
  const message = getDraftMessage(gs, draft);
  if (!message) return gs.drafts.delete(draft.id);
  return deleteMessage(gs, message);
}

export function getCurrentHistoryId(gs: GoogleStore, userEmail: string): string {
  const historyIds = [
    ...gs.messages.findBy("user_email", userEmail).map((message) => message.history_id),
    ...gs.history.findBy("user_email", userEmail).map((event) => event.gmail_id),
  ].filter(Boolean);

  if (historyIds.length === 0) return "0";

  return historyIds.reduce((latest, current) =>
    compareHistoryIds(current, latest) > 0 ? current : latest,
  );
}

export function listHistoryForUser(
  gs: GoogleStore,
  userEmail: string,
  options: GmailHistoryListOptions,
): {
  history: Array<Record<string, unknown>>;
  historyId: string;
  nextPageToken?: string;
} {
  const requestedTypes = options.historyTypes?.length ? new Set(options.historyTypes) : null;
  const events = gs.history
    .findBy("user_email", userEmail)
    .filter((event) => compareHistoryIds(event.gmail_id, options.startHistoryId) > 0)
    .filter((event) => !requestedTypes || requestedTypes.has(event.change_type))
    .filter((event) => !options.labelId || event.label_ids.includes(options.labelId))
    .sort((a, b) => compareHistoryIds(a.gmail_id, b.gmail_id) || a.id - b.id);

  const grouped = new Map<string, GoogleHistoryEvent[]>();
  for (const event of events) {
    const existing = grouped.get(event.gmail_id);
    if (existing) existing.push(event);
    else grouped.set(event.gmail_id, [event]);
  }

  const historyEntries = Array.from(grouped.entries()).map(([historyId, entries]) =>
    formatHistoryEntry(gs, userEmail, historyId, entries),
  );

  const offset = parseOffset(options.pageToken);
  const limit = Math.max(1, Math.min(options.maxResults ?? 100, 500));
  const page = historyEntries.slice(offset, offset + limit);
  const nextPageToken = offset + limit < historyEntries.length ? String(offset + limit) : undefined;

  return {
    history: page,
    historyId: getCurrentHistoryId(gs, userEmail),
    nextPageToken,
  };
}

export function getFilterById(gs: GoogleStore, userEmail: string, filterId: string): GoogleFilter | undefined {
  return gs.filters.findBy("user_email", userEmail).find((filter) => filter.gmail_id === filterId);
}

export function listFiltersForUser(gs: GoogleStore, userEmail: string): GoogleFilter[] {
  return gs.filters
    .findBy("user_email", userEmail)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.gmail_id.localeCompare(b.gmail_id));
}

export function findMatchingFilter(
  gs: GoogleStore,
  input: GoogleFilterInput,
): GoogleFilter | undefined {
  const criteriaFrom = normalizeFilterFrom(input.criteria_from);
  const addLabelIds = sortStrings(dedupeLabelIds(input.add_label_ids ?? []));
  const removeLabelIds = sortStrings(dedupeLabelIds(input.remove_label_ids ?? []));

  return gs.filters
    .findBy("user_email", input.user_email)
    .find((filter) =>
      normalizeFilterFrom(filter.criteria_from) === criteriaFrom &&
      arrayEquals(sortStrings(filter.add_label_ids), addLabelIds) &&
      arrayEquals(sortStrings(filter.remove_label_ids), removeLabelIds),
    );
}

export function createFilterRecord(gs: GoogleStore, input: GoogleFilterInput): GoogleFilter {
  return gs.filters.insert({
    gmail_id: input.gmail_id ?? generateUid("filter"),
    user_email: input.user_email,
    criteria_from: normalizeFilterFrom(input.criteria_from),
    add_label_ids: dedupeLabelIds(input.add_label_ids ?? []),
    remove_label_ids: dedupeLabelIds(input.remove_label_ids ?? []),
  });
}

export function formatFilterResource(filter: GoogleFilter) {
  return {
    id: filter.gmail_id,
    criteria: filter.criteria_from ? { from: filter.criteria_from } : {},
    action: {
      ...(filter.add_label_ids.length > 0 ? { addLabelIds: filter.add_label_ids } : {}),
      ...(filter.remove_label_ids.length > 0 ? { removeLabelIds: filter.remove_label_ids } : {}),
    },
  };
}

export function listForwardingAddressesForUser(gs: GoogleStore, userEmail: string): GoogleForwardingAddress[] {
  return gs.forwardingAddresses
    .findBy("user_email", userEmail)
    .sort((a, b) => a.forwarding_email.localeCompare(b.forwarding_email));
}

export function formatForwardingAddressResource(entry: GoogleForwardingAddress) {
  return {
    forwardingEmail: entry.forwarding_email,
    verificationStatus: entry.verification_status,
  };
}

export function listSendAsForUser(gs: GoogleStore, userEmail: string): GoogleSendAs[] {
  ensureDefaultSendAs(gs, userEmail);

  return gs.sendAs
    .findBy("user_email", userEmail)
    .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.send_as_email.localeCompare(b.send_as_email));
}

export function formatSendAsResource(entry: GoogleSendAs) {
  return {
    sendAsEmail: entry.send_as_email,
    displayName: entry.display_name ?? undefined,
    replyToAddress: entry.send_as_email,
    signature: entry.signature,
    isPrimary: entry.is_default,
    isDefault: entry.is_default,
    treatAsAlias: false,
    verificationStatus: "accepted",
  };
}

export function listMessagesForUser(
  gs: GoogleStore,
  userEmail: string,
  options?: {
    labelIds?: string[];
    query?: string;
    includeSpamTrash?: boolean;
  },
): GoogleMessage[] {
  let messages = gs.messages.findBy("user_email", userEmail);

  if (!options?.includeSpamTrash) {
    messages = messages.filter(
      (message) => !message.label_ids.includes("TRASH") && !message.label_ids.includes("SPAM"),
    );
  }

  if (options?.labelIds?.length) {
    messages = messages.filter((message) => options.labelIds!.every((labelId) => message.label_ids.includes(labelId)));
  }

  if (options?.query) {
    const matcher = buildMessageQueryMatcher(gs, userEmail, options.query);
    messages = messages.filter(matcher);
  }

  return sortMessagesByDateDesc(messages);
}

export function groupThreads(messages: GoogleMessage[]): Array<{
  id: string;
  snippet: string;
  historyId: string;
  messages: GoogleMessage[];
}> {
  const threadMap = new Map<string, GoogleMessage[]>();

  for (const message of messages) {
    const existing = threadMap.get(message.thread_id);
    if (existing) existing.push(message);
    else threadMap.set(message.thread_id, [message]);
  }

  return Array.from(threadMap.entries())
    .map(([threadId, entries]) => {
      const ordered = sortMessagesByDateAsc(entries);
      const latest = ordered.at(-1)!;
      return {
        id: threadId,
        snippet: latest.snippet,
        historyId: latest.history_id,
        messages: ordered,
      };
    })
    .sort((a, b) => Number(b.messages.at(-1)?.internal_date ?? 0) - Number(a.messages.at(-1)?.internal_date ?? 0));
}

export function getThreadMessages(
  gs: GoogleStore,
  userEmail: string,
  threadId: string,
  options?: { includeSpamTrash?: boolean },
): GoogleMessage[] {
  let messages = gs.messages
    .findBy("user_email", userEmail)
    .filter((message) => message.thread_id === threadId);

  if (!options?.includeSpamTrash) {
    messages = messages.filter(
      (message) => !message.label_ids.includes("TRASH") && !message.label_ids.includes("SPAM"),
    );
  }

  return sortMessagesByDateAsc(messages);
}

export function formatMessageResource(
  gs: GoogleStore,
  message: GoogleMessage,
  format: GmailMessageFormat,
  metadataHeaders: string[] = [],
) {
  const headers = buildHeaders(message);
  const filteredHeaders =
    format === "metadata" && metadataHeaders.length > 0
      ? headers.filter((header) => metadataHeaders.includes(header.name))
      : headers;

  const base = {
    id: message.gmail_id,
    threadId: message.thread_id,
    labelIds: message.label_ids,
    snippet: message.snippet,
    historyId: message.history_id,
    internalDate: message.internal_date,
    sizeEstimate: estimateSize(message, headers),
  };

  if (format === "minimal") return base;
  if (format === "raw") return { ...base, raw: message.raw ?? undefined };

  return {
    ...base,
    payload: buildPayload(gs, message, filteredHeaders, format),
  };
}

export function formatThreadResource(
  gs: GoogleStore,
  messages: GoogleMessage[],
  format: GmailMessageFormat,
  metadataHeaders: string[] = [],
) {
  const ordered = sortMessagesByDateAsc(messages);
  const latest = ordered.at(-1)!;

  return {
    id: latest.thread_id,
    historyId: latest.history_id,
    snippet: latest.snippet,
    messages: ordered.map((message) => formatMessageResource(gs, message, format, metadataHeaders)),
  };
}

export function applyLabelMutation(
  labelIds: string[],
  addLabelIds: string[] = [],
  removeLabelIds: string[] = [],
): string[] {
  const next = new Set(labelIds);
  for (const labelId of addLabelIds) next.add(labelId);
  for (const labelId of removeLabelIds) next.delete(labelId);
  return [...next];
}

export function markMessageModified(
  gs: GoogleStore,
  message: GoogleMessage,
  nextLabelIds: string[],
): GoogleMessage {
  const dedupedLabelIds = dedupeLabelIds(nextLabelIds);
  if (arrayEquals(message.label_ids, dedupedLabelIds)) {
    syncDraftState(gs, message);
    return message;
  }

  const historyId = generateHistoryId();
  const addedLabelIds = dedupedLabelIds.filter((labelId) => !message.label_ids.includes(labelId));
  const removedLabelIds = message.label_ids.filter((labelId) => !dedupedLabelIds.includes(labelId));
  const updated = (
    gs.messages.update(message.id, {
      label_ids: dedupedLabelIds,
      history_id: historyId,
    }) ?? message
  );

  const historyEvents: Array<{
    change_type: GoogleHistoryEvent["change_type"];
    message_gmail_id: string;
    thread_id: string;
    label_ids: string[];
  }> = [];

  if (addedLabelIds.length > 0) {
    historyEvents.push({
      change_type: "labelAdded",
      message_gmail_id: updated.gmail_id,
      thread_id: updated.thread_id,
      label_ids: addedLabelIds,
    });
  }

  if (removedLabelIds.length > 0) {
    historyEvents.push({
      change_type: "labelRemoved",
      message_gmail_id: updated.gmail_id,
      thread_id: updated.thread_id,
      label_ids: removedLabelIds,
    });
  }

  if (historyEvents.length > 0) {
    recordHistoryEvents(gs, updated.user_email, historyId, historyEvents);
  }

  syncDraftState(gs, updated);
  return updated;
}

export function deleteMessage(gs: GoogleStore, message: GoogleMessage): boolean {
  const historyId = generateHistoryId();
  recordHistoryEvents(gs, message.user_email, historyId, [
    {
      change_type: "messageDeleted",
      message_gmail_id: message.gmail_id,
      thread_id: message.thread_id,
      label_ids: message.label_ids,
    },
  ]);
  clearDraftRecordsForMessage(gs, message.user_email, message.gmail_id);
  clearMessageAttachments(gs, message.user_email, message.gmail_id);
  return gs.messages.delete(message.id);
}

export function trashLabelIds(labelIds: string[]): string[] {
  const next = new Set(labelIds);
  next.add("TRASH");
  next.delete("INBOX");
  return [...next];
}

export function untrashLabelIds(labelIds: string[]): string[] {
  const next = new Set(labelIds);
  next.delete("TRASH");
  if (!next.has("SENT") && !next.has("DRAFT")) {
    next.add("INBOX");
  }
  return [...next];
}

export function buildMessageQueryMatcher(
  gs: GoogleStore,
  userEmail: string,
  query: string,
): (message: GoogleMessage) => boolean {
  const terms = query.match(/"[^"]+"|\S+/g) ?? [];
  const predicates = terms.flatMap((term) => buildQueryPredicates(gs, userEmail, term));

  if (!predicates.length) return () => true;
  return (message) => predicates.every((predicate) => predicate(message));
}

export function buildRawMessage(message: {
  from: string;
  to: string;
  cc?: string | null;
  bcc?: string | null;
  reply_to?: string | null;
  subject: string;
  body_text?: string | null;
  body_html?: string | null;
  message_id?: string | null;
  references?: string | null;
  in_reply_to?: string | null;
  date_header?: string | null;
  attachments?: RawAttachmentInput[];
}): string {
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    ...(message.cc ? [`Cc: ${message.cc}`] : []),
    ...(message.bcc ? [`Bcc: ${message.bcc}`] : []),
    ...(message.reply_to ? [`Reply-To: ${message.reply_to}`] : []),
    `Subject: ${message.subject}`,
    ...(message.message_id ? [`Message-ID: ${message.message_id}`] : []),
    ...(message.references ? [`References: ${message.references}`] : []),
    ...(message.in_reply_to ? [`In-Reply-To: ${message.in_reply_to}`] : []),
    `Date: ${message.date_header ?? new Date().toUTCString()}`,
    "MIME-Version: 1.0",
  ];

  const attachments = message.attachments ?? [];

  if (attachments.length > 0) {
    const mixedBoundary = `emulate-mixed-${randomBytes(8).toString("hex")}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);

    const parts: string[] = [];
    const bodyPart = buildMimeBodyPart({
      body_text: message.body_text,
      body_html: message.body_html,
    });
    if (bodyPart) {
      parts.push(`--${mixedBoundary}`, bodyPart);
    }

    for (const attachment of attachments) {
      const disposition = attachment.disposition ?? "attachment";
      const contentId = attachment.content_id ? ensureWrappedContentId(attachment.content_id) : null;
      parts.push(`--${mixedBoundary}`);
      parts.push(`Content-Type: ${attachment.mime_type}; name="${escapeMimeParameter(attachment.filename)}"`);
      parts.push(`Content-Disposition: ${disposition}; filename="${escapeMimeParameter(attachment.filename)}"`);
      if (contentId) parts.push(`Content-ID: ${contentId}`);
      parts.push("Content-Transfer-Encoding: base64");
      parts.push("");
      parts.push(wrapBase64(encodeAttachmentContent(attachment.content)));
    }

    parts.push(`--${mixedBoundary}--`, "");
    return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`, "utf8").toString("base64url");
  }

  const bodyPart = buildMimeBodyPart({
    body_text: message.body_text,
    body_html: message.body_html,
  });
  if (bodyPart) {
    return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${bodyPart}`, "utf8").toString("base64url");
  }

  headers.push("Content-Type: text/plain; charset=utf-8");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n`, "utf8").toString("base64url");
}

function buildQueryPredicates(
  gs: GoogleStore,
  userEmail: string,
  term: string,
): Array<(message: GoogleMessage) => boolean> {
  const cleaned = cleanToken(term);
  if (!cleaned) return [];

  const lower = cleaned.toLowerCase();
  if (lower === "or" || lower === "and") return [];

  if (lower.startsWith("-label:")) {
    const labelQuery = cleaned.slice(7);
    return [(message) => !messageMatchesLabelQuery(gs, userEmail, message, labelQuery)];
  }

  if (lower.startsWith("label:")) {
    const labelQuery = cleaned.slice(6);
    return [(message) => messageMatchesLabelQuery(gs, userEmail, message, labelQuery)];
  }

  if (lower.startsWith("in:")) {
    const labelQuery = cleaned.slice(3);
    return [(message) => messageMatchesLabelQuery(gs, userEmail, message, labelQuery)];
  }

  if (lower.startsWith("is:")) {
    const state = cleaned.slice(3).toLowerCase();
    if (state === "read") return [(message) => !message.label_ids.includes("UNREAD")];
    return [(message) => messageMatchesLabelQuery(gs, userEmail, message, state)];
  }

  if (lower.startsWith("from:")) {
    const value = cleaned.slice(5).toLowerCase();
    return value ? [(message) => message.from.toLowerCase().includes(value)] : [];
  }

  if (lower.startsWith("to:")) {
    const value = cleaned.slice(3).toLowerCase();
    return value ? [(message) => message.to.toLowerCase().includes(value)] : [];
  }

  if (lower.startsWith("subject:")) {
    const value = cleaned.slice(8).toLowerCase();
    return value ? [(message) => message.subject.toLowerCase().includes(value)] : [];
  }

  if (lower.startsWith("rfc822msgid:")) {
    const value = cleaned.slice(11).replace(/[<>]/g, "").toLowerCase();
    return value ? [(message) => message.message_id.replace(/[<>]/g, "").toLowerCase() === value] : [];
  }

  if (lower.startsWith("before:")) {
    const timestamp = parseDateFilter(cleaned.slice(7));
    return timestamp != null ? [(message) => Number(message.internal_date) < timestamp] : [];
  }

  if (lower.startsWith("after:")) {
    const timestamp = parseDateFilter(cleaned.slice(6));
    return timestamp != null ? [(message) => Number(message.internal_date) > timestamp] : [];
  }

  if (lower === "has:attachment") {
    return [(message) => hasMessageAttachments(gs, message)];
  }

  const value = cleaned.toLowerCase();
  return value ? [(message) => searchableText(message).includes(value)] : [];
}

function resolveInternalDate(value: string | undefined): number {
  if (!value) return Date.now();

  if (/^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (String(parsed).length >= 13) return parsed;
    return parsed * 1000;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function formatHistoryEntry(
  gs: GoogleStore,
  userEmail: string,
  historyId: string,
  events: GoogleHistoryEvent[],
): Record<string, unknown> {
  const messages = new Map<string, Record<string, unknown>>();
  const messagesAdded: Array<Record<string, unknown>> = [];
  const messagesDeleted: Array<Record<string, unknown>> = [];
  const labelsAdded: Array<Record<string, unknown>> = [];
  const labelsRemoved: Array<Record<string, unknown>> = [];

  for (const event of events) {
    const message = formatHistoryMessageRef(gs, userEmail, event);
    messages.set(event.message_gmail_id, message);

    if (event.change_type === "messageAdded") {
      messagesAdded.push({ message });
    } else if (event.change_type === "messageDeleted") {
      messagesDeleted.push({ message });
    } else if (event.change_type === "labelAdded") {
      labelsAdded.push({ message, labelIds: event.label_ids });
    } else if (event.change_type === "labelRemoved") {
      labelsRemoved.push({ message, labelIds: event.label_ids });
    }
  }

  return {
    id: historyId,
    messages: Array.from(messages.values()),
    ...(messagesAdded.length > 0 ? { messagesAdded } : {}),
    ...(messagesDeleted.length > 0 ? { messagesDeleted } : {}),
    ...(labelsAdded.length > 0 ? { labelsAdded } : {}),
    ...(labelsRemoved.length > 0 ? { labelsRemoved } : {}),
  };
}

function formatHistoryMessageRef(
  gs: GoogleStore,
  userEmail: string,
  event: GoogleHistoryEvent,
): Record<string, unknown> {
  const message = getMessageById(gs, userEmail, event.message_gmail_id);

  return {
    id: event.message_gmail_id,
    threadId: message?.thread_id ?? event.thread_id,
    labelIds: message?.label_ids ?? event.label_ids,
    historyId: message?.history_id ?? event.gmail_id,
    ...(message?.internal_date ? { internalDate: message.internal_date } : {}),
  };
}

function compareHistoryIds(left: string, right: string): number {
  try {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    if (leftValue === rightValue) return 0;
    return leftValue > rightValue ? 1 : -1;
  } catch {
    return left.localeCompare(right);
  }
}

function resolveThreadId(
  gs: GoogleStore,
  userEmail: string,
  explicitThreadId: string | undefined,
  inReplyTo: string | null,
  references: string | null,
): string {
  if (explicitThreadId) return explicitThreadId;

  const linkedIds = [inReplyTo, references]
    .flatMap((value) => (value ? value.split(/\s+/) : []))
    .map((value) => value.trim())
    .filter(Boolean);

  for (const headerMessageId of linkedIds) {
    const linkedMessage = gs.messages
      .findBy("user_email", userEmail)
      .find((message) => message.message_id === headerMessageId);
    if (linkedMessage) return linkedMessage.thread_id;
  }

  return generateUid("thr");
}

function replaceMessageAttachments(
  gs: GoogleStore,
  message: GoogleMessage,
  attachments: ParsedAttachment[],
): void {
  clearMessageAttachments(gs, message.user_email, message.gmail_id);

  for (const attachment of attachments) {
    gs.attachments.insert({
      gmail_id: generateUid("att"),
      user_email: message.user_email,
      message_gmail_id: message.gmail_id,
      filename: attachment.filename,
      mime_type: attachment.mime_type,
      disposition: attachment.disposition,
      content_id: attachment.content_id,
      transfer_encoding: attachment.transfer_encoding,
      data: attachment.data,
      size: attachment.size,
    });
  }
}

function recordHistoryEvents(
  gs: GoogleStore,
  userEmail: string,
  historyId: string,
  events: Array<{
    change_type: GoogleHistoryEvent["change_type"];
    message_gmail_id: string;
    thread_id: string;
    label_ids: string[];
  }>,
): void {
  for (const event of events) {
    gs.history.insert({
      gmail_id: historyId,
      user_email: userEmail,
      change_type: event.change_type,
      message_gmail_id: event.message_gmail_id,
      thread_id: event.thread_id,
      label_ids: dedupeLabelIds(event.label_ids),
    });
  }
}

function applyFiltersToLabelIds(
  gs: GoogleStore,
  userEmail: string,
  from: string,
  labelIds: string[],
): string[] {
  if (!from) return labelIds;

  let nextLabelIds = dedupeLabelIds(labelIds);

  for (const filter of gs.filters.findBy("user_email", userEmail)) {
    if (!matchesFilter(filter, from)) continue;
    nextLabelIds = applyLabelMutation(nextLabelIds, filter.add_label_ids, filter.remove_label_ids);
  }

  return nextLabelIds;
}

function syncDraftState(
  gs: GoogleStore,
  message: GoogleMessage,
  preferredDraftId?: string,
): GoogleDraft | undefined {
  const shouldHaveDraft =
    message.label_ids.includes("DRAFT") && !message.label_ids.includes("SENT");
  const existing = gs.drafts
    .findBy("message_gmail_id", message.gmail_id)
    .filter((draft) => draft.user_email === message.user_email);

  if (!shouldHaveDraft) {
    for (const draft of existing) {
      gs.drafts.delete(draft.id);
    }
    return undefined;
  }

  if (existing[0]) return existing[0];

  return gs.drafts.insert({
    gmail_id: preferredDraftId ?? generateDraftId(),
    user_email: message.user_email,
    message_gmail_id: message.gmail_id,
  });
}

function clearDraftRecordsForMessage(gs: GoogleStore, userEmail: string, messageId: string): void {
  const drafts = gs.drafts
    .findBy("message_gmail_id", messageId)
    .filter((draft) => draft.user_email === userEmail);

  for (const draft of drafts) {
    gs.drafts.delete(draft.id);
  }
}

function clearMessageAttachments(gs: GoogleStore, userEmail: string, messageId: string): void {
  const attachments = gs.attachments
    .findBy("message_gmail_id", messageId)
    .filter((attachment) => attachment.user_email === userEmail);

  for (const attachment of attachments) {
    gs.attachments.delete(attachment.id);
  }
}

function listAttachmentsForMessage(gs: GoogleStore, message: GoogleMessage): GoogleAttachment[] {
  return gs.attachments
    .findBy("message_gmail_id", message.gmail_id)
    .filter((attachment) => attachment.user_email === message.user_email)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function hasMessageAttachments(gs: GoogleStore, message: GoogleMessage): boolean {
  return gs.attachments
    .findBy("message_gmail_id", message.gmail_id)
    .some((attachment) => attachment.user_email === message.user_email);
}

function ensureDefaultSendAs(gs: GoogleStore, userEmail: string): void {
  const existing = gs.sendAs.findBy("user_email", userEmail);
  if (existing.length > 0) {
    if (!existing.some((entry) => entry.is_default)) {
      gs.sendAs.update(existing[0].id, { is_default: true });
    }
    return;
  }

  const user = gs.users.findOneBy("email", userEmail);
  gs.sendAs.insert({
    user_email: userEmail,
    send_as_email: userEmail,
    display_name: user?.name?.trim() || userEmail.split("@")[0],
    is_default: true,
    signature: "",
  });
}

function matchesFilter(filter: GoogleFilter, from: string): boolean {
  if (filter.criteria_from) {
    return from.toLowerCase().includes(filter.criteria_from.toLowerCase());
  }

  return true;
}

function normalizeFilterFrom(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function sortStrings(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function arrayEquals(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function messageMatchesLabelQuery(
  gs: GoogleStore,
  userEmail: string,
  message: GoogleMessage,
  query: string,
): boolean {
  const normalized = normalizeLabelQuery(query);
  if (message.label_ids.includes(normalized)) return true;

  return message.label_ids.some((labelId) => {
    const label = findLabelById(gs, userEmail, labelId);
    return label?.name.toLowerCase() === cleanToken(query).toLowerCase();
  });
}

function parseDateFilter(value: string): number | null {
  const trimmed = cleanToken(value);
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    return String(parsed).length >= 13 ? parsed : parsed * 1000;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function searchableText(message: GoogleMessage): string {
  return [
    message.subject,
    message.from,
    message.to,
    message.cc ?? "",
    message.bcc ?? "",
    message.snippet,
    message.body_text ?? "",
    stripHtml(message.body_html ?? ""),
  ]
    .join(" ")
    .toLowerCase();
}

function cleanToken(token: string): string {
  return token
    .trim()
    .replace(/^[()]+/, "")
    .replace(/[()]+$/, "")
    .replace(/^"(.*)"$/, "$1");
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function buildHeaders(message: GoogleMessage): MessageHeader[] {
  const headers: Array<MessageHeader | { name: string; value: string | null }> = [
    { name: "From", value: message.from },
    { name: "To", value: message.to },
    { name: "Cc", value: message.cc },
    { name: "Bcc", value: message.bcc },
    { name: "Reply-To", value: message.reply_to },
    { name: "Subject", value: message.subject },
    { name: "Date", value: message.date_header },
    { name: "Message-ID", value: message.message_id },
    { name: "References", value: message.references },
    { name: "In-Reply-To", value: message.in_reply_to },
  ];

  return headers.filter((header): header is MessageHeader => Boolean(header.value));
}

function buildPayload(
  gs: GoogleStore,
  message: GoogleMessage,
  headers: MessageHeader[],
  format: GmailMessageFormat,
) {
  const textBody = message.body_text ?? null;
  const htmlBody = message.body_html ?? null;
  const attachments = listAttachmentsForMessage(gs, message);

  if (format === "metadata") {
    return {
      partId: "",
      mimeType: attachments.length > 0 ? "multipart/mixed" : htmlBody ? "text/html" : "text/plain",
      filename: "",
      headers,
      body: { size: 0 },
    };
  }

  if (attachments.length === 0) {
    if (textBody && htmlBody) {
      return {
        partId: "",
        mimeType: "multipart/alternative",
        filename: "",
        headers,
        body: { size: 0 },
        parts: [
          createTextBodyPart("0", "text/plain", textBody),
          createTextBodyPart("1", "text/html", htmlBody),
        ],
      };
    }

    if (htmlBody) return createTextBodyPart("", "text/html", htmlBody, headers);
    if (textBody) return createTextBodyPart("", "text/plain", textBody, headers);

    return {
      partId: "",
      mimeType: "text/plain",
      filename: "",
      headers,
      body: { size: 0 },
    };
  }

  const parts: Array<Record<string, unknown>> = [];
  if (textBody && htmlBody) {
    parts.push({
      partId: "0",
      mimeType: "multipart/alternative",
      filename: "",
      headers: [],
      body: { size: 0 },
      parts: [
        createTextBodyPart("0.0", "text/plain", textBody),
        createTextBodyPart("0.1", "text/html", htmlBody),
      ],
    });
  } else if (htmlBody) {
    parts.push(createTextBodyPart("0", "text/html", htmlBody));
  } else if (textBody) {
    parts.push(createTextBodyPart("0", "text/plain", textBody));
  }

  for (const [index, attachment] of attachments.entries()) {
    parts.push(createAttachmentPart(String(parts.length + index), attachment));
  }

  return {
    partId: "",
    mimeType: "multipart/mixed",
    filename: "",
    headers,
    body: { size: 0 },
    parts,
  };
}

function createTextBodyPart(
  partId: string,
  mimeType: string,
  content: string,
  headers: MessageHeader[] = [],
) {
  return {
    partId,
    mimeType,
    filename: "",
    headers,
    body: {
      size: Buffer.byteLength(content, "utf8"),
      data: Buffer.from(content, "utf8").toString("base64url"),
    },
  };
}

function createAttachmentPart(partId: string, attachment: GoogleAttachment) {
  const headers: MessageHeader[] = [
    {
      name: "Content-Type",
      value: attachment.filename
        ? `${attachment.mime_type}; name="${attachment.filename}"`
        : attachment.mime_type,
    },
    {
      name: "Content-Disposition",
      value: `${attachment.disposition ?? "attachment"}; filename="${attachment.filename}"`,
    },
  ];

  if (attachment.transfer_encoding) {
    headers.push({ name: "Content-Transfer-Encoding", value: attachment.transfer_encoding });
  }
  if (attachment.content_id) {
    headers.push({ name: "Content-ID", value: attachment.content_id });
  }

  return {
    partId,
    mimeType: attachment.mime_type,
    filename: attachment.filename,
    headers,
    body: {
      attachmentId: attachment.gmail_id,
      size: attachment.size,
    },
  };
}

function estimateSize(message: GoogleMessage, preBuiltHeaders?: MessageHeader[]): number {
  if (message.raw) {
    return Buffer.byteLength(message.raw, "utf8");
  }
  const headers = (preBuiltHeaders ?? buildHeaders(message))
    .map((header) => `${header.name}: ${header.value}`)
    .join("\n");
  const body = `${message.body_text ?? ""}\n${message.body_html ?? ""}`;
  return Buffer.byteLength(`${headers}\n\n${body}`, "utf8");
}

function deriveSnippet(value: string): string {
  return stripHtml(value).slice(0, 140);
}

function sortMessagesByDateDesc(messages: GoogleMessage[]): GoogleMessage[] {
  return [...messages].sort((a, b) => Number(b.internal_date) - Number(a.internal_date));
}

function sortMessagesByDateAsc(messages: GoogleMessage[]): GoogleMessage[] {
  return [...messages].sort((a, b) => Number(a.internal_date) - Number(b.internal_date));
}

function buildMimeBodyPart(input: {
  body_text?: string | null;
  body_html?: string | null;
}): string | null {
  if (input.body_text && input.body_html) {
    const boundary = `emulate-alt-${randomBytes(8).toString("hex")}`;
    return [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      input.body_text,
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      input.body_html,
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }

  if (input.body_html) {
    return [
      "Content-Type: text/html; charset=utf-8",
      "",
      input.body_html,
    ].join("\r\n");
  }

  if (input.body_text) {
    return [
      "Content-Type: text/plain; charset=utf-8",
      "",
      input.body_text,
    ].join("\r\n");
  }

  return null;
}

function encodeAttachmentContent(content: Buffer | string): string {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return buffer.toString("base64");
}

function wrapBase64(value: string): string {
  return value.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function escapeMimeParameter(value: string): string {
  return value.replace(/"/g, '\\"');
}

function ensureWrappedContentId(value: string): string {
  if (value.startsWith("<") && value.endsWith(">")) return value;
  return `<${value}>`;
}

function parseRawMessage(raw: string): ParsedRawMessage {
  const decoded = decodeBase64Like(raw).toString("utf8").replace(/\r\n/g, "\n");
  const root = parseMimeEntity(decoded);
  const attachments = collectMimeNodes(root)
    .filter((node) => isAttachmentNode(node))
    .map<ParsedAttachment>((node) => ({
      filename: node.filename || "attachment",
      mime_type: node.mimeType || "application/octet-stream",
      disposition: node.disposition,
      content_id: node.contentId,
      transfer_encoding: node.transferEncoding,
      data: (node.body ?? Buffer.alloc(0)).toString("base64url"),
      size: node.body?.length ?? 0,
    }));

  return {
    raw,
    from: root.headers.get("from") ?? "",
    to: root.headers.get("to") ?? "",
    cc: root.headers.get("cc") ?? null,
    bcc: root.headers.get("bcc") ?? null,
    reply_to: root.headers.get("reply-to") ?? null,
    subject: root.headers.get("subject") ?? "",
    message_id: root.headers.get("message-id") ?? null,
    references: root.headers.get("references") ?? null,
    in_reply_to: root.headers.get("in-reply-to") ?? null,
    date_header: root.headers.get("date") ?? null,
    body_text: findFirstTextPart(root, "text/plain"),
    body_html: findFirstTextPart(root, "text/html"),
    attachments,
  };
}

function parseMimeEntity(source: string): ParsedMimeNode {
  const normalized = source.replace(/\r\n/g, "\n");
  const separatorIndex = normalized.indexOf("\n\n");
  const headerText = separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : normalized;
  const bodyText = separatorIndex >= 0 ? normalized.slice(separatorIndex + 2) : "";
  const headers = parseHeaders(headerText);
  const contentType = parseHeaderWithParams(headers.get("content-type") ?? "text/plain; charset=utf-8");
  const disposition = parseHeaderWithParams(headers.get("content-disposition") ?? "");
  const boundary = contentType.params.boundary;
  const mimeType = contentType.value.toLowerCase() || "text/plain";
  const filename = disposition.params.filename ?? contentType.params.name ?? "";

  if (mimeType.startsWith("multipart/") && boundary) {
    return {
      mimeType,
      filename,
      headers,
      body: null,
      parts: splitMultipartBody(bodyText, boundary).map((part) => parseMimeEntity(part)),
      disposition: disposition.value || null,
      contentId: headers.get("content-id") ?? null,
      transferEncoding: headers.get("content-transfer-encoding")?.toLowerCase() ?? null,
      charset: contentType.params.charset ?? null,
    };
  }

  return {
    mimeType,
    filename,
    headers,
    body: decodeMimeBody(bodyText, headers.get("content-transfer-encoding") ?? null),
    parts: [],
    disposition: disposition.value || null,
    contentId: headers.get("content-id") ?? null,
    transferEncoding: headers.get("content-transfer-encoding")?.toLowerCase() ?? null,
    charset: contentType.params.charset ?? null,
  };
}

function parseHeaders(headerText: string): Map<string, string> {
  const headers = new Map<string, string>();
  let currentKey: string | null = null;

  for (const line of headerText.split("\n")) {
    if (!line.trim()) continue;

    if ((line.startsWith(" ") || line.startsWith("\t")) && currentKey) {
      headers.set(currentKey, `${headers.get(currentKey) ?? ""} ${line.trim()}`.trim());
      continue;
    }

    const separator = line.indexOf(":");
    if (separator < 0) continue;

    currentKey = line.slice(0, separator).trim().toLowerCase();
    headers.set(currentKey, line.slice(separator + 1).trim());
  }

  return headers;
}

function parseHeaderWithParams(value: string): HeaderWithParams {
  const [base, ...rest] = value.split(";");
  const params: Record<string, string> = {};

  for (const token of rest) {
    const separator = token.indexOf("=");
    if (separator < 0) continue;
    const key = token.slice(0, separator).trim().toLowerCase();
    const rawValue = token.slice(separator + 1).trim();
    params[key] = rawValue.replace(/^"(.*)"$/, "$1");
  }

  return {
    value: base.trim(),
    params,
  };
}

function splitMultipartBody(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const chunks: string[] = [];

  for (const segment of body.split(marker)) {
    const trimmed = segment.trim();
    if (!trimmed || trimmed === "--") continue;
    chunks.push(trimmed.replace(/^\n+/, "").replace(/\n+$/, ""));
  }

  return chunks;
}

function decodeMimeBody(body: string, transferEncoding: string | null): Buffer {
  const normalizedEncoding = transferEncoding?.toLowerCase() ?? "";

  if (normalizedEncoding === "base64") {
    const compact = body.replace(/\s+/g, "");
    return compact ? Buffer.from(compact, "base64") : Buffer.alloc(0);
  }

  if (normalizedEncoding === "quoted-printable") {
    return decodeQuotedPrintable(body);
  }

  return Buffer.from(body, "utf8");
}

function decodeQuotedPrintable(value: string): Buffer {
  const normalized = value.replace(/=\r?\n/g, "");
  const bytes: number[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    if (current === "=" && /^[A-Fa-f0-9]{2}$/.test(normalized.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(normalized.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }

    bytes.push(normalized.charCodeAt(index));
  }

  return Buffer.from(bytes);
}

function findFirstTextPart(root: ParsedMimeNode, mimeType: "text/plain" | "text/html"): string | null {
  for (const node of collectMimeNodes(root)) {
    if (node.parts.length > 0) continue;
    if (!node.mimeType.includes(mimeType)) continue;
    if (isAttachmentNode(node)) continue;

    const content = decodeTextNode(node).trim();
    if (content) return content;
  }

  return null;
}

function decodeTextNode(node: ParsedMimeNode): string {
  const encoding = normalizeCharset(node.charset);
  return (node.body ?? Buffer.alloc(0)).toString(encoding);
}

function normalizeCharset(value: string | null): BufferEncoding {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "utf-8" || normalized === "us-ascii") return "utf8";
  if (normalized === "iso-8859-1" || normalized === "latin1") return "latin1";
  return "utf8";
}

function collectMimeNodes(root: ParsedMimeNode): ParsedMimeNode[] {
  const nodes: ParsedMimeNode[] = [];
  const queue: ParsedMimeNode[] = [root];

  while (queue.length > 0) {
    const node = queue.shift()!;
    nodes.push(node);
    if (node.parts.length > 0) {
      queue.push(...node.parts);
    }
  }

  return nodes;
}

function isAttachmentNode(node: ParsedMimeNode): boolean {
  if (node.parts.length > 0) return false;

  const disposition = node.disposition?.toLowerCase() ?? "";
  if (node.filename) return true;
  if (disposition.includes("attachment")) return true;
  if (disposition.includes("inline") && !node.mimeType.startsWith("text/")) return true;

  return false;
}

function decodeBase64Like(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64");
}
