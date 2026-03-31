import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getMicrosoftStore } from "./store.js";
import { generateOid, DEFAULT_TENANT_ID } from "./helpers.js";
import { oauthRoutes } from "./routes/oauth.js";

export { getMicrosoftStore, type MicrosoftStore } from "./store.js";
export * from "./entities.js";


export interface MicrosoftSeedConfig {
  users?: Array<{
    email: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    tenant_id?: string;
  }>;
  oauth_clients?: Array<{
    client_id: string;
    client_secret: string;
    name: string;
    redirect_uris: string[];
    tenant_id?: string;
  }>;
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const ms = getMicrosoftStore(store);

  ms.users.insert({
    oid: generateOid(),
    email: "testuser@outlook.com",
    name: "Test User",
    given_name: "Test",
    family_name: "User",
    email_verified: true,
    tenant_id: DEFAULT_TENANT_ID,
    preferred_username: "testuser@outlook.com",
  });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: MicrosoftSeedConfig): void {
  const ms = getMicrosoftStore(store);

  if (config.users) {
    for (const u of config.users) {
      const existing = ms.users.findOneBy("email", u.email);
      if (existing) continue;

      const nameParts = (u.name ?? "").split(/\s+/);
      ms.users.insert({
        oid: generateOid(),
        email: u.email,
        name: u.name ?? u.email.split("@")[0],
        given_name: u.given_name ?? nameParts[0] ?? "",
        family_name: u.family_name ?? nameParts.slice(1).join(" ") ?? "",
        email_verified: true,
        tenant_id: u.tenant_id ?? DEFAULT_TENANT_ID,
        preferred_username: u.email,
      });
    }
  }

  if (config.oauth_clients) {
    for (const client of config.oauth_clients) {
      const existing = ms.oauthClients.findOneBy("client_id", client.client_id);
      if (existing) continue;
      ms.oauthClients.insert({
        client_id: client.client_id,
        client_secret: client.client_secret,
        name: client.name,
        redirect_uris: client.redirect_uris,
        tenant_id: client.tenant_id ?? DEFAULT_TENANT_ID,
      });
    }
  }
}

export const microsoftPlugin: ServicePlugin = {
  name: "microsoft",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oauthRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default microsoftPlugin;
