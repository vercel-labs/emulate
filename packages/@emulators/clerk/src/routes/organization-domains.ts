import type { RouteContext } from "@emulators/core";
import { generateClerkId, nowUnix } from "../helpers.js";
import {
  clerkError,
  requireSecretKey,
  isAuthResponse,
  deletedResponse,
  parsePagination,
  readJsonBody,
} from "../route-helpers.js";
import { getClerkStore } from "../store.js";
import type { ClerkOrganizationDomain } from "../entities.js";

function domainResponse(domain: ClerkOrganizationDomain): Record<string, unknown> {
  return {
    object: "organization_domain",
    id: domain.domain_id,
    name: domain.name,
    organization_id: domain.org_id,
    enrollment_mode: domain.enrollment_mode,
    verification: {
      status: domain.verification_status,
      strategy: domain.verification_strategy,
      attempts: domain.verification_attempts,
      expires_at: domain.verification_expires_at,
    },
    affiliation_email_address: domain.affiliation_email_address,
    total_pending_invitations: domain.total_pending_invitations,
    total_pending_suggestions: domain.total_pending_suggestions,
    created_at: domain.created_at_unix,
    updated_at: domain.updated_at_unix,
  };
}

export function organizationDomainRoutes({ app, store, tokenMap }: RouteContext): void {
  const cs = getClerkStore(store);

  app.get("/v1/organizations/:orgId/domains", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const { limit, offset } = parsePagination(c);
    const domains = cs.organizationDomains.findBy("org_id", orgId);
    const paged = domains.slice(offset, offset + limit);

    return c.json(paged.map(domainResponse));
  });

  app.post("/v1/organizations/:orgId/domains", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const body = await readJsonBody(c);
    const name = body.name as string;
    if (!name) return clerkError(c, 422, "INVALID_REQUEST_BODY", "name is required");

    const enrollmentMode = (body.enrollment_mode as string) ?? "manual_invitation";
    const verified = body.verified !== false;
    const now = nowUnix();

    const domain = cs.organizationDomains.insert({
      domain_id: generateClerkId("orgdom_"),
      name,
      org_id: orgId,
      enrollment_mode: enrollmentMode as ClerkOrganizationDomain["enrollment_mode"],
      verification_status: verified ? "verified" : "unverified",
      verification_strategy: "email_code",
      verification_attempts: 0,
      verification_expires_at: now + 86400,
      affiliation_email_address: null,
      total_pending_invitations: 0,
      total_pending_suggestions: 0,
      created_at_unix: now,
      updated_at_unix: now,
    });

    return c.json(domainResponse(domain));
  });

  app.patch("/v1/organizations/:orgId/domains/:domainId", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const domainId = c.req.param("domainId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const domain = cs.organizationDomains.findOneBy("domain_id", domainId);
    if (!domain || domain.org_id !== orgId) {
      return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Domain not found");
    }

    const body = await readJsonBody(c);
    const updates: Partial<ClerkOrganizationDomain> = { updated_at_unix: nowUnix() };

    if (body.name !== undefined) updates.name = body.name as string;
    if (body.enrollment_mode !== undefined) {
      updates.enrollment_mode = body.enrollment_mode as ClerkOrganizationDomain["enrollment_mode"];
    }
    if (body.verified !== undefined) {
      updates.verification_status = body.verified ? "verified" : "unverified";
    }

    cs.organizationDomains.update(domain.id, updates);
    const updated = cs.organizationDomains.findOneBy("domain_id", domainId)!;
    return c.json(domainResponse(updated));
  });

  app.delete("/v1/organizations/:orgId/domains/:domainId", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const orgId = c.req.param("orgId");
    const domainId = c.req.param("domainId");
    const org = cs.organizations.findOneBy("clerk_id", orgId);
    if (!org) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Organization not found");

    const domain = cs.organizationDomains.findOneBy("domain_id", domainId);
    if (!domain || domain.org_id !== orgId) {
      return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Domain not found");
    }

    cs.organizationDomains.delete(domain.id);
    return c.json(deletedResponse("organization_domain", domainId));
  });
}
