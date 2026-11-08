import { Store, type Collection } from "@emulators/core";
import type {
  StripeCustomer,
  StripeProduct,
  StripePrice,
  StripePaymentIntent,
  StripeCharge,
  StripeCheckoutSession,
  StripeEvent,
  StripeWebhookEndpoint,
  StripeWebhookAttempt,
  StripePaymentMethod,
  StripeSetupIntent,
  StripeInvoice,
  StripeInvoiceItem,
  StripeInvoiceLineItem,
  StripeInvoicePayment,
} from "./entities.js";

export interface StripeStore {
  customers: Collection<StripeCustomer>;
  products: Collection<StripeProduct>;
  prices: Collection<StripePrice>;
  paymentIntents: Collection<StripePaymentIntent>;
  charges: Collection<StripeCharge>;
  checkoutSessions: Collection<StripeCheckoutSession>;
  events: Collection<StripeEvent>;
  webhookEndpoints: Collection<StripeWebhookEndpoint>;
  webhookAttempts: Collection<StripeWebhookAttempt>;
  paymentMethods: Collection<StripePaymentMethod>;
  setupIntents: Collection<StripeSetupIntent>;
  invoices: Collection<StripeInvoice>;
  invoiceItems: Collection<StripeInvoiceItem>;
  invoiceLineItems: Collection<StripeInvoiceLineItem>;
  invoicePayments: Collection<StripeInvoicePayment>;
}

export function getStripeStore(store: Store): StripeStore {
  return {
    customers: store.collection<StripeCustomer>("stripe.customers", ["stripe_id", "email"]),
    products: store.collection<StripeProduct>("stripe.products", ["stripe_id"]),
    prices: store.collection<StripePrice>("stripe.prices", ["stripe_id", "product_id"]),
    paymentIntents: store.collection<StripePaymentIntent>("stripe.payment_intents", ["stripe_id", "customer_id"]),
    charges: store.collection<StripeCharge>("stripe.charges", ["stripe_id", "customer_id", "payment_intent_id"]),
    checkoutSessions: store.collection<StripeCheckoutSession>("stripe.checkout_sessions", ["stripe_id", "customer_id"]),
    events: store.collection<StripeEvent>("stripe.events", ["stripe_id", "type"]),
    webhookEndpoints: store.collection<StripeWebhookEndpoint>("stripe.webhook_endpoints", ["stripe_id", "url"]),
    webhookAttempts: store.collection<StripeWebhookAttempt>("stripe.webhook_attempts", ["event_id"]),
    paymentMethods: store.collection<StripePaymentMethod>("stripe.payment_methods", ["stripe_id", "customer_id"]),
    setupIntents: store.collection<StripeSetupIntent>("stripe.setup_intents", ["stripe_id", "customer_id"]),
    invoices: store.collection<StripeInvoice>("stripe.invoices", ["stripe_id", "customer_id", "subscription_id"]),
    invoiceItems: store.collection<StripeInvoiceItem>("stripe.invoice_items", [
      "stripe_id",
      "customer_id",
      "invoice_id",
    ]),
    invoiceLineItems: store.collection<StripeInvoiceLineItem>("stripe.invoice_line_items", [
      "stripe_id",
      "invoice_id",
      "invoice_item_id",
    ]),
    invoicePayments: store.collection<StripeInvoicePayment>("stripe.invoice_payments", [
      "stripe_id",
      "invoice_id",
      "payment_intent_id",
    ]),
  };
}
