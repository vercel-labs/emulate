import type { RouteContext } from "@emulators/core";
import { getAsanaStore } from "../store.js";
import {
  generateGid,
  asanaError,
  asanaData,
  parsePagination,
  applyPagination,
  parseAsanaBody,
  formatSection,
  compact,
} from "../helpers.js";

export function sectionRoutes({ app, store, baseUrl }: RouteContext): void {
  const as = () => getAsanaStore(store);

  app.post("/api/1.0/projects/:project_gid/sections", async (c) => {
    const projectGid = c.req.param("project_gid");
    const project = as().projects.findOneBy("gid", projectGid);
    if (!project) return asanaError(c, 404, "project: Not Found");

    const body = await parseAsanaBody(c);
    if (!body.name) return asanaError(c, 400, "name: Missing input");

    const gid = generateGid();
    const section = as().sections.insert({
      gid,
      resource_type: "section",
      name: body.name as string,
      project_gid: projectGid,
    });

    return c.json(asanaData(formatSection(section, as())), 201);
  });

  app.get("/api/1.0/sections/:section_gid", (c) => {
    const gid = c.req.param("section_gid");
    const section = as().sections.findOneBy("gid", gid);
    if (!section) return asanaError(c, 404, "section: Not Found");
    return c.json(asanaData(formatSection(section, as())));
  });

  app.put("/api/1.0/sections/:section_gid", async (c) => {
    const gid = c.req.param("section_gid");
    const section = as().sections.findOneBy("gid", gid);
    if (!section) return asanaError(c, 404, "section: Not Found");

    const body = await parseAsanaBody(c);
    const updates: Partial<{ name: string }> = {};
    if (body.name !== undefined) updates.name = body.name as string;

    const updated = as().sections.update(section.id, updates);
    return c.json(asanaData(formatSection(updated ?? section, as())));
  });

  app.delete("/api/1.0/sections/:section_gid", (c) => {
    const gid = c.req.param("section_gid");
    const section = as().sections.findOneBy("gid", gid);
    if (!section) return asanaError(c, 404, "section: Not Found");

    as().sections.delete(section.id);
    return c.json(asanaData({}));
  });

  app.get("/api/1.0/sections/:section_gid/tasks", (c) => {
    const gid = c.req.param("section_gid");
    const section = as().sections.findOneBy("gid", gid);
    if (!section) return asanaError(c, 404, "section: Not Found");

    const pagination = parsePagination(c);
    const taskRels = as()
      .taskProjects.findBy("project_gid", section.project_gid)
      .filter((tp) => tp.section_gid === gid);
    const tasks = taskRels
      .map((tp) => as().tasks.findOneBy("gid", tp.task_gid))
      .filter(Boolean)
      .map((t) => compact(t!.gid, t!.resource_type, t!.name));

    const result = applyPagination(tasks, pagination, `/api/1.0/sections/${gid}/tasks`, baseUrl);
    return c.json(result);
  });

  app.post("/api/1.0/sections/:section_gid/addTask", async (c) => {
    const sectionGid = c.req.param("section_gid");
    const section = as().sections.findOneBy("gid", sectionGid);
    if (!section) return asanaError(c, 404, "section: Not Found");

    const body = await parseAsanaBody(c);
    const taskGid = body.task as string;
    if (!taskGid) return asanaError(c, 400, "task: Missing input");

    const task = as().tasks.findOneBy("gid", taskGid);
    if (!task) return asanaError(c, 404, "task: Not Found");

    // Find or create task-project relationship
    const existing = as()
      .taskProjects.findBy("task_gid", taskGid)
      .find((tp) => tp.project_gid === section.project_gid);

    if (existing) {
      as().taskProjects.update(existing.id, { section_gid: sectionGid });
    } else {
      as().taskProjects.insert({
        task_gid: taskGid,
        project_gid: section.project_gid,
        section_gid: sectionGid,
      });
    }

    return c.json(asanaData({}));
  });
}
