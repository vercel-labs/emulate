import { Store, type Collection } from "@emulators/core";
import type {
  PolarOrganization,
  PolarProduct,
  PolarPrice,
  PolarCheckout,
  PolarSubscription,
} from "./entities.js";

export interface PolarStore {
  organizations: Collection<PolarOrganization>;
  products: Collection<PolarProduct>;
  prices: Collection<PolarPrice>;
  checkouts: Collection<PolarCheckout>;
  subscriptions: Collection<PolarSubscription>;
}

export function getPolarStore(store: Store): PolarStore {
  return {
    organizations: store.collection<PolarOrganization>("polar.organizations", ["polar_id", "slug"]),
    products: store.collection<PolarProduct>("polar.products", ["polar_id", "organization_id"]),
    prices: store.collection<PolarPrice>("polar.prices", ["polar_id", "product_id"]),
    checkouts: store.collection<PolarCheckout>("polar.checkouts", ["polar_id", "organization_id"]),
    subscriptions: store.collection<PolarSubscription>("polar.subscriptions", ["polar_id", "organization_id", "user_id"]),
  };
}
