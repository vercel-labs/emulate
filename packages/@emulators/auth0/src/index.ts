import type { Hono } from "hono";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import type { Auth0ApplicationType, Auth0ConnectionStrategy, Auth0TokenEndpointAuthMethod } from "./entities.js";
import {
  createDefaultApplication,
  createDefaultConnection,
  createDefaultUser,
  DEFAULT_AUDIENCE,
  generateAuth0Id,
  setTenant,
  userIdForConnection,
} from "./helpers.js";
import { authorizeRoutes } from "./routes/authorize.js";
import { logoutRoutes } from "./routes/logout.js";
import { managementRoutes } from "./routes/management.js";
import { oidcDiscoveryRoutes } from "./routes/oidc-discovery.js";
import { tokenRoutes } from "./routes/token.js";
import { userinfoRoutes } from "./routes/userinfo.js";
import { getAuth0Store } from "./store.js";

export { getAuth0Store, type Auth0Store } from "./store.js";
export * from "./entities.js";

export interface Auth0SeedConfig {
  tenant?: string;
  users?: Array<{
    user_id?: string;
    email: string;
    name?: string;
    nickname?: string;
    picture?: string;
    password?: string;
    connection?: string;
    email_verified?: boolean;
    blocked?: boolean;
    locale?: string;
  }>;
  roles?: Array<{
    id?: string;
    name: string;
    description?: string;
  }>;
  organizations?: Array<{
    id?: string;
    name: string;
    display_name?: string;
    branding?: Record<string, unknown>;
    members?: string[];
  }>;
  applications?: Array<{
    client_id: string;
    client_secret?: string;
    name?: string;
    app_type?: Auth0ApplicationType;
    callbacks?: string[];
    redirect_uris?: string[];
    allowed_logout_urls?: string[];
    grant_types?: string[];
    token_endpoint_auth_method?: Auth0TokenEndpointAuthMethod;
    organization_usage?: "deny" | "allow" | "require";
  }>;
  connections?: Array<{
    id?: string;
    name: string;
    strategy?: Auth0ConnectionStrategy;
    enabled_clients?: string[];
  }>;
  apis?: Array<{
    audience: string;
    name?: string;
    scopes?: string[];
  }>;
  audiences?: string[];
  role_assignments?: Array<{
    user_id: string;
    role_id: string;
  }>;
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const auth0 = getAuth0Store(store);
  setTenant(store, store.getData<string>("auth0.tenant") ?? "dev-tenant");

  if (auth0.applications.all().length === 0) auth0.applications.insert(createDefaultApplication());
  if (auth0.connections.all().length === 0) auth0.connections.insert(createDefaultConnection());
  if (auth0.users.all().length === 0) auth0.users.insert(createDefaultUser());
  if (auth0.apis.all().length === 0) {
    auth0.apis.insert({
      audience: DEFAULT_AUDIENCE,
      name: "Default API",
      scopes: ["read:current_user", "update:current_user_metadata"],
    });
  }
}

export function seedFromConfig(store: Store, _baseUrl: string, config: Auth0SeedConfig): void {
  const auth0 = getAuth0Store(store);
  if (config.tenant) setTenant(store, config.tenant);

  if (config.applications) {
    for (const app of config.applications) {
      if (auth0.applications.findOneBy("client_id", app.client_id)) continue;
      auth0.applications.insert({
        client_id: app.client_id,
        client_secret: app.client_secret ?? "",
        name: app.name ?? app.client_id,
        app_type: app.app_type ?? "regular_web",
        callbacks: app.callbacks ?? app.redirect_uris ?? ["http://localhost:3000/callback"],
        allowed_logout_urls: app.allowed_logout_urls ?? ["http://localhost:3000/"],
        grant_types: app.grant_types ?? ["authorization_code", "refresh_token", "client_credentials"],
        token_endpoint_auth_method: app.token_endpoint_auth_method ?? "client_secret_post",
        organization_usage: app.organization_usage ?? "allow",
      });
    }
  }

  if (config.connections) {
    for (const connection of config.connections) {
      if (auth0.connections.findOneBy("name", connection.name)) continue;
      auth0.connections.insert({
        connection_id: connection.id ?? generateAuth0Id("con"),
        name: connection.name,
        strategy: connection.strategy ?? "auth0",
        enabled_clients: connection.enabled_clients ?? auth0.applications.all().map((app) => app.client_id),
      });
    }
  }

  if (config.users) {
    for (const user of config.users) {
      if (auth0.users.findOneBy("email", user.email)) continue;
      const connection = user.connection ?? "Username-Password-Authentication";
      const provider = connection === "Username-Password-Authentication" ? "auth0" : connection;
      const name = user.name ?? user.email;
      auth0.users.insert({
        auth0_id: user.user_id ?? userIdForConnection(provider, generateAuth0Id("user")),
        email: user.email,
        email_verified: user.email_verified ?? true,
        name,
        nickname: user.nickname ?? user.email.split("@")[0] ?? name,
        picture: user.picture ?? "https://cdn.auth0.com/avatars/default.png",
        connection,
        password: user.password ?? null,
        blocked: user.blocked ?? false,
        locale: user.locale ?? "en-US",
        last_login: null,
        logins_count: 0,
      });
    }
  }

  if (config.roles) {
    for (const role of config.roles) {
      if (auth0.roles.findOneBy("name", role.name)) continue;
      auth0.roles.insert({
        role_id: role.id ?? generateAuth0Id("rol"),
        name: role.name,
        description: role.description ?? "",
      });
    }
  }

  if (config.organizations) {
    for (const organization of config.organizations) {
      if (auth0.organizations.findOneBy("name", organization.name)) continue;
      const created = auth0.organizations.insert({
        org_id: organization.id ?? generateAuth0Id("org"),
        name: organization.name,
        display_name: organization.display_name ?? organization.name,
        branding: organization.branding ?? {},
      });
      for (const memberRef of organization.members ?? []) {
        const user = auth0.users.findOneBy("auth0_id", memberRef) ?? auth0.users.findOneBy("email", memberRef);
        if (user) auth0.organizationMemberships.insert({ org_id: created.org_id, user_auth0_id: user.auth0_id });
      }
    }
  }

  if (config.apis) {
    for (const api of config.apis) {
      if (auth0.apis.findOneBy("audience", api.audience)) continue;
      auth0.apis.insert({
        audience: api.audience,
        name: api.name ?? api.audience,
        scopes: api.scopes ?? [],
      });
    }
  }

  if (config.audiences) {
    for (const audience of config.audiences) {
      if (auth0.apis.findOneBy("audience", audience)) continue;
      auth0.apis.insert({ audience, name: audience, scopes: [] });
    }
  }

  if (config.role_assignments) {
    for (const assignment of config.role_assignments) {
      const user =
        auth0.users.findOneBy("auth0_id", assignment.user_id) ?? auth0.users.findOneBy("email", assignment.user_id);
      const role =
        auth0.roles.findOneBy("role_id", assignment.role_id) ?? auth0.roles.findOneBy("name", assignment.role_id);
      if (!user || !role) continue;
      const exists = auth0.roleAssignments
        .findBy("user_auth0_id", user.auth0_id)
        .find((entry) => entry.role_id === role.role_id);
      if (!exists) auth0.roleAssignments.insert({ user_auth0_id: user.auth0_id, role_id: role.role_id });
    }
  }
}

export const auth0Plugin: ServicePlugin = {
  name: "auth0",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oidcDiscoveryRoutes(ctx);
    authorizeRoutes(ctx);
    tokenRoutes(ctx);
    userinfoRoutes(ctx);
    logoutRoutes(ctx);
    managementRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default auth0Plugin;
