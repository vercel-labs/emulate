import { Store, type Collection } from "@emulators/core";
import type { LinkedInUser, LinkedInOAuthClient } from "./entities.js";

export interface LinkedInStore {
  users: Collection<LinkedInUser>;
  oauthClients: Collection<LinkedInOAuthClient>;
}

export function getLinkedInStore(store: Store): LinkedInStore {
  return {
    users: store.collection<LinkedInUser>("linkedin.users", ["sub", "email"]),
    oauthClients: store.collection<LinkedInOAuthClient>("linkedin.oauth_clients", ["client_id"]),
  };
}
