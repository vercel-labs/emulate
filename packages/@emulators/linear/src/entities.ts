import type { Entity } from "@emulators/core";

export type LinearWorkflowStateType = "backlog" | "unstarted" | "started" | "completed" | "canceled";
export type LinearTokenType = "personal" | "oauth_access" | "oauth_refresh" | "client_credentials";
export type LinearTokenActorType = "user" | "app";
export type LinearIssuePriority = 0 | 1 | 2 | 3 | 4;
export type LinearAgentActivityType = "thought" | "elicitation" | "action" | "response" | "error" | "prompt";
export type LinearAgentActivitySignal = "auth" | "continue" | "select" | "stop";
export type LinearAgentSessionStatus = "pending" | "active" | "awaitingInput" | "complete" | "error" | "stale";
export type LinearAgentPlanStepStatus = "pending" | "inProgress" | "completed" | "canceled";

export interface LinearAgentPlanStep {
  content: string;
  status: LinearAgentPlanStepStatus;
}

export interface LinearAgentExternalUrl {
  label: string;
  url: string;
}

/** Discriminated activity content matching Linear Agent Interaction payloads. */
export type LinearAgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string; reasonCode?: string }
  | { type: "prompt"; body: string; title?: string }
  | { type: "action"; action: string; parameter: string; result?: string };

export interface LinearAgentSelectOption {
  label?: string;
  value: string;
}

export interface LinearAgentAuthSignalMetadata {
  url: string;
  userId?: string;
  providerName?: string;
}

export interface LinearAgentSelectSignalMetadata {
  options: LinearAgentSelectOption[];
}

export type LinearAgentActivitySignalMetadata = LinearAgentAuthSignalMetadata | LinearAgentSelectSignalMetadata;

export interface LinearOrganization extends Entity {
  linear_id: string;
  name: string;
  url_key: string;
  url: string;
}

export interface LinearUser extends Entity {
  linear_id: string;
  email: string;
  name: string;
  display_name: string;
  avatar_url: string | null;
  active: boolean;
  admin: boolean;
  app: boolean;
}

export interface LinearTeam extends Entity {
  linear_id: string;
  key: string;
  name: string;
  description: string | null;
  private: boolean;
  url: string;
  issue_sequence: number;
}

export interface LinearWorkflowState extends Entity {
  linear_id: string;
  team_id: string;
  name: string;
  type: LinearWorkflowStateType;
  position: number;
}

export interface LinearIssueLabel extends Entity {
  linear_id: string;
  team_id: string | null;
  name: string;
  color: string;
  description: string | null;
}

export interface LinearProject extends Entity {
  linear_id: string;
  team_id: string | null;
  name: string;
  description: string | null;
  state: "planned" | "started" | "completed" | "canceled";
}

export interface LinearCycle extends Entity {
  linear_id: string;
  team_id: string;
  name: string;
  number: number;
  starts_at: string | null;
  ends_at: string | null;
}

export interface LinearIssue extends Entity {
  linear_id: string;
  identifier: string;
  number: number;
  team_id: string;
  title: string;
  description: string | null;
  priority: LinearIssuePriority;
  state_id: string;
  assignee_id: string | null;
  creator_id: string | null;
  delegate_id: string | null;
  project_id: string | null;
  cycle_id: string | null;
  label_ids: string[];
  url: string;
  archived_at: string | null;
  canceled_at: string | null;
  completed_at: string | null;
  started_at: string | null;
  due_date: string | null;
  create_as_user: string | null;
  display_icon_url: string | null;
}

export interface LinearComment extends Entity {
  linear_id: string;
  issue_id: string;
  user_id: string | null;
  body: string;
  create_as_user: string | null;
  display_icon_url: string | null;
}

export interface LinearOAuthApp extends Entity {
  linear_id: string;
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
  scopes: string[];
  actor: LinearTokenActorType;
  assignable: boolean;
  mentionable: boolean;
  app_user_id: string | null;
}

export interface LinearToken extends Entity {
  token: string;
  type: LinearTokenType;
  actor_type: LinearTokenActorType;
  user_id: string | null;
  app_id: string | null;
  scopes: string[];
  expires_at: string | null;
  revoked: boolean;
  refresh_token: string | null;
}

export interface LinearWebhook extends Entity {
  linear_id: string;
  label: string;
  url: string;
  enabled: boolean;
  resource_types: string[];
  team_id: string | null;
  all_public_teams: boolean;
  secret: string | null;
  creator_id: string | null;
}

export interface LinearWebhookDelivery extends Entity {
  linear_id: string;
  webhook_id: string;
  event: string;
  action: string;
  url: string;
  status: number | null;
  error: string | null;
  payload: unknown;
  headers: Record<string, string>;
}

export interface LinearAgentSession extends Entity {
  linear_id: string;
  issue_id: string | null;
  comment_id: string | null;
  agent_user_id: string;
  creator_id: string | null;
  oauth_client_id: string;
  status: LinearAgentSessionStatus;
  plan: LinearAgentPlanStep[] | null;
  external_link: string | null;
  external_urls: LinearAgentExternalUrl[];
  started_at: string | null;
  ended_at: string | null;
  summary: string | null;
}

export interface LinearAgentActivity extends Entity {
  linear_id: string;
  session_id: string;
  user_id: string;
  source_comment_id: string | null;
  content: LinearAgentActivityContent;
  contextual_metadata: Record<string, unknown> | null;
  archived_at: string | null;
  ephemeral: boolean;
  queued: boolean;
  sent_at: string | null;
  signal: LinearAgentActivitySignal | null;
  signal_metadata: LinearAgentActivitySignalMetadata | null;
}
