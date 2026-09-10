import type { S1Filter } from "../entities.js";
import { formatAgent, formatFilter, formatGroup } from "../formatters.js";
import {
  api,
  bool,
  containsAny,
  dataOf,
  filterOf,
  list,
  matchesList,
  notFound,
  obj,
  oneOf,
  paginate,
  parseJsonBody,
  queryParams,
  route,
  str,
  strOrNull,
  validation,
} from "../helpers.js";
import { formatPolicy, groupPolicy, stripPolicyMeta } from "../policy.js";
import { logEvent, nextId } from "../store.js";
import {
  createGroup,
  findAccount,
  findAgent,
  findGroup,
  findSite,
  reassignSiteAgents,
  requestUser,
  type S1RouteContext,
} from "../route-utils.js";

const GROUP_TYPES = ["static", "pinned", "dynamic"] as const;

export function groupRoutes(rc: S1RouteContext): void {
  const { app, ss, fmt } = rc;

  route(
    app,
    "get",
    "/groups",
    api(ss, (c) => {
      const params = queryParams(c);
      const accountIds = params.list("accountIds");
      const rows = ss.groups
        .all()
        .filter((group) => matchesList(group.s1_id, params.list("groupIds") ?? params.list("ids")))
        .filter((group) => matchesList(group.site_id, params.list("siteIds")))
        .filter((group) => {
          if (!accountIds) return true;
          const site = ss.sites.findOneBy("s1_id", group.site_id);
          return !!site && accountIds.includes(site.account_id);
        })
        .filter((group) => matchesList(group.name, params.list("name")))
        .filter((group) => containsAny(group.name, params.list("name__contains") ?? params.list("query")))
        .filter((group) => matchesList(group.type, params.list("types") ?? params.list("type")))
        .filter((group) =>
          params.bool("isDefault") === undefined ? true : group.isDefault === params.bool("isDefault"),
        )
        .filter((group) => ss.sites.findOneBy("s1_id", group.site_id)?.state !== "deleted")
        .sort((a, b) => a.id - b.id)
        .map((group) => formatGroup(fmt, group));
      return c.json(
        paginate(c, rows, { sortable: ["id", "name", "rank", "type", "createdAt", "updatedAt", "totalAgents"] }),
      );
    }),
  );

  route(
    app,
    "post",
    "/groups",
    api(ss, async (c, key) => {
      const data = dataOf(await parseJsonBody(c));
      const siteId = str(data.siteId);
      if (!siteId) throw validation("siteId is required");
      const name = str(data.name)?.trim();
      if (!name) throw validation("name is required");
      const type = oneOf(data.type, GROUP_TYPES, "type");
      const filterId = strOrNull(data.filterId);
      if (type === "dynamic" && !filterId) throw validation("filterId is required for dynamic groups");
      const group = createGroup(ss, {
        siteId,
        name,
        inherits: bool(data.inherits) ?? true,
        filterId,
        type,
        description: strOrNull(data.description),
        policy:
          data.policy && typeof data.policy === "object"
            ? stripPolicyMeta(data.policy as Record<string, unknown>)
            : null,
        creator: requestUser(ss, key.user_id),
      });
      reassignSiteAgents(ss, group.site_id);
      return c.json({ data: formatGroup(fmt, group) });
    }),
  );

  route(
    app,
    "get",
    "/groups/:id",
    api(ss, (c) => c.json({ data: formatGroup(fmt, findGroup(ss, c.req.param("id"))) })),
  );

  route(
    app,
    "put",
    "/groups/:id",
    api(ss, async (c) => {
      const group = findGroup(ss, c.req.param("id"));
      const data = dataOf(await parseJsonBody(c));
      const name = data.name !== undefined ? (str(data.name)?.trim() ?? "") : group.name;
      if (!name) throw validation("name cannot be empty");
      if (
        ss.groups
          .findBy("site_id", group.site_id)
          .some((candidate) => candidate.id !== group.id && candidate.name.toLowerCase() === name.toLowerCase())
      )
        throw validation(`A group named ${name} already exists`, 4000030);
      const filterId = data.filterId !== undefined ? strOrNull(data.filterId) : group.filter_id;
      if (filterId && !ss.filters.findOneBy("s1_id", filterId)) throw notFound(`Filter ${filterId} was not found`);
      const updated = ss.groups.update(group.id, {
        name,
        description: data.description !== undefined ? strOrNull(data.description) : group.description,
        inherits: bool(data.inherits) ?? group.inherits,
        filter_id: filterId,
        type:
          data.type !== undefined
            ? (oneOf(data.type, GROUP_TYPES, "type") ?? group.type)
            : filterId && group.type === "static"
              ? "dynamic"
              : group.type,
      })!;
      reassignSiteAgents(ss, updated.site_id);
      logEvent(ss, "group.updated", updated.s1_id, { name: updated.name });
      return c.json({ data: formatGroup(fmt, updated) });
    }),
  );

  route(
    app,
    "delete",
    "/groups/:id",
    api(ss, (c) => {
      const group = findGroup(ss, c.req.param("id"));
      if (group.isDefault) throw validation("The default group of a site cannot be deleted");
      ss.groups.delete(group.id);
      reassignSiteAgents(ss, group.site_id);
      logEvent(ss, "group.deleted", group.s1_id, { name: group.name, siteId: group.site_id });
      return c.json({ data: { success: true } });
    }),
  );

  route(
    app,
    "get",
    "/groups/:id/policy",
    api(ss, (c) => {
      const group = findGroup(ss, c.req.param("id"));
      return c.json({ data: formatPolicy(groupPolicy(ss, group.s1_id), group.updated_at) });
    }),
  );

  route(
    app,
    "put",
    "/groups/:id/policy",
    api(ss, async (c, key) => {
      const group = findGroup(ss, c.req.param("id"));
      const data = stripPolicyMeta(dataOf(await parseJsonBody(c)));
      if (Object.keys(data).length === 0) throw validation("data must contain at least one policy field");
      const updated = ss.groups.update(group.id, { inherits: false, policy: { ...(group.policy ?? {}), ...data } })!;
      logEvent(ss, "policy.updated", group.s1_id, { level: "group", fields: Object.keys(data) });
      return c.json({
        data: formatPolicy(groupPolicy(ss, updated.s1_id), updated.updated_at, requestUser(ss, key.user_id)),
      });
    }),
  );

  route(
    app,
    "put",
    "/groups/:id/revert-policy",
    api(ss, (c) => {
      const group = findGroup(ss, c.req.param("id"));
      const updated = ss.groups.update(group.id, { inherits: true, policy: null })!;
      return c.json({ data: formatPolicy(groupPolicy(ss, updated.s1_id), updated.updated_at) });
    }),
  );

  route(
    app,
    "put",
    "/groups/:id/move-agents",
    api(ss, async (c) => {
      const group = findGroup(ss, c.req.param("id"));
      if (group.type === "dynamic") throw validation("Agents cannot be moved manually into a dynamic group");
      const filter = filterOf(await parseJsonBody(c));
      const ids = list(filter.ids) ?? [];
      const agents = ids.map((id) => findAgent(ss, id)).filter((agent) => agent.site_id === group.site_id);
      for (const agent of agents) ss.agents.update(agent.id, { group_id: group.s1_id });
      return c.json({ data: { agentsMoved: agents.length } });
    }),
  );

  route(
    app,
    "get",
    "/groups/:id/agents",
    api(ss, (c) => {
      const group = findGroup(ss, c.req.param("id"));
      return c.json(
        paginate(
          c,
          ss.agents.findBy("group_id", group.s1_id).map((agent) => formatAgent(fmt, agent)),
        ),
      );
    }),
  );

  route(
    app,
    "get",
    "/filters",
    api(ss, (c) => {
      const params = queryParams(c);
      const siteIds = params.list("siteIds");
      const accountIds = params.list("accountIds");
      const rows = ss.filters
        .all()
        .filter((filter) => matchesList(filter.s1_id, params.list("ids")))
        .filter((filter) => (siteIds ? filter.scope_level === "site" && siteIds.includes(filter.scope_id) : true))
        .filter((filter) =>
          accountIds ? filter.scope_level === "account" && accountIds.includes(filter.scope_id) : true,
        )
        .filter((filter) => containsAny(filter.name, params.list("name__contains") ?? params.list("query")))
        .filter((filter) => matchesList(filter.name, params.list("name")))
        .sort((a, b) => a.id - b.id)
        .map(formatFilter);
      return c.json(paginate(c, rows, { sortable: ["id", "name", "createdAt", "updatedAt"] }));
    }),
  );

  route(
    app,
    "post",
    "/filters",
    api(ss, async (c) => {
      const body = await parseJsonBody(c);
      const data = dataOf(body);
      const filter = filterOf(body);
      const name = str(data.name)?.trim();
      if (!name) throw validation("name is required");
      const siteIds = list(filter.siteIds);
      const accountIds = list(filter.accountIds);
      const scope: Pick<S1Filter, "scope_level" | "scope_id"> =
        siteIds && siteIds.length > 0
          ? { scope_level: "site", scope_id: findSite(ss, siteIds[0]).s1_id }
          : accountIds && accountIds.length > 0
            ? { scope_level: "account", scope_id: findAccount(ss, accountIds[0]).s1_id }
            : { scope_level: "site", scope_id: "" };
      if (!scope.scope_id) throw validation("filter.siteIds or filter.accountIds is required");
      if (
        ss.filters
          .findBy("scope_id", scope.scope_id)
          .some((candidate) => candidate.name.toLowerCase() === name.toLowerCase())
      )
        throw validation(`A filter named ${name} already exists in this scope`, 4000030);
      const created = ss.filters.insert({
        s1_id: nextId(ss),
        ...scope,
        name,
        filterFields: obj(data.filterFields) ?? {},
      });
      logEvent(ss, "filter.created", created.s1_id, {
        name,
        scope: scope.scope_level,
        scopeId: scope.scope_id,
        filterFields: created.filterFields,
      });
      return c.json({ data: formatFilter(created) });
    }),
  );

  route(
    app,
    "get",
    "/filters/:id",
    api(ss, (c) => {
      const filter = ss.filters.findOneBy("s1_id", c.req.param("id"));
      if (!filter) throw notFound(`Filter ${c.req.param("id")} was not found`);
      return c.json({ data: formatFilter(filter) });
    }),
  );

  route(
    app,
    "put",
    "/filters/:id",
    api(ss, async (c) => {
      const filter = ss.filters.findOneBy("s1_id", c.req.param("id"));
      if (!filter) throw notFound(`Filter ${c.req.param("id")} was not found`);
      const data = dataOf(await parseJsonBody(c));
      const updated = ss.filters.update(filter.id, {
        name: str(data.name)?.trim() || filter.name,
        filterFields: obj(data.filterFields) ?? filter.filterFields,
      })!;
      if (filter.scope_level === "site") reassignSiteAgents(ss, filter.scope_id);
      return c.json({ data: formatFilter(updated) });
    }),
  );

  route(
    app,
    "delete",
    "/filters/:id",
    api(ss, (c) => {
      const filter = ss.filters.findOneBy("s1_id", c.req.param("id"));
      if (!filter) throw notFound(`Filter ${c.req.param("id")} was not found`);
      const usedBy = ss.groups.all().filter((group) => group.filter_id === filter.s1_id);
      if (usedBy.length > 0)
        throw validation(`Filter ${filter.name} is used by ${usedBy.length} dynamic group(s) and cannot be deleted`);
      ss.filters.delete(filter.id);
      logEvent(ss, "filter.deleted", filter.s1_id, { name: filter.name });
      return c.json({ data: formatFilter(filter) });
    }),
  );
}
