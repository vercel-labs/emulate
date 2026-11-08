import { derivedInvoicePrefix, toUnixTimestamp, type ExpandResolver } from "./helpers.js";
import { testCardByNumber } from "./test-cards.js";
import { unitAmountDecimal, wholeAmount } from "./pricing.js";
import type { StripeStore } from "./store.js";
import type {
  StripeBillingDetails,
  StripeCharge,
  StripeCheckoutSession,
  StripeCustomer,
  StripeInvoice,
  StripeInvoiceItem,
  StripeInvoiceLineItem,
  StripeInvoicePayment,
  StripePaymentError,
  StripePaymentIntent,
  StripePaymentMethod,
  StripePrice,
  StripeProduct,
  StripeSetupIntent,
  StripeSubscription,
  StripeSubscriptionItem,
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

/** `last_payment_error` as Stripe renders it: only the fields that apply, in reference order. */
function formatPaymentError(error: StripePaymentError | undefined) {
  if (!error) return null;
  return {
    ...(error.charge && { charge: error.charge }),
    code: error.code,
    ...(error.decline_code && { decline_code: error.decline_code }),
    doc_url: error.doc_url,
    message: error.message,
    ...(error.param && { param: error.param }),
    ...(error.payment_method && { payment_method: structuredClone(error.payment_method) }),
    type: error.type,
  };
}

/** The PaymentIntent object in the key order of the API reference. Connect, shipping and receipts are not modelled. */
export function formatPaymentIntent(pi: StripePaymentIntent) {
  return {
    id: pi.stripe_id,
    object: "payment_intent" as const,
    amount: pi.amount,
    amount_capturable: 0,
    amount_details: { tip: {} },
    amount_received: pi.amount_received ?? 0,
    application: null,
    application_fee_amount: null,
    automatic_payment_methods: { enabled: true },
    canceled_at: pi.canceled_at ?? null,
    cancellation_reason: pi.cancellation_reason ?? null,
    capture_method: pi.capture_method ?? "automatic_async",
    client_secret: pi.client_secret ?? null,
    confirmation_method: pi.confirmation_method ?? "automatic",
    created: pi.created ?? toUnixTimestamp(pi.created_at),
    currency: pi.currency,
    customer: pi.customer_id,
    description: pi.description,
    excluded_payment_method_types: null,
    last_payment_error: formatPaymentError(pi.last_payment_error),
    latest_charge: pi.latest_charge ?? null,
    livemode: false,
    metadata: pi.metadata,
    next_action: pi.next_action ? structuredClone(pi.next_action) : null,
    on_behalf_of: null,
    payment_method: pi.payment_method,
    payment_method_configuration_details: null,
    payment_method_options: {
      card: { installments: null, mandate_options: null, network: null, request_three_d_secure: "automatic" as const },
    },
    payment_method_types: ["card"],
    processing: null,
    receipt_email: null,
    review: null,
    setup_future_usage: pi.setup_future_usage ?? null,
    shipping: null,
    source: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    status: pi.status,
    transfer_data: null,
    transfer_group: null,
  };
}

/**
 * The SetupIntent object in the key order of the API reference. SetupAttempts and mandates
 * are not modelled, so `latest_attempt`, `mandate` and `single_use_mandate` stay null.
 */
export function formatSetupIntent(si: StripeSetupIntent) {
  return {
    id: si.stripe_id,
    object: "setup_intent" as const,
    application: null,
    automatic_payment_methods: null,
    cancellation_reason: si.cancellation_reason ?? null,
    client_secret: si.client_secret,
    created: si.created,
    customer: si.customer_id ?? null,
    description: si.description ?? null,
    excluded_payment_method_types: null,
    flow_directions: null,
    last_setup_error: formatPaymentError(si.last_setup_error),
    latest_attempt: null,
    livemode: false,
    mandate: null,
    metadata: si.metadata,
    next_action: si.next_action ? structuredClone(si.next_action) : null,
    on_behalf_of: null,
    payment_method: si.payment_method ?? null,
    payment_method_configuration_details: null,
    payment_method_options: {
      card: { mandate_options: null, network: null, request_three_d_secure: "automatic" as const },
    },
    payment_method_types: ["card"],
    single_use_mandate: null,
    status: si.status,
    usage: si.usage,
  };
}

function chargeOutcome(ch: StripeCharge) {
  if (ch.status === "succeeded") {
    return {
      advice_code: null,
      network_advice_code: null,
      network_decline_code: null,
      network_status: "approved_by_network",
      reason: null,
      risk_level: "normal",
      seller_message: "Payment complete.",
      type: "authorized",
    };
  }
  if (ch.status !== "failed") return null;
  const reason = ch.decline_code ?? ch.failure_code ?? null;
  return {
    advice_code: null,
    network_advice_code: null,
    network_decline_code: null,
    network_status: "declined_by_network",
    reason,
    risk_level: "normal",
    seller_message:
      reason && reason !== "generic_decline"
        ? `The bank returned the decline code \`${reason}\`.`
        : "The bank did not return any further details with this decline.",
    type: "issuer_declined",
  };
}

/** `payment_method_details` of a card charge, from the card as it was when charged. */
function chargePaymentMethodDetails(ch: StripeCharge) {
  if (!ch.card) return null;
  const testCard = testCardByNumber(ch.card.number);
  const succeeded = ch.status === "succeeded";
  const address = ch.billing_details?.address;
  return {
    card: {
      amount_authorized: succeeded ? ch.amount : null,
      authorization_code: ch.authorization_code ?? null,
      brand: testCard?.brand ?? "unknown",
      checks: {
        address_line1_check: address?.line1 ? "unchecked" : null,
        address_postal_code_check: address?.postal_code ? "unchecked" : null,
        cvc_check: ch.card.cvc_check ?? null,
      },
      country: testCard?.country ?? null,
      exp_month: ch.card.exp_month,
      exp_year: ch.card.exp_year,
      extended_authorization: { status: "disabled" },
      fingerprint: testCard?.fingerprint ?? null,
      funding: testCard?.funding ?? "unknown",
      incremental_authorization: { status: "unavailable" },
      installments: null,
      last4: ch.card.number.slice(-4),
      mandate: null,
      multicapture: { status: "unavailable" },
      network: testCard?.brand ?? null,
      network_token: { used: false },
      network_transaction_id: ch.network_transaction_id ?? null,
      overcapture: { maximum_amount_capturable: ch.amount, status: "unavailable" },
      regulated_status: "unregulated",
      three_d_secure: ch.three_d_secure
        ? {
            authentication_flow: "challenge",
            electronic_commerce_indicator: "05",
            exemption_indicator: null,
            result: "authenticated",
            result_reason: null,
            version: "2.2.0",
          }
        : null,
      wallet: null,
    },
    type: "card" as const,
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
    billing_details: formatBillingDetails(ch.billing_details ?? {}),
    calculated_statement_descriptor: null,
    captured: succeeded,
    created: ch.created ?? toUnixTimestamp(ch.created_at),
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
    outcome: chargeOutcome(ch),
    paid: succeeded,
    payment_intent: ch.payment_intent_id,
    payment_method: ch.payment_method ?? null,
    payment_method_details: chargePaymentMethodDetails(ch),
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

/**
 * The Product object in the key order of the API reference, shared by the products API and
 * every `expand[]=product`. Default prices, marketing features, package dimensions and tax
 * codes are not modelled.
 */
export function formatProduct(p: StripeProduct) {
  return {
    id: p.stripe_id,
    object: "product" as const,
    active: p.active,
    created: toUnixTimestamp(p.created_at),
    default_price: null,
    description: p.description,
    images: [...(p.images ?? [])],
    marketing_features: [] as unknown[],
    livemode: false,
    metadata: p.metadata,
    name: p.name,
    package_dimensions: null,
    shippable: p.shippable ?? null,
    statement_descriptor: p.statement_descriptor ?? null,
    tax_code: null,
    unit_label: p.unit_label ?? null,
    updated: toUnixTimestamp(p.updated_at),
    url: p.url ?? null,
  };
}

/**
 * The Price object in the key order of the API reference. `tiers` and `currency_options` are
 * includable and added by the expand resolver. `recurring.trial_period_days` is legacy and
 * always null.
 */
export function formatPrice(p: StripePrice) {
  const tiered = p.billing_scheme === "tiered";
  return {
    id: p.stripe_id,
    object: "price" as const,
    active: p.active,
    billing_scheme: p.billing_scheme ?? "per_unit",
    created: toUnixTimestamp(p.created_at),
    currency: p.currency,
    custom_unit_amount: null,
    livemode: false,
    lookup_key: p.lookup_key ?? null,
    metadata: p.metadata,
    nickname: p.nickname ?? null,
    product: p.product_id,
    recurring: p.recurring
      ? {
          interval: p.recurring.interval,
          interval_count: p.recurring.interval_count,
          meter: p.recurring.meter ?? null,
          trial_period_days: null,
          usage_type: p.recurring.usage_type,
        }
      : null,
    tax_behavior: p.tax_behavior ?? "unspecified",
    tiers_mode: tiered ? (p.tiers_mode ?? null) : null,
    transform_quantity: p.transform_quantity ? { ...p.transform_quantity } : null,
    type: p.type,
    unit_amount: tiered ? null : p.unit_amount,
    unit_amount_decimal: unitAmountDecimal(p) ?? null,
  };
}

/** The `tiers` of a tiered price, with the final `inf` tier rendered as `up_to: null`. */
export function formatPriceTiers(p: StripePrice) {
  if (p.billing_scheme !== "tiered") return null;
  return (p.tiers ?? []).map((tier) => ({
    flat_amount: wholeAmount(tier.flat_amount_decimal),
    flat_amount_decimal: tier.flat_amount_decimal ?? null,
    unit_amount: wholeAmount(tier.unit_amount_decimal),
    unit_amount_decimal: tier.unit_amount_decimal ?? null,
    up_to: tier.up_to ?? null,
  }));
}

/**
 * `currency_options` of a price. Extra currencies are not modelled, so the map holds only the
 * price's own currency.
 */
export function formatPriceCurrencyOptions(p: StripePrice) {
  const formatted = formatPrice(p);
  return {
    [p.currency]: {
      custom_unit_amount: null,
      tax_behavior: formatted.tax_behavior,
      unit_amount: formatted.unit_amount,
      unit_amount_decimal: formatted.unit_amount_decimal,
    },
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

/** How many entries an embedded list shows before `has_more`, as on Stripe. */
const EMBEDDED_LIST_LIMIT = 10;

function embeddedList<T>(items: T[], url: string, format: (item: T) => Record<string, unknown>) {
  return {
    object: "list" as const,
    data: items.slice(0, EMBEDDED_LIST_LIMIT).map(format),
    has_more: items.length > EMBEDDED_LIST_LIMIT,
    total_count: items.length,
    url,
  };
}

/** `pricing` of an invoice item or line. Items created from a bare amount have no price. */
function formatPricing(priceId: string | undefined, productId: string | undefined, unitAmountDecimal?: string) {
  if (!priceId) return null;
  return {
    price_details: { price: priceId, product: productId ?? null },
    type: "price_details" as const,
    unit_amount_decimal: unitAmountDecimal ?? null,
  };
}

/** The Invoice Item object in the key order of the API reference. Discounts and tax rates are not modelled. */
export function formatInvoiceItem(ii: StripeInvoiceItem) {
  return {
    id: ii.stripe_id,
    object: "invoiceitem" as const,
    amount: ii.amount,
    currency: ii.currency,
    customer: ii.customer_id,
    date: ii.date,
    description: ii.description ?? null,
    discountable: ii.discountable,
    discounts: [] as string[],
    invoice: ii.invoice_id ?? null,
    livemode: false,
    metadata: ii.metadata,
    parent: ii.subscription_id
      ? {
          subscription_details: { subscription: ii.subscription_id, subscription_item: null },
          type: "subscription_details" as const,
        }
      : null,
    period: { ...ii.period },
    pricing: formatPricing(ii.price_id, ii.product_id, ii.unit_amount_decimal),
    proration: ii.proration,
    quantity: ii.quantity,
    quantity_decimal: String(ii.quantity),
    tax_rates: [] as unknown[],
    test_clock: ii.test_clock ?? null,
  };
}

/** The Invoice Line Item object. A line comes from an invoice item or from a subscription item. */
export function formatInvoiceLineItem(line: StripeInvoiceLineItem) {
  const parent = line.subscription_item_id
    ? {
        subscription_item_details: {
          invoice_item: line.invoice_item_id ?? null,
          proration: line.proration,
          proration_details: { credited_items: null },
          subscription: line.subscription_id ?? null,
          subscription_item: line.subscription_item_id,
        },
        type: "subscription_item_details" as const,
      }
    : {
        invoice_item_details: {
          invoice_item: line.invoice_item_id ?? null,
          proration: line.proration,
          proration_details: { credited_items: null },
          subscription: line.subscription_id ?? null,
        },
        type: "invoice_item_details" as const,
      };
  return {
    id: line.stripe_id,
    object: "line_item" as const,
    amount: line.amount,
    currency: line.currency,
    description: line.description ?? null,
    discount_amounts: [] as unknown[],
    discountable: line.discountable,
    discounts: [] as string[],
    invoice: line.invoice_id,
    livemode: false,
    metadata: line.metadata,
    parent,
    period: { ...line.period },
    pretax_credit_amounts: [] as unknown[],
    pricing: formatPricing(line.price_id, line.product_id, line.unit_amount_decimal),
    quantity: line.quantity,
    quantity_decimal: String(line.quantity),
    subtotal: line.amount,
    taxes: [] as unknown[],
  };
}

/** The Invoice Payment object. Only PaymentIntent payments are modelled. */
export function formatInvoicePayment(p: StripeInvoicePayment) {
  return {
    id: p.stripe_id,
    object: "invoice_payment" as const,
    amount_paid: p.amount_paid ?? null,
    amount_requested: p.amount_requested,
    created: p.created,
    currency: p.currency,
    invoice: p.invoice_id,
    is_default: p.is_default,
    livemode: false,
    payment: { type: "payment_intent" as const, payment_intent: p.payment_intent_id },
    status: p.status,
    status_transitions: { canceled_at: p.canceled_at ?? null, paid_at: p.paid_at ?? null },
  };
}

/** The lines of an invoice in the order they were added. */
export function invoiceLines(ss: StripeStore, invoiceId: string): StripeInvoiceLineItem[] {
  return ss.invoiceLineItems.findBy("invoice_id", invoiceId).sort((a, b) => a.id - b.id);
}

export function invoicePayments(ss: StripeStore, invoiceId: string): StripeInvoicePayment[] {
  return ss.invoicePayments.findBy("invoice_id", invoiceId).sort((a, b) => a.id - b.id);
}

/** The default InvoicePayment Stripe creates at finalization, which carries the invoice's PaymentIntent. */
export function defaultInvoicePayment(ss: StripeStore, invoiceId: string): StripeInvoicePayment | undefined {
  return invoicePayments(ss, invoiceId).find((p) => p.is_default);
}

/**
 * The money fields of an invoice. Taxes, discounts, credit notes and customer balances are not
 * modelled, so the total is the sum of the lines and a negative total owes nothing.
 */
export function invoiceAmounts(ss: StripeStore, inv: StripeInvoice) {
  const subtotal = invoiceLines(ss, inv.stripe_id).reduce((sum, line) => sum + line.amount, 0);
  const amountDue = inv.status === "void" ? 0 : Math.max(0, subtotal);
  return {
    subtotal,
    total: subtotal,
    amount_due: amountDue,
    amount_paid: inv.amount_paid,
    amount_remaining: Math.max(0, amountDue - inv.amount_paid),
  };
}

/** How long Stripe waits after invoice.created before it finalizes an auto-advancing draft. */
export const DRAFT_FINALIZE_DELAY = 3600;

/** The hosted invoice page. Until it exists the URL answers 404. */
export function hostedInvoiceUrl(baseUrl: string, invoiceId: string): string {
  return `${baseUrl}/invoice/${invoiceId}`;
}

/**
 * The Invoice object in the key order of the API reference, for API versions from basil on:
 * no top-level `subscription`, `payment_intent`, `charge` or `paid`. `payments`,
 * `confirmation_secret` and `amount_paid_off_stripe` are includable and added by the expand
 * resolver. `status_details` appears only while the invoice is uncollectible.
 */
export function formatInvoice(ss: StripeStore, inv: StripeInvoice, baseUrl: string) {
  const amounts = invoiceAmounts(ss, inv);
  const customer = ss.customers.findOneBy("stripe_id", inv.customer_id);
  const snapshot = inv.customer_snapshot ?? { email: customer?.email ?? null, name: customer?.name ?? null };
  const finalized = inv.status !== "draft";
  const hosted = finalized ? hostedInvoiceUrl(baseUrl, inv.stripe_id) : null;
  return {
    id: inv.stripe_id,
    object: "invoice" as const,
    account_country: null,
    account_name: null,
    account_tax_ids: null,
    amount_due: amounts.amount_due,
    amount_paid: amounts.amount_paid,
    amount_overpaid: 0,
    amount_remaining: amounts.amount_remaining,
    amount_shipping: 0,
    application: null,
    attempt_count: inv.attempt_count,
    attempted: inv.attempted,
    auto_advance: inv.auto_advance,
    automatic_tax: { enabled: false, liability: null, status: null },
    automatically_finalizes_at: !finalized && inv.auto_advance ? inv.created + DRAFT_FINALIZE_DELAY : null,
    billing_reason: inv.billing_reason,
    collection_method: inv.collection_method,
    created: inv.created,
    currency: inv.currency,
    custom_fields: null,
    customer: inv.customer_id,
    customer_account: null,
    customer_address: null,
    customer_email: snapshot.email,
    customer_name: snapshot.name,
    customer_phone: null,
    customer_shipping: null,
    customer_tax_exempt: "none" as const,
    customer_tax_ids: [] as unknown[],
    default_payment_method: inv.default_payment_method ?? null,
    default_source: null,
    default_tax_rates: [] as unknown[],
    description: inv.description ?? null,
    discounts: [] as string[],
    due_date: inv.due_date ?? null,
    effective_at: inv.finalized_at ?? null,
    ending_balance: finalized ? 0 : null,
    footer: inv.footer ?? null,
    from_invoice: null,
    hosted_invoice_url: hosted,
    invoice_pdf: hosted,
    issuer: { type: "self" as const },
    last_finalization_error: null,
    latest_revision: null,
    lines: embeddedList(invoiceLines(ss, inv.stripe_id), `/v1/invoices/${inv.stripe_id}/lines`, formatInvoiceLineItem),
    livemode: false,
    metadata: inv.metadata,
    next_payment_attempt: inv.next_payment_attempt ?? null,
    number: inv.number ?? null,
    on_behalf_of: null,
    parent: inv.subscription_id
      ? {
          quote_details: null,
          subscription_details: {
            metadata: inv.subscription_metadata ?? {},
            subscription: inv.subscription_id,
            subscription_proration_date: null,
          },
          type: "subscription_details" as const,
        }
      : null,
    payment_settings: { default_mandate: null, payment_method_options: null, payment_method_types: null },
    period_end: inv.period_end,
    period_start: inv.period_start,
    post_payment_credit_notes_amount: 0,
    pre_payment_credit_notes_amount: 0,
    receipt_number: null,
    rendering: null,
    shipping_cost: null,
    shipping_details: null,
    starting_balance: 0,
    statement_descriptor: null,
    status: inv.status,
    ...(inv.status === "uncollectible" && {
      status_details: { uncollectible: { reason: inv.uncollectible_reason ?? null } },
    }),
    status_transitions: {
      finalized_at: inv.finalized_at ?? null,
      marked_uncollectible_at: inv.marked_uncollectible_at ?? null,
      paid_at: inv.paid_at ?? null,
      voided_at: inv.voided_at ?? null,
    },
    subtotal: amounts.subtotal,
    subtotal_excluding_tax: amounts.subtotal,
    test_clock: inv.test_clock ?? null,
    threshold_reason: null,
    total: amounts.total,
    total_discount_amounts: [] as unknown[],
    total_excluding_tax: amounts.total,
    total_pretax_credit_amounts: [] as unknown[],
    total_taxes: [] as unknown[],
    transfer_data: null,
    webhooks_delivered_at: inv.webhooks_delivered_at ?? null,
  };
}

/**
 * The legacy Plan object Stripe still embeds in every subscription item, derived from its
 * recurring price. `amount` is null for tiered prices, like the price's `unit_amount`.
 */
export function formatPlan(p: StripePrice) {
  const price = formatPrice(p);
  return {
    id: p.stripe_id,
    object: "plan" as const,
    active: p.active,
    amount: price.unit_amount,
    amount_decimal: price.unit_amount_decimal,
    billing_scheme: price.billing_scheme,
    created: price.created,
    currency: p.currency,
    discounts: null,
    interval: p.recurring?.interval ?? null,
    interval_count: p.recurring?.interval_count ?? null,
    livemode: false,
    metadata: p.metadata,
    meter: p.recurring?.meter ?? null,
    nickname: p.nickname ?? null,
    product: p.product_id,
    tiers_mode: price.tiers_mode,
    transform_usage: p.transform_quantity ? { ...p.transform_quantity } : null,
    trial_period_days: null,
    usage_type: p.recurring?.usage_type ?? "licensed",
  };
}

/** The items of a subscription in the order they were added. */
export function subscriptionItems(ss: StripeStore, subscriptionId: string): StripeSubscriptionItem[] {
  return ss.subscriptionItems.findBy("subscription_id", subscriptionId).sort((a, b) => a.id - b.id);
}

/**
 * The Subscription Item object. Periods live here rather than on the subscription. Trial
 * Offers are not modelled, so `current_trial` is always null; legacy trials show on the
 * subscription's `trial_start` and `trial_end`.
 */
export function formatSubscriptionItem(ss: StripeStore, si: StripeSubscriptionItem) {
  const price = ss.prices.findOneBy("stripe_id", si.price_id);
  return {
    id: si.stripe_id,
    object: "subscription_item" as const,
    billing_thresholds: null,
    created: si.created,
    current_period_end: si.current_period_end,
    current_period_start: si.current_period_start,
    current_trial: null,
    discounts: [] as string[],
    metadata: si.metadata,
    plan: price ? formatPlan(price) : null,
    price: price ? formatPrice(price) : null,
    quantity: si.quantity,
    subscription: si.subscription_id,
    tax_rates: [] as unknown[],
  };
}

/** How many items a subscription may have, all of which its `items` list embeds. */
export const MAX_SUBSCRIPTION_ITEMS = 20;

/**
 * The Subscription object in the key order of the API reference. There is no top-level
 * `current_period_*`, `plan` or `quantity`: periods live on the items. Taxes, discounts,
 * schedules, Connect and pause_collection are not modelled and keep their empty defaults.
 */
export function formatSubscription(ss: StripeStore, sub: StripeSubscription) {
  const items = subscriptionItems(ss, sub.stripe_id);
  return {
    id: sub.stripe_id,
    object: "subscription" as const,
    application: null,
    application_fee_percent: null,
    automatic_tax: { disabled_reason: null, enabled: false, liability: null },
    billing_cycle_anchor: sub.billing_cycle_anchor,
    billing_cycle_anchor_config: null,
    billing_mode: {
      flexible: { proration_discounts: "included" as const },
      type: "flexible" as const,
      updated_at: sub.created,
    },
    billing_thresholds: null,
    cancel_at: sub.cancel_at ?? null,
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: sub.canceled_at ?? null,
    cancellation_details: {
      comment: sub.cancellation_details.comment ?? null,
      feedback: sub.cancellation_details.feedback ?? null,
      reason: sub.cancellation_details.reason ?? null,
    },
    collection_method: sub.collection_method,
    created: sub.created,
    currency: sub.currency,
    customer: sub.customer_id,
    customer_account: null,
    days_until_due: sub.days_until_due ?? null,
    default_payment_method: sub.default_payment_method ?? null,
    default_source: null,
    default_tax_rates: [] as unknown[],
    description: sub.description ?? null,
    discounts: null,
    ended_at: sub.ended_at ?? null,
    invoice_settings: { account_tax_ids: null, issuer: { type: "self" as const } },
    items: {
      object: "list" as const,
      data: items.slice(0, MAX_SUBSCRIPTION_ITEMS).map((si) => formatSubscriptionItem(ss, si)),
      has_more: items.length > MAX_SUBSCRIPTION_ITEMS,
      total_count: items.length,
      url: `/v1/subscription_items?subscription=${sub.stripe_id}`,
    },
    latest_invoice: sub.latest_invoice ?? null,
    livemode: false,
    metadata: sub.metadata,
    next_pending_invoice_item_invoice: null,
    on_behalf_of: null,
    pause_collection: null,
    payment_settings: {
      payment_method_options: null,
      payment_method_types: null,
      save_default_payment_method: sub.save_default_payment_method ?? "off",
    },
    pending_invoice_item_interval: null,
    pending_setup_intent: null,
    pending_update: null,
    presentment_details: null,
    schedule: null,
    start_date: sub.start_date,
    status: sub.status,
    status_details: null,
    test_clock: sub.test_clock ?? null,
    transfer_data: null,
    trial_end: sub.trial_end ?? null,
    trial_settings: {
      end_behavior: {
        missing_payment_method: sub.trial_missing_payment_method ?? "create_invoice",
        billing_cycle_anchor: "now" as const,
      },
    },
    trial_start: sub.trial_start ?? null,
  };
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
    setup_intent: (id) => {
      const found = ss.setupIntents.findOneBy("stripe_id", id);
      return found ? formatSetupIntent(found) : undefined;
    },
    invoice: (id) => {
      const found = ss.invoices.findOneBy("stripe_id", id);
      return found ? formatInvoice(ss, found, baseUrl) : undefined;
    },
    invoiceitem: (id) => {
      const found = ss.invoiceItems.findOneBy("stripe_id", id);
      return found ? formatInvoiceItem(found) : undefined;
    },
    invoice_payment: (id) => {
      const found = ss.invoicePayments.findOneBy("stripe_id", id);
      return found ? formatInvoicePayment(found) : undefined;
    },
    subscription: (id) => {
      const found = ss.subscriptions.findOneBy("stripe_id", id);
      return found ? formatSubscription(ss, found) : undefined;
    },
    subscription_item: (id) => {
      const found = ss.subscriptionItems.findOneBy("stripe_id", id);
      return found ? formatSubscriptionItem(ss, found) : undefined;
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
    setup_intent: "setup_intent",
    invoice: "invoice",
    latest_invoice: "invoice",
    invoice_item: "invoiceitem",
    subscription: "subscription",
    subscription_item: "subscription_item",
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
    ["seti_", "setup_intent"],
    ["in_", "invoice"],
    ["ii_", "invoiceitem"],
    ["inpay_", "invoice_payment"],
    ["sub_", "subscription"],
    ["si_", "subscription_item"],
  ];

  const storedInvoice = (parent: Record<string, unknown>) => ss.invoices.findOneBy("stripe_id", String(parent.id));

  const storedPrice = (parent: Record<string, unknown>) => ss.prices.findOneBy("stripe_id", String(parent.id));

  const includable: Record<string, Record<string, (parent: Record<string, unknown>) => unknown>> = {
    price: {
      tiers: (parent) => {
        const price = storedPrice(parent);
        return price ? formatPriceTiers(price) : undefined;
      },
      currency_options: (parent) => {
        const price = storedPrice(parent);
        return price ? formatPriceCurrencyOptions(price) : undefined;
      },
    },
    charge: {
      refunds: (parent) => emptyList(`/v1/charges/${String(parent.id)}/refunds`),
    },
    invoice: {
      payments: (parent) =>
        embeddedList(invoicePayments(ss, String(parent.id)), "/v1/invoice_payments", formatInvoicePayment),
      confirmation_secret: (parent) => {
        const payment = defaultInvoicePayment(ss, String(parent.id));
        const pi = payment ? ss.paymentIntents.findOneBy("stripe_id", payment.payment_intent_id) : undefined;
        return pi?.client_secret ? { client_secret: pi.client_secret, type: "payment_intent" } : null;
      },
      amount_paid_off_stripe: (parent) => storedInvoice(parent)?.amount_paid_off_stripe ?? 0,
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
