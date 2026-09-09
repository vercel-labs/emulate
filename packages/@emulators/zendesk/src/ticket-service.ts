import type {
  AuditEvent,
  CustomFieldValue,
  TicketMetrics,
  TicketPriority,
  TicketStatus,
  TicketType,
  Via,
  ZendeskAudit,
  ZendeskComment,
  ZendeskMacro,
  ZendeskTicket,
  ZendeskUser,
} from "./entities.js";
import {
  applyActions,
  evaluateConditions,
  renderPlaceholders,
  type ActionPatch,
  type RuleContext,
} from "./conditions.js";
import { formatComment, formatTicket, ticketCreatedAt } from "./formatters.js";
import { bool, list, normalizeTags, nowIso, num, obj, recordInvalid, str, strOrNull, toIso } from "./helpers.js";
import { nextId, reserveId } from "./ids.js";
import { ensureEndUser, findUserByEmail } from "./records.js";
import type { ZendeskStore } from "./store.js";
import { emitZendeskEvent, invokeWebhook, type ZendeskCtx } from "./webhooks.js";

const STATUSES = new Set<string>(["new", "open", "pending", "hold", "solved", "closed"]);
const PRIORITIES = new Set<string>(["low", "normal", "high", "urgent"]);
const TYPES = new Set<string>(["problem", "incident", "question", "task"]);
export const SYSTEM_USER_ID = -1;

export const API_VIA: Via = { channel: "api", source: { from: {}, to: {}, rel: null } };
export const WEB_VIA: Via = { channel: "web", source: { from: {}, to: {}, rel: null } };

export function emailVia(
  from: { address: string; name?: string | null },
  to: { address: string; name?: string | null },
): Via {
  return {
    channel: "email",
    source: {
      from: { address: from.address, name: from.name ?? from.address },
      to: { address: to.address, name: to.name ?? to.address },
      rel: null,
    },
  };
}

export interface CommentInput {
  body?: string;
  html_body?: string;
  public?: boolean;
  author_id?: number;
  uploads?: string[];
  created_at?: string | null;
  via?: Via;
}

export interface TicketInput {
  id?: number;
  subject?: string;
  description?: string;
  comment?: CommentInput | null;
  requester_id?: number;
  requester?: { name?: string | null; email?: string | null; locale?: string | null } | null;
  submitter_id?: number;
  assignee_id?: number | null;
  assignee_email?: string;
  group_id?: number | null;
  organization_id?: number | null;
  priority?: TicketPriority | null;
  type?: TicketType | null;
  status?: TicketStatus;
  custom_status_id?: number;
  tags?: string[];
  additional_tags?: string[];
  remove_tags?: string[];
  custom_fields?: CustomFieldValue[];
  external_id?: string | null;
  due_at?: string | null;
  collaborator_ids?: number[];
  additional_collaborators?: number[];
  email_ccs?: Array<{ user_id?: number; user_email?: string; user_name?: string; action?: string }>;
  follower_ids?: number[];
  problem_id?: number | null;
  brand_id?: number;
  ticket_form_id?: number;
  recipient?: string | null;
  via?: Via;
  created_at?: string | null;
  updated_at?: string | null;
  solved_at?: string | null;
  comments?: CommentInput[];
  macro_ids?: number[];
}

function parseCommentInput(raw: unknown): CommentInput | null {
  if (raw === null) return null;
  if (typeof raw === "string") return { body: raw, public: true };
  const body = obj(raw);
  if (Object.keys(body).length === 0) return null;
  return {
    body: str(body.body) ?? str(body.value) ?? (body.html_body ? undefined : ""),
    html_body: str(body.html_body),
    public: bool(body.public),
    author_id: num(body.author_id),
    uploads: list(body.uploads).map(String),
    created_at: body.created_at !== undefined ? toIso(body.created_at) : undefined,
  };
}

function parseCustomFields(raw: unknown): CustomFieldValue[] | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    return raw
      .map(obj)
      .filter((field) => num(field.id) !== undefined)
      .map((field) => ({ id: num(field.id)!, value: field.value ?? null }));
  }
  const record = obj(raw);
  return Object.entries(record)
    .filter(([key]) => /^\d+$/.test(key))
    .map(([key, value]) => ({ id: Number(key), value: value ?? null }));
}

export function parseTicketInput(raw: unknown): TicketInput {
  const body = obj(raw);
  const input: TicketInput = {};
  if (body.id !== undefined) input.id = num(body.id);
  if (body.subject !== undefined) input.subject = str(body.subject) ?? "";
  if (body.raw_subject !== undefined && input.subject === undefined) input.subject = str(body.raw_subject) ?? "";
  if (body.description !== undefined) input.description = str(body.description) ?? "";
  if (body.comment !== undefined) input.comment = parseCommentInput(body.comment);
  if (body.requester_id !== undefined) input.requester_id = num(body.requester_id);
  if (body.requester !== undefined) {
    const requester = obj(body.requester);
    input.requester = body.requester
      ? { name: strOrNull(requester.name), email: strOrNull(requester.email), locale: strOrNull(requester.locale) }
      : null;
    if (typeof body.requester === "string") input.requester = { email: body.requester, name: null, locale: null };
  }
  if (body.submitter_id !== undefined) input.submitter_id = num(body.submitter_id);
  if (body.assignee_id !== undefined)
    input.assignee_id = body.assignee_id === null ? null : (num(body.assignee_id) ?? null);
  if (body.assignee_email !== undefined) input.assignee_email = str(body.assignee_email);
  if (body.group_id !== undefined) input.group_id = body.group_id === null ? null : (num(body.group_id) ?? null);
  if (body.organization_id !== undefined)
    input.organization_id = body.organization_id === null ? null : (num(body.organization_id) ?? null);
  if (body.priority !== undefined)
    input.priority = body.priority === null ? null : (str(body.priority)?.toLowerCase() as TicketPriority);
  if (body.type !== undefined) input.type = body.type === null ? null : (str(body.type)?.toLowerCase() as TicketType);
  if (body.status !== undefined) input.status = str(body.status)?.toLowerCase() as TicketStatus;
  if (body.custom_status_id !== undefined) input.custom_status_id = num(body.custom_status_id);
  if (body.tags !== undefined) input.tags = normalizeTags(body.tags);
  if (body.additional_tags !== undefined) input.additional_tags = normalizeTags(body.additional_tags);
  if (body.remove_tags !== undefined) input.remove_tags = normalizeTags(body.remove_tags);
  const customFields = parseCustomFields(body.custom_fields) ?? parseCustomFields(body.fields);
  if (customFields) input.custom_fields = customFields;
  if (body.external_id !== undefined) input.external_id = strOrNull(body.external_id);
  if (body.due_at !== undefined) input.due_at = toIso(body.due_at);
  if (body.collaborator_ids !== undefined)
    input.collaborator_ids = list(body.collaborator_ids).map(Number).filter(Number.isFinite);
  if (body.additional_collaborators !== undefined) {
    input.additional_collaborators = list(body.additional_collaborators)
      .map((item) => (typeof item === "object" ? num(obj(item).id) : num(item)))
      .filter((item): item is number => item !== undefined);
  }
  if (body.email_ccs !== undefined) {
    input.email_ccs = list(body.email_ccs).map((item) => {
      const cc = obj(item);
      return {
        user_id: num(cc.user_id),
        user_email: str(cc.user_email),
        user_name: str(cc.user_name),
        action: str(cc.action),
      };
    });
  }
  if (body.follower_ids !== undefined) input.follower_ids = list(body.follower_ids).map(Number).filter(Number.isFinite);
  if (body.problem_id !== undefined)
    input.problem_id = body.problem_id === null ? null : (num(body.problem_id) ?? null);
  if (body.brand_id !== undefined) input.brand_id = num(body.brand_id);
  if (body.ticket_form_id !== undefined) input.ticket_form_id = num(body.ticket_form_id);
  if (body.recipient !== undefined) input.recipient = strOrNull(body.recipient);
  if (body.created_at !== undefined) input.created_at = toIso(body.created_at);
  if (body.updated_at !== undefined) input.updated_at = toIso(body.updated_at);
  if (body.solved_at !== undefined) input.solved_at = toIso(body.solved_at);
  if (body.comments !== undefined) {
    input.comments = list(body.comments)
      .map(parseCommentInput)
      .filter((comment): comment is CommentInput => comment !== null);
  }
  if (body.macro_ids !== undefined) input.macro_ids = list(body.macro_ids).map(Number).filter(Number.isFinite);
  const via = obj(body.via);
  if (via.channel) {
    input.via = {
      channel: String(via.channel) as Via["channel"],
      source: { from: obj(obj(via.source).from), to: obj(obj(via.source).to), rel: null },
    };
  }
  return input;
}

function minutesBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
}

export function fillCustomFields(
  zs: ZendeskStore,
  existing: CustomFieldValue[],
  incoming: CustomFieldValue[] | undefined,
): CustomFieldValue[] {
  const definitions = zs.ticketFields.all().filter((field) => field.active && isCustomFieldType(field.type));
  const byId = new Map(existing.map((field) => [field.id, field.value]));
  for (const field of incoming ?? []) {
    const definition = definitions.find((candidate) => candidate.zd_id === field.id);
    if (!definition) throw recordInvalid({ custom_fields: `Custom field ${field.id} does not exist` });
    let value = field.value;
    if (value === "" || value === undefined) value = null;
    if (definition.type === "tagger" && value !== null) {
      const option = definition.custom_field_options.find((candidate) => candidate.value === String(value));
      if (!option)
        throw recordInvalid({
          [`custom_field_${field.id}`]: `${definition.title}: ${String(value)} is not a valid option`,
        });
      value = option.value;
    }
    if (definition.type === "multiselect" && value !== null) {
      const values = Array.isArray(value)
        ? value.map(String)
        : String(value)
            .split(",")
            .map((item) => item.trim());
      for (const item of values) {
        if (!definition.custom_field_options.some((candidate) => candidate.value === item)) {
          throw recordInvalid({ [`custom_field_${field.id}`]: `${definition.title}: ${item} is not a valid option` });
        }
      }
      value = values;
    }
    if (definition.type === "checkbox" && value !== null) value = value === true || value === "true";
    if ((definition.type === "integer" || definition.type === "decimal") && value !== null) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed))
        throw recordInvalid({ [`custom_field_${field.id}`]: `${definition.title}: must be a number` });
      value = definition.type === "integer" ? String(Math.trunc(parsed)) : String(parsed);
    }
    if (definition.type === "regexp" && value !== null && definition.regexp_for_validation) {
      if (!new RegExp(definition.regexp_for_validation).test(String(value))) {
        throw recordInvalid({ [`custom_field_${field.id}`]: `${definition.title}: is invalid` });
      }
    }
    byId.set(field.id, value);
  }
  return definitions.map((definition) => ({ id: definition.zd_id, value: byId.get(definition.zd_id) ?? null }));
}

export function isCustomFieldType(type: string): boolean {
  return !["subject", "description", "status", "tickettype", "priority", "group", "assignee", "custom_status"].includes(
    type,
  );
}

function tagsFromCustomFields(zs: ZendeskStore, fields: CustomFieldValue[], tags: string[]): string[] {
  let result = [...tags];
  for (const field of fields) {
    const definition = zs.ticketFields.findOneBy("zd_id", field.id);
    if (!definition) continue;
    if (definition.type === "tagger" || definition.type === "multiselect") {
      const optionTags = definition.custom_field_options.map((option) => option.value);
      result = result.filter((tag) => !optionTags.includes(tag));
      const values = Array.isArray(field.value)
        ? field.value.map(String)
        : field.value !== null
          ? [String(field.value)]
          : [];
      result.push(...values);
    }
    if (definition.type === "checkbox" && definition.tag) {
      result = result.filter((tag) => tag !== definition.tag);
      if (field.value === true) result.push(definition.tag);
    }
  }
  return [...new Set(result)];
}

function defaultCustomStatus(zs: ZendeskStore, status: TicketStatus): number {
  const category = status === "closed" ? "solved" : status === "deleted" ? "solved" : status;
  return (
    zs.customStatuses.all().find((candidate) => candidate.status_category === category && candidate.default)?.zd_id ?? 0
  );
}

function isAgent(user: ZendeskUser | undefined): boolean {
  return !!user && (user.role === "agent" || user.role === "admin");
}

export interface TicketChangeOptions {
  via?: Via;
  runTriggers?: boolean;
  isImport?: boolean;
  emitEvents?: boolean;
}

function resolveAssignee(zs: ZendeskStore, input: TicketInput): number | null | undefined {
  if (input.assignee_email) {
    const assignee = findUserByEmail(zs, input.assignee_email);
    if (!assignee || !isAgent(assignee)) throw recordInvalid({ assignee: "Assignee: is not an agent" });
    return assignee.zd_id;
  }
  if (input.assignee_id === undefined) return undefined;
  if (input.assignee_id === null) return null;
  const assignee = zs.users.findOneBy("zd_id", input.assignee_id);
  if (!assignee || assignee.deleted || !isAgent(assignee))
    throw recordInvalid({ assignee: "Assignee: Invalid assignee" });
  return assignee.zd_id;
}

function resolveGroup(zs: ZendeskStore, groupId: number | null | undefined): number | null | undefined {
  if (groupId === undefined) return undefined;
  if (groupId === null) return null;
  const group = zs.groups.findOneBy("zd_id", groupId);
  if (!group || group.deleted) throw recordInvalid({ group: "Group: Invalid group" });
  return group.zd_id;
}

function resolveOrganization(zs: ZendeskStore, organizationId: number | null | undefined): number | null | undefined {
  if (organizationId === undefined) return undefined;
  if (organizationId === null) return null;
  const organization = zs.organizations.findOneBy("zd_id", organizationId);
  if (!organization || organization.deleted)
    throw recordInvalid({ organization: "Organization: Invalid organization" });
  return organization.zd_id;
}

function validateEnums(input: TicketInput, isImport: boolean): void {
  if (input.status !== undefined && !STATUSES.has(input.status))
    throw recordInvalid({ status: `Status: ${input.status} is not a valid status` });
  if (input.status === "closed" && !isImport) throw recordInvalid({ status: "Status: closed prevents ticket update" });
  if (input.priority !== undefined && input.priority !== null && !PRIORITIES.has(input.priority)) {
    throw recordInvalid({ priority: `Priority: ${input.priority} is not a valid priority` });
  }
  if (input.type !== undefined && input.type !== null && !TYPES.has(input.type)) {
    throw recordInvalid({ type: `Type: ${input.type} is not a valid type` });
  }
}

async function resolveEmailCcs(ctx: ZendeskCtx, current: number[], input: TicketInput): Promise<number[]> {
  if (input.email_ccs === undefined) return current;
  let result = [...current];
  for (const cc of input.email_ccs) {
    let userId = cc.user_id;
    if (userId === undefined && cc.user_email) {
      userId = (await ensureEndUser(ctx, { email: cc.user_email, name: cc.user_name ?? null })).zd_id;
    }
    if (userId === undefined) continue;
    if (cc.action === "delete") result = result.filter((id) => id !== userId);
    else if (!result.includes(userId)) result.push(userId);
  }
  return result;
}

function newMetrics(createdAt: string, assigneeId: number | null, groupId: number | null): TicketMetrics {
  return {
    assigned_at: assigneeId !== null ? createdAt : null,
    initially_assigned_at: assigneeId !== null ? createdAt : null,
    solved_at: null,
    status_updated_at: createdAt,
    requester_updated_at: createdAt,
    assignee_updated_at: assigneeId !== null ? createdAt : null,
    latest_comment_added_at: null,
    reopens: 0,
    replies: 0,
    group_stations: groupId !== null ? 1 : 0,
    assignee_stations: assigneeId !== null ? 1 : 0,
    first_reply_minutes: null,
    full_resolution_minutes: null,
  };
}

function insertComment(
  zs: ZendeskStore,
  ticketId: number,
  auditId: number,
  authorId: number,
  input: CommentInput,
  via: Via,
): ZendeskComment {
  const body = input.body ?? (input.html_body ? input.html_body.replace(/<[^>]+>/g, "") : "");
  const attachments = (input.uploads ?? [])
    .map((token) => zs.attachments.findOneBy("token", token))
    .filter((attachment): attachment is NonNullable<typeof attachment> => !!attachment);
  const comment = zs.comments.insert({
    zd_id: nextId(zs, "events"),
    ticket_id: ticketId,
    audit_id: auditId,
    author_id: authorId,
    body,
    html_body:
      input.html_body ??
      `<div class="zd-comment" dir="auto"><p dir="auto">${escapeHtml(body).replace(/\n/g, "<br>")}</p></div>`,
    public: input.public ?? true,
    attachment_ids: attachments.map((attachment) => attachment.zd_id),
    via: input.via ?? via,
    redacted: false,
  });
  for (const attachment of attachments)
    zs.attachments.update(attachment.id, { comment_id: comment.zd_id, token: null });
  return comment;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function ticketDetail(ctx: ZendeskCtx, ticket: ZendeskTicket, actorId: number): Record<string, unknown> {
  const formatted = formatTicket({ zs: ctx.zs, baseUrl: ctx.baseUrl }, ticket);
  return {
    actor_id: actorId,
    assignee_id: formatted.assignee_id,
    brand_id: formatted.brand_id,
    created_at: formatted.created_at,
    custom_status: formatted.custom_status_id,
    description: formatted.description,
    external_id: formatted.external_id,
    form_id: formatted.ticket_form_id,
    group_id: formatted.group_id,
    id: formatted.id,
    is_public: formatted.is_public,
    organization_id: formatted.organization_id,
    priority: formatted.priority,
    requester_id: formatted.requester_id,
    status: formatted.status,
    subject: formatted.subject,
    submitter_id: formatted.submitter_id,
    tags: formatted.tags,
    type: formatted.type,
    updated_at: formatted.updated_at,
    via: formatted.via,
  };
}

export async function createTicket(
  ctx: ZendeskCtx,
  input: TicketInput,
  actor: ZendeskUser,
  options: TicketChangeOptions = {},
): Promise<{ ticket: ZendeskTicket; audit: ZendeskAudit }> {
  const { zs } = ctx;
  const isImport = options.isImport ?? false;
  validateEnums(input, isImport);
  const comment = input.comment ?? (input.description !== undefined ? { body: input.description, public: true } : null);
  if (!comment && !(isImport && (input.comments?.length ?? 0) > 0)) {
    throw recordInvalid({ base: "Description: cannot be blank" });
  }

  let requester: ZendeskUser | undefined;
  if (input.requester_id !== undefined) {
    requester = zs.users.findOneBy("zd_id", input.requester_id);
    if (!requester || requester.deleted) throw recordInvalid({ requester: "Requester: Invalid requester" });
  } else if (input.requester) {
    requester = input.requester.email
      ? await ensureEndUser(ctx, input.requester, { emit: options.emitEvents !== false })
      : zs.users.all().find((user) => !user.deleted && user.name === input.requester?.name);
    if (!requester) throw recordInvalid({ requester: "Requester: Invalid requester" });
  } else {
    requester = actor;
  }

  const assigneeId = resolveAssignee(zs, input) ?? null;
  let groupId = resolveGroup(zs, input.group_id) ?? null;
  if (groupId === null && assigneeId !== null) {
    const assignee = zs.users.findOneBy("zd_id", assigneeId);
    groupId = assignee?.default_group_id ?? null;
  }
  const organizationId = resolveOrganization(zs, input.organization_id) ?? requester.organization_id;
  const status: TicketStatus = input.status ?? (assigneeId !== null ? "open" : "new");
  const createdAt = (isImport ? input.created_at : null) ?? nowIso();
  const via = input.via ?? options.via ?? (isAgent(actor) ? API_VIA : WEB_VIA);
  const customFields = fillCustomFields(zs, [], input.custom_fields);
  const tags = tagsFromCustomFields(zs, customFields, [...(input.tags ?? []), ...(input.additional_tags ?? [])]);
  const emailCcs = await resolveEmailCcs(ctx, [], input);
  const collaborators = [
    ...new Set([...(input.collaborator_ids ?? []), ...(input.additional_collaborators ?? []), ...emailCcs]),
  ];
  const brand = zs.brands.all().find((candidate) => candidate.default) ?? zs.brands.all()[0];
  const form = zs.ticketForms.all().find((candidate) => candidate.default) ?? zs.ticketForms.all()[0];
  const subject = input.subject ?? (comment?.body ?? input.comments?.[0]?.body ?? "").split("\n")[0].slice(0, 150);
  const id = input.id ?? nextId(zs, "tickets");
  if (input.id !== undefined) {
    if (zs.tickets.findOneBy("zd_id", id)) throw recordInvalid({ id: "Id: has already been taken" });
    reserveId(zs, "tickets", id);
  }
  if (input.problem_id !== undefined && input.problem_id !== null) {
    const problem = zs.tickets.findOneBy("zd_id", input.problem_id);
    if (!problem || problem.type !== "problem") throw recordInvalid({ problem_id: "Problem: Invalid problem ticket" });
  }

  const metrics = newMetrics(createdAt, assigneeId, groupId);
  const ticket = zs.tickets.insert({
    zd_id: id,
    subject,
    raw_subject: subject,
    description: comment?.body ?? input.comments?.[0]?.body ?? "",
    status,
    custom_status_id: input.custom_status_id ?? defaultCustomStatus(zs, status),
    priority: input.priority ?? null,
    type: input.type ?? null,
    requester_id: requester.zd_id,
    submitter_id: input.submitter_id ?? actor.zd_id,
    assignee_id: assigneeId,
    group_id: groupId,
    organization_id: organizationId,
    brand_id: input.brand_id ?? brand?.zd_id ?? 1,
    ticket_form_id: input.ticket_form_id ?? form?.zd_id ?? 1,
    external_id: input.external_id ?? null,
    recipient: input.recipient ?? null,
    collaborator_ids: collaborators,
    email_cc_ids: emailCcs,
    follower_ids: input.follower_ids ?? [],
    problem_id: input.problem_id ?? null,
    due_at: input.type === "task" ? (input.due_at ?? null) : (input.due_at ?? null),
    tags,
    custom_fields: customFields,
    via,
    is_public: comment ? (comment.public ?? true) : true,
    satisfaction_rating_id: null,
    followup_ids: [],
    metrics,
    deleted: false,
    deleted_at: null,
    spam: false,
    generated_timestamp: Math.floor(Date.parse(createdAt) / 1000),
    created_at_override: isImport ? (input.created_at ?? null) : null,
    updated_at_override: isImport ? (input.updated_at ?? input.created_at ?? null) : null,
  });

  const audit = zs.audits.insert({
    zd_id: nextId(zs, "audits"),
    ticket_id: ticket.zd_id,
    author_id: actor.zd_id,
    events: [],
    via,
    metadata: {},
  });
  const events: AuditEvent[] = [];
  const commentInputs =
    isImport && input.comments && input.comments.length > 0 ? input.comments : comment ? [comment] : [];
  let firstReply: string | null = null;
  let replies = 0;
  for (const [index, item] of commentInputs.entries()) {
    const authorId = item.author_id ?? (comment === item ? actor.zd_id : requester.zd_id);
    const created = insertComment(zs, ticket.zd_id, audit.zd_id, authorId, item, via);
    if (item.created_at) zs.comments.update(created.id, { created_at: item.created_at } as Partial<ZendeskComment>);
    events.push({ id: created.zd_id, type: "Comment" });
    const author = zs.users.findOneBy("zd_id", authorId);
    if (index > 0 && created.public && isAgent(author) && authorId !== requester.zd_id) {
      replies++;
      firstReply ??= item.created_at ?? created.created_at;
    }
  }
  const createEvent = (field: string, value: unknown) => {
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return;
    events.push({ id: nextId(zs, "events"), type: "Create", field_name: field, value });
  };
  createEvent("subject", ticket.subject);
  createEvent("status", ticket.status);
  createEvent("priority", ticket.priority);
  createEvent("type", ticket.type);
  createEvent("requester_id", ticket.requester_id);
  createEvent("assignee_id", ticket.assignee_id);
  createEvent("group_id", ticket.group_id);
  createEvent("organization_id", ticket.organization_id);
  createEvent("tags", ticket.tags);
  for (const field of ticket.custom_fields) if (field.value !== null) createEvent(String(field.id), field.value);
  zs.audits.update(audit.id, { events });

  const solvedAt = status === "solved" || status === "closed" ? (input.solved_at ?? createdAt) : null;
  const finalTicket = zs.tickets.update(ticket.id, {
    metrics: {
      ...metrics,
      replies,
      first_reply_minutes: firstReply ? minutesBetween(createdAt, firstReply) : null,
      latest_comment_added_at: commentInputs.length > 0 ? createdAt : null,
      solved_at: solvedAt,
      full_resolution_minutes: solvedAt ? minutesBetween(createdAt, solvedAt) : null,
    },
  })!;
  if (isImport) {
    zs.tickets.update(finalTicket.id, {
      created_at: createdAt,
      updated_at: input.updated_at ?? createdAt,
    } as Partial<ZendeskTicket>);
  }
  const stored = zs.tickets.get(finalTicket.id)!;

  if (options.emitEvents !== false && !isImport) {
    await emitZendeskEvent(
      ctx,
      "zen:event-type:ticket.created",
      `zen:ticket:${stored.zd_id}`,
      ticketDetail(ctx, stored, actor.zd_id),
    );
  }
  if ((options.runTriggers ?? true) && !isImport) {
    const firstComment = commentInputs.length > 0 ? (zs.comments.findBy("ticket_id", stored.zd_id)[0] ?? null) : null;
    await runTriggers(ctx, {
      zs,
      ticket: stored,
      previous: null,
      updateType: "Create",
      currentUser: actor,
      comment: firstComment,
    });
  }
  return { ticket: zs.tickets.get(stored.id)!, audit: zs.audits.get(audit.id)! };
}

interface ChangeRecord {
  field: string;
  value: unknown;
  previous: unknown;
  eventType: string;
}

export async function updateTicket(
  ctx: ZendeskCtx,
  ticket: ZendeskTicket,
  input: TicketInput,
  actor: ZendeskUser,
  options: TicketChangeOptions = {},
): Promise<{ ticket: ZendeskTicket; audit: ZendeskAudit | null }> {
  const { zs } = ctx;
  const isImport = options.isImport ?? false;
  validateEnums(input, isImport);
  if (ticket.status === "closed" && !isImport) {
    const onlyTags = Object.keys(input).every((key) =>
      ["tags", "additional_tags", "remove_tags", "custom_fields"].includes(key),
    );
    if (!onlyTags) throw recordInvalid({ status: "Status: closed prevents ticket update" });
  }
  const now = nowIso();
  const via = input.via ?? options.via ?? (isAgent(actor) ? API_VIA : WEB_VIA);
  const changes: ChangeRecord[] = [];
  const updates: Partial<ZendeskTicket> = {};
  const metrics = { ...ticket.metrics };

  const record = (field: keyof ZendeskTicket & string, value: unknown, eventType: string) => {
    if (JSON.stringify(value) === JSON.stringify(ticket[field])) return;
    (updates as Record<string, unknown>)[field] = value;
    changes.push({ field, value, previous: ticket[field], eventType });
  };

  if (input.subject !== undefined) {
    record("subject", input.subject, "ticket.subject_changed");
    updates.raw_subject = input.subject;
  }
  if (input.priority !== undefined) record("priority", input.priority, "ticket.priority_changed");
  if (input.type !== undefined) record("type", input.type, "ticket.type_changed");
  if (input.external_id !== undefined) record("external_id", input.external_id, "ticket.external_id_changed");
  if (input.due_at !== undefined) record("due_at", input.due_at, "ticket.due_date_changed");
  if (input.recipient !== undefined) record("recipient", input.recipient, "ticket.recipient_changed");
  if (input.brand_id !== undefined) record("brand_id", input.brand_id, "ticket.brand_changed");
  if (input.ticket_form_id !== undefined) record("ticket_form_id", input.ticket_form_id, "ticket.form_changed");
  if (input.problem_id !== undefined) record("problem_id", input.problem_id, "ticket.problem_link_changed");
  if (input.follower_ids !== undefined) record("follower_ids", input.follower_ids, "ticket.follower_added");

  if (input.requester_id !== undefined || input.requester) {
    let requester: ZendeskUser | undefined;
    if (input.requester_id !== undefined) requester = zs.users.findOneBy("zd_id", input.requester_id);
    else if (input.requester?.email)
      requester = await ensureEndUser(ctx, input.requester, { emit: options.emitEvents !== false });
    if (!requester || requester.deleted) throw recordInvalid({ requester: "Requester: Invalid requester" });
    record("requester_id", requester.zd_id, "ticket.requester_changed");
    if (input.organization_id === undefined && requester.organization_id !== ticket.organization_id) {
      record("organization_id", requester.organization_id, "ticket.organization_changed");
    }
    metrics.requester_updated_at = now;
  }
  const assigneeId = resolveAssignee(zs, input);
  if (assigneeId !== undefined) {
    record("assignee_id", assigneeId, "ticket.agent_assignment_changed");
    if (assigneeId !== ticket.assignee_id) {
      metrics.assignee_updated_at = now;
      if (assigneeId !== null) {
        metrics.assigned_at = now;
        metrics.initially_assigned_at ??= now;
        metrics.assignee_stations += 1;
        if (input.group_id === undefined && ticket.group_id === null) {
          const assignee = zs.users.findOneBy("zd_id", assigneeId);
          if (assignee?.default_group_id)
            record("group_id", assignee.default_group_id, "ticket.group_assignment_changed");
        }
      }
    }
  }
  const groupId = resolveGroup(zs, input.group_id);
  if (groupId !== undefined) {
    record("group_id", groupId, "ticket.group_assignment_changed");
    if (groupId !== ticket.group_id && groupId !== null) metrics.group_stations += 1;
  }
  const organizationId = resolveOrganization(zs, input.organization_id);
  if (organizationId !== undefined) record("organization_id", organizationId, "ticket.organization_changed");

  let tags = ticket.tags;
  if (input.tags !== undefined) tags = input.tags;
  if (input.additional_tags) tags = [...new Set([...tags, ...input.additional_tags])];
  if (input.remove_tags) tags = tags.filter((tag) => !input.remove_tags!.includes(tag));
  if (input.custom_fields !== undefined) {
    const merged = fillCustomFields(zs, ticket.custom_fields, input.custom_fields);
    if (JSON.stringify(merged) !== JSON.stringify(ticket.custom_fields)) {
      updates.custom_fields = merged;
      for (const field of merged) {
        const previous = ticket.custom_fields.find((candidate) => candidate.id === field.id)?.value ?? null;
        if (JSON.stringify(previous) !== JSON.stringify(field.value)) {
          changes.push({
            field: String(field.id),
            value: field.value,
            previous,
            eventType: "ticket.custom_field_changed",
          });
        }
      }
    }
    tags = tagsFromCustomFields(zs, merged, tags);
  }
  if (JSON.stringify(tags) !== JSON.stringify(ticket.tags)) record("tags", tags, "ticket.tags_changed");

  const emailCcs = await resolveEmailCcs(ctx, ticket.email_cc_ids, input);
  if (JSON.stringify(emailCcs) !== JSON.stringify(ticket.email_cc_ids)) {
    updates.email_cc_ids = emailCcs;
    updates.collaborator_ids = [...new Set([...ticket.collaborator_ids, ...emailCcs])];
  }
  if (input.collaborator_ids !== undefined)
    updates.collaborator_ids = [...new Set([...input.collaborator_ids, ...emailCcs])];
  if (input.additional_collaborators) {
    updates.collaborator_ids = [
      ...new Set([...(updates.collaborator_ids ?? ticket.collaborator_ids), ...input.additional_collaborators]),
    ];
  }

  let pendingComment: CommentInput | null = null;
  let status = input.status;
  const requesterId = updates.requester_id ?? ticket.requester_id;
  if (
    input.comment &&
    (input.comment.body !== undefined ||
      input.comment.html_body !== undefined ||
      (input.comment.uploads?.length ?? 0) > 0)
  ) {
    const authorId = input.comment.author_id ?? actor.zd_id;
    const author = zs.users.findOneBy("zd_id", authorId);
    if (status === undefined && !isImport) {
      if (!isAgent(author) && (ticket.status === "solved" || ticket.status === "pending")) status = "open";
      if (isAgent(author) && ticket.status === "new") status = "open";
    }
    if (author && !isAgent(author) && input.comment.public === false) input.comment.public = true;
    metrics.latest_comment_added_at = now;
    if ((input.comment.public ?? true) && isAgent(author) && authorId !== requesterId) {
      metrics.replies += 1;
      metrics.first_reply_minutes ??= minutesBetween(ticketCreatedAt(ticket), now);
    }
    pendingComment = { ...input.comment, author_id: authorId };
  }
  if (status !== undefined && status !== ticket.status) {
    record("status", status, "ticket.status_changed");
    metrics.status_updated_at = now;
    if (status === "solved" || status === "closed") {
      metrics.solved_at = input.solved_at ?? now;
      metrics.full_resolution_minutes = minutesBetween(ticketCreatedAt(ticket), metrics.solved_at);
    } else if (ticket.status === "solved" || ticket.status === "closed") {
      metrics.reopens += 1;
      metrics.solved_at = null;
      metrics.full_resolution_minutes = null;
    }
    updates.custom_status_id = input.custom_status_id ?? defaultCustomStatus(zs, status);
  } else if (input.custom_status_id !== undefined) {
    record("custom_status_id", input.custom_status_id, "ticket.custom_status_changed");
  }

  if (changes.length === 0 && !pendingComment) {
    return { ticket, audit: null };
  }

  updates.metrics = metrics;
  if (isImport && input.updated_at) updates.updated_at_override = input.updated_at;
  else updates.updated_at_override = null;
  const updated = zs.tickets.update(ticket.id, updates)!;

  const audit = zs.audits.insert({
    zd_id: nextId(zs, "audits"),
    ticket_id: updated.zd_id,
    author_id: actor.zd_id,
    events: [],
    via,
    metadata: {},
  });
  const events: AuditEvent[] = [];
  let storedComment: ZendeskComment | null = null;
  if (pendingComment) {
    storedComment = insertComment(
      zs,
      updated.zd_id,
      audit.zd_id,
      pendingComment.author_id ?? actor.zd_id,
      pendingComment,
      via,
    );
    events.push({ id: storedComment.zd_id, type: "Comment" });
    if (updated.is_public === false && storedComment.public) zs.tickets.update(updated.id, { is_public: true });
  }
  for (const change of changes) {
    events.push({
      id: nextId(zs, "events"),
      type: "Change",
      field_name: change.field,
      value: change.value,
      previous_value: change.previous,
    });
  }
  zs.audits.update(audit.id, { events });
  const stored = zs.tickets.get(updated.id)!;

  if (options.emitEvents !== false && !isImport) {
    const detail = ticketDetail(ctx, stored, actor.zd_id);
    if (storedComment) {
      await emitZendeskEvent(ctx, "zen:event-type:ticket.comment_added", `zen:ticket:${stored.zd_id}`, detail, {
        comment: formatComment({ zs, baseUrl: ctx.baseUrl }, storedComment),
      });
    }
    for (const change of changes) {
      await emitZendeskEvent(ctx, `zen:event-type:${change.eventType}`, `zen:ticket:${stored.zd_id}`, detail, {
        current: change.value,
        previous: change.previous,
        ...(change.eventType === "ticket.custom_field_changed" ? { field_id: Number(change.field) } : {}),
      });
    }
  }
  if ((options.runTriggers ?? true) && !isImport) {
    await runTriggers(ctx, {
      zs,
      ticket: stored,
      previous: ticket,
      updateType: "Change",
      currentUser: actor,
      comment: storedComment,
    });
  }
  return { ticket: zs.tickets.get(stored.id)!, audit: zs.audits.get(audit.id)! };
}

export async function deleteTicket(
  ctx: ZendeskCtx,
  ticket: ZendeskTicket,
  actor: ZendeskUser,
  emit = true,
): Promise<ZendeskTicket> {
  const { zs } = ctx;
  const deleted = zs.tickets.update(ticket.id, { deleted: true, deleted_at: nowIso(), status: "deleted" })!;
  if (emit) {
    await emitZendeskEvent(
      ctx,
      "zen:event-type:ticket.soft_deleted",
      `zen:ticket:${deleted.zd_id}`,
      ticketDetail(ctx, deleted, actor.zd_id),
    );
  }
  return deleted;
}

export function restoreTicket(zs: ZendeskStore, ticket: ZendeskTicket): ZendeskTicket {
  const lastStatus = [...zs.audits.findBy("ticket_id", ticket.zd_id)]
    .reverse()
    .flatMap((audit) => audit.events)
    .find((event) => (event.type === "Change" || event.type === "Create") && event.field_name === "status");
  const status = (lastStatus?.value as TicketStatus | undefined) ?? "open";
  return zs.tickets.update(ticket.id, {
    deleted: false,
    deleted_at: null,
    status: status === "deleted" ? "open" : status,
  })!;
}

export function permanentlyDeleteTicket(zs: ZendeskStore, ticket: ZendeskTicket): void {
  for (const comment of zs.comments.findBy("ticket_id", ticket.zd_id)) zs.comments.delete(comment.id);
  for (const audit of zs.audits.findBy("ticket_id", ticket.zd_id)) zs.audits.delete(audit.id);
  zs.tickets.delete(ticket.id);
}

export function patchToInput(patch: ActionPatch, ticket: ZendeskTicket): TicketInput {
  const input: TicketInput = {};
  if (patch.status !== undefined) input.status = patch.status;
  if (patch.priority !== undefined) input.priority = patch.priority;
  if (patch.type !== undefined) input.type = patch.type;
  if (patch.group_id !== undefined) input.group_id = patch.group_id;
  if (patch.assignee_id !== undefined) input.assignee_id = patch.assignee_id;
  if (patch.subject !== undefined) input.subject = patch.subject;
  if (patch.brand_id !== undefined) input.brand_id = patch.brand_id;
  if (patch.ticket_form_id !== undefined) input.ticket_form_id = patch.ticket_form_id;
  if (patch.custom_fields) input.custom_fields = patch.custom_fields;
  if (patch.set_tags) input.tags = patch.set_tags;
  if (patch.add_tags) input.additional_tags = patch.add_tags;
  if (patch.remove_tags) input.remove_tags = patch.remove_tags;
  if (patch.comment) input.comment = { body: patch.comment.body, public: patch.comment.public };
  void ticket;
  return input;
}

const RULE_VIA: Via = { channel: "rule", source: { from: {}, to: {}, rel: "trigger" } };

export async function runTriggers(ctx: ZendeskCtx, ruleCtx: RuleContext): Promise<void> {
  const { zs } = ctx;
  const triggers = zs.triggers
    .all()
    .filter((trigger) => trigger.active)
    .sort((a, b) => a.position - b.position || a.id - b.id);
  let current = ruleCtx.ticket;
  const systemActor: ZendeskUser =
    ruleCtx.currentUser ?? (zs.users.all().find((user) => user.role === "admin") as ZendeskUser);
  for (const trigger of triggers) {
    if (!evaluateConditions(trigger.conditions, { ...ruleCtx, ticket: current })) continue;
    const patch = applyActions(trigger.actions, ruleCtx.currentUser);
    for (const notification of patch.notifications) {
      const webhook =
        zs.webhooks.findOneBy("zd_id", notification.webhookId) ??
        zs.webhooks.all().find((candidate) => candidate.name === notification.webhookId);
      if (!webhook || webhook.status !== "active") continue;
      const body = renderPlaceholders(notification.body, {
        zs,
        baseUrl: ctx.baseUrl,
        ticket: current,
        currentUser: ruleCtx.currentUser,
        comment: ruleCtx.comment,
      });
      await invokeWebhook(ctx, webhook, body, { triggerId: trigger.zd_id });
    }
    const input = patchToInput(patch, current);
    if (Object.keys(input).length > 0) {
      const result = await updateTicket(ctx, current, input, systemActor, {
        via: {
          ...RULE_VIA,
          source: { from: { id: trigger.zd_id, title: trigger.title, deleted: false }, to: {}, rel: "trigger" },
        },
        runTriggers: false,
      });
      current = result.ticket;
    }
  }
}

export function macroResult(
  zs: ZendeskStore,
  macro: ZendeskMacro,
  ticket: ZendeskTicket | null,
  actor: ZendeskUser,
): Record<string, unknown> {
  const patch = applyActions(macro.actions, actor);
  const result: Record<string, unknown> = {};
  if (ticket) {
    result.id = ticket.zd_id;
    result.url = `${ticket.zd_id}`;
  }
  if (patch.status !== undefined) result.status = patch.status;
  if (patch.priority !== undefined) result.priority = patch.priority;
  if (patch.type !== undefined) result.type = patch.type;
  if (patch.group_id !== undefined) result.group_id = patch.group_id;
  if (patch.assignee_id !== undefined) result.assignee_id = patch.assignee_id;
  if (patch.subject !== undefined) result.subject = patch.subject;
  if (patch.custom_fields) {
    result.custom_fields = ticket
      ? fillCustomFields(zs, ticket.custom_fields, patch.custom_fields)
      : patch.custom_fields;
    result.fields = result.custom_fields;
  }
  let tags = ticket?.tags ?? [];
  if (patch.set_tags) tags = patch.set_tags;
  if (patch.add_tags) tags = [...new Set([...tags, ...patch.add_tags])];
  if (patch.remove_tags) tags = tags.filter((tag) => !patch.remove_tags!.includes(tag));
  if (patch.set_tags || patch.add_tags || patch.remove_tags) result.tags = tags;
  if (patch.comment) {
    result.comment = {
      body: ticket
        ? renderPlaceholders(patch.comment.body, { zs, baseUrl: "", ticket, currentUser: actor, comment: null })
        : patch.comment.body,
      public: patch.comment.public,
      scoped_body: [],
    };
  }
  return result;
}
