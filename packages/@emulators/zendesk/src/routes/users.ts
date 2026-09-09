import type { AppEnv, Context } from "@emulators/core";
import type { JobResult, ZendeskUser } from "../entities.js";
import {
  formatGroup,
  formatGroupMembership,
  formatJobStatus,
  formatOrganization,
  formatOrganizationMembership,
  formatTicket,
  formatUser,
} from "../formatters.js";
import {
  ZendeskApiError,
  api,
  idList,
  list,
  normalizeTags,
  obj,
  parseJsonBody,
  recordInvalid,
  requireAgent,
  route,
  str,
  stringList,
  zendeskList,
  type Body,
} from "../helpers.js";
import { createJob, createUser, deleteUser, findUserByEmail, parseUserInput, updateUser } from "../records.js";
import { matchUser, parseSearchQuery } from "../search.js";
import {
  canSeeTicket,
  findGroup,
  findOrganization,
  findUser,
  idParam,
  liveTickets,
  liveUsers,
  type ZendeskRouteContext,
} from "../route-utils.js";

export function userRoutes(rc: ZendeskRouteContext): void {
  const { app, zs, ctx, fmt } = rc;
  const userRow = (user: ZendeskUser) => formatUser(fmt, user);

  route(
    app,
    "get",
    "/api/v2/users/me",
    api(zs, (c, auth) => c.json({ user: userRow(auth.user) })),
  );

  route(
    app,
    "get",
    "/api/v2/users",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const roles = new Set([...stringList(c.req.query("role")), ...(c.req.queries("role[]") ?? [])]);
      const externalId = c.req.query("external_id");
      let users = liveUsers(zs);
      if (roles.size > 0) users = users.filter((user) => roles.has(user.role));
      if (externalId) users = users.filter((user) => user.external_id === externalId);
      return zendeskList(c, users, "users", userRow);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/users/search",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const query = c.req.query("query") ?? "";
      const externalId = c.req.query("external_id");
      let users = liveUsers(zs);
      if (externalId) users = users.filter((user) => user.external_id === externalId);
      else if (query) {
        const parsed = parseSearchQuery(query);
        users = users.filter((user) => matchUser(zs, user, parsed));
      }
      return zendeskList(c, users, "users", userRow);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/users/autocomplete",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const name = (c.req.query("name") ?? "").toLowerCase();
      const users = liveUsers(zs).filter(
        (user) =>
          name.length > 0 && (user.name.toLowerCase().includes(name) || user.email?.toLowerCase().includes(name)),
      );
      return zendeskList(c, users, "users", userRow);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/users/show_many",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const ids = idList(c.req.query("ids"));
      const externalIds = stringList(c.req.query("external_ids"));
      const users = liveUsers(zs).filter(
        (user) => ids.includes(user.zd_id) || (user.external_id !== null && externalIds.includes(user.external_id)),
      );
      return zendeskList(c, users, "users", userRow);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/users/count",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return c.json({ count: { value: liveUsers(zs).length, refreshed_at: new Date().toISOString() } });
    }),
  );

  route(
    app,
    "post",
    "/api/v2/users",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const user = await createUser(ctx, parseUserInput(obj(body.user)));
      return c.json({ user: userRow(user) }, 201);
    }),
  );

  route(
    app,
    "post",
    "/api/v2/users/create_or_update",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const input = parseUserInput(obj(body.user));
      const existing =
        findUserByEmail(zs, input.email ?? undefined) ??
        (input.external_id ? liveUsers(zs).find((user) => user.external_id === input.external_id) : undefined);
      if (existing) {
        const updated = await updateUser(ctx, existing, input);
        return c.json({ user: userRow(updated) }, 200);
      }
      const user = await createUser(ctx, input);
      return c.json({ user: userRow(user) }, 201);
    }),
  );

  const bulkUsers = async (
    c: Context<AppEnv>,
    mode: "create" | "create_or_update" | "update",
    body: Body,
  ): Promise<Response> => {
    const items = list(body.users).map(obj);
    const results: JobResult[] = [];
    for (const [index, item] of items.entries()) {
      try {
        const input = parseUserInput(item);
        if (mode === "create") {
          const user = await createUser(ctx, input);
          results.push({ id: user.zd_id, index, action: "created", success: true, status: "Created" });
        } else if (mode === "create_or_update") {
          const existing =
            findUserByEmail(zs, input.email ?? undefined) ??
            (input.external_id ? liveUsers(zs).find((user) => user.external_id === input.external_id) : undefined);
          if (existing) {
            await updateUser(ctx, existing, input);
            results.push({ id: existing.zd_id, index, action: "updated", success: true, status: "Updated" });
          } else {
            const user = await createUser(ctx, input);
            results.push({ id: user.zd_id, index, action: "created", success: true, status: "Created" });
          }
        } else {
          const target =
            input.id !== undefined
              ? zs.users.findOneBy("zd_id", input.id)
              : findUserByEmail(zs, input.email ?? undefined);
          if (!target || target.deleted) throw recordInvalid({ id: "Id: user not found" });
          await updateUser(ctx, target, input);
          results.push({ id: target.zd_id, index, action: "updated", success: true, status: "Updated" });
        }
      } catch (error) {
        if (!(error instanceof ZendeskApiError)) throw error;
        results.push({
          index,
          action: mode === "update" ? "update" : "create",
          success: false,
          status: "Failed",
          errors: error.body.description ?? error.body.error,
          details: JSON.stringify(error.body.details ?? {}),
        });
      }
    }
    return c.json({ job_status: formatJobStatus(fmt, createJob(zs, results, "Completed")) }, 200);
  };
  const bulk = (mode: "create" | "create_or_update" | "update") =>
    api(zs, async (c, auth) => {
      requireAgent(auth);
      return bulkUsers(c, mode, await parseJsonBody(c));
    });

  route(app, "post", "/api/v2/users/create_many", bulk("create"));
  route(app, "post", "/api/v2/users/create_or_update_many", bulk("create_or_update"));

  route(
    app,
    "put",
    "/api/v2/users/update_many",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const ids = idList(c.req.query("ids"));
      const externalIds = stringList(c.req.query("external_ids"));
      const results: JobResult[] = [];
      if (ids.length > 0 || externalIds.length > 0) {
        const input = parseUserInput(obj(body.user));
        const targets = liveUsers(zs).filter(
          (user) => ids.includes(user.zd_id) || (user.external_id !== null && externalIds.includes(user.external_id)),
        );
        for (const [index, target] of targets.entries()) {
          await updateUser(ctx, target, input);
          results.push({ id: target.zd_id, index, action: "updated", success: true, status: "Updated" });
        }
      } else {
        return bulkUsers(c, "update", body);
      }
      return c.json({ job_status: formatJobStatus(fmt, createJob(zs, results, "Completed")) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/users/destroy_many",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const ids = idList(c.req.query("ids"));
      const externalIds = stringList(c.req.query("external_ids"));
      const targets = liveUsers(zs).filter(
        (user) => ids.includes(user.zd_id) || (user.external_id !== null && externalIds.includes(user.external_id)),
      );
      const results: JobResult[] = [];
      for (const [index, target] of targets.entries()) {
        await deleteUser(ctx, target);
        results.push({ id: target.zd_id, index, action: "deleted", success: true, status: "Deleted" });
      }
      return c.json({ job_status: formatJobStatus(fmt, createJob(zs, results, "Completed")) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/users/:id",
    api(zs, (c, auth) => {
      const user = findUser(zs, idParam(c.req.param("id")));
      if (auth.user.role === "end-user" && auth.user.zd_id !== user.zd_id) throw recordInvalidForbidden();
      return c.json({ user: userRow(user) });
    }),
  );

  route(
    app,
    "put",
    "/api/v2/users/:id",
    api(zs, async (c, auth) => {
      const user = findUser(zs, idParam(c.req.param("id")));
      if (auth.user.role === "end-user" && auth.user.zd_id !== user.zd_id) throw recordInvalidForbidden();
      const body = await parseJsonBody(c);
      const updated = await updateUser(ctx, user, parseUserInput(obj(body.user)));
      return c.json({ user: userRow(updated) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/users/:id",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const user = findUser(zs, idParam(c.req.param("id")));
      const deleted = await deleteUser(ctx, user);
      return c.json({ user: userRow(deleted) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/users/:id/related",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const user = findUser(zs, idParam(c.req.param("id")));
      const tickets = liveTickets(zs);
      return c.json({
        user_related: {
          assigned_tickets: tickets.filter((ticket) => ticket.assignee_id === user.zd_id).length,
          requested_tickets: tickets.filter((ticket) => ticket.requester_id === user.zd_id).length,
          ccd_tickets: tickets.filter((ticket) => ticket.email_cc_ids.includes(user.zd_id)).length,
          organization_subscriptions: 0,
        },
      });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/users/:id/identities",
    api(zs, (c) => {
      const user = findUser(zs, idParam(c.req.param("id")));
      const identities = [];
      if (user.email) {
        identities.push({
          id: user.zd_id * 10 + 1,
          url: `${rc.baseUrl}/api/v2/users/${user.zd_id}/identities/${user.zd_id * 10 + 1}.json`,
          user_id: user.zd_id,
          type: "email",
          value: user.email,
          verified: user.verified,
          primary: true,
          created_at: user.created_at,
          updated_at: user.updated_at,
          undeliverable_count: 0,
          deliverable_state: "deliverable",
        });
      }
      if (user.phone) {
        identities.push({
          id: user.zd_id * 10 + 2,
          url: `${rc.baseUrl}/api/v2/users/${user.zd_id}/identities/${user.zd_id * 10 + 2}.json`,
          user_id: user.zd_id,
          type: "phone_number",
          value: user.phone,
          verified: true,
          primary: false,
          created_at: user.created_at,
          updated_at: user.updated_at,
        });
      }
      return c.json({ identities, count: identities.length, next_page: null, previous_page: null });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/users/:id/organizations",
    api(zs, (c) => {
      const user = findUser(zs, idParam(c.req.param("id")));
      const organizations = zs.organizationMemberships
        .findBy("user_id", user.zd_id)
        .map((membership) => zs.organizations.findOneBy("zd_id", membership.organization_id))
        .filter(
          (organization): organization is NonNullable<typeof organization> => !!organization && !organization.deleted,
        );
      return zendeskList(c, organizations, "organizations", (organization) => formatOrganization(fmt, organization));
    }),
  );

  route(
    app,
    "get",
    "/api/v2/users/:id/organization_memberships",
    api(zs, (c) => {
      const user = findUser(zs, idParam(c.req.param("id")));
      return zendeskList(
        c,
        zs.organizationMemberships.findBy("user_id", user.zd_id),
        "organization_memberships",
        (membership) => formatOrganizationMembership(fmt, membership),
      );
    }),
  );

  route(
    app,
    "get",
    "/api/v2/users/:id/group_memberships",
    api(zs, (c) => {
      const user = findUser(zs, idParam(c.req.param("id")));
      return zendeskList(c, zs.groupMemberships.findBy("user_id", user.zd_id), "group_memberships", (membership) =>
        formatGroupMembership(fmt, membership),
      );
    }),
  );

  route(
    app,
    "get",
    "/api/v2/users/:id/groups",
    api(zs, (c) => {
      const user = findUser(zs, idParam(c.req.param("id")));
      const groups = zs.groupMemberships
        .findBy("user_id", user.zd_id)
        .map((membership) => zs.groups.findOneBy("zd_id", membership.group_id))
        .filter((group): group is NonNullable<typeof group> => !!group && !group.deleted);
      return zendeskList(c, groups, "groups", (group) => formatGroup(fmt, group));
    }),
  );

  const userTickets = (selector: (user: ZendeskUser) => (ticket: ReturnType<typeof liveTickets>[number]) => boolean) =>
    api(zs, (c, auth) => {
      const user = findUser(zs, idParam(c.req.param("id")));
      if (auth.user.role === "end-user" && auth.user.zd_id !== user.zd_id) throw recordInvalidForbidden();
      const tickets = liveTickets(zs)
        .filter(selector(user))
        .filter((ticket) => canSeeTicket(zs, auth.user, ticket));
      return zendeskList(c, tickets, "tickets", (ticket) => formatTicket(fmt, ticket));
    });

  route(
    app,
    "get",
    "/api/v2/users/:id/tickets/requested",
    userTickets((user) => (ticket) => ticket.requester_id === user.zd_id),
  );
  route(
    app,
    "get",
    "/api/v2/users/:id/tickets/ccd",
    userTickets((user) => (ticket) => ticket.email_cc_ids.includes(user.zd_id)),
  );
  route(
    app,
    "get",
    "/api/v2/users/:id/tickets/followed",
    userTickets((user) => (ticket) => ticket.follower_ids.includes(user.zd_id)),
  );
  route(
    app,
    "get",
    "/api/v2/users/:id/tickets/assigned",
    userTickets((user) => (ticket) => ticket.assignee_id === user.zd_id),
  );

  route(
    app,
    "get",
    "/api/v2/users/:id/tags",
    api(zs, (c) => c.json({ tags: findUser(zs, idParam(c.req.param("id"))).tags })),
  );

  const setUserTags = (mode: "set" | "add" | "remove") =>
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const user = findUser(zs, idParam(c.req.param("id")));
      const body = await parseJsonBody(c);
      const incoming = normalizeTags(body.tags);
      const tags =
        mode === "set"
          ? incoming
          : mode === "add"
            ? [...new Set([...user.tags, ...incoming])]
            : user.tags.filter((tag) => !incoming.includes(tag));
      const updated = await updateUser(ctx, user, { tags });
      return c.json({ tags: updated.tags }, mode === "add" ? 201 : 200);
    });

  route(app, "post", "/api/v2/users/:id/tags", setUserTags("set"));
  route(app, "put", "/api/v2/users/:id/tags", setUserTags("add"));
  route(app, "delete", "/api/v2/users/:id/tags", setUserTags("remove"));

  route(
    app,
    "get",
    "/api/v2/organizations/:id/users",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const organization = findOrganization(zs, idParam(c.req.param("id")));
      const memberIds = new Set(
        zs.organizationMemberships
          .findBy("organization_id", organization.zd_id)
          .map((membership) => membership.user_id),
      );
      const users = liveUsers(zs).filter(
        (user) => memberIds.has(user.zd_id) || user.organization_id === organization.zd_id,
      );
      return zendeskList(c, users, "users", userRow);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/groups/:id/users",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const group = findGroup(zs, idParam(c.req.param("id")));
      const memberIds = new Set(
        zs.groupMemberships.findBy("group_id", group.zd_id).map((membership) => membership.user_id),
      );
      return zendeskList(
        c,
        liveUsers(zs).filter((user) => memberIds.has(user.zd_id)),
        "users",
        userRow,
      );
    }),
  );

  route(
    app,
    "post",
    "/api/v2/users/:id/password",
    api(zs, async (c, auth) => {
      const user = findUser(zs, idParam(c.req.param("id")));
      if (auth.user.role === "end-user" && auth.user.zd_id !== user.zd_id) throw recordInvalidForbidden();
      const body = await parseJsonBody(c);
      const password = str(body.password);
      if (!password) throw recordInvalid({ password: "Password: cannot be blank" });
      zs.users.update(user.id, { password });
      return c.json({});
    }),
  );
}

function recordInvalidForbidden(): ZendeskApiError {
  return new ZendeskApiError(403, {
    error: "Forbidden",
    description:
      "You do not have access to this page. Please contact the account owner of this help desk for further help.",
  });
}
