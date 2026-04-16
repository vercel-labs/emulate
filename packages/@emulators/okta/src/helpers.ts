import { randomUUID } from "node:crypto";
import type {
  OktaAuthorizationServer,
  OktaAuthorizationServerStatus,
  OktaApp,
  OktaAppStatus,
  OktaGroup,
  OktaGroupType,
  OktaUser,
  OktaUserStatus,
} from "./entities.js";

export const ORG_AUTH_SERVER_ID = "org";
export const DEFAULT_AUTH_SERVER_ID = "default";
export const DEFAULT_AUDIENCE = "api://default";
export const DEFAULT_EVERYONE_GROUP_NAME = "Everyone";
export const DEFAULT_EVERYONE_GROUP_ID = "00g_everyone";

export function nowIso(): string {
  return new Date().toISOString();
}

export function generateOktaId(prefix: string): string {
  const compact = randomUUID().replace(/-/g, "");
  return `${prefix}${compact.slice(0, 17)}`;
}

export function normalizeStatus(status: string | undefined, fallback: OktaUserStatus): OktaUserStatus {
  if (
    status === "STAGED" ||
    status === "PROVISIONED" ||
    status === "ACTIVE" ||
    status === "SUSPENDED" ||
    status === "DEPROVISIONED"
  ) {
    return status;
  }
  return fallback;
}

export function normalizeAppStatus(status: string | undefined, fallback: OktaAppStatus): OktaAppStatus {
  if (status === "ACTIVE" || status === "INACTIVE") return status;
  return fallback;
}

export function normalizeAuthServerStatus(
  status: string | undefined,
  fallback: OktaAuthorizationServerStatus,
): OktaAuthorizationServerStatus {
  if (status === "ACTIVE" || status === "INACTIVE") return status;
  return fallback;
}

export function normalizeGroupType(type: string | undefined, fallback: OktaGroupType): OktaGroupType {
  if (type === "OKTA_GROUP" || type === "BUILT_IN") return type;
  return fallback;
}

export function boolFromQuery(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const lowered = value.toLowerCase();
  if (lowered === "true" || lowered === "1") return true;
  if (lowered === "false" || lowered === "0") return false;
  return fallback;
}

export function resolveOktaIssuer(baseUrl: string, authServerId: string): string {
  if (authServerId === ORG_AUTH_SERVER_ID) return baseUrl;
  return `${baseUrl}/oauth2/${authServerId}`;
}

export function userDisplayName(user: Pick<OktaUser, "display_name" | "first_name" | "last_name" | "login">): string {
  if (user.display_name) return user.display_name;
  const combined = `${user.first_name} ${user.last_name}`.trim();
  return combined || user.login;
}

export function createDefaultUser(): Omit<OktaUser, "id" | "created_at" | "updated_at"> {
  const now = nowIso();
  return {
    okta_id: generateOktaId("00u"),
    status: "ACTIVE",
    activated_at: now,
    status_changed_at: now,
    last_login_at: null,
    password_changed_at: null,
    transitioning_to_status: null,
    login: "testuser@okta.local",
    email: "testuser@okta.local",
    first_name: "Test",
    last_name: "User",
    display_name: "Test User",
    locale: "en-US",
    time_zone: "UTC",
  };
}

export function createDefaultGroup(): Omit<OktaGroup, "id" | "created_at" | "updated_at"> {
  return {
    okta_id: DEFAULT_EVERYONE_GROUP_ID,
    type: "BUILT_IN",
    name: DEFAULT_EVERYONE_GROUP_NAME,
    description: "All users in the organization",
  };
}

export function createDefaultAuthorizationServer(): Omit<OktaAuthorizationServer, "id" | "created_at" | "updated_at"> {
  return {
    server_id: DEFAULT_AUTH_SERVER_ID,
    name: "default",
    description: "Default custom authorization server",
    audiences: [DEFAULT_AUDIENCE],
    status: "ACTIVE",
  };
}

export function createDefaultApp(): Omit<OktaApp, "id" | "created_at" | "updated_at"> {
  return {
    okta_id: generateOktaId("0oa"),
    name: "oidc_client",
    label: "Sample OIDC App",
    status: "ACTIVE",
    sign_on_mode: "OPENID_CONNECT",
    settings: {
      oauthClient: {
        redirect_uris: ["http://localhost:3000/callback"],
      },
    },
    credentials: {},
  };
}
