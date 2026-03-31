import { Store, type Collection } from "@emulators/core";
import type { AppleUser, AppleOAuthClient } from "./entities.js";

export interface AppleStore {
  users: Collection<AppleUser>;
  oauthClients: Collection<AppleOAuthClient>;
}

export function getAppleStore(store: Store): AppleStore {
  return {
    users: store.collection<AppleUser>("apple.users", ["uid", "email"]),
    oauthClients: store.collection<AppleOAuthClient>("apple.oauth_clients", ["client_id"]),
  };
}
