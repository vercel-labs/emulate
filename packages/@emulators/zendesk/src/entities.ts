import type { Entity } from "@emulators/core";

export type UserRole = "end-user" | "agent" | "admin";
export type TicketStatus = "new" | "open" | "pending" | "hold" | "solved" | "closed" | "deleted";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketType = "problem" | "incident" | "question" | "task";
export type Channel = "api" | "web" | "email" | "chat" | "voice" | "system" | "rule";

export interface Via {
  channel: Channel;
  source: {
    from: Record<string, unknown>;
    to: Record<string, unknown>;
    rel: string | null;
  };
}

export interface CustomFieldValue {
  id: number;
  value: unknown;
}

export interface ZendeskApiToken extends Entity {
  token: string;
  email: string | null;
  description: string;
}

export interface ZendeskOAuthToken extends Entity {
  token: string;
  user_id: number;
  scopes: string[];
}

export interface ZendeskUser extends Entity {
  zd_id: number;
  name: string;
  email: string | null;
  role: UserRole;
  active: boolean;
  verified: boolean;
  suspended: boolean;
  organization_id: number | null;
  default_group_id: number | null;
  external_id: string | null;
  alias: string | null;
  details: string | null;
  notes: string | null;
  phone: string | null;
  locale: string;
  time_zone: string;
  tags: string[];
  user_fields: Record<string, unknown>;
  password: string | null;
  last_login_at: string | null;
  signature: string | null;
  moderator: boolean;
  ticket_restriction: string | null;
  only_private_comments: boolean;
  restricted_agent: boolean;
  shared: boolean;
  shared_agent: boolean;
  photo: Record<string, unknown> | null;
  deleted: boolean;
}

export interface ZendeskOrganization extends Entity {
  zd_id: number;
  name: string;
  details: string | null;
  notes: string | null;
  domain_names: string[];
  external_id: string | null;
  group_id: number | null;
  shared_tickets: boolean;
  shared_comments: boolean;
  tags: string[];
  organization_fields: Record<string, unknown>;
  deleted: boolean;
}

export interface ZendeskOrganizationMembership extends Entity {
  zd_id: number;
  user_id: number;
  organization_id: number;
  default: boolean;
}

export interface ZendeskGroup extends Entity {
  zd_id: number;
  name: string;
  description: string | null;
  is_public: boolean;
  default: boolean;
  deleted: boolean;
}

export interface ZendeskGroupMembership extends Entity {
  zd_id: number;
  user_id: number;
  group_id: number;
  default: boolean;
}

export interface ZendeskAttachment extends Entity {
  zd_id: number;
  token: string | null;
  file_name: string;
  content_type: string;
  size: number;
  content: string;
  comment_id: number | null;
  inline: boolean;
}

export interface ZendeskComment extends Entity {
  zd_id: number;
  ticket_id: number;
  audit_id: number;
  author_id: number;
  body: string;
  html_body: string;
  public: boolean;
  attachment_ids: number[];
  via: Via;
  redacted: boolean;
}

export interface AuditEvent {
  id: number;
  type: string;
  [key: string]: unknown;
}

export interface ZendeskAudit extends Entity {
  zd_id: number;
  ticket_id: number;
  author_id: number;
  events: AuditEvent[];
  via: Via;
  metadata: Record<string, unknown>;
}

export interface TicketMetrics {
  assigned_at: string | null;
  initially_assigned_at: string | null;
  solved_at: string | null;
  status_updated_at: string;
  requester_updated_at: string;
  assignee_updated_at: string | null;
  latest_comment_added_at: string | null;
  reopens: number;
  replies: number;
  group_stations: number;
  assignee_stations: number;
  first_reply_minutes: number | null;
  full_resolution_minutes: number | null;
}

export interface ZendeskTicket extends Entity {
  zd_id: number;
  subject: string;
  raw_subject: string;
  description: string;
  status: TicketStatus;
  custom_status_id: number;
  priority: TicketPriority | null;
  type: TicketType | null;
  requester_id: number;
  submitter_id: number;
  assignee_id: number | null;
  group_id: number | null;
  organization_id: number | null;
  brand_id: number;
  ticket_form_id: number;
  external_id: string | null;
  recipient: string | null;
  collaborator_ids: number[];
  email_cc_ids: number[];
  follower_ids: number[];
  problem_id: number | null;
  due_at: string | null;
  tags: string[];
  custom_fields: CustomFieldValue[];
  via: Via;
  is_public: boolean;
  satisfaction_rating_id: number | null;
  followup_ids: number[];
  metrics: TicketMetrics;
  deleted: boolean;
  deleted_at: string | null;
  spam: boolean;
  generated_timestamp: number;
  created_at_override: string | null;
  updated_at_override: string | null;
}

export type FieldType =
  | "subject"
  | "description"
  | "status"
  | "tickettype"
  | "priority"
  | "group"
  | "assignee"
  | "custom_status"
  | "text"
  | "textarea"
  | "checkbox"
  | "date"
  | "integer"
  | "decimal"
  | "regexp"
  | "tagger"
  | "multiselect"
  | "lookup"
  | "dropdown";

export interface FieldOption {
  id: number;
  name: string;
  raw_name: string;
  value: string;
  default: boolean;
}

export interface ZendeskTicketField extends Entity {
  zd_id: number;
  type: FieldType;
  title: string;
  description: string;
  position: number;
  active: boolean;
  required: boolean;
  required_in_portal: boolean;
  visible_in_portal: boolean;
  editable_in_portal: boolean;
  collapsed_for_agents: boolean;
  title_in_portal: string;
  agent_description: string | null;
  tag: string | null;
  regexp_for_validation: string | null;
  removable: boolean;
  custom_field_options: FieldOption[];
  system_field_options: Array<{ name: string; value: string }>;
}

export interface ZendeskCustomField extends Entity {
  zd_id: number;
  kind: "user" | "organization";
  key: string;
  type: string;
  title: string;
  description: string;
  position: number;
  active: boolean;
  custom_field_options: FieldOption[];
}

export interface RuleCondition {
  field: string;
  operator: string;
  value: unknown;
}

export interface RuleConditions {
  all: RuleCondition[];
  any: RuleCondition[];
}

export interface RuleAction {
  field: string;
  value: unknown;
}

export interface ZendeskMacro extends Entity {
  zd_id: number;
  title: string;
  description: string | null;
  active: boolean;
  position: number;
  actions: RuleAction[];
  restriction: Record<string, unknown> | null;
}

export interface ZendeskTrigger extends Entity {
  zd_id: number;
  title: string;
  description: string | null;
  active: boolean;
  position: number;
  category_id: string | null;
  conditions: RuleConditions;
  actions: RuleAction[];
}

export interface ZendeskView extends Entity {
  zd_id: number;
  title: string;
  description: string | null;
  active: boolean;
  position: number;
  conditions: RuleConditions;
  execution: Record<string, unknown>;
  restriction: Record<string, unknown> | null;
}

export type WebhookStatus = "active" | "inactive";

export interface WebhookAuthentication {
  type: "basic_auth" | "bearer_token" | "api_key";
  data: Record<string, string>;
  add_position: "header";
}

export interface ZendeskWebhook extends Entity {
  zd_id: string;
  name: string;
  description: string | null;
  status: WebhookStatus;
  endpoint: string;
  http_method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  request_format: "json" | "xml" | "form_encoded";
  subscriptions: string[];
  authentication: WebhookAuthentication | null;
  custom_headers: Record<string, string>;
  signing_secret: string;
  created_by: string;
  updated_by: string;
}

export interface ZendeskWebhookInvocation extends Entity {
  zd_id: string;
  webhook_id: string;
  event_type: string | null;
  trigger_id: number | null;
  status: "success" | "failed";
  status_code: number | null;
  request_body: string;
  request_headers: Record<string, string>;
  response_body: string | null;
  error_message: string | null;
  completed_at: string;
}

export interface JobResult {
  id?: number | string;
  index?: number;
  action?: string;
  status?: string;
  success?: boolean;
  errors?: string;
  error?: string;
  details?: string;
  [key: string]: unknown;
}

export interface ZendeskJobStatus extends Entity {
  zd_id: string;
  status: "queued" | "working" | "failed" | "completed" | "killed";
  message: string | null;
  progress: number;
  total: number;
  results: JobResult[];
}

export interface ZendeskSatisfactionRating extends Entity {
  zd_id: number;
  ticket_id: number;
  requester_id: number;
  assignee_id: number | null;
  group_id: number | null;
  score: "offered" | "unoffered" | "good" | "bad";
  comment: string | null;
}

export interface ZendeskCustomStatus extends Entity {
  zd_id: number;
  status_category: "new" | "open" | "pending" | "hold" | "solved";
  agent_label: string;
  end_user_label: string;
  description: string;
  end_user_description: string;
  active: boolean;
  default: boolean;
}

export interface ZendeskBrand extends Entity {
  zd_id: number;
  name: string;
  subdomain: string;
  brand_url: string;
  default: boolean;
  active: boolean;
}

export interface ZendeskTicketForm extends Entity {
  zd_id: number;
  name: string;
  display_name: string;
  position: number;
  active: boolean;
  default: boolean;
  end_user_visible: boolean;
  ticket_field_ids: number[];
}

export interface ZendeskEventLog extends Entity {
  zd_id: string;
  type: string;
  subject: string;
  detail: Record<string, unknown>;
  event: Record<string, unknown>;
  time: string;
}
