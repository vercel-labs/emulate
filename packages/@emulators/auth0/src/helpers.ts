import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { Context } from "hono";
import type { AppEnv, Store } from "@emulators/core";
import type { Auth0Application, Auth0Connection, Auth0User } from "./entities.js";
import type { Auth0Store } from "./store.js";

export const DEFAULT_TENANT = "dev-tenant";
export const DEFAULT_AUDIENCE = "https://api.example.test/";
export const DEFAULT_CONNECTION = "Username-Password-Authentication";
export const AUTH0_KID = "emulate-auth0-1";

const keyPairPromise = generateKeyPair("RS256");

export function nowIso(): string {
  return new Date().toISOString();
}

export function generateAuth0Id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function userIdForConnection(connection: string, id: string): string {
  if (id.includes("|")) return id;
  return `${connection}|${id}`;
}

export function userDisplayName(user: Pick<Auth0User, "name" | "nickname" | "email">): string {
  return user.name || user.nickname || user.email;
}

export function getTenant(store: Store): string {
  return store.getData<string>("auth0.tenant") ?? DEFAULT_TENANT;
}

export function setTenant(store: Store, tenant: string): void {
  store.setData("auth0.tenant", tenant || DEFAULT_TENANT);
}

function withTenantQuery(url: string, tenant: string): string {
  const next = new URL(url);
  next.searchParams.set("tenant", tenant);
  return next.toString();
}

export function tenantFromRequest(c: Context<AppEnv>, fallbackTenant: string): string {
  const queryTenant = c.req.query("tenant");
  if (queryTenant) return queryTenant;

  const host = c.req.header("host") ?? "";
  const first = host.split(".")[0];
  if (host.includes(".auth0.localhost") && first) return first;

  return fallbackTenant;
}

export function tenantBaseUrl(c: Context<AppEnv>, baseUrl: string, configuredTenant: string): string {
  const tenant = tenantFromRequest(c, configuredTenant);
  if (c.req.query("tenant")) return withTenantQuery(baseUrl, tenant);

  const requestUrl = new URL(c.req.url);
  if (requestUrl.hostname.includes(".auth0.localhost")) return requestUrl.origin;

  const configured = new URL(baseUrl);
  if (configured.hostname === "localhost" || configured.hostname === "127.0.0.1") {
    configured.hostname = `${tenant}.auth0.localhost`;
    return configured.origin;
  }
  return configured.origin;
}

export function endpointUrl(c: Context<AppEnv>, baseUrl: string, configuredTenant: string, path: string): string {
  const tenant = tenantFromRequest(c, configuredTenant);
  const base = new URL(baseUrl);
  if (c.req.query("tenant")) {
    base.pathname = path;
    base.searchParams.set("tenant", tenant);
    return base.toString();
  }

  const requestUrl = new URL(c.req.url);
  if (requestUrl.hostname.includes(".auth0.localhost")) {
    requestUrl.pathname = path;
    requestUrl.search = "";
    return requestUrl.toString();
  }

  if (base.hostname === "localhost" || base.hostname === "127.0.0.1") {
    base.hostname = `${tenant}.auth0.localhost`;
  }
  base.pathname = path;
  return base.toString();
}

export async function jwks(): Promise<Record<string, unknown>> {
  const { publicKey } = await keyPairPromise;
  const jwk = await exportJWK(publicKey);
  return { keys: [{ ...jwk, kid: AUTH0_KID, use: "sig", alg: "RS256" }] };
}

export async function signJwt(
  claims: Record<string, unknown>,
  options: { issuer: string; audience: string | string[]; subject?: string; expiresIn?: string },
): Promise<string> {
  const { privateKey } = await keyPairPromise;
  const now = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: AUTH0_KID, typ: "JWT" })
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setIssuedAt(now)
    .setExpirationTime(options.expiresIn ?? "1h");
  if (options.subject) jwt = jwt.setSubject(options.subject);
  return jwt.sign(privateKey);
}

export function parseScope(scope: string): string[] {
  return scope
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function createDefaultUser(): Omit<Auth0User, "id" | "created_at" | "updated_at"> {
  return {
    auth0_id: userIdForConnection("auth0", generateAuth0Id("user")),
    email: "dev@example.com",
    email_verified: true,
    name: "Developer",
    nickname: "developer",
    picture: "https://cdn.auth0.com/avatars/de.png",
    connection: DEFAULT_CONNECTION,
    password: "pass",
    blocked: false,
    locale: "en-US",
    last_login: null,
    logins_count: 0,
  };
}

export function createDefaultApplication(): Omit<Auth0Application, "id" | "created_at" | "updated_at"> {
  return {
    client_id: "auth0-test-client",
    client_secret: "auth0-test-secret",
    name: "Sample Auth0 Application",
    app_type: "regular_web",
    callbacks: ["http://localhost:3000/callback"],
    allowed_logout_urls: ["http://localhost:3000/"],
    grant_types: ["authorization_code", "refresh_token", "client_credentials"],
    token_endpoint_auth_method: "client_secret_post",
    organization_usage: "allow",
  };
}

export function createDefaultConnection(): Omit<Auth0Connection, "id" | "created_at" | "updated_at"> {
  return {
    connection_id: generateAuth0Id("con"),
    name: DEFAULT_CONNECTION,
    strategy: "auth0",
    enabled_clients: ["auth0-test-client"],
  };
}

export function collectUserRoles(auth0: Auth0Store, user: Auth0User): string[] {
  return auth0.roleAssignments
    .findBy("user_auth0_id", user.auth0_id)
    .map((assignment) => auth0.roles.findOneBy("role_id", assignment.role_id)?.name)
    .filter((name): name is string => Boolean(name));
}
