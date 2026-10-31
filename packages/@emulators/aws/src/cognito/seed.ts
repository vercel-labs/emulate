import { randomUUID } from "node:crypto";
import type { Store } from "@emulators/core";
import { DEFAULT_CLIENT, DEFAULT_IDENTITY_POOL, DEFAULT_USER_POOL, findUser, passwordHash } from "./helpers.js";
import { getCognitoStore, type CognitoUser } from "./store.js";

export interface CognitoSeedConfig {
  user_pools?: Array<{
    id: string;
    name?: string;
    confirmation_code?: string;
    clients?: Array<{ client_id: string; client_secret?: string; redirect_uris?: string[]; scopes?: string[] }>;
    users?: Array<{
      username: string;
      password: string;
      attributes?: Record<string, string>;
      status?: CognitoUser["status"];
      enabled?: boolean;
    }>;
  }>;
  identity_pools?: Array<{
    id: string;
    name?: string;
    allow_unauthenticated_identities?: boolean;
    providers?: Array<{ user_pool_id: string; client_id: string }>;
  }>;
}

export function seedCognito(store: Store, config: CognitoSeedConfig) {
  const cs = getCognitoStore(store);
  for (const pool of config.user_pools ?? []) {
    const existing = cs.pools.findOneBy("pool_id", pool.id);
    const data = {
      pool_id: pool.id,
      name: pool.name ?? pool.id,
      confirmation_code: pool.confirmation_code ?? "123456",
    };
    if (existing) cs.pools.update(existing.id, data);
    else cs.pools.insert(data);
    for (const client of pool.clients ?? []) {
      const previous = cs.clients.findOneBy("client_id", client.client_id);
      if (previous && previous.pool_id !== pool.id)
        throw new Error(`Cognito client ${client.client_id} belongs to another user pool.`);
      const clientData = {
        ...client,
        pool_id: pool.id,
        redirect_uris: client.redirect_uris ?? [],
        scopes: client.scopes ?? ["openid", "email", "profile", "aws.cognito.signin.user.admin"],
      };
      if (previous) cs.clients.update(previous.id, clientData);
      else cs.clients.insert(clientData);
    }
    for (const user of pool.users ?? []) {
      if (findUser(store, pool.id, user.username)) continue;
      cs.users.insert({
        pool_id: pool.id,
        username: user.username,
        sub: randomUUID(),
        password_hash: passwordHash(user.password),
        attributes: user.attributes ?? {},
        status: user.status ?? "CONFIRMED",
        enabled: user.enabled ?? true,
      });
    }
  }
  for (const pool of config.identity_pools ?? []) {
    const existing = cs.identityPools.findOneBy("pool_id", pool.id);
    const data = {
      pool_id: pool.id,
      name: pool.name ?? pool.id,
      allow_unauthenticated_identities: pool.allow_unauthenticated_identities ?? false,
      providers: pool.providers ?? [],
    };
    if (existing) cs.identityPools.update(existing.id, data);
    else cs.identityPools.insert(data);
  }
}

export function seedCognitoDefaults(store: Store) {
  seedCognito(store, {
    user_pools: [
      {
        id: DEFAULT_USER_POOL,
        name: "emulate",
        clients: [{ client_id: DEFAULT_CLIENT, redirect_uris: ["http://localhost:3000/callback"] }],
      },
    ],
    identity_pools: [
      {
        id: DEFAULT_IDENTITY_POOL,
        name: "emulate",
        providers: [{ user_pool_id: DEFAULT_USER_POOL, client_id: DEFAULT_CLIENT }],
      },
    ],
  });
}
