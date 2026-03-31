import { parsePagination, setLinkHeader, type RouteContext } from "@emulators/core";
import { generateOktaId, normalizeGroupType } from "../helpers.js";
import {
  findGroupByRef,
  findUserByRef,
  groupResponse,
  oktaError,
  readJsonObject,
  requireManagementAuth,
  userResponse,
} from "../route-helpers.js";
import { getOktaStore } from "../store.js";

export function groupRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const oktaStore = getOktaStore(store);

  app.get("/api/v1/groups", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const q = (c.req.query("q") ?? "").toLowerCase();
    let groups = oktaStore.groups.all();
    if (q) {
      groups = groups.filter((group) =>
        `${group.name} ${group.description ?? ""}`.toLowerCase().includes(q),
      );
    }
    const { page, per_page } = parsePagination(c);
    const total = groups.length;
    const start = (page - 1) * per_page;
    const paged = groups.slice(start, start + per_page);
    setLinkHeader(c, total, page, per_page);
    c.header("X-Total-Count", String(total));

    return c.json(paged.map((group) => groupResponse(baseUrl, group)));
  });

  app.post("/api/v1/groups", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const body = await readJsonObject(c);
    const profile = (body.profile && typeof body.profile === "object" ? body.profile : {}) as Record<string, unknown>;
    const name = typeof profile.name === "string" ? profile.name.trim() : "";

    if (!name) {
      return oktaError(c, 400, "E0000001", "profile.name is required");
    }

    if (oktaStore.groups.findOneBy("name", name)) {
      return oktaError(c, 400, "E0000001", "A group with the same name already exists");
    }

    const created = oktaStore.groups.insert({
      okta_id: generateOktaId("00g"),
      type: normalizeGroupType(typeof body.type === "string" ? body.type : undefined, "OKTA_GROUP"),
      name,
      description: typeof profile.description === "string" ? profile.description : null,
    });

    return c.json(groupResponse(baseUrl, created), 201);
  });

  app.get("/api/v1/groups/:groupId/users", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const group = findGroupByRef(oktaStore, c.req.param("groupId"));
    if (!group) return oktaError(c, 404, "E0000007", "Not found: group");

    const memberships = oktaStore.groupMemberships.findBy("group_okta_id", group.okta_id);
    const users = memberships
      .map((membership) => oktaStore.users.findOneBy("okta_id", membership.user_okta_id))
      .filter((user): user is NonNullable<typeof user> => Boolean(user));

    return c.json(users.map((user) => userResponse(baseUrl, user)));
  });

  app.put("/api/v1/groups/:groupId/users/:userId", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const group = findGroupByRef(oktaStore, c.req.param("groupId"));
    if (!group) return oktaError(c, 404, "E0000007", "Not found: group");
    const user = findUserByRef(oktaStore, c.req.param("userId"));
    if (!user) return oktaError(c, 404, "E0000007", "Not found: user");

    const existing = oktaStore.groupMemberships
      .findBy("group_okta_id", group.okta_id)
      .find((membership) => membership.user_okta_id === user.okta_id);
    if (!existing) {
      oktaStore.groupMemberships.insert({
        group_okta_id: group.okta_id,
        user_okta_id: user.okta_id,
      });
    }

    return new Response(null, { status: 204 });
  });

  app.delete("/api/v1/groups/:groupId/users/:userId", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const group = findGroupByRef(oktaStore, c.req.param("groupId"));
    if (!group) return oktaError(c, 404, "E0000007", "Not found: group");
    const user = findUserByRef(oktaStore, c.req.param("userId"));
    if (!user) return oktaError(c, 404, "E0000007", "Not found: user");

    const existing = oktaStore.groupMemberships
      .findBy("group_okta_id", group.okta_id)
      .find((membership) => membership.user_okta_id === user.okta_id);
    if (existing) {
      oktaStore.groupMemberships.delete(existing.id);
    }

    return new Response(null, { status: 204 });
  });

  app.get("/api/v1/groups/:groupId", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const group = findGroupByRef(oktaStore, c.req.param("groupId"));
    if (!group) return oktaError(c, 404, "E0000007", "Not found: group");
    return c.json(groupResponse(baseUrl, group));
  });

  app.put("/api/v1/groups/:groupId", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const group = findGroupByRef(oktaStore, c.req.param("groupId"));
    if (!group) return oktaError(c, 404, "E0000007", "Not found: group");

    const body = await readJsonObject(c);
    const profile = (body.profile && typeof body.profile === "object" ? body.profile : {}) as Record<string, unknown>;
    const nextName = typeof profile.name === "string" ? profile.name.trim() : group.name;

    if (nextName !== group.name) {
      const existing = oktaStore.groups.findOneBy("name", nextName);
      if (existing && existing.okta_id !== group.okta_id) {
        return oktaError(c, 400, "E0000001", "A group with the same name already exists");
      }
    }

    const updated = oktaStore.groups.update(group.id, {
      name: nextName,
      description: typeof profile.description === "string" ? profile.description : group.description,
      type: normalizeGroupType(typeof body.type === "string" ? body.type : undefined, group.type),
    });
    return c.json(groupResponse(baseUrl, updated ?? group));
  });

  app.delete("/api/v1/groups/:groupId", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const group = findGroupByRef(oktaStore, c.req.param("groupId"));
    if (!group) return oktaError(c, 404, "E0000007", "Not found: group");

    for (const membership of oktaStore.groupMemberships.findBy("group_okta_id", group.okta_id)) {
      oktaStore.groupMemberships.delete(membership.id);
    }

    oktaStore.groups.delete(group.id);
    return new Response(null, { status: 204 });
  });
}
