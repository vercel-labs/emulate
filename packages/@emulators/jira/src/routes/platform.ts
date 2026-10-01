import type { RouteContext } from "@emulators/core";
import { API_V, JiraError, listParam, makeHandler, pageParams } from "../context.js";
import {
  allStatusCategories,
  formatIssueType,
  formatPriorityFull,
  formatResolution,
  formatStatus,
  formatUser,
  projectStatuses,
  restUrl,
} from "../formatters.js";
import { allFields } from "../fields.js";
import { findIssueType, findPriority, findProject, findResolution, findStatus, paginate } from "../lookup.js";
import type { JiraUser } from "../entities.js";

const READ_USER = ["read:jira-user", "read:jira-work"];
const READ_WORK = ["read:jira-work"];

const PERMISSION_KEYS = [
  "BROWSE_PROJECTS",
  "CREATE_ISSUES",
  "EDIT_ISSUES",
  "DELETE_ISSUES",
  "ASSIGN_ISSUES",
  "ASSIGNABLE_USER",
  "TRANSITION_ISSUES",
  "RESOLVE_ISSUES",
  "CLOSE_ISSUES",
  "ADD_COMMENTS",
  "EDIT_ALL_COMMENTS",
  "DELETE_ALL_COMMENTS",
  "WORK_ON_ISSUES",
  "LINK_ISSUES",
  "MANAGE_WATCHERS",
  "SCHEDULE_ISSUES",
  "MANAGE_SPRINTS_PERMISSION",
  "ADMINISTER_PROJECTS",
  "ADMINISTER",
  "SYSTEM_ADMIN",
];
const ADMIN_ONLY = new Set(["ADMINISTER", "SYSTEM_ADMIN"]);

export function platformRoutes({ app, store, baseUrl }: RouteContext): void {
  const handle = makeHandler(store, baseUrl);

  app.get(
    `${API_V}/serverInfo`,
    handle(
      (r) =>
        r.c.json({
          baseUrl: r.siteUrl,
          displayUrl: r.siteUrl,
          version: "1001.0.0-SNAPSHOT",
          versionNumbers: [1001, 0, 0],
          deploymentType: "Cloud",
          buildNumber: 100000,
          buildDate: "2026-01-01T00:00:00.000+0000",
          serverTime: new Date().toISOString().replace("Z", "+0000"),
          scmInfo: "emulate",
          serverTitle: "Jira",
          defaultLocale: { locale: "en_US" },
          serverTimeZone: "Etc/UTC",
        }),
      { auth: false },
    ),
  );

  app.get(
    `${API_V}/myself`,
    handle((r) => r.c.json({ ...formatUser(r, r.user), groups: { size: 0, items: [] } }), { scopes: READ_USER }),
  );

  const matchesQuery = (user: JiraUser, query: string | undefined) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      user.display_name.toLowerCase().includes(q) ||
      user.email.toLowerCase().includes(q) ||
      user.account_id.toLowerCase() === q
    );
  };

  app.get(
    `${API_V}/user`,
    handle(
      (r) => {
        const accountId = r.c.req.query("accountId") ?? "";
        const user = r.js.users.findOneBy("account_id", accountId);
        if (!user)
          throw new JiraError(404, [
            `Specified user does not exist or you do not have required permissions: ${accountId}`,
          ]);
        return r.c.json(formatUser(r, user));
      },
      { scopes: READ_USER },
    ),
  );

  app.get(
    `${API_V}/user/bulk`,
    handle(
      (r) => {
        const ids = listParam(r.c, "accountId");
        const users = ids
          .map((id) => r.js.users.findOneBy("account_id", id))
          .filter((user): user is JiraUser => Boolean(user));
        const { startAt, maxResults } = pageParams(r.c, 10, 200);
        const page = paginate(users, { startAt, maxResults });
        return r.c.json({ ...page, values: page.values.map((user) => formatUser(r, user)) });
      },
      { scopes: READ_USER },
    ),
  );

  for (const path of [`${API_V}/user/search`, `${API_V}/users/search`, `${API_V}/users`, `${API_V}/user/picker`]) {
    app.get(
      path,
      handle(
        (r) => {
          const query = r.c.req.query("query") ?? r.c.req.query("username");
          const accountId = r.c.req.query("accountId");
          const { startAt, maxResults } = pageParams(r.c, 50, 1000);
          const users = r.js.users
            .all()
            .filter((user) => (accountId ? user.account_id === accountId : matchesQuery(user, query)))
            .slice(startAt, startAt + maxResults)
            .map((user) => formatUser(r, user));
          if (path.endsWith("/picker")) {
            return r.c.json({
              users: users.map((user) => ({ ...user, html: user!.displayName })),
              total: users.length,
              header: `Showing ${users.length} of ${users.length} matching users`,
            });
          }
          return r.c.json(users);
        },
        { scopes: READ_USER },
      ),
    );
  }

  for (const path of [`${API_V}/user/assignable/search`, `${API_V}/user/assignable/multiProjectSearch`]) {
    app.get(
      path,
      handle(
        (r) => {
          const projectRefs = [...listParam(r.c, "project"), ...listParam(r.c, "projectKeys")];
          for (const ref of projectRefs) {
            if (!findProject(r.js, ref)) throw new JiraError(404, [`No project could be found with key '${ref}'.`]);
          }
          const query = r.c.req.query("query") ?? r.c.req.query("username");
          const accountId = r.c.req.query("accountId");
          const users = r.js.users
            .all()
            .filter((user) => user.active && user.account_type === "atlassian")
            .filter((user) => (accountId ? user.account_id === accountId : matchesQuery(user, query)))
            .map((user) => formatUser(r, user));
          return r.c.json(users);
        },
        { scopes: READ_USER },
      ),
    );
  }

  app.get(
    `${API_V}/mypermissions`,
    handle(
      (r) => {
        const requested = listParam(r.c, "permissions");
        const keys = requested.length > 0 ? requested : PERMISSION_KEYS;
        const permissions: Record<string, unknown> = {};
        keys.forEach((key, index) => {
          permissions[key] = {
            id: String(index + 1),
            key,
            name: key
              .toLowerCase()
              .split("_")
              .filter(Boolean)
              .map((part) => part[0].toUpperCase() + part.slice(1))
              .join(" "),
            type: ADMIN_ONLY.has(key) ? "GLOBAL" : "PROJECT",
            description: "",
            havePermission: ADMIN_ONLY.has(key) || key === "ADMINISTER_PROJECTS" ? r.user.admin : true,
          };
        });
        return r.c.json({ permissions });
      },
      { scopes: READ_WORK },
    ),
  );

  app.get(
    `${API_V}/issuetype`,
    handle((r) => r.c.json(r.js.issueTypes.all().map((type) => formatIssueType(r, type))), { scopes: READ_WORK }),
  );

  app.get(
    `${API_V}/issuetype/project`,
    handle(
      (r) => {
        const project = findProject(r.js, r.c.req.query("projectId") ?? "");
        if (!project) throw new JiraError(404, ["The project was not found or you don't have permission to view it."]);
        return r.c.json(
          project.issue_type_ids.map((id) => formatIssueType(r, r.js.issueTypes.get(id))).filter(Boolean),
        );
      },
      { scopes: READ_WORK },
    ),
  );

  app.get(
    `${API_V}/issuetype/:id`,
    handle(
      (r) => {
        const type = findIssueType(r.js, r.c.req.param("id"));
        if (!type) throw new JiraError(404, ["The issue type selected is invalid."]);
        return r.c.json(formatIssueType(r, type));
      },
      { scopes: READ_WORK },
    ),
  );

  app.get(
    `${API_V}/status`,
    handle((r) => r.c.json(r.js.statuses.all().map((status) => formatStatus(r, status))), { scopes: READ_WORK }),
  );

  app.get(
    `${API_V}/status/:idOrName`,
    handle(
      (r) => {
        const status = findStatus(r.js, decodeURIComponent(r.c.req.param("idOrName")));
        if (!status) throw new JiraError(404, [`The status with id '${r.c.req.param("idOrName")}' does not exist`]);
        return r.c.json(formatStatus(r, status));
      },
      { scopes: READ_WORK },
    ),
  );

  app.get(
    `${API_V}/statuscategory`,
    handle((r) => r.c.json(allStatusCategories(r)), { scopes: READ_WORK }),
  );

  app.get(
    `${API_V}/priority`,
    handle((r) => r.c.json(r.js.priorities.all().map((priority) => formatPriorityFull(r, priority))), {
      scopes: READ_WORK,
    }),
  );

  app.get(
    `${API_V}/priority/search`,
    handle(
      (r) => {
        const all = r.js.priorities.all().map((priority) => formatPriorityFull(r, priority));
        const page = paginate(all, pageParams(r.c, 50));
        return r.c.json({ self: restUrl(r, "/priority/search"), ...page });
      },
      { scopes: READ_WORK },
    ),
  );

  app.get(
    `${API_V}/priority/:id`,
    handle(
      (r) => {
        const priority = findPriority(r.js, r.c.req.param("id"));
        if (!priority) throw new JiraError(404, [`Priority with id ${r.c.req.param("id")} not found.`]);
        return r.c.json(formatPriorityFull(r, priority));
      },
      { scopes: READ_WORK },
    ),
  );

  app.get(
    `${API_V}/resolution`,
    handle((r) => r.c.json(r.js.resolutions.all().map((resolution) => formatResolution(r, resolution))), {
      scopes: READ_WORK,
    }),
  );

  app.get(
    `${API_V}/resolution/:id`,
    handle(
      (r) => {
        const resolution = findResolution(r.js, r.c.req.param("id"));
        if (!resolution) throw new JiraError(404, [`The resolution with id '${r.c.req.param("id")}' does not exist.`]);
        return r.c.json(formatResolution(r, resolution));
      },
      { scopes: READ_WORK },
    ),
  );

  app.get(
    `${API_V}/field`,
    handle((r) => r.c.json(allFields(r.js).map((field) => ({ ...field, key: field.id }))), { scopes: READ_WORK }),
  );

  app.get(
    `${API_V}/label`,
    handle(
      (r) => {
        const labels = [...new Set(r.js.issues.all().flatMap((issue) => issue.labels))].sort();
        const page = paginate(labels, pageParams(r.c, 1000));
        return r.c.json(page);
      },
      { scopes: READ_WORK },
    ),
  );

  app.get(
    `${API_V}/issueLinkType`,
    handle(
      (r) =>
        r.c.json({
          issueLinkTypes: r.js.issueLinkTypes.all().map((type) => ({
            id: String(type.id),
            name: type.name,
            inward: type.inward,
            outward: type.outward,
            self: restUrl(r, `/issueLinkType/${type.id}`),
          })),
        }),
      { scopes: READ_WORK },
    ),
  );

  app.get(
    `${API_V}/project/:key/statuses`,
    handle(
      (r) => {
        const project = findProject(r.js, r.c.req.param("key"));
        if (!project) throw new JiraError(404, [`No project could be found with key '${r.c.req.param("key")}'.`]);
        const statuses = projectStatuses(r, project).map((status) => formatStatus(r, status));
        return r.c.json(
          project.issue_type_ids
            .map((id) => r.js.issueTypes.get(id))
            .filter(Boolean)
            .map((type) => ({
              self: restUrl(r, `/issuetype/${type!.id}`),
              id: String(type!.id),
              name: type!.name,
              subtask: type!.subtask,
              statuses,
            })),
        );
      },
      { scopes: READ_WORK },
    ),
  );
}
