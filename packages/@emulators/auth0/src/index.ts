import type { Hono } from "hono";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { DEFAULT_CONNECTION, generateAuth0UserId, hashPassword } from "./helpers.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { oauthRoutes } from "./routes/oauth.js";
import { ticketRoutes } from "./routes/tickets.js";
import { userRoutes } from "./routes/users.js";
import { getAuth0Store } from "./store.js";

export { getAuth0Store, type Auth0Store } from "./store.js";
export * from "./entities.js";

export interface Auth0SeedConfig {
  connections?: Array<{
    name: string;
    strategy?: string;
  }>;
  users?: Array<{
    email: string;
    password?: string;
    connection?: string;
    email_verified?: boolean;
    blocked?: boolean;
    given_name?: string;
    family_name?: string;
    name?: string;
    nickname?: string;
    picture?: string;
    app_metadata?: Record<string, unknown>;
    user_metadata?: Record<string, unknown>;
    user_id?: string;
  }>;
  oauth_clients?: Array<{
    client_id: string;
    client_secret?: string;
    name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    audience?: string;
  }>;
  log_streams?: Array<{
    url: string;
    events?: string[];
    secret?: string;
  }>;
  signing_key?: {
    private_key_pem: string;
    public_key_pem: string;
    kid?: string;
  };
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const auth0 = getAuth0Store(store);

  if (!auth0.connections.findOneBy("name", DEFAULT_CONNECTION)) {
    auth0.connections.insert({
      name: DEFAULT_CONNECTION,
      strategy: "auth0",
    });
  }

  if (auth0.users.all().length === 0) {
    const userId = generateAuth0UserId();
    const nickname = "testuser";
    auth0.users.insert({
      user_id: userId,
      email: "testuser@auth0.local",
      email_verified: true,
      password_hash: hashPassword("Test1234!"),
      connection: DEFAULT_CONNECTION,
      blocked: false,
      app_metadata: {},
      user_metadata: {},
      given_name: "Test",
      family_name: "User",
      name: "Test User",
      nickname,
      picture: `https://s.gravatar.com/avatar/${userId}?s=480&r=pg&d=https%3A%2F%2Fcdn.auth0.com%2Favatars%2Fte.png`,
    });
  }

  if (auth0.oauthClients.all().length === 0) {
    auth0.oauthClients.insert({
      client_id: "auth0-test-client",
      client_secret: "auth0-test-secret",
      name: "Sample Auth0 Client",
      redirect_uris: ["http://localhost:3000/callback"],
      grant_types: ["authorization_code", "refresh_token", "client_credentials"],
      audience: "",
    });
  }
}

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: Auth0SeedConfig,
  webhooks?: WebhookDispatcher,
): void {
  const auth0 = getAuth0Store(store);

  if (config.connections) {
    for (const conn of config.connections) {
      if (auth0.connections.findOneBy("name", conn.name)) continue;
      auth0.connections.insert({
        name: conn.name,
        strategy: conn.strategy ?? "auth0",
      });
    }
  }

  if (config.users) {
    for (const user of config.users) {
      if (auth0.users.findOneBy("email", user.email)) continue;
      const connection = user.connection ?? DEFAULT_CONNECTION;
      const userId = user.user_id ? `auth0|${user.user_id}` : generateAuth0UserId();
      const nickname = user.nickname ?? user.email.split("@")[0] ?? "";
      auth0.users.insert({
        user_id: userId,
        email: user.email,
        email_verified: user.email_verified ?? false,
        password_hash: hashPassword(user.password ?? "Test1234!"),
        connection,
        blocked: user.blocked ?? false,
        app_metadata: user.app_metadata ?? {},
        user_metadata: user.user_metadata ?? {},
        given_name: user.given_name ?? "",
        family_name: user.family_name ?? "",
        name: user.name ?? user.email,
        nickname,
        picture:
          user.picture ??
          `https://s.gravatar.com/avatar/${userId}?s=480&r=pg&d=https%3A%2F%2Fcdn.auth0.com%2Favatars%2F${nickname.slice(0, 2)}.png`,
      });
    }
  }

  if (config.oauth_clients) {
    for (const client of config.oauth_clients) {
      if (auth0.oauthClients.findOneBy("client_id", client.client_id)) continue;
      auth0.oauthClients.insert({
        client_id: client.client_id,
        client_secret: client.client_secret ?? "",
        name: client.name ?? client.client_id,
        redirect_uris: client.redirect_uris ?? ["http://localhost:3000/callback"],
        grant_types: client.grant_types ?? ["authorization_code", "refresh_token", "client_credentials"],
        audience: client.audience ?? "",
      });
    }
  }

  if (config.signing_key) {
    const { private_key_pem, public_key_pem } = config.signing_key;
    if (!private_key_pem || !public_key_pem) {
      throw new Error("signing_key requires both private_key_pem and public_key_pem");
    }
    store.setData("auth0.signing.config", {
      private_key_pem,
      public_key_pem,
      kid: config.signing_key.kid ?? "emulate-auth0-1",
    });
  }

  if (config.log_streams && webhooks) {
    for (const stream of config.log_streams) {
      webhooks.register({
        url: stream.url,
        events: stream.events ?? ["*"],
        active: true,
        secret: stream.secret,
        owner: "auth0",
      });
    }
  }
}

export const auth0Plugin: ServicePlugin = {
  name: "auth0",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    inspectorRoutes(ctx);
    oauthRoutes(ctx);
    userRoutes(ctx);
    ticketRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default auth0Plugin;
