import type { RouteContext } from "@emulators/core";
import { getAsanaStore } from "../store.js";
import {
  asanaError,
  asanaData,
  parsePagination,
  applyPagination,
  parseAsanaBody,
  formatWorkspace,
  compact,
} from "../helpers.js";

export function workspaceRoutes({ app, store, baseUrl }: RouteContext): void {
  const as = () => getAsanaStore(store);

  app.get("/api/1.0/workspaces", (c) => {
    const pagination = parsePagination(c);
    const workspaces = as().workspaces.all().map(formatWorkspace);
    const result = applyPagination(workspaces, pagination, "/api/1.0/workspaces", baseUrl);
    return c.json(result);
  });

  app.get("/api/1.0/workspaces/:workspace_gid", (c) => {
    const gid = c.req.param("workspace_gid");
    const ws = as().workspaces.findOneBy("gid", gid);
    if (!ws) return asanaError(c, 404, "workspace: Not Found");
    return c.json(asanaData(formatWorkspace(ws)));
  });

  app.put("/api/1.0/workspaces/:workspace_gid", async (c) => {
    const gid = c.req.param("workspace_gid");
    const ws = as().workspaces.findOneBy("gid", gid);
    if (!ws) return asanaError(c, 404, "workspace: Not Found");

    const body = await parseAsanaBody(c);
    const updated = as().workspaces.update(ws.id, {
      ...(body.name !== undefined && { name: body.name as string }),
    });

    return c.json(asanaData(formatWorkspace(updated ?? ws)));
  });
}
