import type { Entity } from "@emulators/core";
import { formatGroup, formatOrganization, formatTicket, formatUser } from "../formatters.js";
import { api, requireAgent, route, zendeskList } from "../helpers.js";
import {
  matchGroup,
  matchOrganization,
  matchTicket,
  matchUser,
  parseSearchQuery,
  type SearchQuery,
} from "../search.js";
import { liveOrganizations, liveTickets, liveUsers, type ZendeskRouteContext } from "../route-utils.js";

interface SearchResult extends Entity {
  result_type: string;
  sort_key: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export function searchRoutes(rc: ZendeskRouteContext): void {
  const { app, zs, fmt } = rc;

  function runSearch(query: SearchQuery, currentUserId: number): SearchResult[] {
    const currentUser = zs.users.findOneBy("zd_id", currentUserId) ?? null;
    const results: SearchResult[] = [];
    let counter = 0;
    const push = (type: string, entity: Entity, payload: Record<string, unknown>) => {
      counter += 1;
      results.push({
        id: counter,
        created_at: entity.created_at,
        updated_at: entity.updated_at,
        result_type: type,
        sort_key: {
          created_at: payload.created_at,
          updated_at: payload.updated_at,
          priority: payload.priority,
          status: payload.status,
          ticket_type: payload.type,
        },
        payload: { ...payload, result_type: type },
      });
    };
    if (!query.type || query.type === "ticket") {
      for (const ticket of liveTickets(zs)) {
        if (matchTicket(zs, ticket, query, currentUser)) push("ticket", ticket, formatTicket(fmt, ticket));
      }
    }
    if (!query.type || query.type === "user") {
      for (const user of liveUsers(zs)) if (matchUser(zs, user, query)) push("user", user, formatUser(fmt, user));
    }
    if (!query.type || query.type === "organization") {
      for (const organization of liveOrganizations(zs)) {
        if (matchOrganization(zs, organization, query))
          push("organization", organization, formatOrganization(fmt, organization));
      }
    }
    if (!query.type || query.type === "group") {
      for (const group of zs.groups.all().filter((candidate) => !candidate.deleted)) {
        if (matchGroup(group, query)) push("group", group, formatGroup(fmt, group));
      }
    }
    return results;
  }

  function sortResults(
    c: { req: { query(name: string): string | undefined } },
    query: SearchQuery,
    results: SearchResult[],
  ): SearchResult[] {
    const sortBy = c.req.query("sort_by") ?? query.orderBy ?? "relevance";
    const desc = (c.req.query("sort_order") ?? (query.sortDesc ? "desc" : "asc")) === "desc";
    if (sortBy === "relevance") return results;
    const key = sortBy === "created" ? "created_at" : sortBy === "updated" ? "updated_at" : sortBy;
    return [...results].sort((a, b) => {
      const av = a.sort_key[key] ?? a.payload[key];
      const bv = b.sort_key[key] ?? b.payload[key];
      const result =
        av === bv
          ? 0
          : av === undefined || av === null
            ? 1
            : bv === undefined || bv === null
              ? -1
              : String(av).localeCompare(String(bv));
      return desc ? -result : result;
    });
  }

  route(
    app,
    "get",
    "/api/v2/search",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const query = parseSearchQuery(c.req.query("query") ?? "");
      const results = sortResults(c, query, runSearch(query, auth.user.zd_id));
      return zendeskList(c, results, "results", (result) => result.payload, { extra: { facets: null } });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/search/count",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const query = parseSearchQuery(c.req.query("query") ?? "");
      return c.json({ count: runSearch(query, auth.user.zd_id).length });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/search/export",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const type = c.req.query("filter[type]");
      const query = parseSearchQuery(c.req.query("query") ?? "");
      if (type === "ticket" || type === "user" || type === "organization" || type === "group") query.type = type;
      const results = sortResults(c, query, runSearch(query, auth.user.zd_id));
      return zendeskList(c, results, "results", (result) => result.payload, {
        cursorOnly: true,
        extra: { facets: null },
      });
    }),
  );
}
