import type { RouteContext } from "@emulators/core";
import { getAsanaStore } from "../store.js";
import {
  asanaError,
  asanaData,
  parsePagination,
  applyPagination,
  formatUserWithWorkspaces,
  resolveUser,
  compact,
} from "../helpers.js";

export function userRoutes({ app, store, baseUrl }: RouteContext): void {
  const as = () => getAsanaStore(store);

  app.get("/api/1.0/users/:user_gid", (c) => {
    const gid = c.req.param("user_gid");

    if (gid === "me") {
      const authUser = c.get("authUser");
      if (!authUser) return asanaError(c, 401, "Not Authorized");
      const user = resolveUser(as(), authUser.login);
      if (!user) return asanaError(c, 404, "user: Not Found");
      return c.json(asanaData(formatUserWithWorkspaces(user, as())));
    }

    const user = as().users.findOneBy("gid", gid);
    if (!user) return asanaError(c, 404, "user: Not Found");
    return c.json(asanaData(formatUserWithWorkspaces(user, as())));
  });

  app.get("/api/1.0/users", (c) => {
    const workspaceGid = c.req.query("workspace");
    if (!workspaceGid) return asanaError(c, 400, "workspace: Missing input");

    const ws = as().workspaces.findOneBy("gid", workspaceGid);
    if (!ws) return asanaError(c, 404, "workspace: Not Found");

    const pagination = parsePagination(c);
    const users = as().users.all();
    const formatted = users.map((u) => compact(u.gid, u.resource_type, u.name));

    const result = applyPagination(formatted, pagination, "/api/1.0/users", baseUrl);
    return c.json(result);
  });
}
