import type { Hono } from "@emulators/core";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import type { ApsClientType } from "./entities.js";
import {
  createDefaultConfidentialClient,
  createDefaultPublicClient,
  createDefaultUser,
  DEFAULT_CONFIDENTIAL_CLIENT_ID,
  DEFAULT_PUBLIC_CLIENT_ID,
  DEFAULT_USER_EMAIL,
  generateUserId,
  normalizeClientType,
  splitName,
} from "./helpers.js";
import { oauthRoutes } from "./routes/oauth.js";
import { getApsStore } from "./store.js";

export { getApsStore, type ApsStore } from "./store.js";
export * from "./entities.js";

export interface ApsSeedConfig {
  clients?: Array<{
    client_id: string;
    client_secret?: string;
    name?: string;
    type?: ApsClientType;
    redirect_uris: string[];
  }>;
  users?: Array<{
    user_id?: string;
    email: string;
    name?: string;
    picture?: string;
  }>;
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const aps = getApsStore(store);

  if (!aps.clients.findOneBy("client_id", DEFAULT_CONFIDENTIAL_CLIENT_ID)) {
    aps.clients.insert(createDefaultConfidentialClient());
  }
  if (!aps.clients.findOneBy("client_id", DEFAULT_PUBLIC_CLIENT_ID)) {
    aps.clients.insert(createDefaultPublicClient());
  }
  if (!aps.users.findOneBy("email", DEFAULT_USER_EMAIL)) {
    aps.users.insert(createDefaultUser());
  }
}

export function seedFromConfig(store: Store, _baseUrl: string, config: ApsSeedConfig): void {
  const aps = getApsStore(store);

  if (config.clients) {
    for (const client of config.clients) {
      const existing = aps.clients.findOneBy("client_id", client.client_id);
      if (existing) continue;
      const type = normalizeClientType(client.type, client.client_secret ? "confidential" : "public");
      aps.clients.insert({
        client_id: client.client_id,
        client_secret: client.client_secret ?? "",
        name: client.name ?? client.client_id,
        type,
        redirect_uris: client.redirect_uris,
      });
    }
  }

  if (config.users) {
    for (const user of config.users) {
      const byEmail = aps.users.findOneBy("email", user.email);
      if (byEmail) continue;
      const name = user.name ?? "Test User";
      const { first_name, last_name } = splitName(name, user.email);
      aps.users.insert({
        user_id: user.user_id ?? generateUserId(),
        email: user.email,
        name,
        first_name,
        last_name,
        picture: user.picture ?? null,
      });
    }
  }
}

export const apsPlugin: ServicePlugin = {
  name: "aps",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oauthRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default apsPlugin;
