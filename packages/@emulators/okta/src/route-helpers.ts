import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AuthUser, TokenMap, AppEnv } from "@emulators/core";
import type {
  OktaApp,
  OktaAuthorizationServer,
  OktaGroup,
  OktaUser,
} from "./entities.js";
import type { OktaStore } from "./store.js";
import { resolveOktaIssuer, userDisplayName } from "./helpers.js";

type OktaErrorCause = { errorSummary: string };

function createErrorBody(
  status: number,
  errorCode: string,
  errorSummary: string,
  errorCauses: OktaErrorCause[] = [],
): Record<string, unknown> {
  return {
    errorCode,
    errorSummary,
    errorLink: errorCode,
    errorId: `${errorCode}-${Date.now()}`,
    errorCauses,
    status,
  };
}

export function oktaError(
  c: Context<AppEnv>,
  status: number,
  errorCode: string,
  errorSummary: string,
  errorCauses: OktaErrorCause[] = [],
): Response {
  const body = createErrorBody(status, errorCode, errorSummary, errorCauses);
  return c.json(body, status as ContentfulStatusCode);
}

export async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object") {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function requireManagementAuth(c: Context<AppEnv>, tokenMap?: TokenMap): AuthUser | Response {
  const existing = c.get("authUser");
  if (existing) return existing;

  const authHeader = c.req.header("Authorization") ?? "";
  if (authHeader.toLowerCase().startsWith("ssws ")) {
    const token = authHeader.slice(5).trim();
    const mapped = tokenMap?.get(token);
    if (mapped) {
      c.set("authUser", mapped);
      c.set("authToken", token);
      c.set("authScopes", mapped.scopes);
      return mapped;
    }
  }

  return oktaError(c, 401, "E0000004", "Authentication failed");
}

export function findUserByRef(os: OktaStore, userRef: string): OktaUser | undefined {
  const decoded = decodeURIComponent(userRef);
  return (
    os.users.findOneBy("okta_id", decoded) ??
    os.users.findOneBy("login", decoded) ??
    os.users.findOneBy("email", decoded)
  );
}

export function findGroupByRef(os: OktaStore, groupRef: string): OktaGroup | undefined {
  const decoded = decodeURIComponent(groupRef);
  return os.groups.findOneBy("okta_id", decoded);
}

export function findAppByRef(os: OktaStore, appRef: string): OktaApp | undefined {
  const decoded = decodeURIComponent(appRef);
  return os.apps.findOneBy("okta_id", decoded);
}

export function findAuthorizationServerByRef(
  os: OktaStore,
  serverRef: string,
): OktaAuthorizationServer | undefined {
  const decoded = decodeURIComponent(serverRef);
  return os.authorizationServers.findOneBy("server_id", decoded);
}

export function userResponse(baseUrl: string, user: OktaUser): Record<string, unknown> {
  return {
    id: user.okta_id,
    status: user.status,
    created: user.created_at,
    activated: user.activated_at,
    statusChanged: user.status_changed_at,
    lastLogin: user.last_login_at,
    lastUpdated: user.updated_at,
    passwordChanged: user.password_changed_at,
    profile: {
      login: user.login,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      displayName: userDisplayName(user),
      locale: user.locale,
      timeZone: user.time_zone,
    },
    _links: {
      self: {
        href: `${baseUrl}/api/v1/users/${encodeURIComponent(user.okta_id)}`,
      },
    },
  };
}

export function groupResponse(baseUrl: string, group: OktaGroup): Record<string, unknown> {
  return {
    id: group.okta_id,
    created: group.created_at,
    lastUpdated: group.updated_at,
    lastMembershipUpdated: group.updated_at,
    objectClass: ["okta:user_group"],
    type: group.type,
    profile: {
      name: group.name,
      description: group.description,
    },
    _links: {
      self: {
        href: `${baseUrl}/api/v1/groups/${encodeURIComponent(group.okta_id)}`,
      },
    },
  };
}

export function appResponse(baseUrl: string, app: OktaApp): Record<string, unknown> {
  return {
    id: app.okta_id,
    name: app.name,
    label: app.label,
    status: app.status,
    created: app.created_at,
    lastUpdated: app.updated_at,
    signOnMode: app.sign_on_mode,
    credentials: app.credentials,
    settings: app.settings,
    _links: {
      self: {
        href: `${baseUrl}/api/v1/apps/${encodeURIComponent(app.okta_id)}`,
      },
    },
  };
}

export function authorizationServerResponse(
  baseUrl: string,
  server: OktaAuthorizationServer,
): Record<string, unknown> {
  return {
    id: server.server_id,
    name: server.name,
    description: server.description,
    audiences: server.audiences,
    issuer: resolveOktaIssuer(baseUrl, server.server_id),
    status: server.status,
    created: server.created_at,
    lastUpdated: server.updated_at,
    _links: {
      self: {
        href: `${baseUrl}/api/v1/authorizationServers/${encodeURIComponent(server.server_id)}`,
      },
    },
  };
}
