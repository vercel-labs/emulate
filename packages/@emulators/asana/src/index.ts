import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getAsanaStore } from "./store.js";
import { generateGid } from "./helpers.js";
import { userRoutes } from "./routes/users.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { projectRoutes } from "./routes/projects.js";
import { sectionRoutes } from "./routes/sections.js";
import { taskRoutes } from "./routes/tasks.js";
import { tagRoutes } from "./routes/tags.js";
import { storyRoutes } from "./routes/stories.js";
import { teamRoutes } from "./routes/teams.js";
import { webhookRoutes } from "./routes/webhooks.js";

export { getAsanaStore, type AsanaStore } from "./store.js";
export * from "./entities.js";

export interface AsanaSeedConfig {
  port?: number;
  workspaces?: Array<{
    name: string;
    is_organization?: boolean;
  }>;
  users?: Array<{
    name: string;
    email?: string;
  }>;
  teams?: Array<{
    name: string;
    workspace?: string;
    visibility?: "secret" | "request_to_join" | "public";
  }>;
  projects?: Array<{
    name: string;
    workspace?: string;
    team?: string;
    owner?: string;
    color?: string;
    default_view?: "list" | "board" | "calendar" | "timeline";
  }>;
  sections?: Array<{
    name: string;
    project?: string;
  }>;
  tasks?: Array<{
    name: string;
    project?: string;
    section?: string;
    assignee?: string;
    completed?: boolean;
    due_on?: string;
  }>;
  tags?: Array<{
    name: string;
    workspace?: string;
    color?: string;
  }>;
}

export function seedFromConfig(store: Store, baseUrl: string, config: AsanaSeedConfig): void {
  const as = getAsanaStore(store);

  if (config.workspaces) {
    for (const ws of config.workspaces) {
      const existing = as.workspaces.all().find((w) => w.name === ws.name);
      if (existing) continue;
      as.workspaces.insert({
        gid: generateGid(),
        resource_type: "workspace",
        name: ws.name,
        is_organization: ws.is_organization ?? false,
        email_domains: [],
      });
    }
  }

  const defaultWorkspace = as.workspaces.all()[0];
  const findWorkspaceGid = (name?: string): string | undefined =>
    name ? (as.workspaces.all().find((w) => w.name === name)?.gid ?? defaultWorkspace?.gid) : defaultWorkspace?.gid;

  if (config.users) {
    for (const u of config.users) {
      const email = u.email ?? `${u.name.toLowerCase().replace(/\s+/g, ".")}@example.com`;
      const existing = as.users.findOneBy("email", email);
      if (existing) continue;
      as.users.insert({
        gid: generateGid(),
        resource_type: "user",
        name: u.name,
        email,
        photo: null,
      });
    }
  }

  if (config.teams) {
    for (const t of config.teams) {
      const existing = as.teams.all().find((team) => team.name === t.name);
      if (existing) continue;

      const wsGid = findWorkspaceGid(t.workspace);
      if (!wsGid) continue;

      as.teams.insert({
        gid: generateGid(),
        resource_type: "team",
        name: t.name,
        workspace_gid: wsGid,
        description: "",
        html_description: "",
        visibility: t.visibility ?? "secret",
        permalink_url: "",
      });
    }
  }

  if (config.projects) {
    for (const p of config.projects) {
      const existing = as.projects.all().find((proj) => proj.name === p.name);
      if (existing) continue;

      const wsGid = findWorkspaceGid(p.workspace);
      if (!wsGid) continue;

      const ownerGid = p.owner
        ? (as.users.all().find((u) => u.name === p.owner)?.gid ?? null)
        : null;
      const teamGid = p.team
        ? (as.teams.all().find((t) => t.name === p.team)?.gid ?? null)
        : null;

      as.projects.insert({
        gid: generateGid(),
        resource_type: "project",
        name: p.name,
        workspace_gid: wsGid,
        owner_gid: ownerGid,
        team_gid: teamGid,
        archived: false,
        color: p.color ?? null,
        notes: "",
        html_notes: "",
        privacy_setting: "public_to_workspace",
        default_view: p.default_view ?? "list",
        completed: false,
        completed_at: null,
        permalink_url: "",
      });
    }
  }

  if (config.sections) {
    for (const s of config.sections) {
      const project = s.project ? as.projects.all().find((p) => p.name === s.project) : null;
      if (!project) continue;

      const existing = as.sections.findBy("project_gid", project.gid).find((sec) => sec.name === s.name);
      if (existing) continue;

      as.sections.insert({
        gid: generateGid(),
        resource_type: "section",
        name: s.name,
        project_gid: project.gid,
      });
    }
  }

  if (config.tags) {
    for (const t of config.tags) {
      const wsGid = findWorkspaceGid(t.workspace);
      if (!wsGid) continue;

      const existing = as.tags.findBy("workspace_gid", wsGid).find((tag) => tag.name === t.name);
      if (existing) continue;

      as.tags.insert({
        gid: generateGid(),
        resource_type: "tag",
        name: t.name,
        workspace_gid: wsGid,
        color: t.color ?? null,
        permalink_url: "",
      });
    }
  }

  // Seed tasks
  if (config.tasks) {
    for (const t of config.tasks) {
      const project = t.project ? as.projects.all().find((p) => p.name === t.project) : null;
      const wsGid = project?.workspace_gid ?? defaultWorkspace?.gid;
      if (!wsGid) continue;

      const assigneeGid = t.assignee
        ? (as.users.all().find((u) => u.name === t.assignee)?.gid ?? null)
        : null;

      const taskGid = generateGid();
      as.tasks.insert({
        gid: taskGid,
        resource_type: "task",
        resource_subtype: "default_task",
        name: t.name,
        assignee_gid: assigneeGid,
        workspace_gid: wsGid,
        completed: t.completed ?? false,
        completed_at: null,
        due_on: t.due_on ?? null,
        due_at: null,
        start_on: null,
        notes: "",
        html_notes: "",
        liked: false,
        num_likes: 0,
        parent_gid: null,
        permalink_url: "",
        follower_gids: [],
      });

      if (project) {
        const sectionGid = t.section
          ? (as.sections.findBy("project_gid", project.gid).find((s) => s.name === t.section)?.gid ?? null)
          : null;
        as.taskProjects.insert({
          task_gid: taskGid,
          project_gid: project.gid,
          section_gid: sectionGid,
        });
      }
    }
  }
}

export const asanaPlugin: ServicePlugin = {
  name: "asana",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    userRoutes(ctx);
    workspaceRoutes(ctx);
    projectRoutes(ctx);
    sectionRoutes(ctx);
    taskRoutes(ctx);
    tagRoutes(ctx);
    storyRoutes(ctx);
    teamRoutes(ctx);
    webhookRoutes(ctx);
  },
  seed(store: Store, _baseUrl: string): void {
    const as = getAsanaStore(store);
    // Seed a default workspace
    if (as.workspaces.all().length === 0) {
      as.workspaces.insert({
        gid: generateGid(),
        resource_type: "workspace",
        name: "My Workspace",
        is_organization: false,
        email_domains: [],
      });
    }
  },
};

export default asanaPlugin;
