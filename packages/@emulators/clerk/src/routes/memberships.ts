import type { RouteContext } from "@emulators/core";
import { generateClerkId, nowUnix } from "../helpers.js";
import {
  clerkError,
  requireSecretKey,
  isAuthResponse,
  deletedResponse,
  paginatedResponse,
  parsePagination,
  membershipResponse,
  readJsonBody,
} from "../route-helpers.js";
import { getClerkStore } from "../store.js";

function defaultPermissions(role: string): string[] {
  if (role === "org:admin") {
    return [
      "org:sys_profile:manage",
      "org:sys_profile:delete",
      "org:sys_memberships:read",
      "org:sys_memberships:manage",
      "org:sys_domains:read",
      "org:sys_domains:manage",
    ];
  }
  return ["org:sys_memberships:read"];
}

export function membershipRoutes({ app, store, tokenMap }: RouteContext): void {
  const cs = getClerkStore(store);

  app.get("/v1/organizations/:orgId/memberships", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const { limit, offset } = parsePagination(c);
    const roleFilter = c.req.query("role");

    let memberships = cs.memberships.findBy("org_id", orgId);

    if (roleFilter) {
      memberships = memberships.filter((m) => m.role === roleFilter);
    }

    const totalCount = memberships.length;
    const paged = memberships.slice(offset, offset + limit);

    const data = paged.map((m) => {
      const user = cs.users.findOneBy("clerk_id", m.user_id);
      const emails = user ? cs.emailAddresses.findBy("user_id", user.clerk_id) : [];
      return membershipResponse(m, org, user, emails);
    });

    return c.json(paginatedResponse(data, totalCount, limit, offset));
  });

  app.post("/v1/organizations/:orgId/memberships", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const body = await readJsonBody(c);
    const userId = body.user_id as string;
    const role = (body.role as string) ?? "org:member";

    if (!userId) return clerkError(c, 422, "INVALID_REQUEST_BODY", "user_id is required");

    const user = cs.users.findOneBy("clerk_id", userId);
    if (!user) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "User not found");

    const existing = cs.memberships.findBy("org_id", orgId).find((m) => m.user_id === userId);
    if (existing) return clerkError(c, 422, "DUPLICATE_RECORD", "User is already a member of this organization");

    const now = nowUnix();
    const membership = cs.memberships.insert({
      membership_id: generateClerkId("orgmem_"),
      org_id: orgId,
      user_id: userId,
      role,
      permissions: defaultPermissions(role),
      public_metadata: {},
      private_metadata: {},
      created_at_unix: now,
      updated_at_unix: now,
    });

    cs.organizations.update(org.id, { members_count: org.members_count + 1, updated_at_unix: now });

    const emails = cs.emailAddresses.findBy("user_id", userId);
    const updatedOrg = cs.organizations.findOneBy("clerk_id", orgId)!;
    return c.json(membershipResponse(membership, updatedOrg, user, emails), 200);
  });

  app.patch("/v1/organizations/:orgId/memberships/:userId", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const userId = c.req.param("userId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const membership = cs.memberships.findBy("org_id", orgId).find((m) => m.user_id === userId);
    if (!membership) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Membership not found");

    const body = await readJsonBody(c);
    const now = nowUnix();
    const patch: Record<string, unknown> = { updated_at_unix: now };

    if (body.role !== undefined) {
      patch.role = body.role;
      patch.permissions = defaultPermissions(body.role as string);
    }

    cs.memberships.update(membership.id, patch);
    const updated = cs.memberships.findBy("org_id", orgId).find((m) => m.user_id === userId)!;
    const user = cs.users.findOneBy("clerk_id", userId);
    const emails = user ? cs.emailAddresses.findBy("user_id", userId) : [];
    return c.json(membershipResponse(updated, org, user, emails));
  });

  app.delete("/v1/organizations/:orgId/memberships/:userId", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const userId = c.req.param("userId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const membership = cs.memberships.findBy("org_id", orgId).find((m) => m.user_id === userId);
    if (!membership) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Membership not found");

    cs.memberships.delete(membership.id);
    cs.organizations.update(org.id, { members_count: Math.max(0, org.members_count - 1), updated_at_unix: nowUnix() });

    return c.json(deletedResponse("organization_membership", membership.membership_id));
  });

  app.patch("/v1/organizations/:orgId/memberships/:userId/metadata", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const userId = c.req.param("userId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const membership = cs.memberships.findBy("org_id", orgId).find((m) => m.user_id === userId);
    if (!membership) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Membership not found");

    const body = await readJsonBody(c);
    const now = nowUnix();
    const patch: Record<string, unknown> = { updated_at_unix: now };

    if (body.public_metadata !== undefined) {
      patch.public_metadata = { ...membership.public_metadata, ...(body.public_metadata as Record<string, unknown>) };
    }
    if (body.private_metadata !== undefined) {
      patch.private_metadata = {
        ...membership.private_metadata,
        ...(body.private_metadata as Record<string, unknown>),
      };
    }

    cs.memberships.update(membership.id, patch);
    const updated = cs.memberships.findBy("org_id", orgId).find((m) => m.user_id === userId)!;
    const user = cs.users.findOneBy("clerk_id", userId);
    const emails = user ? cs.emailAddresses.findBy("user_id", userId) : [];
    return c.json(membershipResponse(updated, org, user, emails));
  });
}
