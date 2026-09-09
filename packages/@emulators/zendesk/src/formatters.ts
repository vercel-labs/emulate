import type {
  ZendeskAttachment,
  ZendeskAudit,
  ZendeskBrand,
  ZendeskComment,
  ZendeskCustomField,
  ZendeskCustomStatus,
  ZendeskEventLog,
  ZendeskGroup,
  ZendeskGroupMembership,
  ZendeskJobStatus,
  ZendeskMacro,
  ZendeskOrganization,
  ZendeskOrganizationMembership,
  ZendeskSatisfactionRating,
  ZendeskTicket,
  ZendeskTicketField,
  ZendeskTicketForm,
  ZendeskTrigger,
  ZendeskUser,
  ZendeskView,
  ZendeskWebhook,
  ZendeskWebhookInvocation,
} from "./entities.js";
import { apiUrl, trimIso } from "./helpers.js";
import { subdomain, type ZendeskStore } from "./store.js";

export interface Fmt {
  zs: ZendeskStore;
  baseUrl: string;
}

type Json = Record<string, unknown>;

export function ticketCreatedAt(t: ZendeskTicket): string {
  return t.created_at_override ?? trimIso(t.created_at);
}

export function ticketUpdatedAt(t: ZendeskTicket): string {
  return t.updated_at_override ?? trimIso(t.updated_at);
}

export function formatUser(f: Fmt, u: ZendeskUser): Json {
  return {
    id: u.zd_id,
    url: apiUrl(f.baseUrl, `users/${u.zd_id}`),
    name: u.name,
    email: u.email,
    created_at: trimIso(u.created_at),
    updated_at: trimIso(u.updated_at),
    time_zone: u.time_zone,
    iana_time_zone: u.time_zone === "UTC" ? "Etc/UTC" : u.time_zone,
    phone: u.phone,
    shared_phone_number: null,
    photo: u.photo,
    locale_id: 1,
    locale: u.locale,
    organization_id: u.organization_id,
    role: u.role,
    verified: u.verified,
    external_id: u.external_id,
    tags: u.tags,
    alias: u.alias,
    active: u.active,
    shared: u.shared,
    shared_agent: u.shared_agent,
    last_login_at: u.last_login_at,
    two_factor_auth_enabled: false,
    signature: u.signature,
    details: u.details,
    notes: u.notes,
    role_type: u.role === "admin" ? 4 : u.role === "agent" ? 0 : null,
    custom_role_id: null,
    moderator: u.moderator,
    ticket_restriction: u.ticket_restriction,
    only_private_comments: u.only_private_comments,
    restricted_agent: u.restricted_agent,
    suspended: u.suspended,
    default_group_id: u.default_group_id,
    report_csv: false,
    user_fields: withFieldDefaults(f.zs, "user", u.user_fields),
    chat_only: false,
  };
}

function withFieldDefaults(zs: ZendeskStore, kind: "user" | "organization", values: Record<string, unknown>): Json {
  const defaults: Json = {};
  for (const field of zs.customFields.findBy("kind", kind)) defaults[field.key] = null;
  return { ...defaults, ...values };
}

export function formatOrganization(f: Fmt, o: ZendeskOrganization): Json {
  return {
    id: o.zd_id,
    url: apiUrl(f.baseUrl, `organizations/${o.zd_id}`),
    external_id: o.external_id,
    name: o.name,
    created_at: trimIso(o.created_at),
    updated_at: trimIso(o.updated_at),
    domain_names: o.domain_names,
    details: o.details,
    notes: o.notes,
    group_id: o.group_id,
    shared_tickets: o.shared_tickets,
    shared_comments: o.shared_comments,
    tags: o.tags,
    organization_fields: withFieldDefaults(f.zs, "organization", o.organization_fields),
  };
}

export function formatOrganizationMembership(f: Fmt, m: ZendeskOrganizationMembership): Json {
  const organization = f.zs.organizations.findOneBy("zd_id", m.organization_id);
  return {
    id: m.zd_id,
    url: apiUrl(f.baseUrl, `organization_memberships/${m.zd_id}`),
    user_id: m.user_id,
    organization_id: m.organization_id,
    organization_name: organization?.name ?? null,
    default: m.default,
    view_tickets: true,
    created_at: trimIso(m.created_at),
    updated_at: trimIso(m.updated_at),
  };
}

export function formatGroup(f: Fmt, g: ZendeskGroup): Json {
  return {
    id: g.zd_id,
    url: apiUrl(f.baseUrl, `groups/${g.zd_id}`),
    name: g.name,
    description: g.description,
    is_public: g.is_public,
    default: g.default,
    deleted: g.deleted,
    created_at: trimIso(g.created_at),
    updated_at: trimIso(g.updated_at),
  };
}

export function formatGroupMembership(f: Fmt, m: ZendeskGroupMembership): Json {
  return {
    id: m.zd_id,
    url: apiUrl(f.baseUrl, `group_memberships/${m.zd_id}`),
    user_id: m.user_id,
    group_id: m.group_id,
    default: m.default,
    created_at: trimIso(m.created_at),
    updated_at: trimIso(m.updated_at),
  };
}

export function attachmentUrl(f: Fmt, a: ZendeskAttachment): string {
  return `${f.baseUrl}/_zendesk/attachments/${a.zd_id}/${encodeURIComponent(a.file_name)}`;
}

export function formatAttachment(f: Fmt, a: ZendeskAttachment): Json {
  return {
    id: a.zd_id,
    url: apiUrl(f.baseUrl, `attachments/${a.zd_id}`),
    file_name: a.file_name,
    content_url: attachmentUrl(f, a),
    mapped_content_url: attachmentUrl(f, a),
    content_type: a.content_type,
    size: a.size,
    width: null,
    height: null,
    inline: a.inline,
    deleted: false,
    malware_access_override: false,
    malware_scan_result: "not_scanned",
    thumbnails: [],
  };
}

export function formatComment(f: Fmt, c: ZendeskComment): Json {
  const attachments = c.attachment_ids
    .map((id) => f.zs.attachments.findOneBy("zd_id", id))
    .filter((a): a is ZendeskAttachment => !!a)
    .map((a) => formatAttachment(f, a));
  return {
    id: c.zd_id,
    type: "Comment",
    author_id: c.author_id,
    body: c.redacted ? "▇▇▇▇" : c.body,
    html_body: c.redacted ? '<div class="zd-comment"><p>▇▇▇▇</p></div>' : c.html_body,
    plain_body: c.redacted ? "▇▇▇▇" : c.body,
    public: c.public,
    attachments,
    audit_id: c.audit_id,
    via: c.via,
    created_at: trimIso(c.created_at),
    metadata: {
      system: { client: "emulate", ip_address: "127.0.0.1", location: "Local", latitude: 0, longitude: 0 },
      custom: {},
    },
  };
}

export function formatAudit(f: Fmt, a: ZendeskAudit): Json {
  return {
    id: a.zd_id,
    ticket_id: a.ticket_id,
    created_at: trimIso(a.created_at),
    author_id: a.author_id,
    metadata: {
      system: { client: "emulate", ip_address: "127.0.0.1", location: "Local", latitude: 0, longitude: 0 },
      custom: {},
      ...a.metadata,
    },
    events: a.events.map((event) => {
      if (event.type !== "Comment") return event;
      const comment = f.zs.comments.findOneBy("zd_id", event.id);
      return comment
        ? {
            ...formatComment(f, comment),
            audit_id: undefined,
            via: undefined,
            created_at: undefined,
            metadata: undefined,
          }
        : event;
    }),
    via: a.via,
  };
}

export function formatSatisfactionRating(f: Fmt, r: ZendeskSatisfactionRating): Json {
  return {
    id: r.zd_id,
    url: apiUrl(f.baseUrl, `satisfaction_ratings/${r.zd_id}`),
    assignee_id: r.assignee_id,
    group_id: r.group_id,
    requester_id: r.requester_id,
    ticket_id: r.ticket_id,
    score: r.score,
    comment: r.comment,
    created_at: trimIso(r.created_at),
    updated_at: trimIso(r.updated_at),
  };
}

export function formatTicket(f: Fmt, t: ZendeskTicket): Json {
  const rating = t.satisfaction_rating_id
    ? f.zs.satisfactionRatings.findOneBy("zd_id", t.satisfaction_rating_id)
    : undefined;
  const incidents = t.type === "problem" ? f.zs.tickets.findBy("problem_id" as never, t.zd_id) : [];
  return {
    url: apiUrl(f.baseUrl, `tickets/${t.zd_id}`),
    id: t.zd_id,
    external_id: t.external_id,
    via: t.via,
    created_at: ticketCreatedAt(t),
    updated_at: ticketUpdatedAt(t),
    generated_timestamp: t.generated_timestamp,
    type: t.type,
    subject: t.subject,
    raw_subject: t.raw_subject,
    description: t.description,
    priority: t.priority,
    status: t.status === "deleted" ? "deleted" : t.status,
    recipient: t.recipient,
    requester_id: t.requester_id,
    submitter_id: t.submitter_id,
    assignee_id: t.assignee_id,
    organization_id: t.organization_id,
    group_id: t.group_id,
    collaborator_ids: t.collaborator_ids,
    follower_ids: t.follower_ids,
    email_cc_ids: t.email_cc_ids,
    forum_topic_id: null,
    problem_id: t.problem_id,
    has_incidents: incidents.length > 0,
    is_public: t.is_public,
    due_at: t.due_at,
    tags: t.tags,
    custom_fields: t.custom_fields,
    satisfaction_rating: rating ? { score: rating.score, id: rating.zd_id, comment: rating.comment } : null,
    sharing_agreement_ids: [],
    custom_status_id: t.custom_status_id,
    fields: t.custom_fields,
    followup_ids: t.followup_ids,
    ticket_form_id: t.ticket_form_id,
    brand_id: t.brand_id,
    allow_channelback: false,
    allow_attachments: true,
    from_messaging_channel: false,
    ...(t.deleted ? { deleted_ticket_id: t.zd_id, deleted_at: t.deleted_at } : {}),
  };
}

export function formatRequest(f: Fmt, t: ZendeskTicket, currentUserId: number | null): Json {
  return {
    id: t.zd_id,
    url: apiUrl(f.baseUrl, `requests/${t.zd_id}`),
    status: t.status,
    priority: t.priority,
    type: t.type,
    subject: t.subject,
    description: t.description,
    organization_id: t.organization_id,
    via: t.via,
    custom_fields: t.custom_fields,
    fields: t.custom_fields,
    requester_id: t.requester_id,
    collaborator_ids: t.collaborator_ids,
    email_cc_ids: t.email_cc_ids,
    is_public: t.is_public,
    due_at: t.due_at,
    can_be_solved_by_me: currentUserId === t.requester_id && (t.status === "open" || t.status === "pending"),
    created_at: ticketCreatedAt(t),
    updated_at: ticketUpdatedAt(t),
    recipient: t.recipient,
    followup_source_id: null,
    assignee_id: t.assignee_id,
    custom_status_id: t.custom_status_id,
    ticket_form_id: t.ticket_form_id,
    brand_id: t.brand_id,
  };
}

export function formatTicketMetrics(f: Fmt, t: ZendeskTicket): Json {
  const m = t.metrics;
  const minutes = (value: number | null) => (value === null ? null : { calendar: value, business: value });
  return {
    id: t.zd_id,
    url: apiUrl(f.baseUrl, `ticket_metrics/${t.zd_id}`),
    ticket_id: t.zd_id,
    created_at: ticketCreatedAt(t),
    updated_at: ticketUpdatedAt(t),
    group_stations: m.group_stations,
    assignee_stations: m.assignee_stations,
    reopens: m.reopens,
    replies: m.replies,
    assignee_updated_at: m.assignee_updated_at,
    requester_updated_at: m.requester_updated_at,
    status_updated_at: m.status_updated_at,
    initially_assigned_at: m.initially_assigned_at,
    assigned_at: m.assigned_at,
    solved_at: m.solved_at,
    latest_comment_added_at: m.latest_comment_added_at,
    reply_time_in_minutes: minutes(m.first_reply_minutes),
    first_resolution_time_in_minutes: minutes(m.full_resolution_minutes),
    full_resolution_time_in_minutes: minutes(m.full_resolution_minutes),
    agent_wait_time_in_minutes: minutes(0),
    requester_wait_time_in_minutes: minutes(m.full_resolution_minutes),
    on_hold_time_in_minutes: minutes(0),
    custom_status_updated_at: m.status_updated_at,
  };
}

const SYSTEM_FIELD_OPTIONS: Record<string, Array<{ name: string; value: string }>> = {
  status: [
    { name: "Open", value: "open" },
    { name: "Pending", value: "pending" },
    { name: "Solved", value: "solved" },
  ],
  priority: [
    { name: "Low", value: "low" },
    { name: "Normal", value: "normal" },
    { name: "High", value: "high" },
    { name: "Urgent", value: "urgent" },
  ],
  tickettype: [
    { name: "Question", value: "question" },
    { name: "Incident", value: "incident" },
    { name: "Problem", value: "problem" },
    { name: "Task", value: "task" },
  ],
};

export function formatTicketField(f: Fmt, field: ZendeskTicketField): Json {
  const custom = field.type === "tagger" || field.type === "multiselect";
  return {
    id: field.zd_id,
    url: apiUrl(f.baseUrl, `ticket_fields/${field.zd_id}`),
    type: field.type,
    title: field.title,
    raw_title: field.title,
    description: field.description,
    raw_description: field.description,
    position: field.position,
    active: field.active,
    required: field.required,
    collapsed_for_agents: field.collapsed_for_agents,
    regexp_for_validation: field.regexp_for_validation,
    title_in_portal: field.title_in_portal,
    raw_title_in_portal: field.title_in_portal,
    visible_in_portal: field.visible_in_portal,
    editable_in_portal: field.editable_in_portal,
    required_in_portal: field.required_in_portal,
    tag: field.tag,
    created_at: trimIso(field.created_at),
    updated_at: trimIso(field.updated_at),
    removable: field.removable,
    agent_description: field.agent_description,
    sub_type_id: null,
    ...(custom ? { custom_field_options: field.custom_field_options } : {}),
    ...(SYSTEM_FIELD_OPTIONS[field.type] ? { system_field_options: SYSTEM_FIELD_OPTIONS[field.type] } : {}),
  };
}

export function formatCustomField(f: Fmt, field: ZendeskCustomField): Json {
  return {
    id: field.zd_id,
    url: apiUrl(f.baseUrl, `${field.kind}_fields/${field.zd_id}`),
    key: field.key,
    type: field.type,
    title: field.title,
    raw_title: field.title,
    description: field.description,
    raw_description: field.description,
    position: field.position,
    active: field.active,
    system: false,
    regexp_for_validation: null,
    created_at: trimIso(field.created_at),
    updated_at: trimIso(field.updated_at),
    ...(field.type === "dropdown" || field.type === "multiselect"
      ? { custom_field_options: field.custom_field_options }
      : {}),
  };
}

export function formatMacro(f: Fmt, m: ZendeskMacro): Json {
  return {
    id: m.zd_id,
    url: apiUrl(f.baseUrl, `macros/${m.zd_id}`),
    title: m.title,
    description: m.description,
    active: m.active,
    position: m.position,
    actions: m.actions,
    restriction: m.restriction,
    created_at: trimIso(m.created_at),
    updated_at: trimIso(m.updated_at),
  };
}

export function formatTrigger(f: Fmt, t: ZendeskTrigger): Json {
  return {
    id: t.zd_id,
    url: apiUrl(f.baseUrl, `triggers/${t.zd_id}`),
    title: t.title,
    description: t.description,
    active: t.active,
    position: t.position,
    category_id: t.category_id,
    conditions: t.conditions,
    actions: t.actions,
    raw_title: t.title,
    created_at: trimIso(t.created_at),
    updated_at: trimIso(t.updated_at),
  };
}

export function formatView(f: Fmt, v: ZendeskView): Json {
  return {
    id: v.zd_id,
    url: apiUrl(f.baseUrl, `views/${v.zd_id}`),
    title: v.title,
    raw_title: v.title,
    description: v.description,
    active: v.active,
    position: v.position,
    conditions: v.conditions,
    execution: v.execution,
    restriction: v.restriction,
    created_at: trimIso(v.created_at),
    updated_at: trimIso(v.updated_at),
  };
}

export function formatWebhook(w: ZendeskWebhook, includeSecret = false): Json {
  return {
    id: w.zd_id,
    name: w.name,
    description: w.description,
    status: w.status,
    subscriptions: w.subscriptions,
    created_at: trimIso(w.created_at),
    created_by: w.created_by,
    updated_at: trimIso(w.updated_at),
    updated_by: w.updated_by,
    endpoint: w.endpoint,
    http_method: w.http_method,
    request_format: w.request_format,
    authentication: w.authentication
      ? {
          type: w.authentication.type,
          add_position: w.authentication.add_position,
          data: Object.fromEntries(
            Object.entries(w.authentication.data).filter(([key]) => key === "username" || key === "name"),
          ),
        }
      : null,
    custom_headers: w.custom_headers,
    ...(includeSecret ? { signing_secret: { algorithm: "SHA256", secret: w.signing_secret } } : {}),
  };
}

export function formatInvocation(i: ZendeskWebhookInvocation): Json {
  return {
    id: i.zd_id,
    webhook_id: i.webhook_id,
    status: i.status,
    status_code: i.status_code,
    latest_completed_attempt_at: trimIso(i.completed_at),
    event_type: i.event_type,
    trigger_id: i.trigger_id,
  };
}

export function formatInvocationAttempt(i: ZendeskWebhookInvocation): Json {
  return {
    id: `${i.zd_id}-1`,
    invocation_id: i.zd_id,
    status: i.status,
    status_code: i.status_code,
    completion_at: trimIso(i.completed_at),
    error_message: i.error_message,
    request: { headers: i.request_headers, body: i.request_body },
    response: { body: i.response_body },
  };
}

export function formatJobStatus(f: Fmt, j: ZendeskJobStatus): Json {
  return {
    id: j.zd_id,
    url: apiUrl(f.baseUrl, `job_statuses/${j.zd_id}`),
    total: j.total,
    progress: j.progress,
    status: j.status,
    message: j.message,
    results: j.results,
  };
}

export function formatCustomStatus(s: ZendeskCustomStatus): Json {
  return {
    id: s.zd_id,
    status_category: s.status_category,
    agent_label: s.agent_label,
    end_user_label: s.end_user_label,
    description: s.description,
    end_user_description: s.end_user_description,
    active: s.active,
    default: s.default,
    raw_agent_label: s.agent_label,
    raw_end_user_label: s.end_user_label,
    raw_description: s.description,
    raw_end_user_description: s.end_user_description,
    created_at: trimIso(s.created_at),
    updated_at: trimIso(s.updated_at),
  };
}

export function formatBrand(f: Fmt, b: ZendeskBrand): Json {
  return {
    id: b.zd_id,
    url: apiUrl(f.baseUrl, `brands/${b.zd_id}`),
    name: b.name,
    brand_url: b.brand_url,
    subdomain: b.subdomain,
    host_mapping: null,
    has_help_center: false,
    help_center_state: "disabled",
    active: b.active,
    default: b.default,
    is_deleted: false,
    logo: null,
    ticket_form_ids: f.zs.ticketForms.all().map((form) => form.zd_id),
    signature_template: "{{agent.signature}}",
    created_at: trimIso(b.created_at),
    updated_at: trimIso(b.updated_at),
  };
}

export function formatTicketForm(f: Fmt, form: ZendeskTicketForm): Json {
  return {
    id: form.zd_id,
    url: apiUrl(f.baseUrl, `ticket_forms/${form.zd_id}`),
    name: form.name,
    raw_name: form.name,
    display_name: form.display_name,
    raw_display_name: form.display_name,
    end_user_visible: form.end_user_visible,
    position: form.position,
    ticket_field_ids: form.ticket_field_ids,
    active: form.active,
    default: form.default,
    in_all_brands: true,
    restricted_brand_ids: [],
    end_user_conditions: [],
    agent_conditions: [],
    created_at: trimIso(form.created_at),
    updated_at: trimIso(form.updated_at),
  };
}

export function formatEventLog(f: Fmt, e: ZendeskEventLog): Json {
  return {
    account_id: f.zs.raw.getData<number>("zendesk.account_id") ?? 1,
    detail: e.detail,
    event: e.event,
    id: e.zd_id,
    subject: e.subject,
    time: e.time,
    type: e.type,
    zendesk_event_version: "2022-11-06",
  };
}

export function accountSubdomain(f: Fmt): string {
  return subdomain(f.zs);
}
