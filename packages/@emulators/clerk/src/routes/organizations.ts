import type { RouteContext } from "@emulators/core";
import { generateClerkId, nowUnix } from "../helpers.js";
import {
  clerkError,
  requireSecretKey,
  isAuthResponse,
  deletedResponse,
  paginatedResponse,
  parsePagination,
  organizationResponse,
  readJsonBody,
} from "../route-helpers.js";
import { getClerkStore } from "../store.js";

export function organizationRoutes({ app, store, tokenMap }: RouteContext): void {
  const cs = getClerkStore(store);

  app.get("/v1/organizations", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const { limit, offset } = parsePagination(c);
    const query = c.req.query("query");

    let orgs = cs.organizations.all();

    if (query) {
      const q = query.toLowerCase();
      orgs = orgs.filter((o) => o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q));
    }

    orgs.sort((a, b) => b.created_at_unix - a.created_at_unix);
    const totalCount = orgs.length;
    const paged = orgs.slice(offset, offset + limit);

    return c.json(paginatedResponse(paged.map(organizationResponse), totalCount, limit, offset));
  });

  app.get("/v1/organizations/:orgId", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const org = cs.organizations.findOneBy("clerk_id", orgId) ?? cs.organizations.findOneBy("slug", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    return c.json(organizationResponse(org));
  });

  app.post("/v1/organizations", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const body = await readJsonBody(c);
    const name = body.name as string;
    if (!name) return clerkError(c, 422, "INVALID_REQUEST_BODY", "name is required");

    const slug =
      (body.slug as string) ??
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const now = nowUnix();

    const org = cs.organizations.insert({
      clerk_id: generateClerkId("org_"),
      name,
      slug,
      image_url: null,
      has_logo: false,
      members_count: 0,
      pending_invitations_count: 0,
      public_metadata: (body.public_metadata as Record<string, unknown>) ?? {},
      private_metadata: (body.private_metadata as Record<string, unknown>) ?? {},
      max_allowed_memberships: (body.max_allowed_memberships as number) ?? null,
      admin_delete_enabled: (body.admin_delete_enabled as boolean) ?? true,
      created_at_unix: now,
      updated_at_unix: now,
    });

    if (body.created_by) {
      const userId = body.created_by as string;
      const user = cs.users.findOneBy("clerk_id", userId);
      if (user) {
        cs.memberships.insert({
          membership_id: generateClerkId("orgmem_"),
          org_id: org.clerk_id,
          user_id: userId,
          role: "org:admin",
          permissions: [
            "org:sys_profile:manage",
            "org:sys_profile:delete",
            "org:sys_memberships:read",
            "org:sys_memberships:manage",
            "org:sys_domains:read",
            "org:sys_domains:manage",
          ],
          public_metadata: {},
          private_metadata: {},
          created_at_unix: now,
          updated_at_unix: now,
        });
        cs.organizations.update(org.id, { members_count: 1 });
      }
    }

    const updated = cs.organizations.findOneBy("clerk_id", org.clerk_id)!;
    return c.json(organizationResponse(updated), 200);
  });

  app.patch("/v1/organizations/:orgId", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const body = await readJsonBody(c);
    const now = nowUnix();
    const patch: Record<string, unknown> = { updated_at_unix: now };

    if (body.name !== undefined) patch.name = body.name;
    if (body.slug !== undefined) patch.slug = body.slug;
    if (body.public_metadata !== undefined) patch.public_metadata = body.public_metadata;
    if (body.private_metadata !== undefined) patch.private_metadata = body.private_metadata;
    if (body.max_allowed_memberships !== undefined) patch.max_allowed_memberships = body.max_allowed_memberships;
    if (body.admin_delete_enabled !== undefined) patch.admin_delete_enabled = body.admin_delete_enabled;

    cs.organizations.update(org.id, patch);
    const updated = cs.organizations.findOneBy("clerk_id", orgId)!;
    return c.json(organizationResponse(updated));
  });

  app.delete("/v1/organizations/:orgId", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    for (const m of cs.memberships.findBy("org_id", orgId)) cs.memberships.delete(m.id);
    for (const inv of cs.invitations.findBy("org_id", orgId)) cs.invitations.delete(inv.id);
    cs.organizations.delete(org.id);

    return c.json(deletedResponse("organization", orgId));
  });

  app.patch("/v1/organizations/:orgId/metadata", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const body = await readJsonBody(c);
    const now = nowUnix();
    const patch: Record<string, unknown> = { updated_at_unix: now };

    if (body.public_metadata !== undefined) {
      patch.public_metadata = { ...org.public_metadata, ...(body.public_metadata as Record<string, unknown>) };
    }
    if (body.private_metadata !== undefined) {
      patch.private_metadata = { ...org.private_metadata, ...(body.private_metadata as Record<string, unknown>) };
    }

    cs.organizations.update(org.id, patch);
    const updated = cs.organizations.findOneBy("clerk_id", orgId)!;
    return c.json(organizationResponse(updated));
  });
}
