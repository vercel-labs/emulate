import { derivedInvoicePrefix, toUnixTimestamp, type ExpandResolver } from "./helpers.js";
import { testCardByNumber } from "./test-cards.js";
import type { StripeStore } from "./store.js";
import type {
  StripeBillingDetails,
  StripeCharge,
  StripeCheckoutSession,
  StripeCustomer,
  StripePaymentIntent,
  StripePaymentMethod,
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

/** The Customer object in the key order of the API reference. Balances, tax and discounts are not modelled. */
export function formatCustomer(c: StripeCustomer) {
  return {
    id: c.stripe_id,
    object: "customer" as const,
    address: null,
    balance: 0,
    created: toUnixTimestamp(c.created_at),
    currency: null,
    default_source: null,
    delinquent: c.delinquent ?? false,
    description: c.description,
    email: c.email,
    invoice_prefix: c.invoice_prefix ?? derivedInvoicePrefix(c.stripe_id),
    invoice_settings: {
      custom_fields: null,
      default_payment_method: c.invoice_settings?.default_payment_method ?? null,
      footer: null,
      rendering_options: null,
    },
    livemode: false,
    metadata: c.metadata,
    name: c.name,
    next_invoice_sequence: c.next_invoice_sequence ?? 1,
    phone: null,
    preferred_locales: [] as string[],
    shipping: null,
    tax_exempt: "none" as const,
    test_clock: c.test_clock ?? null,
  };
}

export function formatBillingDetails(details: StripeBillingDetails) {
  const address = details.address ?? {};
  return {
    address: {
      city: address.city ?? null,
      country: address.country ?? null,
      line1: address.line1 ?? null,
      line2: address.line2 ?? null,
      postal_code: address.postal_code ?? null,
      state: address.state ?? null,
    },
    email: details.email ?? null,
    name: details.name ?? null,
    phone: details.phone ?? null,
  };
}

/** The PaymentMethod object for a card, in the key order of the API reference. */
export function formatPaymentMethod(pm: StripePaymentMethod) {
  const testCard = testCardByNumber(pm.card.number);
  const brand = testCard?.brand ?? "unknown";
  return {
    id: pm.stripe_id,
    object: "payment_method" as const,
    allow_redisplay: pm.allow_redisplay,
    billing_details: formatBillingDetails(pm.billing_details),
    card: {
      brand,
      checks: {
        address_line1_check: pm.billing_details.address?.line1 ? "unchecked" : null,
        address_postal_code_check: pm.billing_details.address?.postal_code ? "unchecked" : null,
        cvc_check: pm.card.cvc_check ?? null,
      },
      country: testCard?.country ?? null,
      display_brand: testCard?.display_brand ?? null,
      exp_month: pm.card.exp_month,
      exp_year: pm.card.exp_year,
      fingerprint: testCard?.fingerprint ?? null,
      funding: testCard?.funding ?? "unknown",
      generated_from: null,
      last4: pm.card.number.slice(-4),
      networks: { available: [brand], preferred: null },
      regulated_status: "unregulated" as const,
      three_d_secure_usage: { supported: true },
      wallet: null,
    },
    created: pm.created,
    customer: pm.customer_id ?? null,
    livemode: false,
    metadata: pm.metadata,
    type: pm.type,
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
    payment_method: (id) => {
      const found = ss.paymentMethods.findOneBy("stripe_id", id);
      return found ? formatPaymentMethod(found) : undefined;
    },
  };

  const fieldTypes: Record<string, string> = {
    customer: "customer",
    payment_intent: "payment_intent",
    charge: "charge",
    latest_charge: "charge",
    product: "product",
    price: "price",
    payment_method: "payment_method",
    default_payment_method: "payment_method",
  };

  const prefixTypes: Array<[string, string]> = [
    ["cus_", "customer"],
    ["pi_", "payment_intent"],
    ["ch_", "charge"],
    ["py_", "charge"],
    ["prod_", "product"],
    ["price_", "price"],
    ["cs_", "checkout_session"],
    ["pm_", "payment_method"],
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
