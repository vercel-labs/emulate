import type { RouteContext } from "@emulators/core";
import { getAsanaStore } from "../store.js";
import {
  generateGid,
  asanaError,
  asanaData,
  parsePagination,
  applyPagination,
  parseAsanaBody,
  formatTag,
  compact,
} from "../helpers.js";

export function tagRoutes({ app, store, baseUrl }: RouteContext): void {
  const as = () => getAsanaStore(store);

  app.get("/api/1.0/tags", (c) => {
    const pagination = parsePagination(c);
    const workspaceGid = c.req.query("workspace");

    let tags = as().tags.all();
    if (workspaceGid) tags = tags.filter((t) => t.workspace_gid === workspaceGid);

    const formatted = tags.map((t) => compact(t.gid, t.resource_type, t.name));
    const result = applyPagination(formatted, pagination, "/api/1.0/tags", baseUrl);
    return c.json(result);
  });

  app.post("/api/1.0/tags", async (c) => {
    const body = await parseAsanaBody(c);
    if (!body.name) return asanaError(c, 400, "name: Missing input");
    if (!body.workspace) return asanaError(c, 400, "workspace: Missing input");

    const gid = generateGid();
    const tag = as().tags.insert({
      gid,
      resource_type: "tag",
      name: body.name as string,
      workspace_gid: body.workspace as string,
      color: (body.color as string) ?? null,
      permalink_url: "",
    });

    return c.json(asanaData(formatTag(tag, as(), baseUrl)), 201);
  });

  app.get("/api/1.0/tags/:tag_gid", (c) => {
    const gid = c.req.param("tag_gid");
    const tag = as().tags.findOneBy("gid", gid);
    if (!tag) return asanaError(c, 404, "tag: Not Found");
    return c.json(asanaData(formatTag(tag, as(), baseUrl)));
  });

  app.put("/api/1.0/tags/:tag_gid", async (c) => {
    const gid = c.req.param("tag_gid");
    const tag = as().tags.findOneBy("gid", gid);
    if (!tag) return asanaError(c, 404, "tag: Not Found");

    const body = await parseAsanaBody(c);
    const updates: Partial<{ name: string; color: string | null }> = {};
    if (body.name !== undefined) updates.name = body.name as string;
    if (body.color !== undefined) updates.color = body.color as string | null;

    const updated = as().tags.update(tag.id, updates);
    return c.json(asanaData(formatTag(updated ?? tag, as(), baseUrl)));
  });

  app.delete("/api/1.0/tags/:tag_gid", (c) => {
    const gid = c.req.param("tag_gid");
    const tag = as().tags.findOneBy("gid", gid);
    if (!tag) return asanaError(c, 404, "tag: Not Found");

    // Clean up task-tag relationships
    for (const tt of as().taskTags.findBy("tag_gid", gid)) {
      as().taskTags.delete(tt.id);
    }

    as().tags.delete(tag.id);
    return c.json(asanaData({}));
  });

  // Get tasks for a tag
  app.get("/api/1.0/tags/:tag_gid/tasks", (c) => {
    const gid = c.req.param("tag_gid");
    const tag = as().tags.findOneBy("gid", gid);
    if (!tag) return asanaError(c, 404, "tag: Not Found");

    const pagination = parsePagination(c);
    const rels = as().taskTags.findBy("tag_gid", gid);
    const tasks = rels
      .map((tt) => as().tasks.findOneBy("gid", tt.task_gid))
      .filter(Boolean)
      .map((t) => compact(t!.gid, t!.resource_type, t!.name));
    const result = applyPagination(tasks, pagination, `/api/1.0/tags/${gid}/tasks`, baseUrl);
    return c.json(result);
  });

  // Workspace tags
  app.get("/api/1.0/workspaces/:workspace_gid/tags", (c) => {
    const workspaceGid = c.req.param("workspace_gid");
    const ws = as().workspaces.findOneBy("gid", workspaceGid);
    if (!ws) return asanaError(c, 404, "workspace: Not Found");

    const pagination = parsePagination(c);
    const tags = as().tags.findBy("workspace_gid", workspaceGid).map((t) => compact(t.gid, t.resource_type, t.name));
    const result = applyPagination(tags, pagination, `/api/1.0/workspaces/${workspaceGid}/tags`, baseUrl);
    return c.json(result);
  });

  app.post("/api/1.0/workspaces/:workspace_gid/tags", async (c) => {
    const workspaceGid = c.req.param("workspace_gid");
    const ws = as().workspaces.findOneBy("gid", workspaceGid);
    if (!ws) return asanaError(c, 404, "workspace: Not Found");

    const body = await parseAsanaBody(c);
    if (!body.name) return asanaError(c, 400, "name: Missing input");

    const gid = generateGid();
    const tag = as().tags.insert({
      gid,
      resource_type: "tag",
      name: body.name as string,
      workspace_gid: workspaceGid,
      color: (body.color as string) ?? null,
      permalink_url: "",
    });

    return c.json(asanaData(formatTag(tag, as(), baseUrl)), 201);
  });
}
