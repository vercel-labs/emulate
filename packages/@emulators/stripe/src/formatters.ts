import { toUnixTimestamp, type ExpandResolver } from "./helpers.js";
import type { StripeStore } from "./store.js";
import type {
  StripeCharge,
  StripeCheckoutSession,
  StripeCustomer,
  StripePaymentIntent,
  StripePrice,
  StripeProduct,
  StripeWebhookEndpoint,
} from "./entities.js";

/** The Webhook Endpoint object. Stripe returns `secret` only in the create response. */
export function formatWebhookEndpoint(ep: StripeWebhookEndpoint, options: { includeSecret?: boolean } = {}) {
  return {
    id: ep.stripe_id,
    object: "webhook_endpoint" as const,
    api_version: ep.api_version ?? null,
    application: null,
    created: ep.created,
    description: ep.description ?? null,
    enabled_events: [...ep.enabled_events],
    livemode: false,
    metadata: ep.metadata,
    ...(options.includeSecret && { secret: ep.secret ?? null }),
    status: ep.status,
    url: ep.url,
  };
}

export function formatCustomer(c: StripeCustomer) {
  return {
    id: c.stripe_id,
    object: "customer" as const,
    email: c.email,
    name: c.name,
    description: c.description,
    metadata: c.metadata,
    created: toUnixTimestamp(c.created_at),
    livemode: false,
  };
}

export function formatPaymentIntent(pi: StripePaymentIntent) {
  return {
    id: pi.stripe_id,
    object: "payment_intent" as const,
    amount: pi.amount,
    currency: pi.currency,
    status: pi.status,
    customer: pi.customer_id,
    description: pi.description,
    payment_method: pi.payment_method,
    metadata: pi.metadata,
    created: toUnixTimestamp(pi.created_at),
    livemode: false,
  };
}

/** The Charge object in the key order of the API reference. Connect, Radar and receipts are not modelled. */
export function formatCharge(ch: StripeCharge) {
  const succeeded = ch.status === "succeeded";
  return {
    id: ch.stripe_id,
    object: "charge" as const,
    amount: ch.amount,
    amount_captured: succeeded ? ch.amount : 0,
    amount_refunded: 0,
    application: null,
    application_fee: null,
    application_fee_amount: null,
    balance_transaction: null,
    billing_details: {
      address: { city: null, country: null, line1: null, line2: null, postal_code: null, state: null },
      email: null,
      name: null,
      phone: null,
    },
    calculated_statement_descriptor: null,
    captured: succeeded,
    created: toUnixTimestamp(ch.created_at),
    currency: ch.currency,
    customer: ch.customer_id,
    description: ch.description,
    disputed: false,
    failure_balance_transaction: null,
    failure_code: ch.failure_code ?? null,
    failure_message: ch.failure_message ?? null,
    fraud_details: {},
    livemode: false,
    metadata: ch.metadata,
    on_behalf_of: null,
    outcome: succeeded
      ? {
          advice_code: null,
          network_advice_code: null,
          network_decline_code: null,
          network_status: "approved_by_network",
          reason: null,
          risk_level: "normal",
          seller_message: "Payment complete.",
          type: "authorized",
        }
      : null,
    paid: succeeded,
    payment_intent: ch.payment_intent_id,
    payment_method: ch.payment_method ?? null,
    payment_method_details: null,
    receipt_email: null,
    receipt_number: null,
    receipt_url: null,
    refunded: false,
    review: null,
    shipping: null,
    source_transfer: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    status: ch.status,
    transfer_data: null,
    transfer_group: null,
  };
}

export function formatProduct(p: StripeProduct) {
  return {
    id: p.stripe_id,
    object: "product" as const,
    name: p.name,
    description: p.description,
    active: p.active,
    metadata: p.metadata,
    created: toUnixTimestamp(p.created_at),
    livemode: false,
  };
}

export function formatPrice(p: StripePrice) {
  return {
    id: p.stripe_id,
    object: "price" as const,
    product: p.product_id,
    currency: p.currency,
    unit_amount: p.unit_amount,
    type: p.type,
    active: p.active,
    metadata: p.metadata,
    created: toUnixTimestamp(p.created_at),
    livemode: false,
  };
}

export function formatCheckoutSession(s: StripeCheckoutSession, baseUrl: string) {
  return {
    id: s.stripe_id,
    object: "checkout.session" as const,
    mode: s.mode,
    status: s.status,
    payment_status: s.payment_status,
    customer: s.customer_id,
    success_url: s.success_url,
    cancel_url: s.cancel_url,
    metadata: s.metadata,
    created: toUnixTimestamp(s.created_at),
    livemode: false,
    url: s.status === "open" ? `${baseUrl}/checkout/${s.stripe_id}` : null,
  };
}

function emptyList(url: string) {
  return { object: "list" as const, data: [], has_more: false, total_count: 0, url };
}

/**
 * One resolver for every expandable reference. A field is resolved by its name first
 * (so seeded ids without a standard prefix still expand) and then by the id's prefix.
 * Includable fields, which are absent unless expanded, are filled in from their parent.
 */
export function stripeExpandResolver(ss: StripeStore, baseUrl: string): ExpandResolver {
  const byType: Record<string, (id: string) => Record<string, unknown> | undefined> = {
    customer: (id) => {
      const found = ss.customers.findOneBy("stripe_id", id);
      return found ? formatCustomer(found) : undefined;
    },
    payment_intent: (id) => {
      const found = ss.paymentIntents.findOneBy("stripe_id", id);
      return found ? formatPaymentIntent(found) : undefined;
    },
    charge: (id) => {
      const found = ss.charges.findOneBy("stripe_id", id);
      return found ? formatCharge(found) : undefined;
    },
    product: (id) => {
      const found = ss.products.findOneBy("stripe_id", id);
      return found ? formatProduct(found) : undefined;
    },
    price: (id) => {
      const found = ss.prices.findOneBy("stripe_id", id);
      return found ? formatPrice(found) : undefined;
    },
    checkout_session: (id) => {
      const found = ss.checkoutSessions.findOneBy("stripe_id", id);
      return found ? formatCheckoutSession(found, baseUrl) : undefined;
    },
  };

  const fieldTypes: Record<string, string> = {
    customer: "customer",
    payment_intent: "payment_intent",
    charge: "charge",
    latest_charge: "charge",
    product: "product",
    price: "price",
  };

  const prefixTypes: Array<[string, string]> = [
    ["cus_", "customer"],
    ["pi_", "payment_intent"],
    ["ch_", "charge"],
    ["py_", "charge"],
    ["prod_", "product"],
    ["price_", "price"],
    ["cs_", "checkout_session"],
  ];

  const includable: Record<string, Record<string, (parent: Record<string, unknown>) => unknown>> = {
    charge: {
      refunds: (parent) => emptyList(`/v1/charges/${String(parent.id)}/refunds`),
    },
  };

  // Field names come from the request, so lookups must not reach Object.prototype.
  const own = <V>(table: Record<string, V>, key: string): V | undefined =>
    Object.hasOwn(table, key) ? table[key] : undefined;

  return (parent, field, value) => {
    if (typeof value === "string") {
      const fieldType = own(fieldTypes, field);
      const byField = fieldType ? byType[fieldType](value) : undefined;
      if (byField) return byField;
      const prefixed = prefixTypes.find(([prefix]) => value.startsWith(prefix));
      return prefixed ? byType[prefixed[1]](value) : undefined;
    }
    if (value === undefined) {
      const fields = own(includable, String(parent.object));
      const include = fields ? own(fields, field) : undefined;
      return include ? include(parent) : undefined;
    }
    return undefined;
  };
}
