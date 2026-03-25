import { Store, type Collection } from "@internal/core";
import type { DescopeUser, DescopeOAuthClient } from "./entities.js";

export interface DescopeStore {
  users: Collection<DescopeUser>;
  oauthClients: Collection<DescopeOAuthClient>;
}

export function getDescopeStore(store: Store): DescopeStore {
  return {
    users: store.collection<DescopeUser>("descope.users", ["uid", "email"]),
    oauthClients: store.collection<DescopeOAuthClient>("descope.oauth_clients", ["client_id"]),
  };
}
