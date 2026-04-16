import { Store, type Collection } from "@emulators/core";
import type {
  StripeCustomer,
  StripeProduct,
  StripePrice,
  StripePaymentIntent,
  StripeCharge,
  StripeCheckoutSession,
} from "./entities.js";

export interface StripeStore {
  customers: Collection<StripeCustomer>;
  products: Collection<StripeProduct>;
  prices: Collection<StripePrice>;
  paymentIntents: Collection<StripePaymentIntent>;
  charges: Collection<StripeCharge>;
  checkoutSessions: Collection<StripeCheckoutSession>;
}

export function getStripeStore(store: Store): StripeStore {
  return {
    customers: store.collection<StripeCustomer>("stripe.customers", ["stripe_id", "email"]),
    products: store.collection<StripeProduct>("stripe.products", ["stripe_id"]),
    prices: store.collection<StripePrice>("stripe.prices", ["stripe_id", "product_id"]),
    paymentIntents: store.collection<StripePaymentIntent>("stripe.payment_intents", ["stripe_id", "customer_id"]),
    charges: store.collection<StripeCharge>("stripe.charges", ["stripe_id", "customer_id", "payment_intent_id"]),
    checkoutSessions: store.collection<StripeCheckoutSession>("stripe.checkout_sessions", ["stripe_id", "customer_id"]),
  };
}
