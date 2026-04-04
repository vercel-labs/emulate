import { randomBytes } from "crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { escapeHtml } from "@emulators/core";
import type { AsanaStore } from "./store.js";
import type {
  AsanaUser,
  AsanaWorkspace,
  AsanaProject,
  AsanaSection,
  AsanaTask,
  AsanaTag,
  AsanaStory,
  AsanaTeam,
  AsanaTeamMembership,
  AsanaWebhook,
} from "./entities.js";

export { escapeHtml };

export function generateGid(): string {
  const bytes = randomBytes(8);
  let gid = "";
  for (const b of bytes) {
    gid += b.toString(10).padStart(3, "0");
  }
  return gid.slice(0, 16);
}

export function asanaError(c: Context, status: number, message: string) {
  return c.json({ errors: [{ message }] }, status as ContentfulStatusCode);
}

export function asanaData(data: unknown) {
  return { data };
}

export function parsePagination(c: Context): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  return { limit, offset };
}

export function applyPagination<T>(
  items: T[],
  pagination: { limit: number; offset: number },
  basePath: string,
  baseUrl: string,
): { data: T[]; next_page: { offset: string; path: string; uri: string } | null } {
  const { limit, offset } = pagination;
  const paged = items.slice(offset, offset + limit);
  const hasMore = offset + limit < items.length;

  const nextPage = hasMore
    ? {
        offset: String(offset + limit),
        path: `${basePath}?limit=${limit}&offset=${offset + limit}`,
        uri: `${baseUrl}${basePath}?limit=${limit}&offset=${offset + limit}`,
      }
    : null;

  return { data: paged, next_page: nextPage };
}

export async function parseAsanaBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const obj = body as Record<string, unknown>;
      if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
        return obj.data as Record<string, unknown>;
      }
      return obj;
    }
    return {};
  } catch {
    return {};
  }
}

export function compact(gid: string, resource_type: string, name?: string) {
  const result: Record<string, unknown> = { gid, resource_type };
  if (name !== undefined) result.name = name;
  return result;
}

export function resolveUser(as: AsanaStore, login: string): AsanaUser | undefined {
  return (
    as.users.findOneBy("gid", login) ??
    as.users.findOneBy("email", login) ??
    as.users.all().find((u) => u.name === login)
  );
}

function formatUser(user: AsanaUser) {
  return {
    gid: user.gid,
    resource_type: user.resource_type,
    name: user.name,
    email: user.email,
    photo: user.photo,
  };
}

export function formatUserWithWorkspaces(user: AsanaUser, as: AsanaStore) {
  const workspaces = as.workspaces.all().map((w) => compact(w.gid, w.resource_type, w.name));
  return { ...formatUser(user), workspaces };
}

export function formatWorkspace(ws: AsanaWorkspace) {
  return {
    gid: ws.gid,
    resource_type: ws.resource_type,
    name: ws.name,
    is_organization: ws.is_organization,
    email_domains: ws.email_domains,
  };
}

export function formatProject(project: AsanaProject, as: AsanaStore, baseUrl: string) {
  const owner = project.owner_gid ? as.users.findOneBy("gid", project.owner_gid) : null;
  const team = project.team_gid ? as.teams.findOneBy("gid", project.team_gid) : null;
  const workspace = as.workspaces.findOneBy("gid", project.workspace_gid);

  return {
    gid: project.gid,
    resource_type: project.resource_type,
    name: project.name,
    archived: project.archived,
    color: project.color,
    notes: project.notes,
    html_notes: project.html_notes,
    privacy_setting: project.privacy_setting,
    default_view: project.default_view,
    completed: project.completed,
    completed_at: project.completed_at,
    created_at: project.created_at,
    modified_at: project.updated_at,
    owner: owner ? compact(owner.gid, owner.resource_type, owner.name) : null,
    team: team ? compact(team.gid, team.resource_type, team.name) : null,
    workspace: workspace ? compact(workspace.gid, workspace.resource_type, workspace.name) : null,
    permalink_url: project.permalink_url || `${baseUrl}/0/${project.gid}`,
  };
}

export function formatSection(section: AsanaSection, as: AsanaStore) {
  const project = as.projects.findOneBy("gid", section.project_gid);
  return {
    gid: section.gid,
    resource_type: section.resource_type,
    name: section.name,
    created_at: section.created_at,
    project: project ? compact(project.gid, project.resource_type, project.name) : null,
  };
}

export function formatTask(task: AsanaTask, as: AsanaStore, baseUrl: string) {
  const assignee = task.assignee_gid ? as.users.findOneBy("gid", task.assignee_gid) : null;
  const parent = task.parent_gid ? as.tasks.findOneBy("gid", task.parent_gid) : null;
  const workspace = as.workspaces.findOneBy("gid", task.workspace_gid);

  const taskProjectRels = as.taskProjects.findBy("task_gid", task.gid);
  const projects = taskProjectRels
    .map((tp) => as.projects.findOneBy("gid", tp.project_gid))
    .filter(Boolean)
    .map((p) => compact(p!.gid, p!.resource_type, p!.name));

  const memberships = taskProjectRels.map((tp) => {
    const p = as.projects.findOneBy("gid", tp.project_gid);
    const s = tp.section_gid ? as.sections.findOneBy("gid", tp.section_gid) : null;
    return {
      project: p ? compact(p.gid, p.resource_type, p.name) : null,
      section: s ? compact(s.gid, s.resource_type, s.name) : null,
    };
  });

  const taskTagRels = as.taskTags.findBy("task_gid", task.gid);
  const tags = taskTagRels
    .map((tt) => as.tags.findOneBy("gid", tt.tag_gid))
    .filter(Boolean)
    .map((t) => compact(t!.gid, t!.resource_type, t!.name));

  const followers = task.follower_gids
    .map((gid) => as.users.findOneBy("gid", gid))
    .filter(Boolean)
    .map((u) => compact(u!.gid, u!.resource_type, u!.name));

  return {
    gid: task.gid,
    resource_type: task.resource_type,
    resource_subtype: task.resource_subtype,
    name: task.name,
    assignee: assignee ? compact(assignee.gid, assignee.resource_type, assignee.name) : null,
    completed: task.completed,
    completed_at: task.completed_at,
    due_on: task.due_on,
    due_at: task.due_at,
    start_on: task.start_on,
    notes: task.notes,
    html_notes: task.html_notes,
    liked: task.liked,
    num_likes: task.num_likes,
    parent: parent ? compact(parent.gid, parent.resource_type, parent.name) : null,
    projects,
    memberships,
    tags,
    followers,
    workspace: workspace ? compact(workspace.gid, workspace.resource_type, workspace.name) : null,
    permalink_url: task.permalink_url || `${baseUrl}/0/0/task/${task.gid}`,
    created_at: task.created_at,
    modified_at: task.updated_at,
  };
}

export function formatTag(tag: AsanaTag, as: AsanaStore, baseUrl: string) {
  const workspace = as.workspaces.findOneBy("gid", tag.workspace_gid);
  return {
    gid: tag.gid,
    resource_type: tag.resource_type,
    name: tag.name,
    color: tag.color,
    created_at: tag.created_at,
    workspace: workspace ? compact(workspace.gid, workspace.resource_type, workspace.name) : null,
    permalink_url: tag.permalink_url || `${baseUrl}/0/${tag.gid}`,
  };
}

export function formatStory(story: AsanaStory, as: AsanaStore) {
  const createdBy = as.users.findOneBy("gid", story.created_by_gid);
  return {
    gid: story.gid,
    resource_type: story.resource_type,
    resource_subtype: story.resource_subtype,
    text: story.text,
    html_text: story.html_text,
    type: story.type,
    is_editable: story.is_editable,
    created_at: story.created_at,
    created_by: createdBy ? compact(createdBy.gid, createdBy.resource_type, createdBy.name) : null,
  };
}

export function formatTeam(team: AsanaTeam, as: AsanaStore, baseUrl: string) {
  const workspace = as.workspaces.findOneBy("gid", team.workspace_gid);
  return {
    gid: team.gid,
    resource_type: team.resource_type,
    name: team.name,
    description: team.description,
    html_description: team.html_description,
    visibility: team.visibility,
    organization: workspace ? compact(workspace.gid, workspace.resource_type, workspace.name) : null,
    permalink_url: team.permalink_url || `${baseUrl}/0/team/${team.gid}`,
  };
}

export function formatTeamMembership(tm: AsanaTeamMembership, as: AsanaStore) {
  const user = as.users.findOneBy("gid", tm.user_gid);
  const team = as.teams.findOneBy("gid", tm.team_gid);
  return {
    gid: tm.gid,
    resource_type: tm.resource_type,
    user: user ? compact(user.gid, user.resource_type, user.name) : null,
    team: team ? compact(team.gid, team.resource_type, team.name) : null,
    is_guest: tm.is_guest,
    is_admin: tm.is_admin,
  };
}

export function formatWebhook(webhook: AsanaWebhook, as: AsanaStore) {
  const resourceType = as.projects.findOneBy("gid", webhook.resource_gid) ? "project" : "task";

  return {
    gid: webhook.gid,
    resource_type: webhook.resource_type,
    resource: { gid: webhook.resource_gid, resource_type: resourceType },
    target: webhook.target,
    active: webhook.active,
    created_at: webhook.created_at,
    last_success_at: webhook.last_success_at,
    last_failure_at: webhook.last_failure_at,
    last_failure_content: webhook.last_failure_content,
  };
}
