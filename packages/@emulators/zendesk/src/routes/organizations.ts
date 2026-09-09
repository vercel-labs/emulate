import type { JobResult, ZendeskOrganization } from "../entities.js";
import {
  formatJobStatus,
  formatOrganization,
  formatOrganizationMembership,
  formatRequest,
  formatTicket,
} from "../formatters.js";
import {
  ZendeskApiError,
  api,
  idList,
  list,
  normalizeTags,
  num,
  obj,
  parseJsonBody,
  recordInvalid,
  recordNotFound,
  requireAgent,
  route,
  stringList,
  zendeskList,
} from "../helpers.js";
import {
  addOrganizationMembership,
  createJob,
  createOrganization,
  deleteOrganization,
  findOrganizationByName,
  parseOrganizationInput,
  removeOrganizationMembership,
  emitMembershipCreated,
  updateOrganization,
} from "../records.js";
import {
  canSeeTicket,
  findOrganization,
  findUser,
  idParam,
  liveOrganizations,
  liveTickets,
  type ZendeskRouteContext,
} from "../route-utils.js";

export function organizationRoutes(rc: ZendeskRouteContext): void {
  const { app, zs, ctx, fmt } = rc;
  const row = (organization: ZendeskOrganization) => formatOrganization(fmt, organization);

  route(
    app,
    "get",
    "/api/v2/organizations",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return zendeskList(c, liveOrganizations(zs), "organizations", row);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/organizations/count",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return c.json({ count: { value: liveOrganizations(zs).length, refreshed_at: new Date().toISOString() } });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/organizations/search",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const name = c.req.query("name");
      const externalId = c.req.query("external_id");
      let organizations = liveOrganizations(zs);
      if (name)
        organizations = organizations.filter((organization) => organization.name.toLowerCase() === name.toLowerCase());
      else if (externalId)
        organizations = organizations.filter((organization) => organization.external_id === externalId);
      else return c.json({ organizations: [], count: 0, next_page: null, previous_page: null });
      return zendeskList(c, organizations, "organizations", row);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/organizations/autocomplete",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const name = (c.req.query("name") ?? "").toLowerCase();
      const organizations = liveOrganizations(zs).filter(
        (organization) => name.length > 0 && organization.name.toLowerCase().startsWith(name),
      );
      return zendeskList(c, organizations, "organizations", row);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/organizations/show_many",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const ids = idList(c.req.query("ids"));
      const externalIds = stringList(c.req.query("external_ids"));
      const organizations = liveOrganizations(zs).filter(
        (organization) =>
          ids.includes(organization.zd_id) ||
          (organization.external_id !== null && externalIds.includes(organization.external_id)),
      );
      return zendeskList(c, organizations, "organizations", row);
    }),
  );

  route(
    app,
    "post",
    "/api/v2/organizations",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const organization = await createOrganization(ctx, parseOrganizationInput(obj(body.organization)));
      return c.json({ organization: row(organization) }, 201);
    }),
  );

  route(
    app,
    "post",
    "/api/v2/organizations/create_or_update",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const input = parseOrganizationInput(obj(body.organization));
      const existing =
        (input.id !== undefined ? zs.organizations.findOneBy("zd_id", input.id) : undefined) ??
        (input.external_id
          ? liveOrganizations(zs).find((organization) => organization.external_id === input.external_id)
          : undefined) ??
        findOrganizationByName(zs, input.name);
      if (existing && !existing.deleted) {
        const updated = await updateOrganization(ctx, existing, input);
        return c.json({ organization: row(updated) }, 200);
      }
      const organization = await createOrganization(ctx, input);
      return c.json({ organization: row(organization) }, 201);
    }),
  );

  route(
    app,
    "post",
    "/api/v2/organizations/create_many",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const results: JobResult[] = [];
      for (const [index, item] of list(body.organizations).map(obj).entries()) {
        try {
          const organization = await createOrganization(ctx, parseOrganizationInput(item));
          results.push({ id: organization.zd_id, index, action: "created", success: true, status: "Created" });
        } catch (error) {
          if (!(error instanceof ZendeskApiError)) throw error;
          results.push({
            index,
            action: "create",
            success: false,
            status: "Failed",
            errors: error.body.description ?? error.body.error,
            details: JSON.stringify(error.body.details ?? {}),
          });
        }
      }
      return c.json({ job_status: formatJobStatus(fmt, createJob(zs, results, "Completed")) });
    }),
  );

  route(
    app,
    "put",
    "/api/v2/organizations/update_many",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const ids = idList(c.req.query("ids"));
      const externalIds = stringList(c.req.query("external_ids"));
      const results: JobResult[] = [];
      if (ids.length > 0 || externalIds.length > 0) {
        const input = parseOrganizationInput(obj(body.organization));
        const targets = liveOrganizations(zs).filter(
          (organization) =>
            ids.includes(organization.zd_id) ||
            (organization.external_id !== null && externalIds.includes(organization.external_id)),
        );
        for (const [index, target] of targets.entries()) {
          await updateOrganization(ctx, target, input);
          results.push({ id: target.zd_id, index, action: "updated", success: true, status: "Updated" });
        }
      } else {
        for (const [index, item] of list(body.organizations).map(obj).entries()) {
          try {
            const input = parseOrganizationInput(item);
            const target =
              (input.id !== undefined ? zs.organizations.findOneBy("zd_id", input.id) : undefined) ??
              (input.external_id
                ? liveOrganizations(zs).find((organization) => organization.external_id === input.external_id)
                : undefined);
            if (!target || target.deleted) throw recordInvalid({ id: "Id: organization not found" });
            await updateOrganization(ctx, target, input);
            results.push({ id: target.zd_id, index, action: "updated", success: true, status: "Updated" });
          } catch (error) {
            if (!(error instanceof ZendeskApiError)) throw error;
            results.push({
              index,
              action: "update",
              success: false,
              status: "Failed",
              errors: error.body.description ?? error.body.error,
            });
          }
        }
      }
      return c.json({ job_status: formatJobStatus(fmt, createJob(zs, results, "Completed")) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/organizations/destroy_many",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const ids = idList(c.req.query("ids"));
      const externalIds = stringList(c.req.query("external_ids"));
      const targets = liveOrganizations(zs).filter(
        (organization) =>
          ids.includes(organization.zd_id) ||
          (organization.external_id !== null && externalIds.includes(organization.external_id)),
      );
      const results: JobResult[] = [];
      for (const [index, target] of targets.entries()) {
        await deleteOrganization(ctx, target);
        results.push({ id: target.zd_id, index, action: "deleted", success: true, status: "Deleted" });
      }
      return c.json({ job_status: formatJobStatus(fmt, createJob(zs, results, "Completed")) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/organizations/:id",
    api(zs, (c, auth) => {
      const organization = findOrganization(zs, idParam(c.req.param("id")));
      if (
        auth.user.role === "end-user" &&
        !zs.organizationMemberships
          .findBy("user_id", auth.user.zd_id)
          .some((m) => m.organization_id === organization.zd_id)
      ) {
        throw recordNotFound();
      }
      return c.json({ organization: row(organization) });
    }),
  );

  route(
    app,
    "put",
    "/api/v2/organizations/:id",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const organization = findOrganization(zs, idParam(c.req.param("id")));
      const body = await parseJsonBody(c);
      const updated = await updateOrganization(ctx, organization, parseOrganizationInput(obj(body.organization)));
      return c.json({ organization: row(updated) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/organizations/:id",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const organization = findOrganization(zs, idParam(c.req.param("id")));
      await deleteOrganization(ctx, organization);
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/organizations/:id/related",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const organization = findOrganization(zs, idParam(c.req.param("id")));
      return c.json({
        organization_related: {
          users_count: zs.organizationMemberships.findBy("organization_id", organization.zd_id).length,
          tickets_count: liveTickets(zs).filter((ticket) => ticket.organization_id === organization.zd_id).length,
        },
      });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/organizations/:id/tickets",
    api(zs, (c, auth) => {
      const organization = findOrganization(zs, idParam(c.req.param("id")));
      const tickets = liveTickets(zs).filter(
        (ticket) => ticket.organization_id === organization.zd_id && canSeeTicket(zs, auth.user, ticket),
      );
      return zendeskList(c, tickets, "tickets", (ticket) => formatTicket(fmt, ticket));
    }),
  );

  route(
    app,
    "get",
    "/api/v2/organizations/:id/requests",
    api(zs, (c, auth) => {
      const organization = findOrganization(zs, idParam(c.req.param("id")));
      const tickets = liveTickets(zs).filter(
        (ticket) => ticket.organization_id === organization.zd_id && canSeeTicket(zs, auth.user, ticket),
      );
      return zendeskList(c, tickets, "requests", (ticket) => formatRequest(fmt, ticket, auth.user.zd_id));
    }),
  );

  route(
    app,
    "get",
    "/api/v2/organizations/:id/organization_memberships",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const organization = findOrganization(zs, idParam(c.req.param("id")));
      return zendeskList(
        c,
        zs.organizationMemberships.findBy("organization_id", organization.zd_id),
        "organization_memberships",
        (membership) => formatOrganizationMembership(fmt, membership),
      );
    }),
  );

  route(
    app,
    "get",
    "/api/v2/organizations/:id/tags",
    api(zs, (c) => c.json({ tags: findOrganization(zs, idParam(c.req.param("id"))).tags })),
  );

  const setTags = (mode: "set" | "add" | "remove") =>
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const organization = findOrganization(zs, idParam(c.req.param("id")));
      const body = await parseJsonBody(c);
      const incoming = normalizeTags(body.tags);
      const tags =
        mode === "set"
          ? incoming
          : mode === "add"
            ? [...new Set([...organization.tags, ...incoming])]
            : organization.tags.filter((tag) => !incoming.includes(tag));
      const updated = await updateOrganization(ctx, organization, { tags });
      return c.json({ tags: updated.tags }, mode === "add" ? 201 : 200);
    });

  route(app, "post", "/api/v2/organizations/:id/tags", setTags("set"));
  route(app, "put", "/api/v2/organizations/:id/tags", setTags("add"));
  route(app, "delete", "/api/v2/organizations/:id/tags", setTags("remove"));

  route(
    app,
    "get",
    "/api/v2/organization_memberships",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return zendeskList(c, zs.organizationMemberships.all(), "organization_memberships", (membership) =>
        formatOrganizationMembership(fmt, membership),
      );
    }),
  );

  route(
    app,
    "post",
    "/api/v2/organization_memberships",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const input = obj(body.organization_membership);
      const userId = num(input.user_id);
      const organizationId = num(input.organization_id);
      if (userId === undefined) throw recordInvalid({ user_id: "User: cannot be blank" });
      if (organizationId === undefined) throw recordInvalid({ organization_id: "Organization: cannot be blank" });
      const membership = addOrganizationMembership(zs, userId, organizationId, input.default === true);
      const user = findUser(zs, userId);
      await emitMembershipCreated(ctx, user, organizationId);
      return c.json({ organization_membership: formatOrganizationMembership(fmt, membership) }, 201);
    }),
  );

  route(
    app,
    "post",
    "/api/v2/organization_memberships/create_many",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const results: JobResult[] = [];
      for (const [index, item] of list(body.organization_memberships).map(obj).entries()) {
        try {
          const userId = num(item.user_id);
          const organizationId = num(item.organization_id);
          if (userId === undefined || organizationId === undefined)
            throw recordInvalid({ user_id: "User: cannot be blank" });
          const membership = addOrganizationMembership(zs, userId, organizationId, item.default === true);
          await emitMembershipCreated(ctx, findUser(zs, userId), organizationId);
          results.push({ id: membership.zd_id, index, action: "created", success: true, status: "Created" });
        } catch (error) {
          if (!(error instanceof ZendeskApiError)) throw error;
          results.push({
            index,
            action: "create",
            success: false,
            status: "Failed",
            errors: error.body.description ?? error.body.error,
          });
        }
      }
      return c.json({ job_status: formatJobStatus(fmt, createJob(zs, results, "Completed")) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/organization_memberships/destroy_many",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const ids = idList(c.req.query("ids"));
      const results: JobResult[] = [];
      for (const [index, id] of ids.entries()) {
        const membership = zs.organizationMemberships.findOneBy("zd_id", id);
        if (!membership) {
          results.push({ id, index, action: "delete", success: false, status: "Failed", errors: "Not found" });
          continue;
        }
        removeOrganizationMembership(zs, membership);
        results.push({ id, index, action: "deleted", success: true, status: "Deleted" });
      }
      return c.json({ job_status: formatJobStatus(fmt, createJob(zs, results, "Completed")) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/organization_memberships/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const membership = zs.organizationMemberships.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!membership) throw recordNotFound();
      return c.json({ organization_membership: formatOrganizationMembership(fmt, membership) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/organization_memberships/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const membership = zs.organizationMemberships.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!membership) throw recordNotFound();
      removeOrganizationMembership(zs, membership);
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/users/:userId/organization_memberships/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const membership = zs.organizationMemberships.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!membership || membership.user_id !== idParam(c.req.param("userId"))) throw recordNotFound();
      removeOrganizationMembership(zs, membership);
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "put",
    "/api/v2/users/:userId/organization_memberships/:id/make_default",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const userId = idParam(c.req.param("userId"));
      const membership = zs.organizationMemberships.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!membership || membership.user_id !== userId) throw recordNotFound();
      for (const other of zs.organizationMemberships.findBy("user_id", userId)) {
        zs.organizationMemberships.update(other.id, { default: other.id === membership.id });
      }
      const user = findUser(zs, userId);
      zs.users.update(user.id, { organization_id: membership.organization_id });
      return zendeskList(c, zs.organizationMemberships.findBy("user_id", userId), "organization_memberships", (item) =>
        formatOrganizationMembership(fmt, item),
      );
    }),
  );
}
