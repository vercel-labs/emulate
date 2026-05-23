import { randomBytes } from "crypto";
import type { Context } from "@emulators/core";
import type { ContentfulStatusCode } from "@emulators/core";
import type { SlackJsonObject, SlackMessage, SlackScheduledMessage } from "./entities.js";

let tsCounter = 0;

export type SlackRichMessageFieldName =
  | "blocks"
  | "attachments"
  | "metadata"
  | "mrkdwn"
  | "parse"
  | "link_names"
  | "unfurl_links"
  | "unfurl_media"
  | "username"
  | "icon_url"
  | "icon_emoji"
  | "bot_id"
  | "app_id"
  | "client_msg_id"
  | "reply_broadcast";

export type SlackRichMessageFields = Partial<Pick<SlackMessage, SlackRichMessageFieldName>>;

export interface SlackRichMessageParseResult {
  fields: SlackRichMessageFields;
  providedFields: SlackRichMessageFieldName[];
  error?: string;
}

interface ParsedField<T> {
  value?: T;
  error?: string;
}

export function generateSlackId(prefix: string): string {
  return prefix + randomBytes(5).toString("hex").toUpperCase().slice(0, 9);
}

export function generateTs(): string {
  const now = Math.floor(Date.now() / 1000);
  tsCounter++;
  return `${now}.${String(tsCounter).padStart(6, "0")}`;
}

export function slackOk<T extends Record<string, unknown>>(c: Context, data: T) {
  return c.json({ ok: true, ...data });
}

export function slackError(c: Context, error: string, status: ContentfulStatusCode = 200) {
  return c.json({ ok: false, error }, status);
}

export async function parseSlackBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type") ?? "";
  const rawText = await c.req.text();

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  // Slack SDKs send application/x-www-form-urlencoded by default
  const params = new URLSearchParams(rawText);
  const result: Record<string, unknown> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}

export function formatSlackMessage(msg: SlackMessage) {
  return {
    type: msg.type,
    user: msg.user,
    text: msg.text,
    ts: msg.ts,
    ...(msg.subtype ? { subtype: msg.subtype } : {}),
    ...(msg.bot_id ? { bot_id: msg.bot_id } : {}),
    ...(msg.app_id ? { app_id: msg.app_id } : {}),
    ...(msg.username ? { username: msg.username } : {}),
    ...(msg.icon_url ? { icon_url: msg.icon_url } : {}),
    ...(msg.icon_emoji ? { icon_emoji: msg.icon_emoji } : {}),
    ...(msg.client_msg_id ? { client_msg_id: msg.client_msg_id } : {}),
    ...(msg.topic !== undefined ? { topic: msg.topic } : {}),
    ...(msg.purpose !== undefined ? { purpose: msg.purpose } : {}),
    ...(msg.old_name !== undefined ? { old_name: msg.old_name } : {}),
    ...(msg.name !== undefined ? { name: msg.name } : {}),
    ...(msg.blocks !== undefined ? { blocks: msg.blocks } : {}),
    ...(msg.attachments !== undefined ? { attachments: msg.attachments } : {}),
    ...(msg.metadata !== undefined ? { metadata: msg.metadata } : {}),
    ...(msg.mrkdwn !== undefined ? { mrkdwn: msg.mrkdwn } : {}),
    ...(msg.parse !== undefined ? { parse: msg.parse } : {}),
    ...(msg.link_names !== undefined ? { link_names: msg.link_names } : {}),
    ...(msg.unfurl_links !== undefined ? { unfurl_links: msg.unfurl_links } : {}),
    ...(msg.unfurl_media !== undefined ? { unfurl_media: msg.unfurl_media } : {}),
    ...(msg.reply_broadcast !== undefined ? { reply_broadcast: msg.reply_broadcast } : {}),
    ...(msg.edited ? { edited: msg.edited } : {}),
    ...(msg.thread_ts ? { thread_ts: msg.thread_ts } : {}),
    ...(msg.reply_count > 0 ? { reply_count: msg.reply_count, reply_users: msg.reply_users } : {}),
    ...(msg.reactions.length > 0 ? { reactions: msg.reactions } : {}),
  };
}

export function formatSlackPermalink(baseUrl: string, channel: string, msg: SlackMessage): string {
  const permalink = `${baseUrl.replace(/\/$/, "")}/archives/${channel}/p${msg.ts.replace(".", "")}`;
  if (!msg.thread_ts || msg.thread_ts === msg.ts) return permalink;

  const params = new URLSearchParams({ thread_ts: msg.thread_ts, cid: channel });
  return `${permalink}?${params.toString()}`;
}

export function formatSlackScheduledMessage(msg: SlackScheduledMessage) {
  return {
    text: msg.text,
    type: msg.type,
    subtype: msg.subtype,
    ...(msg.username ? { username: msg.username } : {}),
    ...(msg.bot_id ? { bot_id: msg.bot_id } : {}),
    ...(msg.app_id ? { app_id: msg.app_id } : {}),
    ...(msg.icon_url ? { icon_url: msg.icon_url } : {}),
    ...(msg.icon_emoji ? { icon_emoji: msg.icon_emoji } : {}),
    ...(msg.client_msg_id ? { client_msg_id: msg.client_msg_id } : {}),
    ...(msg.blocks !== undefined ? { blocks: msg.blocks } : {}),
    ...(msg.attachments !== undefined ? { attachments: msg.attachments } : {}),
    ...(msg.metadata !== undefined ? { metadata: msg.metadata } : {}),
    ...(msg.mrkdwn !== undefined ? { mrkdwn: msg.mrkdwn } : {}),
    ...(msg.parse !== undefined ? { parse: msg.parse } : {}),
    ...(msg.link_names !== undefined ? { link_names: msg.link_names } : {}),
    ...(msg.unfurl_links !== undefined ? { unfurl_links: msg.unfurl_links } : {}),
    ...(msg.unfurl_media !== undefined ? { unfurl_media: msg.unfurl_media } : {}),
    ...(msg.reply_broadcast !== undefined ? { reply_broadcast: msg.reply_broadcast } : {}),
    ...(msg.thread_ts ? { thread_ts: msg.thread_ts } : {}),
  };
}

export function formatSlackScheduledMessageListItem(msg: SlackScheduledMessage) {
  return {
    id: msg.scheduled_message_id,
    channel_id: msg.channel_id,
    post_at: msg.post_at,
    date_created: msg.date_created,
    text: msg.text,
  };
}

export function parseSlackRichMessageFields(body: Record<string, unknown>): SlackRichMessageParseResult {
  const fields: SlackRichMessageFields = {};
  const providedFields: SlackRichMessageFieldName[] = [];

  const blocks = parseSlackObjectArray(body.blocks, "invalid_blocks");
  if (blocks.error) return { fields, providedFields, error: blocks.error };
  if (hasBodyField(body, "blocks")) {
    providedFields.push("blocks");
    if (blocks.value !== undefined) fields.blocks = blocks.value;
  }

  const attachments = parseSlackObjectArray(body.attachments, "invalid_attachments");
  if (attachments.error) return { fields, providedFields, error: attachments.error };
  if (hasBodyField(body, "attachments")) {
    providedFields.push("attachments");
    if (attachments.value !== undefined) fields.attachments = attachments.value;
  }

  const metadata = parseSlackObject(body.metadata, "invalid_metadata_format");
  if (metadata.error) return { fields, providedFields, error: metadata.error };
  if (hasBodyField(body, "metadata")) {
    providedFields.push("metadata");
    if (metadata.value !== undefined) fields.metadata = metadata.value;
  }

  setOptionalStringField(body, fields, providedFields, "parse");
  setOptionalStringField(body, fields, providedFields, "username");
  setOptionalStringField(body, fields, providedFields, "icon_url");
  setOptionalStringField(body, fields, providedFields, "icon_emoji");
  setOptionalStringField(body, fields, providedFields, "bot_id");
  setOptionalStringField(body, fields, providedFields, "app_id");
  setOptionalStringField(body, fields, providedFields, "client_msg_id");

  setOptionalBooleanField(body, fields, providedFields, "mrkdwn");
  setOptionalBooleanField(body, fields, providedFields, "link_names");
  setOptionalBooleanField(body, fields, providedFields, "unfurl_links");
  setOptionalBooleanField(body, fields, providedFields, "unfurl_media");
  setOptionalBooleanField(body, fields, providedFields, "reply_broadcast");

  return { fields, providedFields };
}

export function hasSlackMessageContent(text: string, fields: SlackRichMessageFields): boolean {
  return text.length > 0 || (fields.blocks?.length ?? 0) > 0 || (fields.attachments?.length ?? 0) > 0;
}

export function resetTsCounter(): void {
  tsCounter = 0;
}

function hasBodyField(body: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function isSlackJsonObject(value: unknown): value is SlackJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSlackJsonString(value: string): ParsedField<unknown> {
  if (value.length === 0) return {};
  try {
    return { value: JSON.parse(value) as unknown };
  } catch {
    return { error: "invalid_json" };
  }
}

function parseSlackObjectArray(value: unknown, error: string): ParsedField<SlackJsonObject[]> {
  let parsed = value;
  if (parsed === undefined || parsed === null || parsed === "") return {};
  if (typeof parsed === "string") {
    const result = parseSlackJsonString(parsed);
    if (result.error) return { error };
    parsed = result.value;
  }

  if (!Array.isArray(parsed) || !parsed.every(isSlackJsonObject)) {
    return { error };
  }
  return { value: parsed };
}

function parseSlackObject(value: unknown, error: string): ParsedField<SlackJsonObject> {
  let parsed = value;
  if (parsed === undefined || parsed === null || parsed === "") return {};
  if (typeof parsed === "string") {
    const result = parseSlackJsonString(parsed);
    if (result.error) return { error };
    parsed = result.value;
  }

  if (!isSlackJsonObject(parsed)) {
    return { error };
  }
  return { value: parsed };
}

function parseSlackBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return undefined;
}

function setOptionalStringField<K extends Extract<SlackRichMessageFieldName, keyof SlackRichMessageFields>>(
  body: Record<string, unknown>,
  fields: SlackRichMessageFields,
  providedFields: SlackRichMessageFieldName[],
  field: K,
): void {
  if (!hasBodyField(body, field)) return;
  providedFields.push(field);
  const value = body[field];
  if (typeof value === "string" && value.length > 0) {
    fields[field] = value as SlackRichMessageFields[K];
  }
}

function setOptionalBooleanField<K extends Extract<SlackRichMessageFieldName, keyof SlackRichMessageFields>>(
  body: Record<string, unknown>,
  fields: SlackRichMessageFields,
  providedFields: SlackRichMessageFieldName[],
  field: K,
): void {
  if (!hasBodyField(body, field)) return;
  providedFields.push(field);
  const value = parseSlackBoolean(body[field]);
  if (value !== undefined) {
    fields[field] = value as SlackRichMessageFields[K];
  }
}
