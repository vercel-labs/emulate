import type {
  CustomFieldValue,
  RuleAction,
  RuleCondition,
  RuleConditions,
  TicketPriority,
  TicketStatus,
  ZendeskComment,
  ZendeskTicket,
  ZendeskUser,
} from "./entities.js";
import { ticketCreatedAt, ticketUpdatedAt } from "./formatters.js";
import { normalizeTags } from "./helpers.js";
import { subdomain, type ZendeskStore } from "./store.js";

export interface RuleContext {
  zs: ZendeskStore;
  ticket: ZendeskTicket;
  previous: ZendeskTicket | null;
  updateType: "Create" | "Change";
  currentUser: ZendeskUser | null;
  comment: ZendeskComment | null;
}

const STATUS_ORDER: Record<string, number> = { new: 0, open: 1, pending: 2, hold: 3, solved: 4, closed: 5 };
const PRIORITY_ORDER: Record<string, number> = { low: 0, normal: 1, high: 2, urgent: 3 };
const VIA_IDS: Record<string, number> = { web: 0, email: 4, api: 5, rule: 8, system: 8, chat: 29, voice: 34 };

function customFieldValue(fields: CustomFieldValue[], id: number): unknown {
  return fields.find((field) => field.id === id)?.value ?? null;
}

function fieldValue(field: string, ticket: ZendeskTicket | null, ctx: RuleContext): unknown {
  if (!ticket) return undefined;
  const custom = field.match(/^custom_fields_(\d+)$/);
  if (custom) return customFieldValue(ticket.custom_fields, Number(custom[1]));
  switch (field) {
    case "status":
      return ticket.status;
    case "type":
    case "ticket_type":
      return ticket.type;
    case "priority":
      return ticket.priority;
    case "group_id":
      return ticket.group_id === null ? "" : String(ticket.group_id);
    case "assignee_id":
      return ticket.assignee_id === null ? "" : String(ticket.assignee_id);
    case "requester_id":
      return String(ticket.requester_id);
    case "submitter_id":
      return String(ticket.submitter_id);
    case "organization_id":
      return ticket.organization_id === null ? "" : String(ticket.organization_id);
    case "brand_id":
      return String(ticket.brand_id);
    case "ticket_form_id":
      return String(ticket.ticket_form_id);
    case "current_tags":
      return ticket.tags;
    case "subject":
      return ticket.subject;
    case "description":
      return ticket.description;
    case "comment_includes_word":
      return ctx.comment?.body ?? "";
    case "update_type":
      return ctx.updateType;
    case "comment_is_public":
      return ctx.comment ? String(ctx.comment.public) : "not_relevant";
    case "via_id":
    case "current_via_id":
      return String(VIA_IDS[ticket.via.channel] ?? 5);
    case "ticket_is_public":
      return ticket.is_public ? "public" : "private";
    case "recipient":
      return ticket.recipient ?? "";
    case "requester_role": {
      const requester = ctx.zs.users.findOneBy("zd_id", ticket.requester_id);
      return requester?.role ?? "end-user";
    }
    case "due_at":
    case "due_date":
      return ticket.due_at;
    case "satisfaction_score": {
      const rating = ticket.satisfaction_rating_id
        ? ctx.zs.satisfactionRatings.findOneBy("zd_id", ticket.satisfaction_rating_id)
        : undefined;
      return rating?.score ?? "unoffered";
    }
    default:
      return undefined;
  }
}

function resolveValue(field: string, value: unknown, ctx: RuleContext): string {
  const text = value === null || value === undefined ? "" : String(value);
  if ((field === "assignee_id" || field === "requester_id") && text === "current_user") {
    return ctx.currentUser ? String(ctx.currentUser.zd_id) : "";
  }
  if (field === "group_id" && text === "current_groups") return "";
  return text;
}

function ordinal(field: string, value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).toLowerCase();
  if (field === "status") return STATUS_ORDER[text] ?? null;
  if (field === "priority") return PRIORITY_ORDER[text] ?? null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function equals(actual: unknown, expected: string): boolean {
  if (Array.isArray(actual)) return actual.map(String).includes(expected);
  if (actual === null || actual === undefined) return expected === "";
  return String(actual).toLowerCase() === expected.toLowerCase();
}

function includes(actual: unknown, expected: string): boolean {
  const words = expected.split(/\s+/).filter(Boolean);
  if (Array.isArray(actual)) {
    const tags = actual.map(String);
    return words.some((word) => tags.includes(word.toLowerCase()));
  }
  const text = String(actual ?? "").toLowerCase();
  return words.some((word) => text.includes(word.toLowerCase()));
}

function present(actual: unknown): boolean {
  if (Array.isArray(actual)) return actual.length > 0;
  return actual !== null && actual !== undefined && actual !== "";
}

export function evaluateCondition(condition: RuleCondition, ctx: RuleContext): boolean {
  const field = condition.field;
  const expected = resolveValue(field, condition.value, ctx);
  const current = fieldValue(field, ctx.ticket, ctx);
  const previous = fieldValue(field, ctx.previous, ctx);
  const changed = ctx.previous !== null && JSON.stringify(current) !== JSON.stringify(previous);
  switch (condition.operator) {
    case "is":
    case "value":
      return equals(current, expected);
    case "is_not":
    case "not_value":
      return !equals(current, expected);
    case "less_than": {
      const a = ordinal(field, current);
      const b = ordinal(field, expected);
      return a !== null && b !== null && a < b;
    }
    case "greater_than": {
      const a = ordinal(field, current);
      const b = ordinal(field, expected);
      return a !== null && b !== null && a > b;
    }
    case "includes":
      return includes(current, expected);
    case "not_includes":
      return !includes(current, expected);
    case "present":
      return present(current);
    case "not_present":
      return !present(current);
    case "changed":
      return changed || (ctx.previous === null && present(current));
    case "not_changed":
      return !changed;
    case "changed_to":
      return (changed || ctx.previous === null) && equals(current, expected);
    case "not_changed_to":
      return !((changed || ctx.previous === null) && equals(current, expected));
    case "changed_from":
      return changed && equals(previous, expected);
    case "not_changed_from":
      return !(changed && equals(previous, expected));
    case "value_previous":
      return equals(previous, expected);
    case "not_value_previous":
      return !equals(previous, expected);
    case "within_previous_n_days":
    case "within_next_n_days": {
      if (typeof current !== "string") return false;
      const days = Number(expected);
      const diff = (Date.parse(current) - Date.now()) / 86400000;
      return condition.operator === "within_next_n_days" ? diff >= 0 && diff <= days : diff <= 0 && -diff <= days;
    }
    default:
      return false;
  }
}

export function evaluateConditions(conditions: RuleConditions, ctx: RuleContext): boolean {
  const all = conditions.all ?? [];
  const any = conditions.any ?? [];
  if (!all.every((condition) => evaluateCondition(condition, ctx))) return false;
  if (any.length > 0 && !any.some((condition) => evaluateCondition(condition, ctx))) return false;
  return true;
}

export function parseConditions(value: unknown): RuleConditions {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const parse = (items: unknown): RuleCondition[] =>
    Array.isArray(items)
      ? items
          .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          .map((item) => ({
            field: String(item.field ?? ""),
            operator: String(item.operator ?? "is"),
            value: item.value ?? null,
          }))
      : [];
  return { all: parse(source.all), any: parse(source.any) };
}

export function parseActions(value: unknown): RuleAction[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => ({ field: String(item.field ?? ""), value: item.value ?? null }))
    : [];
}

export interface ActionPatch {
  status?: TicketStatus;
  priority?: TicketPriority | null;
  type?: ZendeskTicket["type"];
  group_id?: number | null;
  assignee_id?: number | null;
  subject?: string;
  set_tags?: string[];
  add_tags?: string[];
  remove_tags?: string[];
  custom_fields?: CustomFieldValue[];
  comment?: { body: string; public: boolean } | null;
  brand_id?: number;
  ticket_form_id?: number;
  notifications: Array<{ webhookId: string; body: string }>;
}

export function applyActions(actions: RuleAction[], currentUser: ZendeskUser | null): ActionPatch {
  const patch: ActionPatch = { notifications: [] };
  let commentBody: string | null = null;
  let commentPublic = true;
  for (const action of actions) {
    const value = action.value;
    const text = value === null || value === undefined ? "" : Array.isArray(value) ? "" : String(value);
    const custom = action.field.match(/^custom_fields_(\d+)$/);
    if (custom) {
      patch.custom_fields = [...(patch.custom_fields ?? []), { id: Number(custom[1]), value }];
      continue;
    }
    switch (action.field) {
      case "status":
        patch.status = text.toLowerCase() as TicketStatus;
        break;
      case "priority":
        patch.priority = text ? (text.toLowerCase() as TicketPriority) : null;
        break;
      case "type":
      case "ticket_type":
        patch.type = text ? (text.toLowerCase() as ZendeskTicket["type"]) : null;
        break;
      case "group_id":
        patch.group_id = text === "" ? null : Number(text);
        break;
      case "assignee_id":
        patch.assignee_id = text === "current_user" ? (currentUser?.zd_id ?? null) : text === "" ? null : Number(text);
        break;
      case "subject":
        patch.subject = text;
        break;
      case "set_tags":
        patch.set_tags = normalizeTags(value);
        break;
      case "current_tags":
        patch.add_tags = [...(patch.add_tags ?? []), ...normalizeTags(value)];
        break;
      case "remove_tags":
        patch.remove_tags = [...(patch.remove_tags ?? []), ...normalizeTags(value)];
        break;
      case "comment_value":
      case "comment_value_html":
        commentBody = text;
        break;
      case "comment_mode_is_public":
        commentPublic = text !== "false";
        break;
      case "brand_id":
        patch.brand_id = Number(text);
        break;
      case "ticket_form_id":
        patch.ticket_form_id = Number(text);
        break;
      case "notification_webhook": {
        if (Array.isArray(value) && value.length >= 1) {
          patch.notifications.push({ webhookId: String(value[0]), body: String(value[1] ?? "") });
        }
        break;
      }
      default:
        break;
    }
  }
  if (commentBody !== null) patch.comment = { body: commentBody, public: commentPublic };
  return patch;
}

export interface PlaceholderContext {
  zs: ZendeskStore;
  baseUrl: string;
  ticket: ZendeskTicket;
  currentUser: ZendeskUser | null;
  comment: ZendeskComment | null;
}

function userVars(
  prefix: string,
  user: ZendeskUser | undefined,
  ctx: PlaceholderContext,
  vars: Record<string, unknown>,
): void {
  vars[`${prefix}.id`] = user?.zd_id ?? "";
  vars[`${prefix}.name`] = user?.name ?? "";
  vars[`${prefix}.first_name`] = user?.name.split(" ")[0] ?? "";
  vars[`${prefix}.last_name`] = user?.name.split(" ").slice(1).join(" ") ?? "";
  vars[`${prefix}.email`] = user?.email ?? "";
  vars[`${prefix}.external_id`] = user?.external_id ?? "";
  vars[`${prefix}.phone`] = user?.phone ?? "";
  vars[`${prefix}.role`] = user?.role ?? "";
  vars[`${prefix}.locale`] = user?.locale ?? "";
  vars[`${prefix}.tags`] = user?.tags.join(" ") ?? "";
  const organization = user?.organization_id
    ? ctx.zs.organizations.findOneBy("zd_id", user.organization_id)
    : undefined;
  vars[`${prefix}.organization.id`] = organization?.zd_id ?? "";
  vars[`${prefix}.organization.name`] = organization?.name ?? "";
  vars[`${prefix}.organization.external_id`] = organization?.external_id ?? "";
  for (const [key, value] of Object.entries(user?.user_fields ?? {}))
    vars[`${prefix}.custom_fields.${key}`] = value ?? "";
}

export function placeholderVariables(ctx: PlaceholderContext): Record<string, unknown> {
  const { zs, ticket } = ctx;
  const vars: Record<string, unknown> = {};
  const requester = zs.users.findOneBy("zd_id", ticket.requester_id);
  const assignee = ticket.assignee_id ? zs.users.findOneBy("zd_id", ticket.assignee_id) : undefined;
  const submitter = zs.users.findOneBy("zd_id", ticket.submitter_id);
  const organization = ticket.organization_id ? zs.organizations.findOneBy("zd_id", ticket.organization_id) : undefined;
  const group = ticket.group_id ? zs.groups.findOneBy("zd_id", ticket.group_id) : undefined;
  const brand = zs.brands.findOneBy("zd_id", ticket.brand_id);
  const comments = zs.comments.findBy("ticket_id", ticket.zd_id).sort((a, b) => a.id - b.id);
  const latest = ctx.comment ?? comments[comments.length - 1];
  const latestPublic = [...comments].reverse().find((comment) => comment.public);

  vars["ticket.id"] = ticket.zd_id;
  vars["ticket.title"] = ticket.subject;
  vars["ticket.subject"] = ticket.subject;
  vars["ticket.description"] = ticket.description;
  vars["ticket.status"] = ticket.status.charAt(0).toUpperCase() + ticket.status.slice(1);
  vars["ticket.priority"] = ticket.priority ? ticket.priority.charAt(0).toUpperCase() + ticket.priority.slice(1) : "-";
  vars["ticket.ticket_type"] = ticket.type ? ticket.type.charAt(0).toUpperCase() + ticket.type.slice(1) : "-";
  vars["ticket.url"] = `${subdomain(zs)}.zendesk.com/agent/tickets/${ticket.zd_id}`;
  vars["ticket.link"] = `${ctx.baseUrl}/agent/tickets/${ticket.zd_id}`;
  vars["ticket.tags"] = ticket.tags.join(" ");
  vars["ticket.external_id"] = ticket.external_id ?? "";
  vars["ticket.via"] =
    ticket.via.channel === "api" ? "Web Service (API)" : ticket.via.channel === "email" ? "Mail" : "Web Form";
  vars["ticket.created_at"] = ticketCreatedAt(ticket);
  vars["ticket.updated_at"] = ticketUpdatedAt(ticket);
  vars["ticket.due_date"] = ticket.due_at ?? "";
  vars["ticket.account"] = subdomain(zs);
  vars["ticket.brand.name"] = brand?.name ?? "";
  vars["ticket.group.id"] = group?.zd_id ?? "";
  vars["ticket.group.name"] = group?.name ?? "";
  vars["ticket.organization.id"] = organization?.zd_id ?? "";
  vars["ticket.organization.name"] = organization?.name ?? "";
  vars["ticket.organization.external_id"] = organization?.external_id ?? "";
  for (const [key, value] of Object.entries(organization?.organization_fields ?? {})) {
    vars[`ticket.organization.custom_fields.${key}`] = value ?? "";
  }
  vars["ticket.latest_comment"] = latest?.body ?? "";
  vars["ticket.latest_comment.value"] = latest?.body ?? "";
  vars["ticket.latest_comment.id"] = latest?.zd_id ?? "";
  vars["ticket.latest_comment.is_public"] = latest ? String(latest.public) : "";
  vars["ticket.latest_comment.author.id"] = latest?.author_id ?? "";
  vars["ticket.latest_comment.author.name"] = latest ? (zs.users.findOneBy("zd_id", latest.author_id)?.name ?? "") : "";
  vars["ticket.latest_comment.author.email"] = latest
    ? (zs.users.findOneBy("zd_id", latest.author_id)?.email ?? "")
    : "";
  vars["ticket.latest_public_comment"] = latestPublic?.body ?? "";
  vars["ticket.latest_public_comment.value"] = latestPublic?.body ?? "";
  vars["ticket.comments_formatted"] = comments
    .map((comment) => `${zs.users.findOneBy("zd_id", comment.author_id)?.name ?? comment.author_id}: ${comment.body}`)
    .join("\n\n");
  vars["ticket.public_comments_formatted"] = comments
    .filter((comment) => comment.public)
    .map((comment) => `${zs.users.findOneBy("zd_id", comment.author_id)?.name ?? comment.author_id}: ${comment.body}`)
    .join("\n\n");
  for (const field of ticket.custom_fields) {
    vars[`ticket.ticket_field_${field.id}`] = field.value ?? "";
    const definition = zs.ticketFields.findOneBy("zd_id", field.id);
    const option = definition?.custom_field_options.find((candidate) => candidate.value === field.value);
    vars[`ticket.ticket_field_option_title_${field.id}`] = option?.name ?? field.value ?? "";
  }
  userVars("ticket.requester", requester, ctx, vars);
  userVars("ticket.assignee", assignee, ctx, vars);
  userVars("ticket.submitter", submitter, ctx, vars);
  userVars("current_user", ctx.currentUser ?? undefined, ctx, vars);
  vars["account.subdomain"] = subdomain(zs);
  vars["account.name"] = subdomain(zs);
  return vars;
}

function applyFilter(value: unknown, filter: string, arg: string | undefined): unknown {
  switch (filter) {
    case "json":
      return { __raw: JSON.stringify(value ?? "") };
    case "downcase":
      return String(value ?? "").toLowerCase();
    case "upcase":
      return String(value ?? "").toUpperCase();
    case "strip":
      return String(value ?? "").trim();
    case "size":
      return String(value ?? "").length;
    case "default":
      return value === "" || value === null || value === undefined ? (arg ?? "") : value;
    default:
      return value;
  }
}

function jsonSafe(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

export function renderPlaceholders(template: string, ctx: PlaceholderContext): string {
  const vars = placeholderVariables(ctx);
  return template.replace(
    /\{\{\s*([a-zA-Z0-9_.]+)((?:\s*\|\s*[a-z_]+(?:\s*:\s*'[^']*')?)*)\s*\}\}/g,
    (_match, path: string, filters: string) => {
      let value: unknown = vars[path] ?? "";
      const filterPattern = /\|\s*([a-z_]+)(?:\s*:\s*'([^']*)')?/g;
      let filterMatch: RegExpExecArray | null;
      while ((filterMatch = filterPattern.exec(filters ?? "")) !== null) {
        value = applyFilter(value, filterMatch[1], filterMatch[2]);
      }
      if (value && typeof value === "object" && "__raw" in (value as Record<string, unknown>)) {
        return String((value as { __raw: string }).__raw);
      }
      return jsonSafe(value);
    },
  );
}
