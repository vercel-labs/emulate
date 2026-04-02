import type { RouteContext } from "@emulators/core";
import { getAsanaStore } from "../store.js";
import type { AsanaTask } from "../entities.js";
import {
  generateGid,
  asanaError,
  asanaData,
  parsePagination,
  applyPagination,
  parseAsanaBody,
  formatTask,
  formatStory,
  resolveUser,
  compact,
  escapeHtml,
} from "../helpers.js";

export function taskRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const as = () => getAsanaStore(store);

  app.get("/api/1.0/tasks", (c) => {
    const pagination = parsePagination(c);
    const projectGid = c.req.query("project");
    const sectionGid = c.req.query("section");
    const assigneeParam = c.req.query("assignee");
    const workspaceGid = c.req.query("workspace");

    let taskGids: Set<string> | null = null;

    if (projectGid) {
      const rels = as().taskProjects.findBy("project_gid", projectGid);
      taskGids = new Set(rels.map((r) => r.task_gid));
    } else if (sectionGid) {
      const section = as().sections.findOneBy("gid", sectionGid);
      if (!section) return asanaError(c, 404, "section: Not Found");
      const rels = as()
        .taskProjects.findBy("project_gid", section.project_gid)
        .filter((tp) => tp.section_gid === sectionGid);
      taskGids = new Set(rels.map((r) => r.task_gid));
    }

    let tasks = taskGids
      ? as().tasks.all().filter((t) => taskGids!.has(t.gid))
      : as().tasks.all();

    if (assigneeParam) {
      const login = assigneeParam === "me"
        ? (c.get("authUser")?.login ?? assigneeParam)
        : assigneeParam;
      const resolvedGid = resolveUser(as(), login)?.gid ?? login;
      tasks = tasks.filter((t) => t.assignee_gid === resolvedGid);
    }
    if (workspaceGid) {
      tasks = tasks.filter((t) => t.workspace_gid === workspaceGid);
    }

    const formatted = tasks.map((t) => compact(t.gid, t.resource_type, t.name));
    const result = applyPagination(formatted, pagination, "/api/1.0/tasks", baseUrl);
    return c.json(result);
  });

  app.post("/api/1.0/tasks", async (c) => {
    const body = await parseAsanaBody(c);
    if (!body.name && body.name !== "") return asanaError(c, 400, "name: Missing input");

    // Resolve workspace from body or from projects
    let workspaceGid = body.workspace as string | undefined;
    const projectGids = (body.projects as string[]) ?? [];
    const membershipData = body.memberships as Array<{ project: string; section?: string }> | undefined;

    if (!workspaceGid && projectGids.length > 0) {
      const p = as().projects.findOneBy("gid", projectGids[0]);
      if (p) workspaceGid = p.workspace_gid;
    }
    if (!workspaceGid && membershipData && membershipData.length > 0) {
      const p = as().projects.findOneBy("gid", membershipData[0].project);
      if (p) workspaceGid = p.workspace_gid;
    }
    if (!workspaceGid) {
      const defaultWs = as().workspaces.all()[0];
      if (defaultWs) workspaceGid = defaultWs.gid;
    }
    if (!workspaceGid) return asanaError(c, 400, "workspace: Missing input");

    const gid = generateGid();
    const task = as().tasks.insert({
      gid,
      resource_type: "task",
      resource_subtype: (body.resource_subtype as AsanaTask["resource_subtype"]) ?? "default_task",
      name: body.name as string,
      assignee_gid: (body.assignee as string) ?? null,
      workspace_gid: workspaceGid,
      completed: (body.completed as boolean) ?? false,
      completed_at: null,
      due_on: (body.due_on as string) ?? null,
      due_at: (body.due_at as string) ?? null,
      start_on: (body.start_on as string) ?? null,
      notes: (body.notes as string) ?? "",
      html_notes: (body.html_notes as string) ?? "",
      liked: false,
      num_likes: 0,
      parent_gid: (body.parent as string) ?? null,
      permalink_url: "",
      follower_gids: (body.followers as string[]) ?? [],
    });

    // Add project memberships
    for (const pGid of projectGids) {
      as().taskProjects.insert({ task_gid: gid, project_gid: pGid, section_gid: null });
    }
    if (membershipData) {
      for (const m of membershipData) {
        const existing = as().taskProjects.findBy("task_gid", gid).find((tp) => tp.project_gid === m.project);
        if (existing) {
          if (m.section) as().taskProjects.update(existing.id, { section_gid: m.section });
        } else {
          as().taskProjects.insert({ task_gid: gid, project_gid: m.project, section_gid: m.section ?? null });
        }
      }
    }

    return c.json(asanaData(formatTask(task, as(), baseUrl)), 201);
  });

  app.get("/api/1.0/tasks/:task_gid", (c) => {
    const gid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", gid);
    if (!task) return asanaError(c, 404, "task: Not Found");
    return c.json(asanaData(formatTask(task, as(), baseUrl)));
  });

  app.put("/api/1.0/tasks/:task_gid", async (c) => {
    const gid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", gid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const body = await parseAsanaBody(c);
    const updates: Partial<AsanaTask> = {};
    if (body.name !== undefined) updates.name = body.name as string;
    if (body.assignee !== undefined) updates.assignee_gid = body.assignee as string | null;
    if (body.completed !== undefined) {
      updates.completed = body.completed as boolean;
      updates.completed_at = body.completed ? new Date().toISOString() : null;
    }
    if (body.due_on !== undefined) updates.due_on = body.due_on as string | null;
    if (body.due_at !== undefined) updates.due_at = body.due_at as string | null;
    if (body.start_on !== undefined) updates.start_on = body.start_on as string | null;
    if (body.notes !== undefined) updates.notes = body.notes as string;
    if (body.html_notes !== undefined) updates.html_notes = body.html_notes as string;
    if (body.resource_subtype !== undefined) updates.resource_subtype = body.resource_subtype as AsanaTask["resource_subtype"];

    const updated = as().tasks.update(task.id, updates);
    return c.json(asanaData(formatTask(updated ?? task, as(), baseUrl)));
  });

  app.delete("/api/1.0/tasks/:task_gid", (c) => {
    const gid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", gid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    for (const tp of as().taskProjects.findBy("task_gid", gid)) as().taskProjects.delete(tp.id);
    for (const tt of as().taskTags.findBy("task_gid", gid)) as().taskTags.delete(tt.id);
    for (const td of as().taskDependencies.findBy("task_gid", gid)) as().taskDependencies.delete(td.id);
    for (const td of as().taskDependencies.findBy("dependency_gid", gid)) as().taskDependencies.delete(td.id);
    for (const story of as().stories.findBy("task_gid", gid)) as().stories.delete(story.id);
    for (const sub of as().tasks.findBy("parent_gid", gid)) {
      as().tasks.update(sub.id, { parent_gid: null });
    }

    as().tasks.delete(task.id);
    return c.json(asanaData({}));
  });

  // Subtasks
  app.get("/api/1.0/tasks/:task_gid/subtasks", (c) => {
    const gid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", gid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const pagination = parsePagination(c);
    const subtasks = as().tasks.findBy("parent_gid", gid).map((t) => compact(t.gid, t.resource_type, t.name));
    const result = applyPagination(subtasks, pagination, `/api/1.0/tasks/${gid}/subtasks`, baseUrl);
    return c.json(result);
  });

  app.post("/api/1.0/tasks/:task_gid/subtasks", async (c) => {
    const parentGid = c.req.param("task_gid");
    const parentTask = as().tasks.findOneBy("gid", parentGid);
    if (!parentTask) return asanaError(c, 404, "task: Not Found");

    const body = await parseAsanaBody(c);
    if (!body.name && body.name !== "") return asanaError(c, 400, "name: Missing input");

    const gid = generateGid();
    const subtask = as().tasks.insert({
      gid,
      resource_type: "task",
      resource_subtype: (body.resource_subtype as AsanaTask["resource_subtype"]) ?? "default_task",
      name: body.name as string,
      assignee_gid: (body.assignee as string) ?? null,
      workspace_gid: parentTask.workspace_gid,
      completed: false,
      completed_at: null,
      due_on: (body.due_on as string) ?? null,
      due_at: (body.due_at as string) ?? null,
      start_on: null,
      notes: (body.notes as string) ?? "",
      html_notes: (body.html_notes as string) ?? "",
      liked: false,
      num_likes: 0,
      parent_gid: parentGid,
      permalink_url: "",
      follower_gids: [],
    });

    return c.json(asanaData(formatTask(subtask, as(), baseUrl)), 201);
  });

  // Stories for task
  app.get("/api/1.0/tasks/:task_gid/stories", (c) => {
    const gid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", gid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const pagination = parsePagination(c);
    const stories = as().stories.findBy("task_gid", gid).map((s) => formatStory(s, as()));
    const result = applyPagination(stories, pagination, `/api/1.0/tasks/${gid}/stories`, baseUrl);
    return c.json(result);
  });

  app.post("/api/1.0/tasks/:task_gid/stories", async (c) => {
    const taskGid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", taskGid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const body = await parseAsanaBody(c);
    if (!body.text) return asanaError(c, 400, "text: Missing input");

    const authUser = c.get("authUser");
    const user = authUser ? resolveUser(as(), authUser.login) ?? null : null;

    const gid = generateGid();
    const story = as().stories.insert({
      gid,
      resource_type: "story",
      resource_subtype: "comment_added",
      task_gid: taskGid,
      text: body.text as string,
      html_text: (body.html_text as string) ?? `<body>${escapeHtml(body.text as string)}</body>`,
      type: "comment",
      is_editable: true,
      created_by_gid: user?.gid ?? "",
    });

    return c.json(asanaData(formatStory(story, as())), 201);
  });

  // Tags for task
  app.get("/api/1.0/tasks/:task_gid/tags", (c) => {
    const gid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", gid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const pagination = parsePagination(c);
    const tagRels = as().taskTags.findBy("task_gid", gid);
    const tags = tagRels
      .map((tt) => as().tags.findOneBy("gid", tt.tag_gid))
      .filter(Boolean)
      .map((t) => compact(t!.gid, t!.resource_type, t!.name));
    const result = applyPagination(tags, pagination, `/api/1.0/tasks/${gid}/tags`, baseUrl);
    return c.json(result);
  });

  // Projects for task
  app.get("/api/1.0/tasks/:task_gid/projects", (c) => {
    const gid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", gid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const pagination = parsePagination(c);
    const rels = as().taskProjects.findBy("task_gid", gid);
    const projects = rels
      .map((tp) => as().projects.findOneBy("gid", tp.project_gid))
      .filter(Boolean)
      .map((p) => compact(p!.gid, p!.resource_type, p!.name));
    const result = applyPagination(projects, pagination, `/api/1.0/tasks/${gid}/projects`, baseUrl);
    return c.json(result);
  });

  // Dependencies
  app.get("/api/1.0/tasks/:task_gid/dependencies", (c) => {
    const gid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", gid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const pagination = parsePagination(c);
    const deps = as().taskDependencies.findBy("task_gid", gid);
    const tasks = deps
      .map((d) => as().tasks.findOneBy("gid", d.dependency_gid))
      .filter(Boolean)
      .map((t) => compact(t!.gid, t!.resource_type, t!.name));
    const result = applyPagination(tasks, pagination, `/api/1.0/tasks/${gid}/dependencies`, baseUrl);
    return c.json(result);
  });

  app.get("/api/1.0/tasks/:task_gid/dependents", (c) => {
    const gid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", gid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const pagination = parsePagination(c);
    const deps = as().taskDependencies.findBy("dependency_gid", gid);
    const tasks = deps
      .map((d) => as().tasks.findOneBy("gid", d.task_gid))
      .filter(Boolean)
      .map((t) => compact(t!.gid, t!.resource_type, t!.name));
    const result = applyPagination(tasks, pagination, `/api/1.0/tasks/${gid}/dependents`, baseUrl);
    return c.json(result);
  });

  // Add/remove project
  app.post("/api/1.0/tasks/:task_gid/addProject", async (c) => {
    const taskGid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", taskGid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const body = await parseAsanaBody(c);
    const projectGid = body.project as string;
    if (!projectGid) return asanaError(c, 400, "project: Missing input");

    const project = as().projects.findOneBy("gid", projectGid);
    if (!project) return asanaError(c, 404, "project: Not Found");

    const existing = as().taskProjects.findBy("task_gid", taskGid).find((tp) => tp.project_gid === projectGid);
    if (!existing) {
      as().taskProjects.insert({
        task_gid: taskGid,
        project_gid: projectGid,
        section_gid: (body.section as string) ?? null,
      });
    }

    return c.json(asanaData({}));
  });

  app.post("/api/1.0/tasks/:task_gid/removeProject", async (c) => {
    const taskGid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", taskGid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const body = await parseAsanaBody(c);
    const projectGid = body.project as string;
    if (!projectGid) return asanaError(c, 400, "project: Missing input");

    const rel = as().taskProjects.findBy("task_gid", taskGid).find((tp) => tp.project_gid === projectGid);
    if (rel) as().taskProjects.delete(rel.id);

    return c.json(asanaData({}));
  });

  // Add/remove tag
  app.post("/api/1.0/tasks/:task_gid/addTag", async (c) => {
    const taskGid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", taskGid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const body = await parseAsanaBody(c);
    const tagGid = body.tag as string;
    if (!tagGid) return asanaError(c, 400, "tag: Missing input");

    const tag = as().tags.findOneBy("gid", tagGid);
    if (!tag) return asanaError(c, 404, "tag: Not Found");

    const existing = as().taskTags.findBy("task_gid", taskGid).find((tt) => tt.tag_gid === tagGid);
    if (!existing) {
      as().taskTags.insert({ task_gid: taskGid, tag_gid: tagGid });
    }

    return c.json(asanaData({}));
  });

  app.post("/api/1.0/tasks/:task_gid/removeTag", async (c) => {
    const taskGid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", taskGid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const body = await parseAsanaBody(c);
    const tagGid = body.tag as string;
    if (!tagGid) return asanaError(c, 400, "tag: Missing input");

    const rel = as().taskTags.findBy("task_gid", taskGid).find((tt) => tt.tag_gid === tagGid);
    if (rel) as().taskTags.delete(rel.id);

    return c.json(asanaData({}));
  });

  // Add/remove dependencies
  app.post("/api/1.0/tasks/:task_gid/addDependencies", async (c) => {
    const taskGid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", taskGid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const body = await parseAsanaBody(c);
    const dependencies = body.dependencies as string[];
    if (!dependencies || !Array.isArray(dependencies)) return asanaError(c, 400, "dependencies: Missing input");

    for (const depGid of dependencies) {
      const existing = as().taskDependencies.findBy("task_gid", taskGid).find((td) => td.dependency_gid === depGid);
      if (!existing) {
        as().taskDependencies.insert({ task_gid: taskGid, dependency_gid: depGid });
      }
    }

    return c.json(asanaData({}));
  });

  app.post("/api/1.0/tasks/:task_gid/removeDependencies", async (c) => {
    const taskGid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", taskGid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const body = await parseAsanaBody(c);
    const dependencies = body.dependencies as string[];
    if (!dependencies || !Array.isArray(dependencies)) return asanaError(c, 400, "dependencies: Missing input");

    for (const depGid of dependencies) {
      const rel = as().taskDependencies.findBy("task_gid", taskGid).find((td) => td.dependency_gid === depGid);
      if (rel) as().taskDependencies.delete(rel.id);
    }

    return c.json(asanaData({}));
  });

  // Add/remove followers
  app.post("/api/1.0/tasks/:task_gid/addFollowers", async (c) => {
    const taskGid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", taskGid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const body = await parseAsanaBody(c);
    const followers = body.followers as string[];
    if (!followers || !Array.isArray(followers)) return asanaError(c, 400, "followers: Missing input");

    const currentFollowers = new Set(task.follower_gids);
    for (const f of followers) currentFollowers.add(f);
    as().tasks.update(task.id, { follower_gids: [...currentFollowers] });

    const updated = as().tasks.findOneBy("gid", taskGid)!;
    return c.json(asanaData(formatTask(updated, as(), baseUrl)));
  });

  app.post("/api/1.0/tasks/:task_gid/removeFollowers", async (c) => {
    const taskGid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", taskGid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const body = await parseAsanaBody(c);
    const followers = body.followers as string[];
    if (!followers || !Array.isArray(followers)) return asanaError(c, 400, "followers: Missing input");

    const toRemove = new Set(followers);
    const remaining = task.follower_gids.filter((f) => !toRemove.has(f));
    as().tasks.update(task.id, { follower_gids: remaining });

    const updated = as().tasks.findOneBy("gid", taskGid)!;
    return c.json(asanaData(formatTask(updated, as(), baseUrl)));
  });

  // Set parent
  app.post("/api/1.0/tasks/:task_gid/setParent", async (c) => {
    const taskGid = c.req.param("task_gid");
    const task = as().tasks.findOneBy("gid", taskGid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    const body = await parseAsanaBody(c);
    const parentGid = (body.parent as string) ?? null;

    as().tasks.update(task.id, { parent_gid: parentGid });

    const updated = as().tasks.findOneBy("gid", taskGid)!;
    return c.json(asanaData(formatTask(updated, as(), baseUrl)));
  });
}
