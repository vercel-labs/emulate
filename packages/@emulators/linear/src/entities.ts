import type { Entity } from "@emulators/core";

export interface LinearApiKey extends Entity {
  key: string;
}

export interface LinearOrganization extends Entity {
  linear_id: string;
  name: string;
  url_key: string | null;
}

export interface LinearUser extends Entity {
  linear_id: string;
  name: string;
  email: string;
  display_name: string | null;
  active: boolean;
  admin: boolean;
  organization_id: string | null;
}

export type LinearWorkflowStateType = "backlog" | "unstarted" | "started" | "completed" | "canceled";

export interface LinearTeam extends Entity {
  linear_id: string;
  name: string;
  key: string;
  description: string | null;
  organization_id: string;
}

export interface LinearWorkflowState extends Entity {
  linear_id: string;
  name: string;
  type: LinearWorkflowStateType;
  position: number;
  color: string;
  team_id: string;
}

export interface LinearLabel extends Entity {
  linear_id: string;
  name: string;
  color: string;
  description: string | null;
  team_id: string | null;
}

export interface LinearProject extends Entity {
  linear_id: string;
  name: string;
  description: string | null;
  slug_id: string;
  state: string;
  team_id: string | null;
  lead_id: string | null;
  target_date: string | null;
}

export interface LinearIssue extends Entity {
  linear_id: string;
  identifier: string;
  number: number;
  title: string;
  description: string | null;
  priority: number;
  estimate: number | null;
  url: string;
  team_id: string;
  state_id: string | null;
  assignee_id: string | null;
  creator_id: string | null;
  project_id: string | null;
  label_ids: string[];
}
