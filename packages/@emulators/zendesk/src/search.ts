import type { ZendeskGroup, ZendeskOrganization, ZendeskTicket, ZendeskUser } from "./entities.js";
import { ticketCreatedAt, ticketUpdatedAt } from "./formatters.js";
import type { ZendeskStore } from "./store.js";

export type SearchType = "ticket" | "user" | "organization" | "group";

interface Term {
  field: string;
  op: ":" | ">" | "<" | ">=" | "<=";
  value: string;
  negate: boolean;
}

export interface SearchQuery {
  type: SearchType | null;
  terms: Term[];
  text: string[];
  orderBy: string | null;
  sortDesc: boolean;
}

export function parseSearchQuery(query: string): SearchQuery {
  const tokens: string[] = [];
  const pattern = /-?[a-z_]+(?::|>=|<=|>|<)(?:"[^"]*"|\S+)|"[^"]*"|\S+/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) tokens.push(match[0]);

  const result: SearchQuery = { type: null, terms: [], text: [], orderBy: null, sortDesc: false };
  for (const token of tokens) {
    const term = token.match(/^(-?)([a-z_]+)(:|>=|<=|>|<)(.+)$/i);
    if (!term) {
      result.text.push(token.replace(/^"|"$/g, "").toLowerCase());
      continue;
    }
    const negate = term[1] === "-";
    const field = term[2].toLowerCase();
    const op = term[3] as Term["op"];
    const value = term[4].replace(/^"|"$/g, "");
    if (field === "type" && !negate) {
      const type = value.toLowerCase();
      if (type === "ticket" || type === "user" || type === "organization" || type === "group") result.type = type;
      else result.terms.push({ field: "ticket_type", op, value, negate });
      continue;
    }
    if (field === "order_by") {
      result.orderBy = value;
      continue;
    }
    if (field === "sort") {
      result.sortDesc = value.toLowerCase() === "desc";
      continue;
    }
    result.terms.push({ field, op, value, negate });
  }
  return result;
}

function parseDate(value: string): number | null {
  const relative = value.match(/^(\d+)(hour|day|week|month|year)s?$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 }[unit]!;
    return Date.now() - amount * ms;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function compareDate(actual: string | null, term: Term): boolean {
  if (!actual) return false;
  const target = parseDate(term.value);
  if (target === null) return false;
  const value = Date.parse(actual);
  switch (term.op) {
    case ">":
      return value > target;
    case ">=":
      return value >= target;
    case "<":
      return value < target;
    case "<=":
      return value <= target;
    default:
      return Math.floor(value / 86400e3) === Math.floor(target / 86400e3);
  }
}

function equalsIgnoreCase(actual: unknown, expected: string): boolean {
  if (actual === null || actual === undefined) return expected === "none" || expected === "";
  return String(actual).toLowerCase() === expected.toLowerCase();
}

function textMatches(haystack: Array<string | null | undefined>, needles: string[]): boolean {
  if (needles.length === 0) return true;
  const text = haystack
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .toLowerCase();
  return needles.every((needle) => text.includes(needle));
}

function userRef(zs: ZendeskStore, value: string, currentUser: ZendeskUser | null): number | null | undefined {
  if (value === "me") return currentUser?.zd_id ?? null;
  if (value === "none") return null;
  if (/^\d+$/.test(value)) return Number(value);
  const user = zs.users
    .all()
    .find(
      (candidate) =>
        candidate.email?.toLowerCase() === value.toLowerCase() || candidate.name.toLowerCase() === value.toLowerCase(),
    );
  return user?.zd_id ?? -1;
}

function orgRef(zs: ZendeskStore, value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const org = zs.organizations.all().find((candidate) => candidate.name.toLowerCase() === value.toLowerCase());
  return org?.zd_id ?? -1;
}

function groupRef(zs: ZendeskStore, value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const group = zs.groups.all().find((candidate) => candidate.name.toLowerCase() === value.toLowerCase());
  return group?.zd_id ?? -1;
}

function evaluate(term: Term, matched: boolean): boolean {
  return term.negate ? !matched : matched;
}

export function matchTicket(
  zs: ZendeskStore,
  ticket: ZendeskTicket,
  query: SearchQuery,
  currentUser: ZendeskUser | null,
): boolean {
  for (const term of query.terms) {
    const custom = term.field.match(/^custom_field_(\d+)$/);
    let matched: boolean;
    if (custom) {
      const value = ticket.custom_fields.find((field) => field.id === Number(custom[1]))?.value;
      matched = equalsIgnoreCase(value, term.value);
    } else {
      switch (term.field) {
        case "status":
          matched =
            term.op === ":"
              ? equalsIgnoreCase(ticket.status, term.value)
              : compareOrdinal(ticket.status, term, ["new", "open", "pending", "hold", "solved", "closed"]);
          break;
        case "priority":
          matched =
            term.op === ":"
              ? equalsIgnoreCase(ticket.priority, term.value)
              : compareOrdinal(ticket.priority, term, ["low", "normal", "high", "urgent"]);
          break;
        case "ticket_type":
          matched = equalsIgnoreCase(ticket.type, term.value);
          break;
        case "tags":
          matched = ticket.tags.includes(term.value.toLowerCase());
          break;
        case "requester":
        case "requester_id":
          matched = ticket.requester_id === userRef(zs, term.value, currentUser);
          break;
        case "assignee":
        case "assignee_id":
          matched = ticket.assignee_id === userRef(zs, term.value, currentUser);
          break;
        case "submitter":
        case "submitter_id":
          matched = ticket.submitter_id === userRef(zs, term.value, currentUser);
          break;
        case "commenter":
          matched = zs.comments
            .findBy("ticket_id", ticket.zd_id)
            .some((comment) => comment.author_id === userRef(zs, term.value, currentUser));
          break;
        case "cc":
          matched = ticket.email_cc_ids.includes(userRef(zs, term.value, currentUser) ?? -1);
          break;
        case "organization":
        case "organization_id":
          matched = ticket.organization_id === orgRef(zs, term.value);
          break;
        case "group":
        case "group_id":
          matched = ticket.group_id === groupRef(zs, term.value);
          break;
        case "subject":
          matched = ticket.subject.toLowerCase().includes(term.value.toLowerCase());
          break;
        case "description":
          matched = ticket.description.toLowerCase().includes(term.value.toLowerCase());
          break;
        case "external_id":
          matched = equalsIgnoreCase(ticket.external_id, term.value);
          break;
        case "via":
          matched = equalsIgnoreCase(ticket.via.channel, term.value);
          break;
        case "brand":
        case "brand_id":
          matched = String(ticket.brand_id) === term.value;
          break;
        case "form":
        case "ticket_form_id":
          matched = String(ticket.ticket_form_id) === term.value;
          break;
        case "created":
          matched = compareDate(ticketCreatedAt(ticket), term);
          break;
        case "updated":
          matched = compareDate(ticketUpdatedAt(ticket), term);
          break;
        case "solved":
          matched = compareDate(ticket.metrics.solved_at, term);
          break;
        case "due_date":
          matched = compareDate(ticket.due_at, term);
          break;
        case "has_attachment":
          matched =
            (term.value === "true") ===
            zs.comments.findBy("ticket_id", ticket.zd_id).some((comment) => comment.attachment_ids.length > 0);
          break;
        default:
          matched = false;
      }
    }
    if (!evaluate(term, matched)) return false;
  }
  if (query.text.length === 0) return true;
  const comments = zs.comments.findBy("ticket_id", ticket.zd_id).map((comment) => comment.body);
  const requester = zs.users.findOneBy("zd_id", ticket.requester_id);
  return textMatches(
    [
      ticket.subject,
      ticket.description,
      String(ticket.zd_id),
      ...comments,
      requester?.email,
      requester?.name,
      ...ticket.tags,
    ],
    query.text,
  );
}

function compareOrdinal(actual: string | null, term: Term, order: string[]): boolean {
  if (actual === null) return false;
  const a = order.indexOf(actual);
  const b = order.indexOf(term.value.toLowerCase());
  if (a === -1 || b === -1) return false;
  switch (term.op) {
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    default:
      return a === b;
  }
}

export function matchUser(zs: ZendeskStore, user: ZendeskUser, query: SearchQuery): boolean {
  for (const term of query.terms) {
    let matched: boolean;
    switch (term.field) {
      case "email":
        matched =
          user.email?.toLowerCase() === term.value.toLowerCase() ||
          (user.email?.toLowerCase().includes(term.value.toLowerCase()) ?? false);
        break;
      case "name":
        matched = user.name.toLowerCase().includes(term.value.toLowerCase());
        break;
      case "role":
        matched = equalsIgnoreCase(user.role, term.value);
        break;
      case "organization":
      case "organization_id":
        matched = user.organization_id === orgRef(zs, term.value);
        break;
      case "tags":
        matched = user.tags.includes(term.value.toLowerCase());
        break;
      case "external_id":
        matched = equalsIgnoreCase(user.external_id, term.value);
        break;
      case "phone":
        matched = equalsIgnoreCase(user.phone, term.value);
        break;
      case "notes":
        matched = (user.notes ?? "").toLowerCase().includes(term.value.toLowerCase());
        break;
      case "details":
        matched = (user.details ?? "").toLowerCase().includes(term.value.toLowerCase());
        break;
      case "created":
        matched = compareDate(user.created_at, term);
        break;
      case "updated":
        matched = compareDate(user.updated_at, term);
        break;
      case "is_suspended":
      case "suspended":
        matched = String(user.suspended) === term.value;
        break;
      case "group":
      case "group_id":
        matched = zs.groupMemberships
          .findBy("user_id", user.zd_id)
          .some((membership) => membership.group_id === groupRef(zs, term.value));
        break;
      default:
        matched = false;
    }
    if (!evaluate(term, matched)) return false;
  }
  return textMatches(
    [user.name, user.email, user.external_id, user.phone, user.notes, user.details, ...user.tags],
    query.text,
  );
}

export function matchOrganization(zs: ZendeskStore, organization: ZendeskOrganization, query: SearchQuery): boolean {
  for (const term of query.terms) {
    let matched: boolean;
    switch (term.field) {
      case "name":
        matched = organization.name.toLowerCase().includes(term.value.toLowerCase());
        break;
      case "tags":
        matched = organization.tags.includes(term.value.toLowerCase());
        break;
      case "external_id":
        matched = equalsIgnoreCase(organization.external_id, term.value);
        break;
      case "notes":
        matched = (organization.notes ?? "").toLowerCase().includes(term.value.toLowerCase());
        break;
      case "details":
        matched = (organization.details ?? "").toLowerCase().includes(term.value.toLowerCase());
        break;
      case "created":
        matched = compareDate(organization.created_at, term);
        break;
      case "updated":
        matched = compareDate(organization.updated_at, term);
        break;
      default:
        matched = false;
    }
    if (!evaluate(term, matched)) return false;
  }
  return textMatches(
    [
      organization.name,
      organization.external_id,
      organization.notes,
      organization.details,
      ...organization.domain_names,
      ...organization.tags,
    ],
    query.text,
  );
}

export function matchGroup(group: ZendeskGroup, query: SearchQuery): boolean {
  for (const term of query.terms) {
    const matched = term.field === "name" ? group.name.toLowerCase().includes(term.value.toLowerCase()) : false;
    if (!evaluate(term, matched)) return false;
  }
  return textMatches([group.name, group.description], query.text);
}
