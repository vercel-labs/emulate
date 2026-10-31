import type { Entity } from "@emulators/core";

export type Auth0ConnectionStrategy = "auth0" | "google-oauth2" | "samlp" | "waad" | "github" | string;
export type Auth0ApplicationType = "regular_web" | "spa" | "native" | "non_interactive";
export type Auth0TokenEndpointAuthMethod = "client_secret_post" | "client_secret_basic" | "none";

export interface Auth0User extends Entity {
  auth0_id: string;
  email: string;
  email_verified: boolean;
  name: string;
  nickname: string;
  picture: string;
  connection: string;
  password: string | null;
  blocked: boolean;
  locale: string;
  last_login: string | null;
  logins_count: number;
}

export interface Auth0Role extends Entity {
  role_id: string;
  name: string;
  description: string;
}

export interface Auth0Organization extends Entity {
  org_id: string;
  name: string;
  display_name: string;
  branding: Record<string, unknown>;
}

export interface Auth0Application extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  app_type: Auth0ApplicationType;
  callbacks: string[];
  allowed_logout_urls: string[];
  grant_types: string[];
  token_endpoint_auth_method: Auth0TokenEndpointAuthMethod;
  organization_usage: "deny" | "allow" | "require";
}

export interface Auth0Connection extends Entity {
  connection_id: string;
  name: string;
  strategy: Auth0ConnectionStrategy;
  enabled_clients: string[];
}

export interface Auth0Api extends Entity {
  audience: string;
  name: string;
  scopes: string[];
}

export interface Auth0RoleAssignment extends Entity {
  user_auth0_id: string;
  role_id: string;
}

export interface Auth0OrganizationMembership extends Entity {
  org_id: string;
  user_auth0_id: string;
}
