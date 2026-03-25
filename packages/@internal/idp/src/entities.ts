import type { Entity } from "@internal/core";

export interface IdpUser extends Entity {
  uid: string;
  email: string;
  email_verified: boolean;
  name: string;
  given_name: string;
  family_name: string;
  picture: string | null;
  locale: string;
  groups: string[];
  roles: string[];
  attributes: Record<string, unknown>;
}

export interface IdpGroup extends Entity {
  name: string;
  display_name: string;
}

export interface IdpClient extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
  post_logout_redirect_uris: string[];
  scopes: string[];
  claim_mappings: Record<string, string>;
  access_token_ttl: number;
  id_token_ttl: number;
  refresh_token_ttl: number;
}

export interface IdpSigningKey extends Entity {
  kid: string;
  alg: string;
  private_key_pem: string;
  public_key_jwk: Record<string, unknown>;
  active: boolean;
}

export interface IdpServiceProvider extends Entity {
  entity_id: string;
  acs_url: string;
  name_id_format: string;
  attribute_mappings: Record<string, string>;
}
