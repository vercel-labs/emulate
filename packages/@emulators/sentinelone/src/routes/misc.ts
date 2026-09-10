import { formatActivity } from "../formatters.js";
import { api, containsAny, matchesList, paginate, queryParams, route } from "../helpers.js";
import { tenant } from "../store.js";
import { agentInScope, scopeFromParams, type S1RouteContext } from "../route-utils.js";

export function miscRoutes(rc: S1RouteContext): void {
  const { app, ss, fmt, baseUrl } = rc;

  route(
    app,
    "get",
    "/system/info",
    api(ss, (c) =>
      c.json({
        data: {
          release: "Emulate SentinelOne 24.2",
          buildNumber: "24.2.2.118",
          latestAgentVersion: "24.2.2.118",
          console: tenant(ss).consoleUrl,
          region: tenant(ss).region,
          emulatorBaseUrl: baseUrl,
        },
      }),
    ),
  );

  route(
    app,
    "get",
    "/system/status",
    api(ss, (c) => c.json({ data: { health: "ok", status: "OK" } })),
  );
  route(
    app,
    "get",
    "/system/status/db",
    api(ss, (c) => c.json({ data: { health: "ok", status: "OK" } })),
  );
  route(
    app,
    "get",
    "/system/status/cache",
    api(ss, (c) => c.json({ data: { health: "ok", status: "OK" } })),
  );

  route(
    app,
    "get",
    "/activities",
    api(ss, (c) => {
      const params = queryParams(c);
      const scope = scopeFromParams(params);
      const activityTypes = params.list("activityTypes");
      const rows = ss.activities
        .all()
        .filter((activity) => matchesList(activity.s1_id, params.list("ids")))
        .filter((activity) => (activityTypes ? activityTypes.includes(String(activity.activityType)) : true))
        .filter((activity) => matchesList(activity.agent_id, params.list("agentIds")))
        .filter((activity) => matchesList(activity.threat_id, params.list("threatIds")))
        .filter((activity) => matchesList(activity.user_id, params.list("userIds")))
        .filter((activity) => {
          if (!scope.siteIds && !scope.accountIds && !scope.groupIds) return true;
          if (activity.agent_id) {
            const agent = ss.agents.findOneBy("s1_id", activity.agent_id);
            return !!agent && agentInScope(ss, agent, scope);
          }
          if (scope.groupIds && activity.group_id) return scope.groupIds.includes(activity.group_id);
          if (scope.siteIds && activity.site_id) return scope.siteIds.includes(activity.site_id);
          if (scope.accountIds && activity.account_id) return scope.accountIds.includes(activity.account_id);
          return false;
        })
        .filter((activity) => containsAny(activity.primaryDescription, params.list("query")))
        .filter((activity) =>
          params.get("createdAt__gte") ? activity.created_at >= params.get("createdAt__gte")! : true,
        )
        .filter((activity) =>
          params.get("createdAt__lte") ? activity.created_at <= params.get("createdAt__lte")! : true,
        )
        .sort((a, b) => b.id - a.id)
        .map((activity) => formatActivity(fmt, activity));
      return c.json(paginate(c, rows, { sortable: ["id", "createdAt", "activityType", "primaryDescription"] }));
    }),
  );

  route(
    app,
    "get",
    "/activities/types",
    api(ss, (c) => {
      const types = [...new Set(ss.activities.all().map((activity) => activity.activityType))].sort((a, b) => a - b);
      return c.json({
        data: types.map((type) => ({
          id: type,
          action: `activity_${type}`,
          descriptionTemplate:
            ss.activities.all().find((activity) => activity.activityType === type)?.primaryDescription ?? "",
        })),
      });
    }),
  );

  route(
    app,
    "get",
    "/private/agents/summary",
    api(ss, (c) => {
      const params = queryParams(c);
      const scope = scopeFromParams(params);
      const agents = ss.agents.all().filter((agent) => agentInScope(ss, agent, scope) && !agent.isDecommissioned);
      return c.json({
        data: {
          total: agents.length,
          online: agents.filter((agent) => agent.isActive).length,
          infected: agents.filter((agent) => agent.infected).length,
          outOfDate: agents.filter((agent) => !agent.isUpToDate).length,
          decommissioned: ss.agents.all().filter((agent) => agentInScope(ss, agent, scope) && agent.isDecommissioned)
            .length,
        },
      });
    }),
  );

  app.get("/_sentinelone/events", (c) => {
    const type = c.req.query("type");
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 1000);
    const events = [...ss.events.all()]
      .filter((event) => !type || event.type === type)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
    return c.json({
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        subject: event.subject,
        detail: event.detail,
        created_at: event.created_at,
      })),
    });
  });

  app.delete("/_sentinelone/events", (c) => {
    ss.events.clear();
    return c.json({ ok: true });
  });
}
