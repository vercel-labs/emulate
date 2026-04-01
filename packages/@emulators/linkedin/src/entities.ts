import type { Entity } from "@emulators/core";

export interface LinkedInUser extends Entity {
  /** Subject identifier (unique user ID) */
  sub: string;
  email: string;
  name: string;
  given_name: string;
  family_name: string;
  picture: string | null;
  locale: string;
  email_verified: boolean;
}

export interface LinkedInOAuthClient extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
}
