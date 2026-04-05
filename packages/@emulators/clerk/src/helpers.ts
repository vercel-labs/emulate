import { randomUUID } from "node:crypto";
import type { ClerkUser, ClerkEmailAddress, ClerkOrganization } from "./entities.js";

export function generateClerkId(prefix: string): string {
  const compact = randomUUID().replace(/-/g, "");
  return `${prefix}${compact.slice(0, 24)}`;
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

export function createDefaultUser(): Omit<ClerkUser, "id" | "created_at" | "updated_at"> {
  const now = nowUnix();
  return {
    clerk_id: generateClerkId("user_"),
    username: null,
    first_name: "Test",
    last_name: "User",
    image_url: null,
    profile_image_url: null,
    external_id: null,
    primary_email_address_id: null,
    primary_phone_number_id: null,
    password_enabled: true,
    password_hash: "test_password",
    totp_enabled: false,
    backup_code_enabled: false,
    two_factor_enabled: false,
    banned: false,
    locked: false,
    public_metadata: {},
    private_metadata: {},
    unsafe_metadata: {},
    last_active_at: null,
    last_sign_in_at: null,
    created_at_unix: now,
    updated_at_unix: now,
  };
}

export function createDefaultEmailAddress(
  userId: string,
  email: string,
  primary: boolean,
): Omit<ClerkEmailAddress, "id" | "created_at" | "updated_at"> {
  const now = nowUnix();
  return {
    email_id: generateClerkId("idn_"),
    email_address: email,
    user_id: userId,
    verification_status: "verified",
    verification_strategy: "email_code",
    is_primary: primary,
    reserved: false,
    created_at_unix: now,
    updated_at_unix: now,
  };
}

export function createDefaultOrganization(): Omit<ClerkOrganization, "id" | "created_at" | "updated_at"> {
  const now = nowUnix();
  return {
    clerk_id: generateClerkId("org_"),
    name: "My Company",
    slug: "my-company",
    image_url: null,
    has_logo: false,
    members_count: 0,
    pending_invitations_count: 0,
    public_metadata: {},
    private_metadata: {},
    max_allowed_memberships: null,
    admin_delete_enabled: true,
    created_at_unix: now,
    updated_at_unix: now,
  };
}

export function userDisplayName(user: Pick<ClerkUser, "first_name" | "last_name" | "username">): string {
  const combined = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return combined || user.username || "User";
}
