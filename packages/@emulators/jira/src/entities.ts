import type { Entity } from "@emulators/core";

export type JiraStatusCategory = "new" | "indeterminate" | "done";
export type JiraAccountType = "atlassian" | "app" | "customer";
export type JiraBoardType = "scrum" | "kanban";
export type JiraSprintState = "future" | "active" | "closed";
export type JiraCustomFieldType = "string" | "number" | "date" | "datetime" | "option" | "array" | "user" | "sprint";

/** Atlassian Document Format node. Kept loose because ADF is an open tree. */
export interface AdfNode {
  type: string;
  version?: number;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: AdfNode[];
}

export interface JiraSite extends Entity {
  cloud_id: string;
  name: string;
}

export interface JiraUser extends Entity {
  account_id: string;
  email: string;
  display_name: string;
  active: boolean;
  account_type: JiraAccountType;
  time_zone: string;
  locale: string;
  admin: boolean;
}

export interface JiraApiToken extends Entity {
  token: string;
  account_id: string;
  label: string;
}

export interface JiraProject extends Entity {
  key: string;
  name: string;
  description: string;
  lead_account_id: string | null;
  project_type_key: "software" | "business" | "service_desk";
  issue_sequence: number;
  status_ids: number[];
  issue_type_ids: number[];
}

export interface JiraIssueType extends Entity {
  name: string;
  description: string;
  subtask: boolean;
  hierarchy_level: number;
}

export interface JiraStatus extends Entity {
  name: string;
  description: string;
  category: JiraStatusCategory;
}

export interface JiraPriority extends Entity {
  name: string;
  description: string;
  color: string;
}

export interface JiraResolution extends Entity {
  name: string;
  description: string;
}

export interface JiraCustomField extends Entity {
  field_id: string;
  name: string;
  type: JiraCustomFieldType;
  options: string[];
}

export interface JiraIssue extends Entity {
  key: string;
  number: number;
  project_id: number;
  issue_type_id: number;
  summary: string;
  description: AdfNode | null;
  environment: AdfNode | null;
  status_id: number;
  status_changed_at: string;
  priority_id: number | null;
  resolution_id: number | null;
  resolution_date: string | null;
  assignee_id: string | null;
  reporter_id: string | null;
  creator_id: string | null;
  parent_id: number | null;
  labels: string[];
  component_ids: number[];
  fix_version_ids: number[];
  due_date: string | null;
  custom_fields: Record<string, unknown>;
  watcher_ids: string[];
  sprint_id: number | null;
  closed_sprint_ids: number[];
}

export interface JiraComment extends Entity {
  issue_id: number;
  author_id: string | null;
  update_author_id: string | null;
  body: AdfNode;
}

export interface JiraChangelogItem {
  field: string;
  fieldtype: "jira" | "custom";
  fieldId: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
}

export interface JiraChangelog extends Entity {
  issue_id: number;
  author_id: string | null;
  items: JiraChangelogItem[];
}

export interface JiraWorklog extends Entity {
  issue_id: number;
  author_id: string | null;
  update_author_id: string | null;
  comment: AdfNode | null;
  started: string;
  time_spent_seconds: number;
}

export interface JiraIssueLinkType extends Entity {
  name: string;
  inward: string;
  outward: string;
}

export interface JiraIssueLink extends Entity {
  type_id: number;
  inward_issue_id: number;
  outward_issue_id: number;
}

export interface JiraComponent extends Entity {
  project_id: number;
  name: string;
  description: string;
  lead_account_id: string | null;
}

export interface JiraVersion extends Entity {
  project_id: number;
  name: string;
  description: string;
  released: boolean;
  archived: boolean;
  start_date: string | null;
  release_date: string | null;
}

export interface JiraBoard extends Entity {
  name: string;
  type: JiraBoardType;
  project_id: number;
}

export interface JiraSprint extends Entity {
  board_id: number;
  name: string;
  state: JiraSprintState;
  goal: string;
  start_date: string | null;
  end_date: string | null;
  complete_date: string | null;
}

export interface JiraWebhook extends Entity {
  name: string;
  url: string;
  events: string[];
  jql_filter: string | null;
  enabled: boolean;
  exclude_body: boolean;
  secret: string | null;
  kind: "admin" | "dynamic";
  client_id: string | null;
  expiration_date: string | null;
}

export interface JiraWebhookDelivery extends Entity {
  webhook_id: number;
  event: string;
  url: string;
  status: number | null;
  error: string | null;
  payload: unknown;
  headers: Record<string, string>;
}

export interface JiraOAuthApp extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
  scopes: string[];
}

export interface JiraOAuthToken extends Entity {
  token: string;
  type: "access" | "refresh";
  account_id: string;
  client_id: string;
  scopes: string[];
  expires_at: string | null;
  revoked: boolean;
}
