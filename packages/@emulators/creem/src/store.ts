import { Store, type Collection } from "@emulators/core";
import type { CreemCheckout, CreemProduct, CreemSubscription } from "./entities.js";

export interface CreemStore {
  products: Collection<CreemProduct>;
  checkouts: Collection<CreemCheckout>;
  subscriptions: Collection<CreemSubscription>;
}

export function getCreemStore(store: Store): CreemStore {
  return {
    products: store.collection<CreemProduct>("creem.products", ["creem_id"]),
    checkouts: store.collection<CreemCheckout>("creem.checkouts", ["creem_id", "product_id"]),
    subscriptions: store.collection<CreemSubscription>("creem.subscriptions", [
      "creem_id",
      "checkout_id",
      "customer_id",
    ]),
  };
}
