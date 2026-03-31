import type { Entity } from "@emulators/core";

export interface MicrosoftUser extends Entity {
  /** Object ID (oid) — unique per-tenant user identifier */
  oid: string;
  email: string;
  name: string;
  given_name: string;
  family_name: string;
  email_verified: boolean;
  /** Microsoft tenant ID */
  tenant_id: string;
  /** User principal name (usually email) */
  preferred_username: string;
}

export interface MicrosoftOAuthClient extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
  /** Tenant ID this app is registered in */
  tenant_id: string;
}
