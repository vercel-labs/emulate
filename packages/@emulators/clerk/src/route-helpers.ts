import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AuthUser, TokenMap, AppEnv } from "@emulators/core";
import type {
  ClerkUser,
  ClerkEmailAddress,
  ClerkOrganization,
  ClerkOrganizationMembership,
  ClerkOrganizationInvitation,
  ClerkSession,
} from "./entities.js";
import type { ClerkStore } from "./store.js";

export function clerkError(
  c: Context<AppEnv>,
  status: number,
  code: string,
  message: string,
  longMessage?: string,
  meta?: Record<string, unknown>,
): Response {
  return c.json(
    {
      errors: [
        {
          code,
          message,
          long_message: longMessage ?? message,
          meta: meta ?? {},
        },
      ],
    },
    status as ContentfulStatusCode,
  );
}

export function requireSecretKey(c: Context<AppEnv>, tokenMap?: TokenMap): AuthUser | Response {
  const existing = c.get("authUser");
  if (existing) return existing;

  const authHeader = c.req.header("Authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith("sk_test_") || token.startsWith("sk_live_")) {
      const mapped = tokenMap?.get(token);
      if (mapped) {
        c.set("authUser", mapped);
        c.set("authToken", token);
        c.set("authScopes", mapped.scopes);
        return mapped;
      }
    }
  }

  return clerkError(c, 401, "UNAUTHORIZED", "Authentication failed", "Invalid or missing secret key");
}

export function isAuthResponse(result: AuthUser | Response): result is Response {
  return result instanceof Response;
}

export function deletedResponse(objectType: string, objectId: string): Record<string, unknown> {
  return {
    object: "deleted_object",
    id: objectId,
    slug: null,
    deleted: true,
  };
}

export function paginatedResponse<T>(
  data: T[],
  totalCount: number,
  limit: number,
  offset: number,
): Record<string, unknown> {
  return {
    data,
    total_count: totalCount,
    has_more: offset + limit < totalCount,
  };
}

export function parsePagination(c: Context<AppEnv>): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") ?? "10", 10) || 10, 1), 500);
  const offset = Math.max(Number.parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  return { limit, offset };
}

export function userResponse(user: ClerkUser, emailAddresses: ClerkEmailAddress[]): Record<string, unknown> {
  return {
    id: user.clerk_id,
    object: "user",
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name,
    image_url: user.image_url ?? `https://img.clerk.com/preview?seed=${user.clerk_id}`,
    profile_image_url: user.profile_image_url ?? `https://img.clerk.com/preview?seed=${user.clerk_id}`,
    has_image: user.image_url !== null,
    primary_email_address_id: user.primary_email_address_id,
    primary_phone_number_id: user.primary_phone_number_id,
    primary_web3_wallet_id: null,
    email_addresses: emailAddresses.map(emailAddressResponse),
    phone_numbers: [],
    web3_wallets: [],
    external_accounts: [],
    saml_accounts: [],
    passkeys: [],
    password_enabled: user.password_enabled,
    totp_enabled: user.totp_enabled,
    backup_code_enabled: user.backup_code_enabled,
    two_factor_enabled: user.two_factor_enabled,
    banned: user.banned,
    locked: user.locked,
    external_id: user.external_id,
    public_metadata: user.public_metadata,
    private_metadata: user.private_metadata,
    unsafe_metadata: user.unsafe_metadata,
    last_sign_in_at: user.last_sign_in_at,
    last_active_at: user.last_active_at,
    created_at: user.created_at_unix,
    updated_at: user.updated_at_unix,
  };
}

export function emailAddressResponse(email: ClerkEmailAddress): Record<string, unknown> {
  return {
    id: email.email_id,
    object: "email_address",
    email_address: email.email_address,
    reserved: email.reserved,
    verification: {
      status: email.verification_status,
      strategy: email.verification_strategy,
    },
    linked_to: [],
    created_at: email.created_at_unix,
    updated_at: email.updated_at_unix,
  };
}

export function organizationResponse(org: ClerkOrganization): Record<string, unknown> {
  return {
    id: org.clerk_id,
    object: "organization",
    name: org.name,
    slug: org.slug,
    image_url: org.image_url,
    has_image: org.image_url !== null,
    members_count: org.members_count,
    pending_invitations_count: org.pending_invitations_count,
    max_allowed_memberships: org.max_allowed_memberships,
    admin_delete_enabled: org.admin_delete_enabled,
    public_metadata: org.public_metadata,
    private_metadata: org.private_metadata,
    created_at: org.created_at_unix,
    updated_at: org.updated_at_unix,
  };
}

export function membershipResponse(
  membership: ClerkOrganizationMembership,
  org: ClerkOrganization | undefined,
  user: ClerkUser | undefined,
  emailAddresses: ClerkEmailAddress[],
): Record<string, unknown> {
  return {
    id: membership.membership_id,
    object: "organization_membership",
    role: membership.role,
    permissions: membership.permissions,
    public_metadata: membership.public_metadata,
    private_metadata: membership.private_metadata,
    organization: org ? organizationResponse(org) : null,
    public_user_data: user
      ? {
          user_id: user.clerk_id,
          first_name: user.first_name,
          last_name: user.last_name,
          image_url: user.image_url,
          has_image: user.image_url !== null,
          identifier: emailAddresses.find((e) => e.is_primary)?.email_address ?? user.username ?? user.clerk_id,
        }
      : null,
    created_at: membership.created_at_unix,
    updated_at: membership.updated_at_unix,
  };
}

export function invitationResponse(invitation: ClerkOrganizationInvitation): Record<string, unknown> {
  return {
    id: invitation.invitation_id,
    object: "organization_invitation",
    email_address: invitation.email_address,
    role: invitation.role,
    status: invitation.status,
    organization_id: invitation.org_id,
    created_at: invitation.created_at_unix,
    updated_at: invitation.updated_at_unix,
  };
}

export function sessionResponse(session: ClerkSession): Record<string, unknown> {
  return {
    id: session.clerk_id,
    object: "session",
    user_id: session.user_id,
    client_id: session.client_id,
    status: session.status,
    last_active_at: session.last_active_at,
    expire_at: session.expire_at,
    abandon_at: session.abandon_at,
    created_at: session.created_at_unix,
    updated_at: session.updated_at_unix,
  };
}

export async function readJsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object") return body as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

export function findUserByRef(cs: ClerkStore, ref: string): ClerkUser | undefined {
  return cs.users.findOneBy("clerk_id", ref);
}

export function findOrgByRef(cs: ClerkStore, ref: string): ClerkOrganization | undefined {
  return cs.organizations.findOneBy("clerk_id", ref) ?? cs.organizations.findOneBy("slug", ref);
}
