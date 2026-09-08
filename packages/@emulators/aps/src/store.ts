import { Store, type Collection } from "@emulators/core";
import type { ApsClient, ApsUser } from "./entities.js";

export interface ApsStore {
  clients: Collection<ApsClient>;
  users: Collection<ApsUser>;
}

export function getApsStore(store: Store): ApsStore {
  return {
    clients: store.collection<ApsClient>("aps.clients", ["client_id"]),
    users: store.collection<ApsUser>("aps.users", ["user_id", "email"]),
  };
}
