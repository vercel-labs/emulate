import type { Hono } from "hono";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import type { OktaAuthorizationServerStatus, OktaGroupType, OktaUserStatus } from "./entities.js";
import {
  createDefaultApp,
  createDefaultAuthorizationServer,
  createDefaultGroup,
  createDefaultUser,
  DEFAULT_AUTH_SERVER_ID,
  DEFAULT_EVERYONE_GROUP_ID,
  generateOktaId,
  normalizeAppStatus,
  normalizeAuthServerStatus,
  normalizeGroupType,
  normalizeStatus,
} from "./helpers.js";
import { appRoutes } from "./routes/apps.js";
import { authorizationServerRoutes } from "./routes/auth-servers.js";
import { groupRoutes } from "./routes/groups.js";
import { oauthRoutes } from "./routes/oauth.js";
import { userRoutes } from "./routes/users.js";
import { getOktaStore } from "./store.js";

export { getOktaStore, type OktaStore } from "./store.js";
export * from "./entities.js";

export interface OktaSeedConfig {
  users?: Array<{
    okta_id?: string;
    status?: OktaUserStatus;
    login: string;
    email?: string;
    first_name?: string;
    last_name?: string;
    display_name?: string;
    locale?: string;
    time_zone?: string;
  }>;
  groups?: Array<{
    okta_id?: string;
    type?: OktaGroupType;
    name: string;
    description?: string;
  }>;
  apps?: Array<{
    okta_id?: string;
    name: string;
    label?: string;
    status?: "ACTIVE" | "INACTIVE";
    sign_on_mode?: string;
    settings?: Record<string, unknown>;
    credentials?: Record<string, unknown>;
  }>;
  oauth_clients?: Array<{
    client_id: string;
    client_secret?: string;
    name: string;
    redirect_uris: string[];
    response_types?: string[];
    grant_types?: string[];
    token_endpoint_auth_method?: "client_secret_post" | "client_secret_basic" | "none";
    auth_server_id?: string;
  }>;
  authorization_servers?: Array<{
    id: string;
    name: string;
    description?: string;
    audiences?: string[];
    status?: OktaAuthorizationServerStatus;
  }>;
  group_memberships?: Array<{
    group_okta_id: string;
    user_okta_id: string;
  }>;
  app_assignments?: Array<{
    app_okta_id: string;
    user_okta_id: string;
  }>;
}

function ensureMembership(store: ReturnType<typeof getOktaStore>, groupOktaId: string, userOktaId: string): void {
  const existing = store.groupMemberships
    .findBy("group_okta_id", groupOktaId)
    .find((entry) => entry.user_okta_id === userOktaId);
  if (!existing) {
    store.groupMemberships.insert({
      group_okta_id: groupOktaId,
      user_okta_id: userOktaId,
    });
  }
}

function ensureAppAssignment(store: ReturnType<typeof getOktaStore>, appOktaId: string, userOktaId: string): void {
  const existing = store.appAssignments
    .findBy("app_okta_id", appOktaId)
    .find((entry) => entry.user_okta_id === userOktaId);
  if (!existing) {
    store.appAssignments.insert({
      app_okta_id: appOktaId,
      user_okta_id: userOktaId,
    });
  }
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const okta = getOktaStore(store);

  const defaultServer = okta.authorizationServers.findOneBy("server_id", DEFAULT_AUTH_SERVER_ID);
  if (!defaultServer) {
    okta.authorizationServers.insert(createDefaultAuthorizationServer());
  }

  let everyone = okta.groups.findOneBy("okta_id", DEFAULT_EVERYONE_GROUP_ID);
  if (!everyone) {
    everyone = okta.groups.insert(createDefaultGroup());
  }

  let user = okta.users.findOneBy("login", "testuser@okta.local");
  if (!user) {
    user = okta.users.insert(createDefaultUser());
  }

  if (!okta.oauthClients.findOneBy("client_id", "okta-test-client")) {
    okta.oauthClients.insert({
      client_id: "okta-test-client",
      client_secret: "okta-test-secret",
      name: "Sample OIDC Client",
      redirect_uris: ["http://localhost:3000/callback"],
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token", "client_credentials"],
      token_endpoint_auth_method: "client_secret_post",
      auth_server_id: DEFAULT_AUTH_SERVER_ID,
    });
  }

  if (!okta.oauthClients.findOneBy("client_id", "okta-test-app")) {
    okta.oauthClients.insert({
      client_id: "okta-test-app",
      client_secret: "",
      name: "Sample Public PKCE Client",
      redirect_uris: ["http://localhost:3000/official-sdk/callback", "http://localhost:3000/official-sdk"],
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      auth_server_id: DEFAULT_AUTH_SERVER_ID,
    });
  }

  if (okta.apps.all().length === 0) {
    okta.apps.insert(createDefaultApp());
  }

  ensureMembership(okta, everyone.okta_id, user.okta_id);
}

export function seedFromConfig(store: Store, _baseUrl: string, config: OktaSeedConfig): void {
  const okta = getOktaStore(store);

  if (config.authorization_servers) {
    for (const server of config.authorization_servers) {
      const existing = okta.authorizationServers.findOneBy("server_id", server.id);
      if (existing) continue;
      okta.authorizationServers.insert({
        server_id: server.id,
        name: server.name,
        description: server.description ?? "",
        audiences: server.audiences ?? ["api://default"],
        status: normalizeAuthServerStatus(server.status, "ACTIVE"),
      });
    }
  }

  if (config.users) {
    for (const user of config.users) {
      const byLogin = okta.users.findOneBy("login", user.login);
      if (byLogin) continue;
      const resolvedStatus = normalizeStatus(user.status, "ACTIVE");
      okta.users.insert({
        okta_id: user.okta_id ?? generateOktaId("00u"),
        status: resolvedStatus,
        activated_at: resolvedStatus === "ACTIVE" ? new Date().toISOString() : null,
        status_changed_at: new Date().toISOString(),
        last_login_at: null,
        password_changed_at: null,
        transitioning_to_status: null,
        login: user.login,
        email: user.email ?? user.login,
        first_name: user.first_name ?? "Test",
        last_name: user.last_name ?? "User",
        display_name: user.display_name ?? `${user.first_name ?? "Test"} ${user.last_name ?? "User"}`.trim(),
        locale: user.locale ?? "en-US",
        time_zone: user.time_zone ?? "UTC",
      });
    }
  }

  if (config.groups) {
    for (const group of config.groups) {
      const byName = okta.groups.findOneBy("name", group.name);
      if (byName) continue;
      okta.groups.insert({
        okta_id: group.okta_id ?? generateOktaId("00g"),
        type: normalizeGroupType(group.type, "OKTA_GROUP"),
        name: group.name,
        description: group.description ?? null,
      });
    }
  }

  if (config.apps) {
    for (const app of config.apps) {
      const byName = okta.apps.findOneBy("name", app.name);
      if (byName) continue;
      okta.apps.insert({
        okta_id: app.okta_id ?? generateOktaId("0oa"),
        name: app.name,
        label: app.label ?? app.name,
        status: normalizeAppStatus(app.status, "ACTIVE"),
        sign_on_mode: app.sign_on_mode ?? "OPENID_CONNECT",
        settings: app.settings ?? {},
        credentials: app.credentials ?? {},
      });
    }
  }

  if (config.oauth_clients) {
    for (const client of config.oauth_clients) {
      const existing = okta.oauthClients.findOneBy("client_id", client.client_id);
      if (existing) continue;
      const tokenEndpointAuthMethod = client.token_endpoint_auth_method ?? "client_secret_post";
      okta.oauthClients.insert({
        client_id: client.client_id,
        client_secret: client.client_secret ?? "",
        name: client.name,
        redirect_uris: client.redirect_uris,
        response_types: client.response_types ?? ["code"],
        grant_types: client.grant_types ?? ["authorization_code", "refresh_token", "client_credentials"],
        token_endpoint_auth_method: tokenEndpointAuthMethod,
        auth_server_id: client.auth_server_id ?? DEFAULT_AUTH_SERVER_ID,
      });
    }
  }

  if (config.group_memberships) {
    for (const membership of config.group_memberships) {
      const group = okta.groups.findOneBy("okta_id", membership.group_okta_id);
      const user = okta.users.findOneBy("okta_id", membership.user_okta_id);
      if (!group || !user) continue;
      ensureMembership(okta, group.okta_id, user.okta_id);
    }
  }

  if (config.app_assignments) {
    for (const assignment of config.app_assignments) {
      const app = okta.apps.findOneBy("okta_id", assignment.app_okta_id);
      const user = okta.users.findOneBy("okta_id", assignment.user_okta_id);
      if (!app || !user) continue;
      ensureAppAssignment(okta, app.okta_id, user.okta_id);
    }
  }
}

export const oktaPlugin: ServicePlugin = {
  name: "okta",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oauthRoutes(ctx);
    userRoutes(ctx);
    groupRoutes(ctx);
    appRoutes(ctx);
    authorizationServerRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default oktaPlugin;
