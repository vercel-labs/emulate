import type { Entity } from "@emulators/core";

export interface AsanaUser extends Entity {
  gid: string;
  resource_type: "user";
  name: string;
  email: string;
  photo: {
    image_21x21: string;
    image_27x27: string;
    image_36x36: string;
    image_60x60: string;
    image_128x128: string;
  } | null;
}

export interface AsanaWorkspace extends Entity {
  gid: string;
  resource_type: "workspace";
  name: string;
  is_organization: boolean;
  email_domains: string[];
}

export interface AsanaTeam extends Entity {
  gid: string;
  resource_type: "team";
  name: string;
  workspace_gid: string;
  description: string;
  html_description: string;
  visibility: "secret" | "request_to_join" | "public";
  permalink_url: string;
}

export interface AsanaTeamMembership extends Entity {
  gid: string;
  resource_type: "team_membership";
  user_gid: string;
  team_gid: string;
  is_guest: boolean;
  is_admin: boolean;
}

export interface AsanaProject extends Entity {
  gid: string;
  resource_type: "project";
  name: string;
  workspace_gid: string;
  owner_gid: string | null;
  team_gid: string | null;
  archived: boolean;
  color: string | null;
  notes: string;
  html_notes: string;
  privacy_setting: "public_to_workspace" | "private_to_team" | "private";
  default_view: "list" | "board" | "calendar" | "timeline";
  completed: boolean;
  completed_at: string | null;
  permalink_url: string;
}

export interface AsanaSection extends Entity {
  gid: string;
  resource_type: "section";
  name: string;
  project_gid: string;
}

export interface AsanaTask extends Entity {
  gid: string;
  resource_type: "task";
  resource_subtype: "default_task" | "milestone" | "approval";
  name: string;
  assignee_gid: string | null;
  workspace_gid: string;
  completed: boolean;
  completed_at: string | null;
  due_on: string | null;
  due_at: string | null;
  start_on: string | null;
  notes: string;
  html_notes: string;
  liked: boolean;
  num_likes: number;
  parent_gid: string | null;
  permalink_url: string;
  follower_gids: string[];
}

export interface AsanaTaskProject extends Entity {
  task_gid: string;
  project_gid: string;
  section_gid: string | null;
}

export interface AsanaTaskTag extends Entity {
  task_gid: string;
  tag_gid: string;
}

export interface AsanaTaskDependency extends Entity {
  task_gid: string;
  dependency_gid: string;
}

export interface AsanaTag extends Entity {
  gid: string;
  resource_type: "tag";
  name: string;
  workspace_gid: string;
  color: string | null;
  permalink_url: string;
}

export interface AsanaStory extends Entity {
  gid: string;
  resource_type: "story";
  resource_subtype: string;
  task_gid: string;
  text: string;
  html_text: string;
  type: "comment" | "system";
  is_editable: boolean;
  created_by_gid: string;
}

export interface AsanaWebhook extends Entity {
  gid: string;
  resource_type: "webhook";
  resource_gid: string;
  target: string;
  active: boolean;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_content: string;
}
