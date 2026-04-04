import type { RouteContext } from "@emulators/core";
import { getAsanaStore } from "../store.js";
import type { AsanaProject } from "../entities.js";
import {
  generateGid,
  asanaError,
  asanaData,
  parsePagination,
  applyPagination,
  parseAsanaBody,
  formatProject,
  formatSection,
  compact,
} from "../helpers.js";

export function projectRoutes({ app, store, baseUrl }: RouteContext): void {
  const as = () => getAsanaStore(store);

  app.get("/api/1.0/projects", (c) => {
    const pagination = parsePagination(c);
    const workspaceGid = c.req.query("workspace");
    const teamGid = c.req.query("team");

    let projects = as().projects.all();
    if (workspaceGid) projects = projects.filter((p) => p.workspace_gid === workspaceGid);
    if (teamGid) projects = projects.filter((p) => p.team_gid === teamGid);

    const formatted = projects.map((p) => compact(p.gid, p.resource_type, p.name));
    const result = applyPagination(formatted, pagination, "/api/1.0/projects", baseUrl);
    return c.json(result);
  });

  app.post("/api/1.0/projects", async (c) => {
    const body = await parseAsanaBody(c);
    if (!body.name) return asanaError(c, 400, "name: Missing input");
    if (!body.workspace) return asanaError(c, 400, "workspace: Missing input");

    const workspaceGid = body.workspace as string;
    const ws = as().workspaces.findOneBy("gid", workspaceGid);
    if (!ws) return asanaError(c, 404, "workspace: Not Found");

    const gid = generateGid();
    const project = as().projects.insert({
      gid,
      resource_type: "project",
      name: body.name as string,
      workspace_gid: workspaceGid,
      owner_gid: (body.owner as string) ?? null,
      team_gid: (body.team as string) ?? null,
      archived: false,
      color: (body.color as string) ?? null,
      notes: (body.notes as string) ?? "",
      html_notes: (body.html_notes as string) ?? "",
      privacy_setting: (body.privacy_setting as AsanaProject["privacy_setting"]) ?? "public_to_workspace",
      default_view: (body.default_view as AsanaProject["default_view"]) ?? "list",
      completed: false,
      completed_at: null,
      permalink_url: "",
    });

    return c.json(asanaData(formatProject(project, as(), baseUrl)), 201);
  });

  app.get("/api/1.0/projects/:project_gid", (c) => {
    const gid = c.req.param("project_gid");
    const project = as().projects.findOneBy("gid", gid);
    if (!project) return asanaError(c, 404, "project: Not Found");
    return c.json(asanaData(formatProject(project, as(), baseUrl)));
  });

  app.put("/api/1.0/projects/:project_gid", async (c) => {
    const gid = c.req.param("project_gid");
    const project = as().projects.findOneBy("gid", gid);
    if (!project) return asanaError(c, 404, "project: Not Found");

    const body = await parseAsanaBody(c);
    const updates: Partial<AsanaProject> = {};
    if (body.name !== undefined) updates.name = body.name as string;
    if (body.notes !== undefined) updates.notes = body.notes as string;
    if (body.html_notes !== undefined) updates.html_notes = body.html_notes as string;
    if (body.color !== undefined) updates.color = body.color as string | null;
    if (body.archived !== undefined) updates.archived = body.archived as boolean;
    if (body.privacy_setting !== undefined) updates.privacy_setting = body.privacy_setting as AsanaProject["privacy_setting"];
    if (body.default_view !== undefined) updates.default_view = body.default_view as AsanaProject["default_view"];
    if (body.owner !== undefined) updates.owner_gid = body.owner as string;
    if (body.team !== undefined) updates.team_gid = body.team as string;

    const updated = as().projects.update(project.id, updates);
    return c.json(asanaData(formatProject(updated ?? project, as(), baseUrl)));
  });

  app.delete("/api/1.0/projects/:project_gid", (c) => {
    const gid = c.req.param("project_gid");
    const project = as().projects.findOneBy("gid", gid);
    if (!project) return asanaError(c, 404, "project: Not Found");

    // Clean up related data
    for (const tp of as().taskProjects.findBy("project_gid", gid)) {
      as().taskProjects.delete(tp.id);
    }
    for (const section of as().sections.findBy("project_gid", gid)) {
      as().sections.delete(section.id);
    }

    as().projects.delete(project.id);
    return c.json(asanaData({}));
  });

  app.get("/api/1.0/projects/:project_gid/tasks", (c) => {
    const gid = c.req.param("project_gid");
    const project = as().projects.findOneBy("gid", gid);
    if (!project) return asanaError(c, 404, "project: Not Found");

    const pagination = parsePagination(c);
    const taskRels = as().taskProjects.findBy("project_gid", gid);
    const tasks = taskRels
      .map((tp) => as().tasks.findOneBy("gid", tp.task_gid))
      .filter(Boolean)
      .map((t) => compact(t!.gid, t!.resource_type, t!.name));

    const result = applyPagination(tasks, pagination, `/api/1.0/projects/${gid}/tasks`, baseUrl);
    return c.json(result);
  });

  app.get("/api/1.0/projects/:project_gid/sections", (c) => {
    const gid = c.req.param("project_gid");
    const project = as().projects.findOneBy("gid", gid);
    if (!project) return asanaError(c, 404, "project: Not Found");

    const pagination = parsePagination(c);
    const sections = as().sections.findBy("project_gid", gid).map((s) => formatSection(s, as()));
    const result = applyPagination(sections, pagination, `/api/1.0/projects/${gid}/sections`, baseUrl);
    return c.json(result);
  });

  app.get("/api/1.0/projects/:project_gid/task_counts", (c) => {
    const gid = c.req.param("project_gid");
    const project = as().projects.findOneBy("gid", gid);
    if (!project) return asanaError(c, 404, "project: Not Found");

    const taskRels = as().taskProjects.findBy("project_gid", gid);
    let numTasks = 0, numCompleted = 0, numMilestones = 0, numCompletedMilestones = 0;
    for (const tp of taskRels) {
      const t = as().tasks.findOneBy("gid", tp.task_gid);
      if (!t) continue;
      numTasks++;
      if (t.completed) numCompleted++;
      if (t.resource_subtype === "milestone") {
        numMilestones++;
        if (t.completed) numCompletedMilestones++;
      }
    }

    return c.json(asanaData({
      num_tasks: numTasks,
      num_completed_tasks: numCompleted,
      num_incomplete_tasks: numTasks - numCompleted,
      num_milestones: numMilestones,
      num_incomplete_milestones: numMilestones - numCompletedMilestones,
      num_completed_milestones: numCompletedMilestones,
    }));
  });
}
