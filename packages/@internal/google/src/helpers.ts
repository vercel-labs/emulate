import { randomBytes } from "crypto";
import type { Context } from "hono";
import type { GoogleLabel, GoogleMessage } from "./entities.js";
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

export function generateHistoryId(): string {
  return `${Date.now()}${randomBytes(2).toString("hex")}`;
}

export function getAuthenticatedEmail(c: Context): string | null {
  const authUser = c.get("authUser");
  return authUser?.login ?? null;
}

export function matchesRequestedUser(userId: string, authEmail: string): boolean {
  return userId === "me" || userId === authEmail;
}

export function gmailError(
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
  for (const label of SYSTEM_LABELS) {
    const existing = gs.labels
      .findBy("user_email", userEmail)
      .find((row) => row.gmail_id === label.gmail_id);
    if (existing) continue;

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

export function formatLabelResource(gs: GoogleStore, label: GoogleLabel) {
  const messages = gs.messages
    .findBy("user_email", label.user_email)
    .filter((message) => message.label_ids.includes(label.gmail_id));

  const threadIds = new Set(messages.map((message) => message.thread_id));
  const unreadMessages = messages.filter((message) => message.label_ids.includes("UNREAD"));
  const unreadThreadIds = new Set(unreadMessages.map((message) => message.thread_id));

  return {
    id: label.gmail_id,
    name: label.name,
    type: label.type === "system" ? "system" : "user",
    messageListVisibility: label.message_list_visibility ?? undefined,
    labelListVisibility: label.label_list_visibility ?? undefined,
    messagesTotal: messages.length,
    messagesUnread: unreadMessages.length,
    threadsTotal: threadIds.size,
    threadsUnread: unreadThreadIds.size,
    color:
      label.color_background || label.color_text
        ? {
            backgroundColor: label.color_background ?? undefined,
            textColor: label.color_text ?? undefined,
          }
        : undefined,
  };
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
  const labelIds = dedupeLabelIds(input.label_ids ?? options?.defaultLabelIds ?? []);

  if (options?.createMissingCustomLabels) {
    for (const labelId of labelIds.filter((labelId) => !isSystemLabelId(labelId))) {
      ensureCustomLabel(gs, input.user_email, labelId);
    }
  }

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

  return gs.messages.insert({
    gmail_id: gmailId,
    thread_id: threadId,
    user_email: input.user_email,
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
    message_id: messageId,
    references: merged.references,
    in_reply_to: merged.in_reply_to,
    date_header: new Date(internalDateMs).toUTCString(),
    body_text: merged.body_text,
    body_html: merged.body_html,
  });
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

export function getMessageById(gs: GoogleStore, userEmail: string, messageId: string): GoogleMessage | undefined {
  return gs.messages
    .findBy("user_email", userEmail)
    .find((message) => message.gmail_id === messageId);
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
    sizeEstimate: estimateSize(message),
  };

  if (format === "minimal") return base;
  if (format === "raw") return { ...base, raw: message.raw ?? undefined };

  return {
    ...base,
    payload: buildPayload(message, filteredHeaders, format),
  };
}

export function formatThreadResource(
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
    messages: ordered.map((message) => formatMessageResource(message, format, metadataHeaders)),
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
  return (
    gs.messages.update(message.id, {
      label_ids: dedupeLabelIds(nextLabelIds),
      history_id: generateHistoryId(),
    }) ?? message
  );
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
    return [() => false];
  }

  const value = cleaned.toLowerCase();
  return value ? [(message) => searchableText(message).includes(value)] : [];
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

function buildHeaders(message: GoogleMessage): Array<{ name: string; value: string }> {
  const headers: Array<{ name: string; value: string | null }> = [
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

  return headers.filter((header): header is { name: string; value: string } => Boolean(header.value));
}

function buildPayload(
  message: GoogleMessage,
  headers: Array<{ name: string; value: string }>,
  format: GmailMessageFormat,
) {
  const textBody = message.body_text ?? null;
  const htmlBody = message.body_html ?? null;

  if (format === "metadata") {
    return {
      partId: "",
      mimeType: htmlBody ? "text/html" : "text/plain",
      filename: "",
      headers,
      body: { size: 0 },
    };
  }

  if (textBody && htmlBody) {
    return {
      partId: "",
      mimeType: "multipart/alternative",
      filename: "",
      headers,
      body: { size: 0 },
      parts: [
        createBodyPart("0", "text/plain", textBody),
        createBodyPart("1", "text/html", htmlBody),
      ],
    };
  }

  if (htmlBody) return createBodyPart("", "text/html", htmlBody, headers);
  if (textBody) return createBodyPart("", "text/plain", textBody, headers);

  return {
    partId: "",
    mimeType: "text/plain",
    filename: "",
    headers,
    body: { size: 0 },
  };
}

function createBodyPart(
  partId: string,
  mimeType: string,
  content: string,
  headers: Array<{ name: string; value: string }> = [],
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

function estimateSize(message: GoogleMessage): number {
  if (message.raw) {
    return Buffer.byteLength(message.raw, "utf8");
  }
  const headers = buildHeaders(message)
    .map((header) => `${header.name}: ${header.value}`)
    .join("\n");
  const body = `${message.body_text ?? ""}\n${message.body_html ?? ""}`;
  return Buffer.byteLength(`${headers}\n\n${body}`, "utf8");
}

function deriveSnippet(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function sortMessagesByDateDesc(messages: GoogleMessage[]): GoogleMessage[] {
  return [...messages].sort((a, b) => Number(b.internal_date) - Number(a.internal_date));
}

function sortMessagesByDateAsc(messages: GoogleMessage[]): GoogleMessage[] {
  return [...messages].sort((a, b) => Number(a.internal_date) - Number(b.internal_date));
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
  ];

  if (message.body_text && message.body_html) {
    const boundary = `emulate-${randomBytes(8).toString("hex")}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const body = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      message.body_text,
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      message.body_html,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
  }

  headers.push(`Content-Type: ${message.body_html ? "text/html" : "text/plain"}; charset=utf-8`);
  const body = message.body_html ?? message.body_text ?? "";
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
}

function parseRawMessage(raw: string): ParsedRawMessage {
  const decoded = Buffer.from(raw, "base64url").toString("utf8").replace(/\r\n/g, "\n");
  const separatorIndex = decoded.indexOf("\n\n");
  const headerText = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : decoded;
  const bodyText = separatorIndex >= 0 ? decoded.slice(separatorIndex + 2) : "";
  const headers = parseHeaders(headerText);
  const contentType = (headers.get("content-type") ?? "text/plain").toLowerCase();

  let parsed = {
    text: null as string | null,
    html: null as string | null,
  };

  if (contentType.startsWith("multipart/")) {
    parsed = parseMultipartBody(bodyText, contentType);
  } else if (contentType.includes("text/html")) {
    parsed.html = bodyText.trim();
  } else {
    parsed.text = bodyText.trim();
  }

  return {
    raw,
    from: headers.get("from") ?? "",
    to: headers.get("to") ?? "",
    cc: headers.get("cc") ?? null,
    bcc: headers.get("bcc") ?? null,
    reply_to: headers.get("reply-to") ?? null,
    subject: headers.get("subject") ?? "",
    message_id: headers.get("message-id") ?? null,
    references: headers.get("references") ?? null,
    in_reply_to: headers.get("in-reply-to") ?? null,
    date_header: headers.get("date") ?? null,
    body_text: parsed.text,
    body_html: parsed.html,
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

function parseMultipartBody(body: string, contentType: string): { text: string | null; html: string | null } {
  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
  const boundary = boundaryMatch?.[1];
  if (!boundary) return { text: body.trim() || null, html: null };

  let text: string | null = null;
  let html: string | null = null;

  for (const chunk of body.split(`--${boundary}`)) {
    const trimmed = chunk.trim();
    if (!trimmed || trimmed === "--") continue;

    const separatorIndex = trimmed.indexOf("\n\n");
    const partHeaderText = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex) : trimmed;
    const partBody = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 2).trim() : "";
    const partHeaders = parseHeaders(partHeaderText);
    const partType = (partHeaders.get("content-type") ?? "text/plain").toLowerCase();

    if (partType.startsWith("multipart/")) {
      const nested = parseMultipartBody(partBody, partType);
      text = text ?? nested.text;
      html = html ?? nested.html;
      continue;
    }

    if (partType.includes("text/plain")) {
      text = text ?? partBody;
    } else if (partType.includes("text/html")) {
      html = html ?? partBody;
    }
  }

  return { text, html };
}
