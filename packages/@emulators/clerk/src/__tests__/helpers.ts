import type { AddressInfo } from "node:net";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  serve,
} from "@emulators/core";
import type { AppEnv, TokenMap } from "@emulators/core";
import type { Server } from "node:http";
import { clerkPlugin, getClerkStore, seedFromConfig } from "../index.js";

export const clerkTestSecretKey = "sk_test_emulate";

export interface ClerkTestEmulator {
  url: string;
  store: Store;
  tokenMap: TokenMap;
  close: () => Promise<void>;
}

export async function startClerkTestEmulator(
  customize?: (opts: { store: Store; tokenMap: TokenMap }) => void | Promise<void>,
): Promise<ClerkTestEmulator> {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set(clerkTestSecretKey, { login: "admin", id: 1, scopes: [] });

  const app = new Hono<AppEnv>();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", (authMiddleware as (tokens: TokenMap) => ReturnType<typeof authMiddleware>)(tokenMap));

  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  clerkPlugin.register(app as any, store, webhooks, url, tokenMap);
  clerkPlugin.seed?.(store, url);

  seedFromConfig(store, url, {
    users: [
      { email_addresses: ["alice@example.com"], first_name: "Alice", last_name: "Smith", password: "alice123" },
      { email_addresses: ["bob@example.com"], first_name: "Bob", last_name: "Jones" },
    ],
    organizations: [
      {
        name: "Acme Corp",
        slug: "acme",
        members: [
          { email: "alice@example.com", role: "admin" },
          { email: "bob@example.com", role: "member" },
        ],
      },
    ],
  });

  await customize?.({ store, tokenMap });

  return {
    url,
    store,
    tokenMap,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
