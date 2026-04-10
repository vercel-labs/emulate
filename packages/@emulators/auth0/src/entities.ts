import type { Entity } from "@emulators/core";

export interface Auth0User extends Entity {
  user_id: string;
  email: string;
  email_verified: boolean;
  password_hash: string;
  connection: string;
  blocked: boolean;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
  given_name: string;
  family_name: string;
  name: string;
  nickname: string;
  picture: string;
}

export interface Auth0Connection extends Entity {
  name: string;
  strategy: string;
}

export interface Auth0OAuthClient extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
  grant_types: string[];
  audience: string;
}

export interface Auth0EmailVerificationTicket extends Entity {
  user_id: string;
  ticket_id: string;
  result_url: string;
  ttl_seconds: number;
}
