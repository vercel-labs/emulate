import type { Entity } from "@emulators/core";

export type LinearWorkflowStateType = "backlog" | "unstarted" | "started" | "completed" | "canceled";
export type LinearTokenType = "personal" | "oauth_access" | "oauth_refresh" | "client_credentials";
export type LinearTokenActorType = "user" | "app";
export type LinearIssuePriority = 0 | 1 | 2 | 3 | 4;
export type LinearAgentActivityType = "thought" | "elicitation" | "action" | "response" | "error" | "prompt";
export type LinearAgentActivitySignal = "auth" | "continue" | "select" | "stop";
export type LinearAgentSessionStatus =
  | "pending"
  | "active"
  | "awaitingInput"
  | "complete"
  | "error"
  | "stale"
  | "stopping";
export type LinearAgentPlanEntryStatus = "pending" | "inProgress" | "completed" | "canceled";

/** The content of an agent activity, matching the members of Linear's AgentActivityContent union. */
export type LinearAgentActivityContent =
  | { type: "thought" | "elicitation" | "response"; body: string }
  | { type: "error"; body: string; reasonCode?: string }
  | { type: "prompt"; body: string; title?: string }
  | { type: "action"; action: string; parameter: string; result?: string };

export interface LinearAgentExternalLink {
  label: string;
  url: string;
}

export interface LinearAgentPlan {
  entries: Array<{ content: string; status: LinearAgentPlanEntryStatus }>;
  updatedAt: string;
}

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
  /** Hex color. States created before colors were stored use the default for their type. */
  color?: string;
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
  slug_id: string;
  issue_id: string | null;
  comment_id: string | null;
  /** The app user that owns the session. */
  agent_user_id: string;
  /** The human responsible for the session. Null when an agent started it. */
  creator_id: string | null;
  status: LinearAgentSessionStatus;
  /** A plan accepted by agentSessionUpdate, or the free-form string the earlier emulator input took. */
  plan: LinearAgentPlan | string | null;
  summary: string | null;
  external_link: string | null;
  external_links: LinearAgentExternalLink[];
  started_at: string | null;
  ended_at: string | null;
  dismissed_at: string | null;
  dismissed_by_id: string | null;
  archived_at: string | null;
}

export interface LinearAgentActivity extends Entity {
  linear_id: string;
  session_id: string;
  user_id: string;
  content: LinearAgentActivityContent;
  ephemeral: boolean;
  signal: LinearAgentActivitySignal | null;
  signal_metadata: Record<string, unknown> | null;
  contextual_metadata: Record<string, unknown> | null;
  archived_at: string | null;
}
