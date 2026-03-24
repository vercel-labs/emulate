import type { RouteContext } from "@internal/core";
import { getIdpStore } from "../store.js";
import { scimAuthMiddleware } from "../scim/auth.js";
import {
  SERVICE_PROVIDER_CONFIG,
  RESOURCE_TYPES,
  SCIM_USER_SCHEMA,
  SCIM_GROUP_SCHEMA,
  SCIM_ENTERPRISE_USER_SCHEMA,
} from "../scim/constants.js";
import {
  idpUserToScimUser,
  scimUserToIdpUserInput,
  idpGroupToScimGroup,
  scimGroupToIdpGroupInput,
} from "../scim/schema-mapper.js";
import { scimListResponse, scimError, paginate } from "../scim/response.js";
import { parseFilter } from "../scim/filter-parser.js";
import { applyPatchOps } from "../scim/patch-handler.js";
import { generateUid } from "../helpers.js";

// Full SCIM 2.0 schema definitions for /Schemas endpoint
const SCHEMAS = [
  {
    id: SCIM_USER_SCHEMA,
    name: "User",
    description: "User Account",
    attributes: [
      { name: "userName", type: "string", multiValued: false, required: true, mutability: "readWrite", returned: "default", uniqueness: "server" },
      { name: "name", type: "complex", multiValued: false, required: false, subAttributes: [
        { name: "formatted", type: "string" },
        { name: "familyName", type: "string" },
        { name: "givenName", type: "string" },
      ]},
      { name: "displayName", type: "string", multiValued: false, required: false },
      { name: "emails", type: "complex", multiValued: true, required: false },
      { name: "active", type: "boolean", multiValued: false, required: false },
      { name: "groups", type: "complex", multiValued: true, required: false, mutability: "readOnly" },
    ],
    meta: { resourceType: "Schema", location: "/scim/v2/Schemas/" + SCIM_USER_SCHEMA },
  },
  {
    id: SCIM_GROUP_SCHEMA,
    name: "Group",
    description: "Group",
    attributes: [
      { name: "displayName", type: "string", multiValued: false, required: true },
      { name: "members", type: "complex", multiValued: true, required: false },
    ],
    meta: { resourceType: "Schema", location: "/scim/v2/Schemas/" + SCIM_GROUP_SCHEMA },
  },
  {
    id: SCIM_ENTERPRISE_USER_SCHEMA,
    name: "EnterpriseUser",
    description: "Enterprise User Extension",
    attributes: [
      { name: "department", type: "string", multiValued: false, required: false },
      { name: "employeeNumber", type: "string", multiValued: false, required: false },
      { name: "manager", type: "complex", multiValued: false, required: false },
    ],
    meta: { resourceType: "Schema", location: "/scim/v2/Schemas/" + SCIM_ENTERPRISE_USER_SCHEMA },
  },
];

export function scimRoutes({ app, store, baseUrl }: RouteContext): void {
  const idp = getIdpStore(store);
  const auth = scimAuthMiddleware(store);

  // Helper to return SCIM JSON with correct content type
  function scimJson(_c: any, body: any, status = 200, extraHeaders?: Record<string, string>) {
    const headers: Record<string, string> = {
      "Content-Type": "application/scim+json",
      ...extraHeaders,
    };
    return new Response(JSON.stringify(body), { status, headers });
  }

  // ─── Discovery (no auth required) ───────────────────────────────

  app.get("/scim/v2/ServiceProviderConfig", (c) => {
    return scimJson(c, SERVICE_PROVIDER_CONFIG);
  });

  app.get("/scim/v2/ResourceTypes", (c) => {
    return scimJson(c, RESOURCE_TYPES);
  });

  app.get("/scim/v2/Schemas", (c) => {
    return scimJson(c, SCHEMAS);
  });

  // ─── Users ──────────────────────────────────────────────────────

  // List users
  app.get("/scim/v2/Users", auth, (c) => {
    const allUsers = idp.users.all();
    const allGroups = idp.groups.all();
    let scimUsers = allUsers.map(u => idpUserToScimUser(u, baseUrl, allGroups));

    // Filter
    const filterParam = c.req.query("filter");
    if (filterParam) {
      const matcher = parseFilter(filterParam);
      scimUsers = scimUsers.filter(u => matcher(u as unknown as Record<string, unknown>));
    }

    // Pagination
    const startIndex = Math.max(1, parseInt(c.req.query("startIndex") ?? "1", 10));
    const count = parseInt(c.req.query("count") ?? "100", 10);
    const { page, total } = paginate(scimUsers, startIndex, count);

    return scimJson(c, scimListResponse(page, total, startIndex, page.length));
  });

  // Get user by ID
  app.get("/scim/v2/Users/:id", auth, (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const user = idp.users.get(id);
    if (!user) {
      return scimJson(c, scimError(404, "User not found"), 404);
    }
    const allGroups = idp.groups.all();
    return scimJson(c, idpUserToScimUser(user, baseUrl, allGroups));
  });

  // Create user
  app.post("/scim/v2/Users", auth, async (c) => {
    const body = await c.req.json();
    const userName = body.userName;

    // Check uniqueness
    if (userName) {
      const existing = idp.users.findOneBy("email", userName);
      if (existing) {
        return scimJson(c, scimError(409, "userName already exists", "uniqueness"), 409);
      }
    }

    const input = scimUserToIdpUserInput(body);
    const newUser = idp.users.insert({
      uid: (input.uid as string) ?? generateUid("idp"),
      email: (input.email as string) ?? userName,
      email_verified: true,
      name: (input.name as string) ?? userName ?? "",
      given_name: (input.given_name as string) ?? "",
      family_name: (input.family_name as string) ?? "",
      picture: (input.picture as string) ?? null,
      locale: (input.locale as string) ?? "en",
      groups: [],
      roles: [],
      attributes: (input.attributes as Record<string, unknown>) ?? {},
    });

    const allGroups = idp.groups.all();
    const scimUser = idpUserToScimUser(newUser, baseUrl, allGroups);
    return scimJson(c, scimUser, 201, { Location: `${baseUrl}/scim/v2/Users/${newUser.id}` });
  });

  // Replace user (PUT)
  app.put("/scim/v2/Users/:id", auth, async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const user = idp.users.get(id);
    if (!user) {
      return scimJson(c, scimError(404, "User not found"), 404);
    }

    const body = await c.req.json();
    const userName = body.userName;

    // Check uniqueness (allow same user)
    if (userName) {
      const existing = idp.users.findOneBy("email", userName);
      if (existing && existing.id !== id) {
        return scimJson(c, scimError(409, "userName already exists", "uniqueness"), 409);
      }
    }

    const input = scimUserToIdpUserInput(body);
    const updated = idp.users.update(id, {
      email: (input.email as string) ?? user.email,
      name: (input.name as string) ?? user.name,
      given_name: (input.given_name as string) ?? user.given_name,
      family_name: (input.family_name as string) ?? user.family_name,
      picture: (input.picture as string | null) ?? user.picture,
      locale: (input.locale as string) ?? user.locale,
      attributes: (input.attributes as Record<string, unknown>) ?? user.attributes,
    });

    const allGroups = idp.groups.all();
    return scimJson(c, idpUserToScimUser(updated!, baseUrl, allGroups));
  });

  // Patch user
  app.patch("/scim/v2/Users/:id", auth, async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const user = idp.users.get(id);
    if (!user) {
      return scimJson(c, scimError(404, "User not found"), 404);
    }

    const body = await c.req.json();
    const allGroups = idp.groups.all();

    // Convert user to SCIM representation for patching
    const scimUser = idpUserToScimUser(user, baseUrl, allGroups) as unknown as Record<string, unknown>;
    const patched = applyPatchOps(scimUser, body.Operations);

    // Convert back and update
    const input = scimUserToIdpUserInput(patched as any);
    const updated = idp.users.update(id, {
      email: (input.email as string) ?? user.email,
      name: (input.name as string) ?? user.name,
      given_name: (input.given_name as string) ?? user.given_name,
      family_name: (input.family_name as string) ?? user.family_name,
      picture: (input.picture as string | null) ?? user.picture,
      locale: (input.locale as string) ?? user.locale,
      attributes: (input.attributes as Record<string, unknown>) ?? user.attributes,
    });

    return scimJson(c, idpUserToScimUser(updated!, baseUrl, idp.groups.all()));
  });

  // Delete user
  app.delete("/scim/v2/Users/:id", auth, (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const user = idp.users.get(id);
    if (!user) {
      return scimJson(c, scimError(404, "User not found"), 404);
    }
    idp.users.delete(id);
    return c.body(null, 204);
  });

  // ─── Groups ─────────────────────────────────────────────────────

  // List groups
  app.get("/scim/v2/Groups", auth, (c) => {
    const allGroups = idp.groups.all();
    const allUsers = idp.users.all();
    let scimGroups = allGroups.map(g => idpGroupToScimGroup(g, baseUrl, allUsers));

    // Filter
    const filterParam = c.req.query("filter");
    if (filterParam) {
      const matcher = parseFilter(filterParam);
      scimGroups = scimGroups.filter(g => matcher(g as unknown as Record<string, unknown>));
    }

    // Pagination
    const startIndex = Math.max(1, parseInt(c.req.query("startIndex") ?? "1", 10));
    const count = parseInt(c.req.query("count") ?? "100", 10);
    const { page, total } = paginate(scimGroups, startIndex, count);

    return scimJson(c, scimListResponse(page, total, startIndex, page.length));
  });

  // Get group by ID
  app.get("/scim/v2/Groups/:id", auth, (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const group = idp.groups.get(id);
    if (!group) {
      return scimJson(c, scimError(404, "Group not found"), 404);
    }
    const allUsers = idp.users.all();
    return scimJson(c, idpGroupToScimGroup(group, baseUrl, allUsers));
  });

  // Create group
  app.post("/scim/v2/Groups", auth, async (c) => {
    const body = await c.req.json();
    const input = scimGroupToIdpGroupInput(body);
    const newGroup = idp.groups.insert({
      name: (input.name as string) ?? "",
      display_name: (input.display_name as string) ?? "",
    });

    const allUsers = idp.users.all();
    const scimGroup = idpGroupToScimGroup(newGroup, baseUrl, allUsers);
    return scimJson(c, scimGroup, 201, { Location: `${baseUrl}/scim/v2/Groups/${newGroup.id}` });
  });

  // Replace group (PUT)
  app.put("/scim/v2/Groups/:id", auth, async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const group = idp.groups.get(id);
    if (!group) {
      return scimJson(c, scimError(404, "Group not found"), 404);
    }

    const body = await c.req.json();
    const input = scimGroupToIdpGroupInput(body);
    const updated = idp.groups.update(id, {
      display_name: (input.display_name as string) ?? group.display_name,
      name: (input.name as string) ?? group.name,
    });

    // Sync members if provided
    if (body.members) {
      syncGroupMembers(group.name, body.members);
    }

    const allUsers = idp.users.all();
    return scimJson(c, idpGroupToScimGroup(updated!, baseUrl, allUsers));
  });

  // Patch group
  app.patch("/scim/v2/Groups/:id", auth, async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const group = idp.groups.get(id);
    if (!group) {
      return scimJson(c, scimError(404, "Group not found"), 404);
    }

    const body = await c.req.json();
    const operations = body.Operations ?? [];

    for (const op of operations) {
      const opType = (op.op as string).toLowerCase();

      if (opType === "add" && op.path === "members" && Array.isArray(op.value)) {
        // Add members to group
        for (const member of op.value) {
          const userId = parseInt(member.value, 10);
          const user = idp.users.get(userId);
          if (user && !user.groups.includes(group.name)) {
            idp.users.update(userId, {
              groups: [...user.groups, group.name],
            });
          }
        }
      } else if (opType === "remove" && op.path) {
        // Parse remove path: members[value eq "123"]
        const bracketMatch = (op.path as string).match(/^members\[value\s+eq\s+"([^"]+)"\]$/);
        if (bracketMatch) {
          const userId = parseInt(bracketMatch[1], 10);
          const user = idp.users.get(userId);
          if (user) {
            idp.users.update(userId, {
              groups: user.groups.filter(g => g !== group.name),
            });
          }
        }
      } else if (opType === "replace") {
        // Handle replace operations on group attributes
        if (op.path === "displayName") {
          idp.groups.update(id, { display_name: op.value });
        }
      }
    }

    const allUsers = idp.users.all();
    return scimJson(c, idpGroupToScimGroup(group, baseUrl, allUsers));
  });

  // Delete group
  app.delete("/scim/v2/Groups/:id", auth, (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const group = idp.groups.get(id);
    if (!group) {
      return scimJson(c, scimError(404, "Group not found"), 404);
    }

    // Remove group from all users
    const allUsers = idp.users.all();
    for (const user of allUsers) {
      if (user.groups.includes(group.name)) {
        idp.users.update(user.id, {
          groups: user.groups.filter(g => g !== group.name),
        });
      }
    }

    idp.groups.delete(id);
    return c.body(null, 204);
  });

  // ─── Helpers ────────────────────────────────────────────────────

  function syncGroupMembers(groupName: string, members: Array<{ value: string }>) {
    const allUsers = idp.users.all();
    const memberIds = new Set(members.map(m => parseInt(m.value, 10)));

    for (const user of allUsers) {
      const inGroup = user.groups.includes(groupName);
      const shouldBeInGroup = memberIds.has(user.id);

      if (shouldBeInGroup && !inGroup) {
        idp.users.update(user.id, { groups: [...user.groups, groupName] });
      } else if (!shouldBeInGroup && inGroup) {
        idp.users.update(user.id, { groups: user.groups.filter(g => g !== groupName) });
      }
    }
  }
}
