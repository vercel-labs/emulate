import type { JobResult, ZendeskGroup } from "../entities.js";
import { formatGroup, formatGroupMembership, formatJobStatus } from "../formatters.js";
import {
  ZendeskApiError,
  api,
  bool,
  idList,
  list,
  num,
  obj,
  parseJsonBody,
  recordInvalid,
  recordNotFound,
  requireAgent,
  route,
  str,
  strOrNull,
  zendeskList,
} from "../helpers.js";
import { addGroupMembership, createGroup, createJob } from "../records.js";
import { findGroup, findUser, idParam, type ZendeskRouteContext } from "../route-utils.js";

export function groupRoutes(rc: ZendeskRouteContext): void {
  const { app, zs, fmt } = rc;
  const row = (group: ZendeskGroup) => formatGroup(fmt, group);
  const liveGroups = () => zs.groups.all().filter((group) => !group.deleted);

  route(
    app,
    "get",
    "/api/v2/groups",
    api(zs, (c) => zendeskList(c, liveGroups(), "groups", row)),
  );

  route(
    app,
    "get",
    "/api/v2/groups/assignable",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return zendeskList(c, liveGroups(), "groups", row);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/groups/count",
    api(zs, (c) => c.json({ count: { value: liveGroups().length, refreshed_at: new Date().toISOString() } })),
  );

  route(
    app,
    "post",
    "/api/v2/groups",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const input = obj(body.group);
      const group = createGroup(zs, {
        name: str(input.name) ?? "",
        description: strOrNull(input.description),
        default: bool(input.default),
        is_public: bool(input.is_public),
      });
      return c.json({ group: row(group) }, 201);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/groups/:id",
    api(zs, (c) => c.json({ group: row(findGroup(zs, idParam(c.req.param("id")))) })),
  );

  route(
    app,
    "put",
    "/api/v2/groups/:id",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const group = findGroup(zs, idParam(c.req.param("id")));
      const body = await parseJsonBody(c);
      const input = obj(body.group);
      const name = input.name !== undefined ? (str(input.name) ?? "").trim() : group.name;
      if (!name) throw recordInvalid({ name: "Name: cannot be blank" });
      if (bool(input.default) === true) {
        for (const other of zs.groups.all())
          if (other.default && other.id !== group.id) zs.groups.update(other.id, { default: false });
      }
      const updated = zs.groups.update(group.id, {
        name,
        description: input.description !== undefined ? strOrNull(input.description) : group.description,
        is_public: bool(input.is_public) ?? group.is_public,
        default: bool(input.default) ?? group.default,
      })!;
      return c.json({ group: row(updated) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/groups/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const group = findGroup(zs, idParam(c.req.param("id")));
      if (group.default) throw recordInvalid({ base: "Default group cannot be deleted" });
      zs.groups.update(group.id, { deleted: true });
      for (const membership of zs.groupMemberships.findBy("group_id", group.zd_id))
        zs.groupMemberships.delete(membership.id);
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/group_memberships",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return zendeskList(c, zs.groupMemberships.all(), "group_memberships", (membership) =>
        formatGroupMembership(fmt, membership),
      );
    }),
  );

  route(
    app,
    "get",
    "/api/v2/group_memberships/assignable",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return zendeskList(c, zs.groupMemberships.all(), "group_memberships", (membership) =>
        formatGroupMembership(fmt, membership),
      );
    }),
  );

  route(
    app,
    "get",
    "/api/v2/groups/:id/memberships",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const group = findGroup(zs, idParam(c.req.param("id")));
      return zendeskList(c, zs.groupMemberships.findBy("group_id", group.zd_id), "group_memberships", (membership) =>
        formatGroupMembership(fmt, membership),
      );
    }),
  );

  route(
    app,
    "post",
    "/api/v2/group_memberships",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const input = obj(body.group_membership);
      const userId = num(input.user_id);
      const groupId = num(input.group_id);
      if (userId === undefined) throw recordInvalid({ user_id: "User: cannot be blank" });
      if (groupId === undefined) throw recordInvalid({ group_id: "Group: cannot be blank" });
      const membership = addGroupMembership(zs, userId, groupId, bool(input.default) === true);
      return c.json({ group_membership: formatGroupMembership(fmt, membership) }, 201);
    }),
  );

  route(
    app,
    "post",
    "/api/v2/group_memberships/create_many",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const results: JobResult[] = [];
      for (const [index, item] of list(body.group_memberships).map(obj).entries()) {
        try {
          const userId = num(item.user_id);
          const groupId = num(item.group_id);
          if (userId === undefined || groupId === undefined) throw recordInvalid({ user_id: "User: cannot be blank" });
          const membership = addGroupMembership(zs, userId, groupId, bool(item.default) === true);
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
    "/api/v2/group_memberships/destroy_many",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const results: JobResult[] = [];
      for (const [index, id] of idList(c.req.query("ids")).entries()) {
        const membership = zs.groupMemberships.findOneBy("zd_id", id);
        if (!membership) {
          results.push({ id, index, action: "delete", success: false, status: "Failed", errors: "Not found" });
          continue;
        }
        zs.groupMemberships.delete(membership.id);
        results.push({ id, index, action: "deleted", success: true, status: "Deleted" });
      }
      return c.json({ job_status: formatJobStatus(fmt, createJob(zs, results, "Completed")) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/group_memberships/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const membership = zs.groupMemberships.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!membership) throw recordNotFound();
      return c.json({ group_membership: formatGroupMembership(fmt, membership) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/group_memberships/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const membership = zs.groupMemberships.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!membership) throw recordNotFound();
      zs.groupMemberships.delete(membership.id);
      const user = zs.users.findOneBy("zd_id", membership.user_id);
      if (user && user.default_group_id === membership.group_id) {
        const remaining = zs.groupMemberships.findBy("user_id", user.zd_id)[0];
        zs.users.update(user.id, { default_group_id: remaining?.group_id ?? null });
      }
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "put",
    "/api/v2/users/:userId/group_memberships/:id/make_default",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const userId = idParam(c.req.param("userId"));
      const membership = zs.groupMemberships.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!membership || membership.user_id !== userId) throw recordNotFound();
      for (const other of zs.groupMemberships.findBy("user_id", userId)) {
        zs.groupMemberships.update(other.id, { default: other.id === membership.id });
      }
      const user = findUser(zs, userId);
      zs.users.update(user.id, { default_group_id: membership.group_id });
      return zendeskList(c, zs.groupMemberships.findBy("user_id", userId), "group_memberships", (item) =>
        formatGroupMembership(fmt, item),
      );
    }),
  );
}
