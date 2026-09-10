import { Store, type Collection } from "@emulators/core";
import type { CsAlert, CsApiKey, CsCustomer, CsEventLog } from "./entities.js";

export interface CsStore {
  raw: Store;
  apiKeys: Collection<CsApiKey>;
  customers: Collection<CsCustomer>;
  alerts: Collection<CsAlert>;
  events: Collection<CsEventLog>;
}

export function getCsStore(store: Store): CsStore {
  return {
    raw: store,
    apiKeys: store.collection<CsApiKey>("cybersoar.api_keys", ["api_key"]),
    customers: store.collection<CsCustomer>("cybersoar.customers", ["customer_id", "slug", "name"]),
    alerts: store.collection<CsAlert>("cybersoar.alerts", [
      "alert_id",
      "case_id",
      "customer_id",
      "service",
      "status",
      "verdict",
    ]),
    events: store.collection<CsEventLog>("cybersoar.events", ["type"]),
  };
}

export function logEvent(cs: CsStore, type: string, subject: string, detail: Record<string, unknown>): void {
  cs.events.insert({ type, subject, detail });
  const all = cs.events.all();
  if (all.length > 1000) for (const stale of all.slice(0, all.length - 1000)) cs.events.delete(stale.id);
}
