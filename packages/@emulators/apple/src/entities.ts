import type { Entity } from "@emulators/core";

export interface AppleUser extends Entity {
  uid: string;
  email: string;
  name: string;
  given_name: string;
  family_name: string;
  email_verified: boolean;
  is_private_email: boolean;
  private_relay_email: string | null;
  real_user_status: number;
}

export interface AppleOAuthClient extends Entity {
  client_id: string;
  team_id: string;
  key_id: string;
  name: string;
  redirect_uris: string[];
}
