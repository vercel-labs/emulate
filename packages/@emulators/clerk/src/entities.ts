import type { Entity } from "@emulators/core";

export interface ClerkUser extends Entity {
  clerk_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  profile_image_url: string | null;
  external_id: string | null;
  primary_email_address_id: string | null;
  primary_phone_number_id: string | null;
  password_enabled: boolean;
  password_hash: string | null;
  totp_enabled: boolean;
  backup_code_enabled: boolean;
  two_factor_enabled: boolean;
  banned: boolean;
  locked: boolean;
  public_metadata: Record<string, unknown>;
  private_metadata: Record<string, unknown>;
  unsafe_metadata: Record<string, unknown>;
  last_active_at: number | null;
  last_sign_in_at: number | null;
  created_at_unix: number;
  updated_at_unix: number;
}

export interface ClerkEmailAddress extends Entity {
  email_id: string;
  email_address: string;
  user_id: string;
  verification_status: "verified" | "unverified";
  verification_strategy: string;
  is_primary: boolean;
  reserved: boolean;
  created_at_unix: number;
  updated_at_unix: number;
}

export interface ClerkOrganization extends Entity {
  clerk_id: string;
  name: string;
  slug: string;
  image_url: string | null;
  has_logo: boolean;
  members_count: number;
  pending_invitations_count: number;
  public_metadata: Record<string, unknown>;
  private_metadata: Record<string, unknown>;
  max_allowed_memberships: number | null;
  admin_delete_enabled: boolean;
  created_at_unix: number;
  updated_at_unix: number;
}

export interface ClerkOrganizationMembership extends Entity {
  membership_id: string;
  org_id: string;
  user_id: string;
  role: string;
  permissions: string[];
  public_metadata: Record<string, unknown>;
  private_metadata: Record<string, unknown>;
  created_at_unix: number;
  updated_at_unix: number;
}

export interface ClerkOrganizationInvitation extends Entity {
  invitation_id: string;
  email_address: string;
  org_id: string;
  role: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: number;
  created_at_unix: number;
  updated_at_unix: number;
}

export interface ClerkSession extends Entity {
  clerk_id: string;
  user_id: string;
  client_id: string;
  status: "active" | "revoked" | "ended";
  last_active_at: number | null;
  expire_at: number;
  abandon_at: number;
  created_at_unix: number;
  updated_at_unix: number;
}

export interface ClerkOAuthApplication extends Entity {
  app_id: string;
  name: string;
  client_id: string;
  client_secret: string;
  is_public: boolean;
  scopes: string[];
  redirect_uris: string[];
  created_at_unix: number;
  updated_at_unix: number;
}
