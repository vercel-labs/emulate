import { Store, type Collection } from "@emulators/core";
import type {
  AsanaUser,
  AsanaWorkspace,
  AsanaTeam,
  AsanaTeamMembership,
  AsanaProject,
  AsanaSection,
  AsanaTask,
  AsanaTaskProject,
  AsanaTaskTag,
  AsanaTaskDependency,
  AsanaTag,
  AsanaStory,
  AsanaWebhook,
} from "./entities.js";

export interface AsanaStore {
  users: Collection<AsanaUser>;
  workspaces: Collection<AsanaWorkspace>;
  teams: Collection<AsanaTeam>;
  teamMemberships: Collection<AsanaTeamMembership>;
  projects: Collection<AsanaProject>;
  sections: Collection<AsanaSection>;
  tasks: Collection<AsanaTask>;
  taskProjects: Collection<AsanaTaskProject>;
  taskTags: Collection<AsanaTaskTag>;
  taskDependencies: Collection<AsanaTaskDependency>;
  tags: Collection<AsanaTag>;
  stories: Collection<AsanaStory>;
  webhooks: Collection<AsanaWebhook>;
}

export function getAsanaStore(store: Store): AsanaStore {
  return {
    users: store.collection<AsanaUser>("asana.users", ["gid", "email"]),
    workspaces: store.collection<AsanaWorkspace>("asana.workspaces", ["gid"]),
    teams: store.collection<AsanaTeam>("asana.teams", ["gid", "workspace_gid"]),
    teamMemberships: store.collection<AsanaTeamMembership>("asana.team_memberships", ["gid", "team_gid", "user_gid"]),
    projects: store.collection<AsanaProject>("asana.projects", ["gid", "workspace_gid", "team_gid"]),
    sections: store.collection<AsanaSection>("asana.sections", ["gid", "project_gid"]),
    tasks: store.collection<AsanaTask>("asana.tasks", ["gid", "workspace_gid", "assignee_gid", "parent_gid"]),
    taskProjects: store.collection<AsanaTaskProject>("asana.task_projects", ["task_gid", "project_gid"]),
    taskTags: store.collection<AsanaTaskTag>("asana.task_tags", ["task_gid", "tag_gid"]),
    taskDependencies: store.collection<AsanaTaskDependency>("asana.task_dependencies", ["task_gid", "dependency_gid"]),
    tags: store.collection<AsanaTag>("asana.tags", ["gid", "workspace_gid"]),
    stories: store.collection<AsanaStory>("asana.stories", ["gid", "task_gid"]),
    webhooks: store.collection<AsanaWebhook>("asana.webhooks", ["gid"]),
  };
}
