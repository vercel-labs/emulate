import type { Hono } from "@emulators/core";
import type { AppEnv, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import type {
  AuditEvent,
  FieldType,
  RuleAction,
  RuleConditions,
  TicketPriority,
  TicketStatus,
  TicketType,
  UserRole,
  Via,
  WebhookAuthentication,
  ZendeskTicketField,
} from "./entities.js";
import { parseActions, parseConditions } from "./conditions.js";
import type { Fmt } from "./formatters.js";
import { normalizeTags, nowIso, toIso } from "./helpers.js";
import { hexToken, nextId, reserveId, ulid } from "./ids.js";
import { fieldRoutes } from "./routes/fields.js";
import { groupRoutes } from "./routes/groups.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { miscRoutes } from "./routes/misc.js";
import { organizationRoutes } from "./routes/organizations.js";
import { requestRoutes } from "./routes/requests.js";
import { ruleRoutes } from "./routes/rules.js";
import { searchRoutes } from "./routes/search.js";
import { ticketRoutes } from "./routes/tickets.js";
import { userRoutes } from "./routes/users.js";
import type { ZendeskRouteContext } from "./route-utils.js";
import { getZendeskStore, setAccountId, setSubdomain, type ZendeskStore } from "./store.js";
import { API_VIA, WEB_VIA, fillCustomFields, isCustomFieldType } from "./ticket-service.js";
import type { ZendeskCtx } from "./webhooks.js";

export { getZendeskStore, type ZendeskStore } from "./store.js";
export * from "./entities.js";
export { signWebhook } from "./webhooks.js";

type SeedTimestamp = number | string;

export interface ZendeskSeedConfig {
  port?: number;
  baseUrl?: string;
  subdomain?: string;
  account_id?: number;
  api_tokens?: Array<{ token: string; email?: string; description?: string }>;
  oauth_tokens?: Array<{ token: string; user: string; scopes?: string[] }>;
  groups?: Array<{ id?: number; name: string; description?: string; default?: boolean }>;
  organizations?: Array<{
    id?: number;
    name: string;
    domain_names?: string[];
    external_id?: string;
    tags?: string[];
    details?: string;
    notes?: string;
    organization_fields?: Record<string, unknown>;
    shared_tickets?: boolean;
    shared_comments?: boolean;
  }>;
  users?: Array<{
    id?: number;
    name: string;
    email?: string;
    role?: UserRole;
    organization?: string | number;
    groups?: Array<string | number>;
    tags?: string[];
    external_id?: string;
    user_fields?: Record<string, unknown>;
    locale?: string;
    phone?: string;
    password?: string;
    verified?: boolean;
    suspended?: boolean;
  }>;
  ticket_fields?: Array<{
    id?: number;
    type: FieldType;
    title: string;
    description?: string;
    tag?: string;
    required?: boolean;
    visible_in_portal?: boolean;
    editable_in_portal?: boolean;
    options?: Array<{ name: string; value?: string; default?: boolean }>;
  }>;
  user_fields?: Array<{
    id?: number;
    key: string;
    title?: string;
    type?: string;
    options?: Array<{ name: string; value?: string }>;
  }>;
  organization_fields?: Array<{
    id?: number;
    key: string;
    title?: string;
    type?: string;
    options?: Array<{ name: string; value?: string }>;
  }>;
  tickets?: Array<{
    id?: number;
    subject: string;
    description?: string;
    requester: string | number;
    assignee?: string | number;
    group?: string | number;
    organization?: string | number;
    status?: TicketStatus;
    priority?: TicketPriority;
    type?: TicketType;
    tags?: string[];
    custom_fields?: Record<string, unknown>;
    external_id?: string;
    created_at?: SeedTimestamp;
    via?: "api" | "web" | "email";
    comments?: Array<{ author: string | number; body: string; public?: boolean; created_at?: SeedTimestamp }>;
  }>;
  macros?: Array<{ id?: number; title: string; description?: string; actions: RuleAction[]; active?: boolean }>;
  triggers?: Array<{
    id?: number;
    title: string;
    description?: string;
    conditions: RuleConditions | Record<string, unknown>;
    actions: RuleAction[];
    active?: boolean;
    position?: number;
  }>;
  views?: Array<{
    id?: number;
    title: string;
    description?: string;
    conditions: RuleConditions | Record<string, unknown>;
    active?: boolean;
    position?: number;
  }>;
  webhooks?: Array<{
    id?: string;
    name: string;
    endpoint: string;
    subscriptions?: string[];
    signing_secret?: string;
    status?: "active" | "inactive";
    http_method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    request_format?: "json" | "xml" | "form_encoded";
    authentication?: { type: "basic_auth" | "bearer_token" | "api_key"; data: Record<string, string> };
    custom_headers?: Record<string, string>;
  }>;
}

export const DEFAULT_SUBDOMAIN = "emulate-support";
export const DEFAULT_API_TOKEN = "test_emulate_zendesk_api_token";
export const DEFAULT_ADMIN_EMAIL = "admin@example.com";
export const DEFAULT_AGENT_EMAIL = "agent@example.com";
export const DEFAULT_END_USER_EMAIL = "test@example.com";
export const DEFAULT_ORGANIZATION_NAME = "Example Inc";
export const DEFAULT_GROUP_NAME = "Support";
export const DEFAULT_CATEGORY_FIELD_TITLE = "Category";
export const DEFAULT_REFERENCE_FIELD_TITLE = "Case reference";

export const DEFAULT_SEED: ZendeskSeedConfig = {
  subdomain: DEFAULT_SUBDOMAIN,
  account_id: 1,
  api_tokens: [{ token: DEFAULT_API_TOKEN, email: DEFAULT_ADMIN_EMAIL, description: "Local API token" }],
  groups: [{ name: DEFAULT_GROUP_NAME, description: "Default support group", default: true }],
  organizations: [
    {
      name: DEFAULT_ORGANIZATION_NAME,
      domain_names: ["example.com"],
      tags: ["customer"],
      organization_fields: { english: true },
    },
  ],
  users: [
    { name: "Support Admin", email: DEFAULT_ADMIN_EMAIL, role: "admin" },
    { name: "Alex Agent", email: DEFAULT_AGENT_EMAIL, role: "agent" },
    { name: "Test Customer", email: DEFAULT_END_USER_EMAIL, role: "end-user", organization: DEFAULT_ORGANIZATION_NAME },
  ],
  ticket_fields: [
    {
      type: "text",
      title: DEFAULT_REFERENCE_FIELD_TITLE,
      description: "External case reference",
      visible_in_portal: true,
      editable_in_portal: true,
    },
    {
      type: "tagger",
      title: DEFAULT_CATEGORY_FIELD_TITLE,
      options: [
        { name: "Billing", value: "category_billing" },
        { name: "Technical", value: "category_technical" },
        { name: "Other", value: "category_other" },
      ],
    },
  ],
  organization_fields: [
    { key: "english", title: "English", type: "checkbox" },
    { key: "client_id", title: "Client ID", type: "text" },
  ],
  tickets: [
    {
      subject: "Welcome to the Zendesk emulator",
      description: "Hello, I would like to know how to test my support integration locally.",
      requester: DEFAULT_END_USER_EMAIL,
      assignee: DEFAULT_AGENT_EMAIL,
      group: DEFAULT_GROUP_NAME,
      status: "open",
      priority: "normal",
      type: "question",
      tags: ["welcome"],
      custom_fields: { [DEFAULT_CATEGORY_FIELD_TITLE]: "category_technical" },
      comments: [
        {
          author: DEFAULT_AGENT_EMAIL,
          body: "Thanks for reaching out. Everything you create here stays local.",
          public: true,
        },
      ],
    },
  ],
  macros: [
    {
      title: "Mark as solved",
      actions: [
        { field: "status", value: "solved" },
        { field: "comment_value", value: "We consider this request resolved. Reply to reopen it." },
      ],
    },
  ],
  views: [
    {
      title: "Your unsolved tickets",
      conditions: {
        all: [
          { field: "status", operator: "less_than", value: "solved" },
          { field: "assignee_id", operator: "is", value: "current_user" },
        ],
      },
    },
    {
      title: "Unassigned tickets",
      conditions: {
        all: [
          { field: "status", operator: "less_than", value: "solved" },
          { field: "assignee_id", operator: "is", value: "" },
        ],
      },
    },
    {
      title: "All unsolved tickets",
      conditions: { all: [{ field: "status", operator: "less_than", value: "solved" }] },
    },
    {
      title: "Recently updated tickets",
      conditions: { all: [{ field: "status", operator: "less_than", value: "closed" }] },
    },
    { title: "Pending tickets", conditions: { all: [{ field: "status", operator: "is", value: "pending" }] } },
    { title: "Recently solved tickets", conditions: { all: [{ field: "status", operator: "is", value: "solved" }] } },
  ],
};

const SYSTEM_TICKET_FIELDS: Array<{ type: FieldType; title: string; portal: boolean }> = [
  { type: "subject", title: "Subject", portal: true },
  { type: "description", title: "Description", portal: true },
  { type: "status", title: "Status", portal: false },
  { type: "tickettype", title: "Type", portal: false },
  { type: "priority", title: "Priority", portal: false },
  { type: "group", title: "Group", portal: false },
  { type: "assignee", title: "Assignee", portal: false },
];

const DEFAULT_CUSTOM_STATUSES: Array<{
  category: "new" | "open" | "pending" | "hold" | "solved";
  agent: string;
  endUser: string;
}> = [
  { category: "new", agent: "New", endUser: "Open" },
  { category: "open", agent: "Open", endUser: "Open" },
  { category: "pending", agent: "Pending", endUser: "Awaiting your reply" },
  { category: "hold", agent: "On-hold", endUser: "Open" },
  { category: "solved", agent: "Solved", endUser: "Solved" },
];

function seedBaseline(zs: ZendeskStore): void {
  if (zs.ticketFields.count() === 0) {
    SYSTEM_TICKET_FIELDS.forEach((field, index) => {
      zs.ticketFields.insert({
        zd_id: nextId(zs, "ticket_fields"),
        type: field.type,
        title: field.title,
        description: "",
        position: index + 1,
        active: true,
        required: field.type === "subject" || field.type === "description",
        required_in_portal: field.type === "subject" || field.type === "description",
        visible_in_portal: field.portal,
        editable_in_portal: field.portal,
        collapsed_for_agents: false,
        title_in_portal: field.title,
        agent_description: null,
        tag: null,
        regexp_for_validation: null,
        removable: false,
        custom_field_options: [],
        system_field_options: [],
      });
    });
  }
  if (zs.customStatuses.count() === 0) {
    for (const status of DEFAULT_CUSTOM_STATUSES) {
      zs.customStatuses.insert({
        zd_id: nextId(zs, "custom_statuses"),
        status_category: status.category,
        agent_label: status.agent,
        end_user_label: status.endUser,
        description: "",
        end_user_description: "",
        active: true,
        default: true,
      });
    }
  }
  if (zs.brands.count() === 0) {
    const name = zs.raw.getData<string>("zendesk.subdomain") ?? DEFAULT_SUBDOMAIN;
    zs.brands.insert({
      zd_id: nextId(zs, "brands"),
      name: "Emulate Support",
      subdomain: name,
      brand_url: `https://${name}.zendesk.com`,
      default: true,
      active: true,
    });
  }
  if (zs.ticketForms.count() === 0) {
    zs.ticketForms.insert({
      zd_id: nextId(zs, "ticket_forms"),
      name: "Default Ticket Form",
      display_name: "Default Ticket Form",
      position: 1,
      active: true,
      default: true,
      end_user_visible: true,
      ticket_field_ids: zs.ticketFields.all().map((field) => field.zd_id),
    });
  }
}

function resolveUser(zs: ZendeskStore, ref: string | number | undefined) {
  if (ref === undefined) return undefined;
  if (typeof ref === "number") return zs.users.findOneBy("zd_id", ref);
  const lowered = ref.toLowerCase();
  return zs.users.all().find((user) => user.email?.toLowerCase() === lowered || user.name.toLowerCase() === lowered);
}

function resolveOrganization(zs: ZendeskStore, ref: string | number | undefined) {
  if (ref === undefined) return undefined;
  if (typeof ref === "number") return zs.organizations.findOneBy("zd_id", ref);
  return zs.organizations.all().find((organization) => organization.name.toLowerCase() === ref.toLowerCase());
}

function resolveGroup(zs: ZendeskStore, ref: string | number | undefined) {
  if (ref === undefined) return undefined;
  if (typeof ref === "number") return zs.groups.findOneBy("zd_id", ref);
  return zs.groups.all().find((group) => group.name.toLowerCase() === ref.toLowerCase());
}

function seedOptions(
  zs: ZendeskStore,
  options: Array<{ name: string; value?: string; default?: boolean }> | undefined,
) {
  return (options ?? []).map((option) => ({
    id: nextId(zs, "custom_field_options"),
    name: option.name,
    raw_name: option.name,
    value: option.value ?? option.name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    default: option.default ?? false,
  }));
}

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: ZendeskSeedConfig,
  _webhooks?: WebhookDispatcher,
): void {
  const zs = getZendeskStore(store);
  if (config.subdomain) setSubdomain(zs, config.subdomain);
  if (config.account_id !== undefined) setAccountId(zs, config.account_id);
  seedBaseline(zs);

  for (const token of config.api_tokens ?? []) {
    if (!token.token || zs.apiTokens.findOneBy("token", token.token)) continue;
    zs.apiTokens.insert({
      token: token.token,
      email: token.email ?? null,
      description: token.description ?? "API token",
    });
  }
  if (zs.apiTokens.count() === 0) {
    zs.apiTokens.insert({ token: DEFAULT_API_TOKEN, email: null, description: "Local API token" });
  }

  for (const group of config.groups ?? []) {
    if (zs.groups.all().some((existing) => existing.name.toLowerCase() === group.name.toLowerCase())) continue;
    const id = group.id ?? nextId(zs, "groups");
    if (group.id !== undefined) reserveId(zs, "groups", id);
    const makeDefault = group.default ?? zs.groups.count() === 0;
    if (makeDefault)
      for (const other of zs.groups.all()) if (other.default) zs.groups.update(other.id, { default: false });
    zs.groups.insert({
      zd_id: id,
      name: group.name,
      description: group.description ?? null,
      is_public: true,
      default: makeDefault,
      deleted: false,
    });
  }
  if (zs.groups.count() === 0) {
    zs.groups.insert({
      zd_id: nextId(zs, "groups"),
      name: DEFAULT_GROUP_NAME,
      description: null,
      is_public: true,
      default: true,
      deleted: false,
    });
  }

  for (const field of config.organization_fields ?? []) {
    if (zs.customFields.findBy("kind", "organization").some((existing) => existing.key === field.key)) continue;
    zs.customFields.insert({
      zd_id: field.id ?? nextId(zs, "organization_fields"),
      kind: "organization",
      key: field.key,
      type: field.type ?? "text",
      title: field.title ?? field.key,
      description: "",
      position: zs.customFields.findBy("kind", "organization").length + 1,
      active: true,
      custom_field_options: seedOptions(zs, field.options),
    });
  }
  for (const field of config.user_fields ?? []) {
    if (zs.customFields.findBy("kind", "user").some((existing) => existing.key === field.key)) continue;
    zs.customFields.insert({
      zd_id: field.id ?? nextId(zs, "user_fields"),
      kind: "user",
      key: field.key,
      type: field.type ?? "text",
      title: field.title ?? field.key,
      description: "",
      position: zs.customFields.findBy("kind", "user").length + 1,
      active: true,
      custom_field_options: seedOptions(zs, field.options),
    });
  }

  for (const field of config.ticket_fields ?? []) {
    if (zs.ticketFields.all().some((existing) => existing.title.toLowerCase() === field.title.toLowerCase())) continue;
    const id = field.id ?? nextId(zs, "ticket_fields");
    if (field.id !== undefined) reserveId(zs, "ticket_fields", id);
    const created: ZendeskTicketField = zs.ticketFields.insert({
      zd_id: id,
      type: field.type,
      title: field.title,
      description: field.description ?? "",
      position: zs.ticketFields.count() + 1,
      active: true,
      required: field.required ?? false,
      required_in_portal: false,
      visible_in_portal: field.visible_in_portal ?? false,
      editable_in_portal: field.editable_in_portal ?? false,
      collapsed_for_agents: false,
      title_in_portal: field.title,
      agent_description: null,
      tag: field.tag ?? null,
      regexp_for_validation: null,
      removable: true,
      custom_field_options: seedOptions(zs, field.options),
      system_field_options: [],
    });
    for (const form of zs.ticketForms.all())
      zs.ticketForms.update(form.id, { ticket_field_ids: [...form.ticket_field_ids, created.zd_id] });
    for (const ticket of zs.tickets.all())
      zs.tickets.update(ticket.id, { custom_fields: [...ticket.custom_fields, { id: created.zd_id, value: null }] });
  }

  for (const organization of config.organizations ?? []) {
    if (zs.organizations.all().some((existing) => existing.name.toLowerCase() === organization.name.toLowerCase()))
      continue;
    const id = organization.id ?? nextId(zs, "organizations");
    if (organization.id !== undefined) reserveId(zs, "organizations", id);
    zs.organizations.insert({
      zd_id: id,
      name: organization.name,
      details: organization.details ?? null,
      notes: organization.notes ?? null,
      domain_names: organization.domain_names ?? [],
      external_id: organization.external_id ?? null,
      group_id: null,
      shared_tickets: organization.shared_tickets ?? false,
      shared_comments: organization.shared_comments ?? false,
      tags: normalizeTags(organization.tags ?? []),
      organization_fields: organization.organization_fields ?? {},
      deleted: false,
    });
  }

  const defaultGroup = zs.groups.all().find((group) => group.default) ?? zs.groups.all()[0];
  for (const user of config.users ?? []) {
    if (user.email && zs.users.all().some((existing) => existing.email?.toLowerCase() === user.email!.toLowerCase()))
      continue;
    const id = user.id ?? nextId(zs, "users");
    if (user.id !== undefined) reserveId(zs, "users", id);
    const role = user.role ?? "end-user";
    const organization =
      resolveOrganization(zs, user.organization) ??
      (user.email
        ? zs.organizations
            .all()
            .find((org) =>
              org.domain_names.some((domain) => user.email!.toLowerCase().endsWith(`@${domain.toLowerCase()}`)),
            )
        : undefined);
    const groups = (user.groups ?? [])
      .map((ref) => resolveGroup(zs, ref))
      .filter((group): group is NonNullable<typeof group> => !!group);
    if (role !== "end-user" && groups.length === 0 && defaultGroup) groups.push(defaultGroup);
    const created = zs.users.insert({
      zd_id: id,
      name: user.name,
      email: user.email ?? null,
      role,
      active: true,
      verified: user.verified ?? true,
      suspended: user.suspended ?? false,
      organization_id: organization?.zd_id ?? null,
      default_group_id: groups[0]?.zd_id ?? null,
      external_id: user.external_id ?? null,
      alias: null,
      details: null,
      notes: null,
      phone: user.phone ?? null,
      locale: user.locale ?? "en-US",
      time_zone: "UTC",
      tags: normalizeTags(user.tags ?? []),
      user_fields: user.user_fields ?? {},
      password: user.password ?? null,
      last_login_at: null,
      signature: null,
      moderator: role === "admin",
      ticket_restriction: role === "end-user" ? "requested" : null,
      only_private_comments: false,
      restricted_agent: role === "agent",
      shared: false,
      shared_agent: false,
      photo: null,
      deleted: false,
    });
    if (organization) {
      zs.organizationMemberships.insert({
        zd_id: nextId(zs, "organization_memberships"),
        user_id: created.zd_id,
        organization_id: organization.zd_id,
        default: true,
      });
    }
    groups.forEach((group, index) => {
      zs.groupMemberships.insert({
        zd_id: nextId(zs, "group_memberships"),
        user_id: created.zd_id,
        group_id: group.zd_id,
        default: index === 0,
      });
    });
  }

  for (const token of config.oauth_tokens ?? []) {
    if (!token.token || zs.oauthTokens.findOneBy("token", token.token)) continue;
    const user = resolveUser(zs, token.user);
    if (!user) continue;
    zs.oauthTokens.insert({ token: token.token, user_id: user.zd_id, scopes: token.scopes ?? ["read", "write"] });
  }

  const admin =
    zs.users.all().find((user) => user.role === "admin") ?? zs.users.all().find((user) => user.role === "agent");
  for (const entry of config.tickets ?? []) {
    if (entry.id !== undefined && zs.tickets.findOneBy("zd_id", entry.id)) continue;
    const requester = resolveUser(zs, entry.requester);
    if (!requester) continue;
    const assignee = resolveUser(zs, entry.assignee);
    const group =
      resolveGroup(zs, entry.group) ??
      (assignee?.default_group_id ? zs.groups.findOneBy("zd_id", assignee.default_group_id) : undefined);
    const organization =
      resolveOrganization(zs, entry.organization) ??
      (requester.organization_id ? zs.organizations.findOneBy("zd_id", requester.organization_id) : undefined);
    const createdAt = toIso(entry.created_at) ?? nowIso();
    const status = entry.status ?? (assignee ? "open" : "new");
    const customFieldInput = Object.entries(entry.custom_fields ?? {}).flatMap(([key, value]) => {
      const numeric = Number(key);
      const field = Number.isFinite(numeric)
        ? zs.ticketFields.findOneBy("zd_id", numeric)
        : zs.ticketFields
            .all()
            .find(
              (candidate) => candidate.title.toLowerCase() === key.toLowerCase() && isCustomFieldType(candidate.type),
            );
      return field ? [{ id: field.zd_id, value }] : [];
    });
    let customFields;
    try {
      customFields = fillCustomFields(zs, [], customFieldInput);
    } catch {
      customFields = fillCustomFields(zs, [], []);
    }
    const optionTags = customFields.flatMap((field) =>
      typeof field.value === "string" && zs.ticketFields.findOneBy("zd_id", field.id)?.type === "tagger"
        ? [field.value]
        : [],
    );
    const tags = [...new Set([...normalizeTags(entry.tags ?? []), ...optionTags])];
    const via: Via =
      entry.via === "email"
        ? {
            channel: "email",
            source: {
              from: { address: requester.email ?? "", name: requester.name },
              to: {
                address: `support@${zs.raw.getData<string>("zendesk.subdomain") ?? DEFAULT_SUBDOMAIN}.zendesk.com`,
                name: "Support",
              },
              rel: null,
            },
          }
        : entry.via === "api"
          ? API_VIA
          : WEB_VIA;
    const id = entry.id ?? nextId(zs, "tickets");
    if (entry.id !== undefined) reserveId(zs, "tickets", id);
    const description = entry.description ?? entry.subject;
    const solvedAt = status === "solved" || status === "closed" ? createdAt : null;
    const ticket = zs.tickets.insert({
      zd_id: id,
      subject: entry.subject,
      raw_subject: entry.subject,
      description,
      status,
      custom_status_id:
        zs.customStatuses
          .all()
          .find(
            (candidate) => candidate.status_category === (status === "closed" ? "solved" : status) && candidate.default,
          )?.zd_id ?? 0,
      priority: entry.priority ?? null,
      type: entry.type ?? null,
      requester_id: requester.zd_id,
      submitter_id: requester.zd_id,
      assignee_id: assignee?.zd_id ?? null,
      group_id: group?.zd_id ?? null,
      organization_id: organization?.zd_id ?? null,
      brand_id: zs.brands.all()[0]?.zd_id ?? 1,
      ticket_form_id: zs.ticketForms.all()[0]?.zd_id ?? 1,
      external_id: entry.external_id ?? null,
      recipient: null,
      collaborator_ids: [],
      email_cc_ids: [],
      follower_ids: [],
      problem_id: null,
      due_at: null,
      tags,
      custom_fields: customFields,
      via,
      is_public: true,
      satisfaction_rating_id: null,
      followup_ids: [],
      metrics: {
        assigned_at: assignee ? createdAt : null,
        initially_assigned_at: assignee ? createdAt : null,
        solved_at: solvedAt,
        status_updated_at: createdAt,
        requester_updated_at: createdAt,
        assignee_updated_at: assignee ? createdAt : null,
        latest_comment_added_at: createdAt,
        reopens: 0,
        replies: 0,
        group_stations: group ? 1 : 0,
        assignee_stations: assignee ? 1 : 0,
        first_reply_minutes: null,
        full_resolution_minutes: solvedAt ? 0 : null,
      },
      deleted: false,
      deleted_at: null,
      spam: false,
      generated_timestamp: Math.floor(Date.parse(createdAt) / 1000),
      created_at_override: entry.created_at !== undefined ? createdAt : null,
      updated_at_override: entry.created_at !== undefined ? createdAt : null,
    });
    const audit = zs.audits.insert({
      zd_id: nextId(zs, "audits"),
      ticket_id: ticket.zd_id,
      author_id: requester.zd_id,
      events: [],
      via,
      metadata: {},
    });
    const events: AuditEvent[] = [];
    const firstComment = zs.comments.insert({
      zd_id: nextId(zs, "events"),
      ticket_id: ticket.zd_id,
      audit_id: audit.zd_id,
      author_id: requester.zd_id,
      body: description,
      html_body: `<div class="zd-comment" dir="auto"><p dir="auto">${description}</p></div>`,
      public: true,
      attachment_ids: [],
      via,
      redacted: false,
    });
    events.push({ id: firstComment.zd_id, type: "Comment" });
    events.push({ id: nextId(zs, "events"), type: "Create", field_name: "subject", value: ticket.subject });
    events.push({ id: nextId(zs, "events"), type: "Create", field_name: "status", value: ticket.status });
    if (ticket.tags.length > 0)
      events.push({ id: nextId(zs, "events"), type: "Create", field_name: "tags", value: ticket.tags });
    zs.audits.update(audit.id, { events });
    let replies = 0;
    for (const comment of entry.comments ?? []) {
      const author = resolveUser(zs, comment.author) ?? admin;
      if (!author) continue;
      const commentAudit = zs.audits.insert({
        zd_id: nextId(zs, "audits"),
        ticket_id: ticket.zd_id,
        author_id: author.zd_id,
        events: [],
        via: API_VIA,
        metadata: {},
      });
      const stored = zs.comments.insert({
        zd_id: nextId(zs, "events"),
        ticket_id: ticket.zd_id,
        audit_id: commentAudit.zd_id,
        author_id: author.zd_id,
        body: comment.body,
        html_body: `<div class="zd-comment" dir="auto"><p dir="auto">${comment.body}</p></div>`,
        public: comment.public ?? true,
        attachment_ids: [],
        via: API_VIA,
        redacted: false,
      });
      zs.audits.update(commentAudit.id, { events: [{ id: stored.zd_id, type: "Comment" }] });
      if ((comment.public ?? true) && author.role !== "end-user") replies++;
    }
    if (replies > 0) zs.tickets.update(ticket.id, { metrics: { ...ticket.metrics, replies, first_reply_minutes: 0 } });
  }

  for (const macro of config.macros ?? []) {
    if (zs.macros.all().some((existing) => existing.title === macro.title)) continue;
    zs.macros.insert({
      zd_id: macro.id ?? nextId(zs, "macros"),
      title: macro.title,
      description: macro.description ?? null,
      active: macro.active ?? true,
      position: zs.macros.count() + 1,
      actions: parseActions(macro.actions),
      restriction: null,
    });
  }
  for (const trigger of config.triggers ?? []) {
    if (zs.triggers.all().some((existing) => existing.title === trigger.title)) continue;
    zs.triggers.insert({
      zd_id: trigger.id ?? nextId(zs, "triggers"),
      title: trigger.title,
      description: trigger.description ?? null,
      active: trigger.active ?? true,
      position: trigger.position ?? zs.triggers.count() + 1,
      category_id: null,
      conditions: parseConditions(trigger.conditions),
      actions: parseActions(trigger.actions),
    });
  }
  for (const view of config.views ?? []) {
    if (zs.views.all().some((existing) => existing.title === view.title)) continue;
    zs.views.insert({
      zd_id: view.id ?? nextId(zs, "views"),
      title: view.title,
      description: view.description ?? null,
      active: view.active ?? true,
      position: view.position ?? zs.views.count() + 1,
      conditions: parseConditions(view.conditions),
      execution: {
        columns: [
          { id: "subject", title: "Subject" },
          { id: "requester", title: "Requester" },
          { id: "status", title: "Status" },
        ],
      },
      restriction: null,
    });
  }
  for (const webhook of config.webhooks ?? []) {
    if (zs.webhooks.all().some((existing) => existing.name === webhook.name)) continue;
    const authentication: WebhookAuthentication | null = webhook.authentication
      ? { type: webhook.authentication.type, data: webhook.authentication.data, add_position: "header" }
      : null;
    zs.webhooks.insert({
      zd_id: webhook.id ?? ulid(),
      name: webhook.name,
      description: null,
      status: webhook.status ?? "active",
      endpoint: webhook.endpoint,
      http_method: webhook.http_method ?? "POST",
      request_format: webhook.request_format ?? "json",
      subscriptions: webhook.subscriptions ?? ["conditional_ticket_events"],
      authentication,
      custom_headers: webhook.custom_headers ?? {},
      signing_secret: webhook.signing_secret ?? hexToken(32),
      created_by: String(admin?.zd_id ?? 0),
      updated_by: String(admin?.zd_id ?? 0),
    });
  }
}

function seedDefaults(store: Store, baseUrl: string): void {
  seedFromConfig(store, baseUrl, DEFAULT_SEED);
}

export const zendeskPlugin: ServicePlugin = {
  name: "zendesk",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const zs = getZendeskStore(store);
    const ctx: ZendeskCtx = { zs, baseUrl };
    const fmt: Fmt = { zs, baseUrl };
    const rc: ZendeskRouteContext = { app, zs, ctx, fmt, baseUrl };
    userRoutes(rc);
    organizationRoutes(rc);
    groupRoutes(rc);
    ticketRoutes(rc);
    requestRoutes(rc);
    fieldRoutes(rc);
    searchRoutes(rc);
    ruleRoutes(rc);
    miscRoutes(rc);
    inspectorRoutes(rc);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default zendeskPlugin;
