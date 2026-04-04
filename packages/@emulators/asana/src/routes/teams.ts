import type { RouteContext } from "@emulators/core";
import type { AsanaTeam } from "../entities.js";
import { getAsanaStore } from "../store.js";
import {
  generateGid,
  asanaError,
  asanaData,
  parsePagination,
  applyPagination,
  parseAsanaBody,
  formatTeam,
  formatTeamMembership,
  compact,
} from "../helpers.js";

export function teamRoutes({ app, store, baseUrl }: RouteContext): void {
  const as = () => getAsanaStore(store);

  app.get("/api/1.0/teams/:team_gid", (c) => {
    const gid = c.req.param("team_gid");
    const team = as().teams.findOneBy("gid", gid);
    if (!team) return asanaError(c, 404, "team: Not Found");
    return c.json(asanaData(formatTeam(team, as(), baseUrl)));
  });

  app.post("/api/1.0/teams", async (c) => {
    const body = await parseAsanaBody(c);
    if (!body.name) return asanaError(c, 400, "name: Missing input");
    if (!body.organization) return asanaError(c, 400, "organization: Missing input");

    const workspaceGid = body.organization as string;
    const ws = as().workspaces.findOneBy("gid", workspaceGid);
    if (!ws) return asanaError(c, 404, "organization: Not Found");

    const gid = generateGid();
    const team = as().teams.insert({
      gid,
      resource_type: "team",
      name: body.name as string,
      workspace_gid: workspaceGid,
      description: (body.description as string) ?? "",
      html_description: (body.html_description as string) ?? "",
      visibility: (body.visibility as AsanaTeam["visibility"]) ?? "secret",
      permalink_url: "",
    });

    return c.json(asanaData(formatTeam(team, as(), baseUrl)), 201);
  });

  app.get("/api/1.0/workspaces/:workspace_gid/teams", (c) => {
    const workspaceGid = c.req.param("workspace_gid");
    const ws = as().workspaces.findOneBy("gid", workspaceGid);
    if (!ws) return asanaError(c, 404, "workspace: Not Found");

    const pagination = parsePagination(c);
    const teams = as().teams.findBy("workspace_gid", workspaceGid).map((t) => compact(t.gid, t.resource_type, t.name));
    const result = applyPagination(teams, pagination, `/api/1.0/workspaces/${workspaceGid}/teams`, baseUrl);
    return c.json(result);
  });

  app.get("/api/1.0/teams/:team_gid/users", (c) => {
    const teamGid = c.req.param("team_gid");
    const team = as().teams.findOneBy("gid", teamGid);
    if (!team) return asanaError(c, 404, "team: Not Found");

    const pagination = parsePagination(c);
    const memberships = as().teamMemberships.findBy("team_gid", teamGid);
    const users = memberships
      .map((tm) => as().users.findOneBy("gid", tm.user_gid))
      .filter(Boolean)
      .map((u) => compact(u!.gid, u!.resource_type, u!.name));
    const result = applyPagination(users, pagination, `/api/1.0/teams/${teamGid}/users`, baseUrl);
    return c.json(result);
  });

  app.get("/api/1.0/teams/:team_gid/projects", (c) => {
    const teamGid = c.req.param("team_gid");
    const team = as().teams.findOneBy("gid", teamGid);
    if (!team) return asanaError(c, 404, "team: Not Found");

    const pagination = parsePagination(c);
    const projects = as().projects.findBy("team_gid", teamGid).map((p) => compact(p.gid, p.resource_type, p.name));
    const result = applyPagination(projects, pagination, `/api/1.0/teams/${teamGid}/projects`, baseUrl);
    return c.json(result);
  });

  app.post("/api/1.0/teams/:team_gid/addUser", async (c) => {
    const teamGid = c.req.param("team_gid");
    const team = as().teams.findOneBy("gid", teamGid);
    if (!team) return asanaError(c, 404, "team: Not Found");

    const body = await parseAsanaBody(c);
    const userGid = body.user as string;
    if (!userGid) return asanaError(c, 400, "user: Missing input");

    const existing = as()
      .teamMemberships.findBy("team_gid", teamGid)
      .find((tm) => tm.user_gid === userGid);

    const membership = existing ?? as().teamMemberships.insert({
      gid: generateGid(),
      resource_type: "team_membership",
      user_gid: userGid,
      team_gid: teamGid,
      is_guest: false,
      is_admin: false,
    });

    return c.json(asanaData(formatTeamMembership(membership, as())));
  });

  app.post("/api/1.0/teams/:team_gid/removeUser", async (c) => {
    const teamGid = c.req.param("team_gid");
    const team = as().teams.findOneBy("gid", teamGid);
    if (!team) return asanaError(c, 404, "team: Not Found");

    const body = await parseAsanaBody(c);
    const userGid = body.user as string;
    if (!userGid) return asanaError(c, 400, "user: Missing input");

    const membership = as()
      .teamMemberships.findBy("team_gid", teamGid)
      .find((tm) => tm.user_gid === userGid);
    if (membership) as().teamMemberships.delete(membership.id);

    return c.json(asanaData({}));
  });
}
