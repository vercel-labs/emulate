import { Store, type Collection } from "@emulators/core";
import type { MicrosoftUser, MicrosoftOAuthClient } from "./entities.js";

export interface MicrosoftStore {
  users: Collection<MicrosoftUser>;
  oauthClients: Collection<MicrosoftOAuthClient>;
}

export function getMicrosoftStore(store: Store): MicrosoftStore {
  return {
    users: store.collection<MicrosoftUser>("microsoft.users", ["oid", "email"]),
    oauthClients: store.collection<MicrosoftOAuthClient>("microsoft.oauth_clients", ["client_id"]),
  };
}
