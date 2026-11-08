import type { Entity } from "@emulators/core";

export interface StripeCustomer extends Entity {
  stripe_id: string;
  email: string | null;
  name: string | null;
  description: string | null;
  metadata: Record<string, string>;
  invoice_settings?: { default_payment_method?: string };
  /** Eight characters. Customers inserted without one get a prefix derived from their id. */
  invoice_prefix?: string;
  next_invoice_sequence?: number;
  delinquent?: boolean;
  test_clock?: string;
  /** Unix seconds on the customer's clock. Customers inserted without one use created_at. */
  created?: number;
}

export interface StripeAddress {
  city?: string;
  country?: string;
  line1?: string;
  line2?: string;
  postal_code?: string;
  state?: string;
}

export interface StripeBillingDetails {
  address?: StripeAddress;
  email?: string;
  name?: string;
  phone?: string;
}

export type CardCheck = "pass" | "fail" | "unavailable" | "unchecked";

export interface StripePaymentMethodCard {
  /** The test card number this card was created from. Its behaviour comes from the test card table. */
  number: string;
  exp_month: number;
  exp_year: number;
  cvc_check?: CardCheck;
}

export interface StripePaymentMethod extends Entity {
  stripe_id: string;
  type: "card";
  customer_id?: string;
  card: StripePaymentMethodCard;
  billing_details: StripeBillingDetails;
  allow_redisplay: "always" | "limited" | "unspecified";
  metadata: Record<string, string>;
  created: number;
  /** Detached payment methods can never be attached again. */
  detached?: boolean;
  /**
   * Charge behaviour set through /_stripe/simulate/payment_methods/:id, which replaces the
   * test card's for later charges. Setup and attach still follow the test card.
   */
  simulated?: SimulatedCardBehavior;
}

/** How charges on a payment method behave once the emulator was told to change them. */
export interface SimulatedCardBehavior {
  charge: "succeed" | "decline";
  authentication: "none" | "always";
  decline?: { code: string; decline_code?: string; message: string; param?: string };
}

export interface StripeProduct extends Entity {
  stripe_id: string;
  name: string;
  description: string | null;
  active: boolean;
  metadata: Record<string, string>;
  images?: string[];
  shippable?: boolean;
  statement_descriptor?: string;
  unit_label?: string;
  url?: string;
}

export type PriceInterval = "day" | "week" | "month" | "year";

export interface StripePriceRecurring {
  interval: PriceInterval;
  interval_count: number;
  usage_type: "licensed" | "metered";
  meter?: string;
}

/**
 * One pricing tier. Amounts are kept as decimal strings, the integer fields are derived from
 * them. A tier without `up_to` is the final `inf` tier.
 */
export interface StripePriceTier {
  up_to?: number;
  unit_amount_decimal?: string;
  flat_amount_decimal?: string;
}

export interface StripePriceTransformQuantity {
  divide_by: number;
  round: "up" | "down";
}

export interface StripePrice extends Entity {
  stripe_id: string;
  product_id: string;
  currency: string;
  /** Set when the unit amount is a whole number. Tiered prices and fractional amounts leave it null. */
  unit_amount: number | null;
  type: "one_time" | "recurring";
  active: boolean;
  metadata: Record<string, string>;
  /** Defaults to `per_unit`. */
  billing_scheme?: "per_unit" | "tiered";
  /** Defaults to String(unit_amount) when unit_amount is set. */
  unit_amount_decimal?: string;
  recurring?: StripePriceRecurring;
  tiers?: StripePriceTier[];
  tiers_mode?: "graduated" | "volume";
  transform_quantity?: StripePriceTransformQuantity;
  lookup_key?: string;
  nickname?: string;
  tax_behavior?: "exclusive" | "inclusive" | "unspecified";
}

export type PaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "succeeded"
  | "canceled";

/**
 * A payment error as Stripe stores it on `last_payment_error`. `payment_method` is the
 * PaymentMethod object as it was when the attempt failed.
 */
export interface StripePaymentError {
  type: "card_error" | "invalid_request_error";
  code: string;
  decline_code?: string;
  message: string;
  doc_url: string;
  param?: string;
  charge?: string;
  payment_method?: Record<string, unknown>;
}

/** The `next_action` of an intent waiting on 3D Secure. */
export interface StripeNextAction {
  type: "use_stripe_sdk";
  use_stripe_sdk: { source: string; stripe_js: string; type: "three_d_secure_redirect" };
}

export interface StripePaymentIntent extends Entity {
  stripe_id: string;
  amount: number;
  currency: string;
  status: PaymentIntentStatus;
  customer_id: string | null;
  description: string | null;
  payment_method: string | null;
  metadata: Record<string, string>;
  /** Unix seconds on the customer's clock. Intents inserted without one use created_at. */
  created?: number;
  amount_received?: number;
  client_secret?: string;
  capture_method?: "automatic" | "automatic_async";
  confirmation_method?: "automatic" | "manual";
  setup_future_usage?: "off_session" | "on_session";
  latest_charge?: string;
  last_payment_error?: StripePaymentError;
  next_action?: StripeNextAction;
  /** Set once the customer completed 3D Secure, so a manual confirmation does not ask again. */
  authenticated?: boolean;
  canceled_at?: number;
  cancellation_reason?: string;
}

export type SetupIntentStatus = PaymentIntentStatus;

export interface StripeSetupIntent extends Entity {
  stripe_id: string;
  status: SetupIntentStatus;
  /** On successful setup the payment method is attached to this customer. */
  customer_id?: string;
  payment_method?: string;
  usage: "off_session" | "on_session";
  description?: string;
  metadata: Record<string, string>;
  /** Unix seconds on the customer's clock. */
  created: number;
  client_secret: string;
  /** Same shape as a PaymentIntent's `last_payment_error`, without a charge. */
  last_setup_error?: StripePaymentError;
  next_action?: StripeNextAction;
  cancellation_reason?: "abandoned" | "duplicate" | "requested_by_customer";
}

export interface StripeCharge extends Entity {
  stripe_id: string;
  amount: number;
  currency: string;
  status: "succeeded" | "pending" | "failed";
  customer_id: string | null;
  payment_intent_id: string | null;
  description: string | null;
  metadata: Record<string, string>;
  payment_method?: string;
  failure_code?: string;
  failure_message?: string;
  /** Unix seconds on the customer's clock. Charges inserted without one use created_at. */
  created?: number;
  /** The issuer's reason for a failed charge, rendered as `outcome.reason`. */
  decline_code?: string;
  /** The card as it was when charged. Charges without one render `payment_method_details` as null. */
  card?: StripePaymentMethodCard;
  billing_details?: StripeBillingDetails;
  /** Whether the customer completed 3D Secure for this charge. */
  three_d_secure?: boolean;
  authorization_code?: string;
  network_transaction_id?: string;
}

export interface StripeCheckoutSession extends Entity {
  stripe_id: string;
  mode: "payment" | "setup" | "subscription";
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  customer_id: string | null;
  success_url: string | null;
  cancel_url: string | null;
  line_items: StripeCheckoutLineItem[];
  metadata: Record<string, string>;
  /** Unix seconds. Sessions inserted without one use created_at. */
  created?: number;
  /** Defaults to 24 hours after `created`. */
  expires_at?: number;
  currency?: string;
  /** What is due when the session completes: 0 during a trial. */
  amount_subtotal?: number;
  amount_total?: number;
  client_reference_id?: string;
  customer_email?: string;
  /** Payment and setup mode only. Subscription mode always creates a customer. */
  customer_creation?: "always" | "if_required";
  /** Subscription mode only. Defaults to `always`. */
  payment_method_collection?: "always" | "if_required";
  subscription_data?: StripeCheckoutSubscriptionData;
  /** Collected when the session completes. */
  customer_details?: { email?: string; name?: string };
  subscription_id?: string;
  invoice_id?: string;
  payment_intent_id?: string;
}

export interface StripeCheckoutLineItem {
  /** The `li_` id. Sessions stored without one render an id derived from the session. */
  stripe_id?: string;
  price: string;
  quantity: number;
}

/** The `subscription_data` a subscription-mode session passes on to its subscription. */
export interface StripeCheckoutSubscriptionData {
  description?: string;
  metadata: Record<string, string>;
  /** An absolute trial end. */
  trial_end?: number;
  /** A trial length counted from the moment the session completes. */
  trial_period_days?: number;
  missing_payment_method?: "cancel" | "create_invoice" | "pause";
}

export interface StripeEventRequest {
  id: string | null;
  idempotency_key: string | null;
}

export interface StripeEvent extends Entity {
  stripe_id: string;
  type: string;
  api_version: string;
  /** Unix seconds. Kept separately from created_at so simulated time can set it later. */
  created: number;
  data: { object: Record<string, unknown>; previous_attributes?: Record<string, unknown> };
  pending_webhooks: number;
  request: StripeEventRequest;
}

export interface StripeWebhookEndpoint extends Entity {
  stripe_id: string;
  url: string;
  enabled_events: string[];
  status: "enabled" | "disabled";
  /** Rendered as null when unset. Events always use the emulator's version. */
  api_version?: string;
  description?: string;
  metadata: Record<string, string>;
  /** Seed endpoints may have no secret, in which case deliveries are unsigned. */
  secret?: string;
  created: number;
}

export type InvoiceStatus = "draft" | "open" | "paid" | "uncollectible" | "void";

export type InvoiceBillingReason =
  | "manual"
  | "subscription_create"
  | "subscription_cycle"
  | "subscription_threshold"
  | "subscription_update"
  | "upcoming";

export type InvoiceUncollectibleReason =
  | "max_payment_attempts"
  | "payment_not_received"
  | "subscription_canceled"
  | "subscription_paused"
  | "user_forgiven";

/** The customer fields an invoice freezes when it is finalized. Drafts read the live customer. */
export interface StripeInvoiceCustomerSnapshot {
  email: string | null;
  name: string | null;
}

export interface StripeInvoice extends Entity {
  stripe_id: string;
  customer_id: string;
  status: InvoiceStatus;
  currency: string;
  collection_method: "charge_automatically" | "send_invoice";
  billing_reason: InvoiceBillingReason;
  auto_advance: boolean;
  metadata: Record<string, string>;
  /** Unix seconds on the customer's clock. */
  created: number;
  period_start: number;
  period_end: number;
  attempt_count: number;
  attempted: boolean;
  amount_paid: number;
  /** Set when the invoice was paid outside Stripe. Rendered only when expanded. */
  amount_paid_off_stripe?: number;
  description?: string;
  footer?: string;
  default_payment_method?: string;
  due_date?: number;
  number?: string;
  next_payment_attempt?: number;
  finalized_at?: number;
  paid_at?: number;
  voided_at?: number;
  marked_uncollectible_at?: number;
  uncollectible_reason?: InvoiceUncollectibleReason;
  customer_snapshot?: StripeInvoiceCustomerSnapshot;
  /**
   * The payment method whose last attempt ended in a hard decline. Retries stay scheduled
   * but are not executed while the invoice would still be charged with it.
   */
  hard_declined_payment_method?: string;
  webhooks_delivered_at?: number;
  /** The subscription that generated the invoice, rendered as `parent.subscription_details`. */
  subscription_id?: string;
  subscription_metadata?: Record<string, string>;
  test_clock?: string;
}

/** A pending charge for a customer, invoiced as a line once it is attached to an invoice. */
export interface StripeInvoiceItem extends Entity {
  stripe_id: string;
  customer_id: string;
  invoice_id?: string;
  amount: number;
  currency: string;
  description?: string;
  discountable: boolean;
  metadata: Record<string, string>;
  period: { start: number; end: number };
  /** Without a price the item was created from a bare amount and renders `pricing` as null. */
  price_id?: string;
  product_id?: string;
  unit_amount_decimal: string;
  quantity: number;
  proration: boolean;
  subscription_id?: string;
  /** Unix seconds on the customer's clock, rendered as `date`. */
  date: number;
  test_clock?: string;
}

export interface StripeInvoiceLineItem extends Entity {
  stripe_id: string;
  invoice_id: string;
  amount: number;
  currency: string;
  description?: string;
  discountable: boolean;
  metadata: Record<string, string>;
  period: { start: number; end: number };
  price_id?: string;
  product_id?: string;
  unit_amount_decimal?: string;
  quantity: number;
  proration: boolean;
  /** Exactly one of the two parents is set. */
  invoice_item_id?: string;
  subscription_item_id?: string;
  subscription_id?: string;
}

export interface StripeInvoicePayment extends Entity {
  stripe_id: string;
  invoice_id: string;
  amount_requested: number;
  /** Null on the wire until the payment is paid. */
  amount_paid?: number;
  currency: string;
  is_default: boolean;
  payment_intent_id: string;
  status: "open" | "paid" | "canceled";
  created: number;
  paid_at?: number;
  canceled_at?: number;
}

export type SubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export type SubscriptionCancellationReason =
  | "cancellation_requested"
  | "payment_disputed"
  | "payment_failed"
  | "canceled_by_retention_policy";

export type SubscriptionCancellationFeedback =
  | "customer_service"
  | "low_quality"
  | "missing_features"
  | "other"
  | "switched_service"
  | "too_complex"
  | "too_expensive"
  | "unused";

export interface StripeSubscriptionCancellationDetails {
  comment?: string;
  feedback?: SubscriptionCancellationFeedback;
  reason?: SubscriptionCancellationReason;
}

/**
 * A subscription. Billing periods live on its items, as in API versions from basil on. Every
 * item shares one currency and one interval.
 */
export interface StripeSubscription extends Entity {
  stripe_id: string;
  customer_id: string;
  status: SubscriptionStatus;
  currency: string;
  collection_method: "charge_automatically" | "send_invoice";
  days_until_due?: number;
  default_payment_method?: string;
  description?: string;
  metadata: Record<string, string>;
  /** Unix seconds on the customer's clock. */
  created: number;
  start_date: number;
  billing_cycle_anchor: number;
  cancel_at?: number;
  cancel_at_period_end: boolean;
  canceled_at?: number;
  ended_at?: number;
  cancellation_details: StripeSubscriptionCancellationDetails;
  trial_start?: number;
  trial_end?: number;
  /** What happens when the trial ends without a payment method. Defaults to `create_invoice`. */
  trial_missing_payment_method?: "cancel" | "create_invoice" | "pause";
  latest_invoice?: string;
  /** Whether invoice payments are attempted with the customer present. Defaults to false. */
  off_session?: boolean;
  save_default_payment_method?: "off" | "on_subscription";
  test_clock?: string;
  /** The `trial_end` customer.subscription.trial_will_end was last sent for. */
  trial_will_end_sent_for?: number;
  /** The renewal time invoice.upcoming was last sent for. */
  upcoming_sent_for?: number;
  /** The last transition to `paused`, rendered as `status_details.paused`. */
  paused_details?: StripeSubscriptionPauseDetails;
}

export type SubscriptionPauseReason =
  | "final_payment_failure"
  | "first_payment_failure"
  | "pause_requested"
  | "system"
  | "trial_end_without_payment_method";

export interface StripeSubscriptionPauseDetails {
  reason: SubscriptionPauseReason;
  transitioned_at: number;
}

export interface StripeSubscriptionItem extends Entity {
  stripe_id: string;
  subscription_id: string;
  price_id: string;
  quantity: number;
  metadata: Record<string, string>;
  /** Unix seconds on the customer's clock. */
  created: number;
  current_period_start: number;
  current_period_end: number;
}

export type TestClockStatus = "advancing" | "internal_failure" | "ready";

/** A test clock. Customers created on it, and everything billed to them, read its frozen time. */
export interface StripeTestClock extends Entity {
  stripe_id: string;
  name?: string;
  frozen_time: number;
  status: TestClockStatus;
  /** Unix seconds on the wall clock. */
  created: number;
  deletes_after: number;
}

/** A delivery the chaos settings decided not to send. Sent deliveries live in the core dispatcher. */
export interface StripeWebhookAttempt extends Entity {
  event_id: string;
  type: string;
  status: "dropped";
  url: string;
  created: number;
}
