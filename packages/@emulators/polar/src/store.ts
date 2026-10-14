import { Store, type Collection } from "@emulators/core";
import type { PolarOrganization, PolarProduct, PolarCheckout, PolarSubscription } from "./entities.js";

export interface PolarStore {
  organizations: Collection<PolarOrganization>;
  products: Collection<PolarProduct>;
  checkouts: Collection<PolarCheckout>;
  subscriptions: Collection<PolarSubscription>;
}

export function getPolarStore(store: Store): PolarStore {
  return {
    organizations: store.collection<PolarOrganization>("polar.organizations", ["polar_id", "slug"]),
    products: store.collection<PolarProduct>("polar.products", ["polar_id", "organization_id"]),
    checkouts: store.collection<PolarCheckout>("polar.checkouts", ["polar_id", "product_id"]),
    subscriptions: store.collection<PolarSubscription>("polar.subscriptions", ["polar_id", "user_id"]),
  };
}
