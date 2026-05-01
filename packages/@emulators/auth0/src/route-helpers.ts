import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv, AuthUser, TokenMap } from "@emulators/core";
import type { Auth0Application, Auth0Connection, Auth0Organization, Auth0Role, Auth0User } from "./entities.js";
import type { Auth0Store } from "./store.js";
import { userDisplayName } from "./helpers.js";

export function auth0Error(c: Context<AppEnv>, status: number, error: string, message: string): Response {
  return c.json({ statusCode: status, error, message }, status as ContentfulStatusCode);
}

export async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object") return body as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

export function requireManagementAuth(c: Context<AppEnv>, _tokenMap?: TokenMap): AuthUser | Response {
  const existing = c.get("authUser");
  if (existing) return existing;
  return auth0Error(c, 401, "Unauthorized", "Missing or invalid access token.");
}

export function findUserByRef(auth0: Auth0Store, ref: string): Auth0User | undefined {
  const decoded = decodeURIComponent(ref);
  return auth0.users.findOneBy("auth0_id", decoded) ?? auth0.users.findOneBy("email", decoded);
}

export function findRoleByRef(auth0: Auth0Store, ref: string): Auth0Role | undefined {
  const decoded = decodeURIComponent(ref);
  return auth0.roles.findOneBy("role_id", decoded) ?? auth0.roles.findOneBy("name", decoded);
}

export function findApplicationByRef(auth0: Auth0Store, ref: string): Auth0Application | undefined {
  const decoded = decodeURIComponent(ref);
  return auth0.applications.findOneBy("client_id", decoded);
}

export function findConnectionByRef(auth0: Auth0Store, ref: string): Auth0Connection | undefined {
  const decoded = decodeURIComponent(ref);
  return auth0.connections.findOneBy("connection_id", decoded) ?? auth0.connections.findOneBy("name", decoded);
}

export function findOrganizationByRef(auth0: Auth0Store, ref: string): Auth0Organization | undefined {
  const decoded = decodeURIComponent(ref);
  return auth0.organizations.findOneBy("org_id", decoded) ?? auth0.organizations.findOneBy("name", decoded);
}

export function userResponse(user: Auth0User): Record<string, unknown> {
  return {
    user_id: user.auth0_id,
    email: user.email,
    email_verified: user.email_verified,
    name: userDisplayName(user),
    nickname: user.nickname,
    picture: user.picture,
    blocked: user.blocked,
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login: user.last_login,
    logins_count: user.logins_count,
    identities: [
      {
        connection: user.connection,
        provider: user.auth0_id.split("|")[0] ?? "auth0",
        user_id: user.auth0_id.split("|")[1] ?? user.auth0_id,
        isSocial: user.connection !== "Username-Password-Authentication",
      },
    ],
    user_metadata: {
      locale: user.locale,
    },
  };
}

export function roleResponse(role: Auth0Role): Record<string, unknown> {
  return {
    id: role.role_id,
    name: role.name,
    description: role.description,
  };
}

export function applicationResponse(app: Auth0Application): Record<string, unknown> {
  return {
    client_id: app.client_id,
    name: app.name,
    app_type: app.app_type,
    callbacks: app.callbacks,
    allowed_logout_urls: app.allowed_logout_urls,
    grant_types: app.grant_types,
    token_endpoint_auth_method: app.token_endpoint_auth_method,
    organization_usage: app.organization_usage,
  };
}

export function connectionResponse(connection: Auth0Connection): Record<string, unknown> {
  return {
    id: connection.connection_id,
    name: connection.name,
    strategy: connection.strategy,
    enabled_clients: connection.enabled_clients,
  };
}

export function organizationResponse(organization: Auth0Organization): Record<string, unknown> {
  return {
    id: organization.org_id,
    name: organization.name,
    display_name: organization.display_name,
    branding: organization.branding,
  };
}
