import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@internal/core";
import { getDescopeStore } from "./store.js";
import { generateUid } from "./helpers.js";
import { oauthRoutes } from "./routes/oauth.js";
import { descopeApiRoutes } from "./routes/descope-api.js";

export { getDescopeStore, type DescopeStore } from "./store.js";
export * from "./entities.js";

export interface DescopeSeedConfig {
  port?: number;
  users?: Array<{
    email: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    picture?: string;
    locale?: string;
  }>;
  oauth_clients?: Array<{
    client_id: string;
    client_secret: string;
    name: string;
    redirect_uris: string[];
  }>;
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const ds = getDescopeStore(store);

  ds.users.insert({
    uid: generateUid("descope"),
    email: "testuser@example.com",
    name: "Test User",
    given_name: "Test",
    family_name: "User",
    picture: null,
    email_verified: true,
    locale: "en",
  });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: DescopeSeedConfig): void {
  const ds = getDescopeStore(store);

  if (config.users) {
    for (const u of config.users) {
      const existing = ds.users.findOneBy("email", u.email);
      if (existing) continue;

      const nameParts = (u.name ?? "").split(/\s+/);
      ds.users.insert({
        uid: generateUid("descope"),
        email: u.email,
        name: u.name ?? u.email.split("@")[0],
        given_name: u.given_name ?? nameParts[0] ?? "",
        family_name: u.family_name ?? nameParts.slice(1).join(" ") ?? "",
        picture: u.picture ?? null,
        email_verified: true,
        locale: u.locale ?? "en",
      });
    }
  }

  if (config.oauth_clients) {
    for (const client of config.oauth_clients) {
      const existing = ds.oauthClients.findOneBy("client_id", client.client_id);
      if (existing) continue;
      ds.oauthClients.insert({
        client_id: client.client_id,
        client_secret: client.client_secret,
        name: client.name,
        redirect_uris: client.redirect_uris,
      });
    }
  }
}

export const descopePlugin: ServicePlugin = {
  name: "descope",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    // Register Descope proprietary API (for Descope SDK)
    descopeApiRoutes(ctx);
    // Register standard OAuth (for backward compatibility/direct OAuth)
    oauthRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default descopePlugin;
