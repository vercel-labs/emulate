import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getLinkedInStore } from "./store.js";
import { generateSub } from "./helpers.js";
import { oauthRoutes } from "./routes/oauth.js";

export { getLinkedInStore, type LinkedInStore } from "./store.js";
export * from "./entities.js";

export interface LinkedInSeedConfig {
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
  const li = getLinkedInStore(store);

  li.users.insert({
    sub: generateSub(),
    email: "testuser@linkedin.com",
    name: "Test User",
    given_name: "Test",
    family_name: "User",
    picture: null,
    email_verified: true,
    locale: "en_US",
  });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: LinkedInSeedConfig): void {
  const li = getLinkedInStore(store);

  if (config.users) {
    for (const u of config.users) {
      const existing = li.users.findOneBy("email", u.email);
      if (existing) continue;

      const nameParts = (u.name ?? "").split(/\s+/).filter(Boolean);
      li.users.insert({
        sub: generateSub(),
        email: u.email,
        name: u.name ?? u.email.split("@")[0],
        given_name: u.given_name ?? nameParts[0] ?? "",
        family_name: u.family_name ?? nameParts.slice(1).join(" "),
        picture: u.picture ?? null,
        email_verified: true,
        locale: u.locale ?? "en_US",
      });
    }
  }

  if (config.oauth_clients) {
    for (const client of config.oauth_clients) {
      const existing = li.oauthClients.findOneBy("client_id", client.client_id);
      if (existing) continue;
      li.oauthClients.insert({
        client_id: client.client_id,
        client_secret: client.client_secret,
        name: client.name,
        redirect_uris: client.redirect_uris,
      });
    }
  }
}

export const linkedinPlugin: ServicePlugin = {
  name: "linkedin",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oauthRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default linkedinPlugin;
