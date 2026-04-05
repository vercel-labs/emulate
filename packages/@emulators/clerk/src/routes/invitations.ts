import type { RouteContext } from "@emulators/core";
import { generateClerkId, nowUnix } from "../helpers.js";
import {
  clerkError,
  requireSecretKey,
  isAuthResponse,
  paginatedResponse,
  parsePagination,
  invitationResponse,
  readJsonBody,
} from "../route-helpers.js";
import { getClerkStore } from "../store.js";

export function invitationRoutes({ app, store, tokenMap }: RouteContext): void {
  const cs = getClerkStore(store);

  app.get("/v1/organizations/:orgId/invitations", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const { limit, offset } = parsePagination(c);
    const statusFilter = c.req.query("status");

    let invitations = cs.invitations.findBy("org_id", orgId);

    if (statusFilter) {
      invitations = invitations.filter((inv) => inv.status === statusFilter);
    }

    const totalCount = invitations.length;
    const paged = invitations.slice(offset, offset + limit);

    return c.json(paginatedResponse(paged.map(invitationResponse), totalCount, limit, offset));
  });

  app.get("/v1/organizations/:orgId/invitations/:invitationId", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const invitationId = c.req.param("invitationId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const invitation = cs.invitations.findOneBy("invitation_id", invitationId);
    if (!invitation || invitation.org_id !== orgId) {
      return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Invitation not found");
    }

    return c.json(invitationResponse(invitation));
  });

  app.post("/v1/organizations/:orgId/invitations", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const body = await readJsonBody(c);
    const emailAddress = body.email_address as string;
    if (!emailAddress) return clerkError(c, 422, "INVALID_REQUEST_BODY", "email_address is required");

    const role = (body.role as string) ?? "org:member";
    const expiresInDays = (body.expires_in_days as number) ?? 30;
    const now = nowUnix();

    const invitation = cs.invitations.insert({
      invitation_id: generateClerkId("orginv_"),
      email_address: emailAddress,
      org_id: orgId,
      role,
      status: "pending",
      expires_at: now + expiresInDays * 86400,
      created_at_unix: now,
      updated_at_unix: now,
    });

    cs.organizations.update(org.id, {
      pending_invitations_count: org.pending_invitations_count + 1,
      updated_at_unix: now,
    });

    return c.json(invitationResponse(invitation), 200);
  });

  app.post("/v1/organizations/:orgId/invitations/bulk", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const body = await readJsonBody(c);
    const emailAddresses = body.email_addresses as string[];
    if (!emailAddresses || !Array.isArray(emailAddresses)) {
      return clerkError(c, 422, "INVALID_REQUEST_BODY", "email_addresses array is required");
    }

    const role = (body.role as string) ?? "org:member";
    const expiresInDays = (body.expires_in_days as number) ?? 30;
    const now = nowUnix();

    const created = emailAddresses.map((email) =>
      cs.invitations.insert({
        invitation_id: generateClerkId("orginv_"),
        email_address: email,
        org_id: orgId,
        role,
        status: "pending",
        expires_at: now + expiresInDays * 86400,
        created_at_unix: now,
        updated_at_unix: now,
      }),
    );

    cs.organizations.update(org.id, {
      pending_invitations_count: org.pending_invitations_count + created.length,
      updated_at_unix: now,
    });

    return c.json(created.map(invitationResponse));
  });

  app.post("/v1/organizations/:orgId/invitations/:invitationId/revoke", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const invitationId = c.req.param("invitationId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const invitation = cs.invitations.findOneBy("invitation_id", invitationId);
    if (!invitation || invitation.org_id !== orgId) {
      return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Invitation not found");
    }

    if (invitation.status !== "pending") {
      return clerkError(c, 422, "INVALID_REQUEST_BODY", "Only pending invitations can be revoked");
    }

    const now = nowUnix();
    cs.invitations.update(invitation.id, { status: "revoked", updated_at_unix: now });
    cs.organizations.update(org.id, {
      pending_invitations_count: Math.max(0, org.pending_invitations_count - 1),
      updated_at_unix: now,
    });

    const updated = cs.invitations.findOneBy("invitation_id", invitationId)!;
    return c.json(invitationResponse(updated));
  });
}
