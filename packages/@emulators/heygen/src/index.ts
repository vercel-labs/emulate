import { randomBytes } from "crypto";
import type {
  AppEnv,
  RouteContext,
  ServicePlugin,
  Store,
  TokenMap,
  WebhookDispatcher,
} from "@emulators/core";
import type { Hono } from "hono";
import { oauthRoutes } from "./routes/oauth.js";
import { getHeyGenStore } from "./store.js";

export { getHeyGenStore, type HeyGenStore } from "./store.js";
export * from "./entities.js";

export interface HeyGenSeedUser {
  email: string;
  name?: string;
  picture?: string;
}

export interface HeyGenSeedConfig {
  port?: number;
  users?: HeyGenSeedUser[];
  oauth_clients?: Array<{
    client_id: string;
    client_secret: string;
    name?: string;
    redirect_uris: string[];
  }>;
}

function generateUserId(): string {
  return "heygen_" + randomBytes(8).toString("hex");
}

function seedDefaults(store: Store): void {
  const hs = getHeyGenStore(store);
  const defaultEmail = "testuser@heygen.com";

  if (!hs.users.findOneBy("email", defaultEmail)) {
    hs.users.insert({
      user_id: generateUserId(),
      email: defaultEmail,
      name: "Test User",
      picture: null,
    });
  }
}

export function seedFromConfig(store: Store, _baseUrl: string, config: HeyGenSeedConfig): void {
  const hs = getHeyGenStore(store);

  if (config.users) {
    for (const user of config.users) {
      const existing = hs.users.findOneBy("email", user.email);
      if (!existing) {
        hs.users.insert({
          user_id: generateUserId(),
          email: user.email,
          name: user.name ?? user.email.split("@")[0],
          picture: user.picture ?? null,
        });
      }
    }
  }

  if (config.oauth_clients) {
    for (const client of config.oauth_clients) {
      const existing = hs.oauthClients.findOneBy("client_id", client.client_id);
      if (existing) continue;
      hs.oauthClients.insert({
        client_id: client.client_id,
        client_secret: client.client_secret,
        name: client.name ?? "App (HeyGen)",
        redirect_uris: client.redirect_uris,
      });
    }
  }

  if (!config.users || config.users.length === 0) {
    seedDefaults(store);
  }
}

export const heygenPlugin: ServicePlugin = {
  name: "heygen",
  register(
    app: Hono<AppEnv>,
    store: Store,
    webhooks: WebhookDispatcher,
    baseUrl: string,
    tokenMap?: TokenMap,
  ): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oauthRoutes(ctx);
  },
  seed(store: Store): void {
    seedDefaults(store);
  },
};

export default heygenPlugin;
