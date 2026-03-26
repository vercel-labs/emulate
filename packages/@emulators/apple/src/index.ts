import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getAppleStore } from "./store.js";
import { generateAppleUid, generatePrivateRelayEmail } from "./helpers.js";
import { oauthRoutes } from "./routes/oauth.js";

export { getAppleStore, type AppleStore } from "./store.js";
export * from "./entities.js";

export interface AppleSeedConfig {
  users?: Array<{
    email: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    is_private_email?: boolean;
  }>;
  oauth_clients?: Array<{
    client_id: string;
    team_id: string;
    key_id?: string;
    name: string;
    redirect_uris: string[];
  }>;
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const as = getAppleStore(store);

  as.users.insert({
    uid: generateAppleUid(),
    email: "testuser@icloud.com",
    name: "Test User",
    given_name: "Test",
    family_name: "User",
    email_verified: true,
    is_private_email: false,
    private_relay_email: null,
    real_user_status: 2,
  });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: AppleSeedConfig): void {
  const as = getAppleStore(store);

  if (config.users) {
    for (const u of config.users) {
      const existing = as.users.findOneBy("email", u.email);
      if (existing) continue;

      const nameParts = (u.name ?? "").split(/\s+/);
      const isPrivate = u.is_private_email ?? false;

      as.users.insert({
        uid: generateAppleUid(),
        email: u.email,
        name: u.name ?? u.email.split("@")[0],
        given_name: u.given_name ?? nameParts[0] ?? "",
        family_name: u.family_name ?? nameParts.slice(1).join(" ") ?? "",
        email_verified: true,
        is_private_email: isPrivate,
        private_relay_email: isPrivate ? generatePrivateRelayEmail() : null,
        real_user_status: 2,
      });
    }
  }

  if (config.oauth_clients) {
    for (const client of config.oauth_clients) {
      const existing = as.oauthClients.findOneBy("client_id", client.client_id);
      if (existing) continue;
      as.oauthClients.insert({
        client_id: client.client_id,
        team_id: client.team_id,
        key_id: client.key_id ?? "TESTKEY001",
        name: client.name,
        redirect_uris: client.redirect_uris,
      });
    }
  }
}

export const applePlugin: ServicePlugin = {
  name: "apple",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oauthRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default applePlugin;
