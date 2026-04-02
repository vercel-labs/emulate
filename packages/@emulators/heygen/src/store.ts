import type { Store, Collection } from "@emulators/core";
import type { HeyGenUser, HeyGenOAuthClient } from "./entities.js";

export interface HeyGenStore {
  users: Collection<HeyGenUser>;
  oauthClients: Collection<HeyGenOAuthClient>;
}

export function getHeyGenStore(store: Store): HeyGenStore {
  return {
    users: store.collection<HeyGenUser>("heygen.users", ["user_id", "email"]),
    oauthClients: store.collection<HeyGenOAuthClient>("heygen.oauth_clients", ["client_id"]),
  };
}
