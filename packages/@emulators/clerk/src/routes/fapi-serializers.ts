import type { Store } from "@emulators/core";
import { userResponse, resolvePrimaryOrgClaims } from "../route-helpers.js";
import { getClerkStore } from "../store.js";
import { createSessionToken } from "./oauth.js";
import type { ClerkUser, ClerkSession, ClerkOrganizationMembership } from "../entities.js";

// FAPI projection layer: builds the client/session/membership JSON shapes that
// clerk-js consumes. FAPI uses millisecond timestamps and embeds resources
// (vs the Backend API serializers in route-helpers.ts, which use seconds).

// FAPI organization_membership JSON. Shared by the user-resource embed and the
// /v1/me/organization_memberships list.
export function fapiMembershipJson(
  cs: ReturnType<typeof getClerkStore>,
  m: ClerkOrganizationMembership,
): Record<string, unknown> | null {
  const org = cs.organizations.findOneBy("clerk_id", m.org_id);
  if (!org) return null;
  return {
    object: "organization_membership",
    id: m.membership_id,
    role: m.role,
    permissions: m.permissions,
    public_metadata: m.public_metadata,
    organization: {
      object: "organization",
      id: org.clerk_id,
      name: org.name,
      slug: org.slug,
      image_url: org.image_url,
      has_image: org.image_url !== null,
      members_count: org.members_count,
      max_allowed_memberships: org.max_allowed_memberships,
      admin_delete_enabled: org.admin_delete_enabled,
      public_metadata: org.public_metadata,
      created_at: org.created_at_unix * 1000,
      updated_at: org.updated_at_unix * 1000,
    },
    created_at: m.created_at_unix * 1000,
    updated_at: m.updated_at_unix * 1000,
  };
}

export function userOrgMemberships(store: Store, user: ClerkUser): Record<string, unknown>[] {
  const cs = getClerkStore(store);
  return cs.memberships
    .findBy("user_id", user.clerk_id)
    .map((m) => fapiMembershipJson(cs, m))
    .filter((m): m is Record<string, unknown> => m !== null);
}

// Build a FAPI SessionJSON (with embedded user, org memberships, and a live token).
export async function buildSessionJson(store: Store, baseUrl: string, s: ClerkSession): Promise<Record<string, unknown>> {
  const cs = getClerkStore(store);
  const user = cs.users.findOneBy("clerk_id", s.user_id);
  const emails = user ? cs.emailAddresses.findBy("user_id", user.clerk_id) : [];
  const primaryEmail = emails.find((e) => e.is_primary) ?? emails[0];

  // last_active_token is REQUIRED by clerk-js — must be a real token object.
  let lastActiveToken: { object: string; jwt: string } | null = null;
  let lastActiveOrgId: string | null = null;
  let userJson: Record<string, unknown> | null = null;

  if (user) {
    const orgClaims = resolvePrimaryOrgClaims(cs, user);
    lastActiveOrgId = orgClaims.orgId ?? null;
    const jwt = await createSessionToken(store, user, s.clerk_id, baseUrl, orgClaims);
    lastActiveToken = { object: "token", jwt };
    userJson = { ...userResponse(user, emails), organization_memberships: userOrgMemberships(store, user) };
  }

  return {
    object: "session",
    id: s.clerk_id,
    status: s.status,
    factor_verification_age: [0, 0],
    expire_at: s.expire_at * 1000,
    abandon_at: s.abandon_at * 1000,
    last_active_at: (s.last_active_at ?? s.created_at_unix) * 1000,
    last_active_token: lastActiveToken,
    last_active_organization_id: lastActiveOrgId,
    actor: null,
    tasks: [],
    user: userJson,
    public_user_data: user
      ? {
          first_name: user.first_name,
          last_name: user.last_name,
          image_url: user.image_url ?? `https://img.clerk.com/preview?seed=${user.clerk_id}`,
          has_image: user.image_url !== null,
          identifier: primaryEmail?.email_address ?? user.username ?? user.clerk_id,
        }
      : null,
    created_at: s.created_at_unix * 1000,
    updated_at: s.updated_at_unix * 1000,
  };
}

export async function buildClientJson(store: Store, baseUrl: string, activeSessionId?: string | null, now = Date.now()) {
  const cs = getClerkStore(store);
  const sessions = cs.sessions.all().filter((s) => s.status === "active");
  const sessionJsons = await Promise.all(sessions.map((s) => buildSessionJson(store, baseUrl, s)));

  return {
    object: "client",
    id: "client_emulate",
    sessions: sessionJsons,
    sign_up: null,
    sign_in: null,
    last_active_session_id: activeSessionId ?? sessionJsons[0]?.id ?? null,
    last_authentication_strategy: null,
    cookie_expires_at: null,
    created_at: now,
    updated_at: now,
  };
}

// FAPI envelope: { response, client }. The optional embeds let clerk-js's
// useSignIn()/useSignUp() hooks (which proxy client.sign_in / client.sign_up)
// reflect an in-progress attempt.
export async function fapiResponse(
  response: unknown,
  store: Store,
  baseUrl: string,
  activeSessionId?: string | null,
  embedSignIn?: Record<string, unknown> | null,
  embedSignUp?: Record<string, unknown> | null,
) {
  const client = await buildClientJson(store, baseUrl, activeSessionId);
  if (embedSignIn !== undefined) {
    (client as Record<string, unknown>).sign_in = embedSignIn;
  }
  if (embedSignUp !== undefined) {
    (client as Record<string, unknown>).sign_up = embedSignUp;
  }
  return { response, client };
}
