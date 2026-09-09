import type { Entity } from "@emulators/core";

export type Address = Record<string, string>;
export type CustomFields = Record<string, string>;
export type MetaData = Record<string, unknown> | null;

export type ItemType = "plan" | "addon" | "charge";
export type PricingModel = "flat_fee" | "per_unit" | "tiered" | "volume" | "stairstep";
export type PeriodUnit = "day" | "week" | "month" | "year";
export type TrialPeriodUnit = "day" | "month";
export type AutoCollection = "on" | "off";
export type EventSource =
  | "admin_console"
  | "api"
  | "scheduled_job"
  | "hosted_page"
  | "portal"
  | "system"
  | "none"
  | "js_api"
  | "migration"
  | "bulk_operation"
  | "external_service";

export interface ChargebeeApiKey extends Entity {
  key: string;
  name: string;
}

export interface ChargebeeCustomer extends Entity {
  cb_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company: string | null;
  phone: string | null;
  locale: string | null;
  auto_collection: AutoCollection;
  net_term_days: number;
  allow_direct_debit: boolean;
  taxability: "taxable" | "exempt";
  preferred_currency_code: string | null;
  billing_address: Address | null;
  vat_number: string | null;
  meta_data: MetaData;
  custom_fields: CustomFields;
  primary_payment_source_id: string | null;
  backup_payment_source_id: string | null;
  promotional_credits: number;
  refundable_credits: number;
  excess_payments: number;
  unbilled_charges: number;
  parent_id: string | null;
  payment_owner_id: string | null;
  invoice_owner_id: string | null;
  channel: "web" | "app_store" | "play_store";
  resource_version: number;
  deleted: boolean;
}

export interface ChargebeeItemFamily extends Entity {
  cb_id: string;
  name: string;
  description: string | null;
  status: "active" | "deleted";
  resource_version: number;
}

export interface ChargebeeItem extends Entity {
  cb_id: string;
  name: string;
  external_name: string | null;
  description: string | null;
  type: ItemType;
  item_family_id: string;
  status: "active" | "archived" | "deleted";
  enabled_for_checkout: boolean;
  enabled_in_portal: boolean;
  item_applicability: "all" | "restricted";
  applicable_items: string[];
  metered: boolean;
  unit: string | null;
  is_shippable: boolean;
  is_giftable: boolean;
  metadata: MetaData;
  custom_fields: CustomFields;
  archived_at: number | null;
  resource_version: number;
}

export interface PriceTier {
  starting_unit: number;
  ending_unit: number | null;
  price: number;
}

export interface ChargebeeItemPrice extends Entity {
  cb_id: string;
  name: string;
  external_name: string | null;
  description: string | null;
  item_id: string;
  item_family_id: string;
  item_type: ItemType;
  status: "active" | "archived" | "deleted";
  pricing_model: PricingModel;
  price: number | null;
  currency_code: string;
  period: number | null;
  period_unit: PeriodUnit | null;
  trial_period: number | null;
  trial_period_unit: TrialPeriodUnit | null;
  free_quantity: number;
  tiers: PriceTier[];
  is_taxable: boolean;
  show_description_in_invoices: boolean;
  show_description_in_quotes: boolean;
  invoice_notes: string | null;
  metadata: MetaData;
  custom_fields: CustomFields;
  archived_at: number | null;
  resource_version: number;
}

export interface CouponItemConstraint {
  item_type: ItemType;
  constraint: "none" | "all" | "specific" | "criteria";
  item_price_ids: string[];
}

export interface ChargebeeCoupon extends Entity {
  cb_id: string;
  name: string;
  invoice_name: string | null;
  discount_type: "fixed_amount" | "percentage";
  discount_amount: number | null;
  discount_percentage: number | null;
  currency_code: string | null;
  duration_type: "one_time" | "forever" | "limited_period";
  duration_month: number | null;
  valid_till: number | null;
  max_redemptions: number | null;
  status: "active" | "expired" | "archived" | "deleted";
  apply_on: "invoice_amount" | "each_specified_item";
  item_constraints: CouponItemConstraint[];
  redemptions: number;
  meta_data: MetaData;
  archived_at: number | null;
  resource_version: number;
}

export type SubscriptionStatus = "future" | "in_trial" | "active" | "non_renewing" | "paused" | "cancelled";

export interface SubscriptionItem {
  item_price_id: string;
  item_type: ItemType;
  quantity: number;
  unit_price: number;
  amount: number;
  free_quantity: number;
}

export interface SubscriptionCoupon {
  coupon_id: string;
  apply_till: number | null;
  applied_count: number;
}

export interface ScheduledChanges {
  subscription_items: SubscriptionItem[];
}

export interface ChargebeeSubscription extends Entity {
  cb_id: string;
  customer_id: string;
  status: SubscriptionStatus;
  currency_code: string;
  subscription_items: SubscriptionItem[];
  coupons: SubscriptionCoupon[];
  billing_period: number;
  billing_period_unit: PeriodUnit;
  start_date: number | null;
  trial_start: number | null;
  trial_end: number | null;
  current_term_start: number | null;
  current_term_end: number | null;
  next_billing_at: number | null;
  started_at: number | null;
  activated_at: number | null;
  cancelled_at: number | null;
  cancel_reason: string | null;
  cancel_reason_code: string | null;
  cancel_schedule_created_at: number | null;
  pause_date: number | null;
  resume_date: number | null;
  auto_collection: AutoCollection | null;
  po_number: string | null;
  invoice_notes: string | null;
  shipping_address: Address | null;
  meta_data: MetaData;
  custom_fields: CustomFields;
  scheduled_changes: ScheduledChanges | null;
  changes_scheduled_at: number | null;
  channel: "web" | "app_store" | "play_store";
  resource_version: number;
  deleted: boolean;
}

export type InvoiceStatus = "paid" | "posted" | "payment_due" | "not_paid" | "voided" | "pending";
export type LineItemEntityType = "plan_item_price" | "addon_item_price" | "charge_item_price" | "adhoc";

export interface InvoiceLineItem {
  id: string;
  date_from: number;
  date_to: number;
  unit_amount: number;
  quantity: number;
  amount: number;
  pricing_model: PricingModel;
  description: string;
  entity_type: LineItemEntityType;
  entity_id: string | null;
  discount_amount: number;
  item_level_discount_amount: number;
  subscription_id: string | null;
  customer_id: string;
  metered: boolean;
  is_taxed: boolean;
  tax_amount: number;
}

export interface InvoiceDiscount {
  amount: number;
  description: string;
  entity_type: "item_level_coupon" | "document_level_coupon" | "promotional_credits" | "prorated_credits";
  entity_id: string | null;
}

export interface LinkedPayment {
  txn_id: string;
  applied_amount: number;
  applied_at: number;
  txn_status: TransactionStatus;
  txn_date: number;
  txn_amount: number;
}

export interface AppliedCredit {
  cn_id: string;
  applied_amount: number;
  applied_at: number;
  cn_reason_code: string | null;
  cn_create_reason_code: string | null;
  cn_date: number;
  cn_status: CreditNoteStatus;
}

export interface ChargebeeInvoice extends Entity {
  cb_id: string;
  customer_id: string;
  subscription_id: string | null;
  recurring: boolean;
  status: InvoiceStatus;
  date: number;
  due_date: number | null;
  net_term_days: number;
  currency_code: string;
  total: number;
  amount_paid: number;
  amount_adjusted: number;
  write_off_amount: number;
  credits_applied: number;
  amount_due: number;
  sub_total: number;
  tax: number;
  paid_at: number | null;
  voided_at: number | null;
  void_reason_code: string | null;
  first_invoice: boolean;
  line_items: InvoiceLineItem[];
  discounts: InvoiceDiscount[];
  linked_payments: LinkedPayment[];
  applied_credits: AppliedCredit[];
  adjustment_credit_note_ids: string[];
  issued_credit_note_ids: string[];
  billing_address: Address | null;
  shipping_address: Address | null;
  po_number: string | null;
  notes: string | null;
  vat_number: string | null;
  dunning_status: "in_progress" | "exhausted" | "stopped" | "success" | null;
  generated_at: number;
  resource_version: number;
  deleted: boolean;
}

export type TransactionStatus = "success" | "failure" | "in_progress" | "voided" | "needs_attention";
export type TransactionType = "authorization" | "payment" | "refund" | "payment_reversal";
export type PaymentMethodType =
  | "card"
  | "cash"
  | "check"
  | "bank_transfer"
  | "chargeback"
  | "other"
  | "paypal_express_checkout"
  | "direct_debit";

export interface LinkedInvoice {
  invoice_id: string;
  applied_amount: number;
  applied_at: number;
  invoice_date: number;
  invoice_total: number;
  invoice_status: InvoiceStatus;
}

export interface LinkedCreditNote {
  cn_id: string;
  applied_amount: number;
  applied_at: number;
  cn_reference_invoice_id: string | null;
  cn_total: number;
  cn_status: CreditNoteStatus;
  cn_date: number;
  cn_reason_code: string | null;
}

export interface ChargebeeTransaction extends Entity {
  cb_id: string;
  customer_id: string;
  subscription_id: string | null;
  payment_source_id: string | null;
  payment_method: PaymentMethodType;
  gateway: "chargebee" | "not_applicable";
  gateway_account_id: string | null;
  type: TransactionType;
  date: number;
  amount: number;
  status: TransactionStatus;
  currency_code: string;
  reference_number: string | null;
  id_at_gateway: string | null;
  error_code: string | null;
  error_text: string | null;
  masked_card_number: string | null;
  refunded_txn_id: string | null;
  amount_unused: number;
  linked_invoices: LinkedInvoice[];
  linked_credit_notes: LinkedCreditNote[];
  resource_version: number;
  deleted: boolean;
}

export interface CardDetails {
  first_name: string | null;
  last_name: string | null;
  iin: string;
  last4: string;
  brand: string;
  funding_type: "credit" | "debit" | "prepaid" | "not_known";
  expiry_month: number;
  expiry_year: number;
  masked_number: string;
}

export interface ChargebeePaymentSource extends Entity {
  cb_id: string;
  customer_id: string;
  type: "card" | "paypal_express_checkout" | "direct_debit" | "generic";
  reference_id: string;
  status: "valid" | "expiring" | "expired" | "invalid" | "pending_verification";
  gateway: "chargebee";
  gateway_account_id: string;
  card: CardDetails | null;
  issuing_country: string | null;
  resource_version: number;
  deleted: boolean;
}

export type HostedPageType =
  | "checkout_new"
  | "checkout_existing"
  | "checkout_one_time"
  | "update_payment_method"
  | "manage_payment_sources"
  | "collect_now";

export type HostedPageState = "created" | "requested" | "succeeded" | "cancelled" | "acknowledged" | "failed";

export interface HostedPageContent {
  customer_id?: string;
  subscription_id?: string;
  invoice_id?: string;
  payment_source_id?: string;
}

export interface ChargebeeHostedPage extends Entity {
  cb_id: string;
  type: HostedPageType;
  state: HostedPageState;
  failure_reason: string | null;
  pass_thru_content: string | null;
  embed: boolean;
  expires_at: number;
  redirect_url: string | null;
  cancel_url: string | null;
  request: Record<string, unknown>;
  content: HostedPageContent | null;
  resource_version: number;
}

export interface ChargebeePortalSession extends Entity {
  cb_id: string;
  token: string;
  customer_id: string;
  status: "created" | "logged_in" | "logged_out" | "not_yet_activated" | "activated";
  redirect_url: string | null;
  forward_url: string | null;
  expires_at: number;
  login_at: number | null;
  logout_at: number | null;
  resource_version: number;
}

export type WebhookStatus =
  | "not_configured"
  | "scheduled"
  | "succeeded"
  | "re_scheduled"
  | "failed"
  | "skipped"
  | "not_applicable";

export interface ChargebeeEvent extends Entity {
  cb_id: string;
  event_type: string;
  occurred_at: number;
  source: EventSource;
  user: string | null;
  content: Record<string, unknown>;
  webhook_status: WebhookStatus;
  webhooks: Array<{ id: string; webhook_status: WebhookStatus }>;
}

export type CreditNoteType = "adjustment" | "refundable";
export type CreditNoteStatus = "adjusted" | "refunded" | "refund_due" | "voided";

export interface CreditNoteAllocation {
  invoice_id: string;
  allocated_amount: number;
  allocated_at: number;
  invoice_date: number;
  invoice_status: InvoiceStatus;
}

export interface ChargebeeCreditNote extends Entity {
  cb_id: string;
  customer_id: string;
  subscription_id: string | null;
  reference_invoice_id: string | null;
  type: CreditNoteType;
  reason_code: string | null;
  create_reason_code: string | null;
  status: CreditNoteStatus;
  date: number;
  currency_code: string;
  total: number;
  amount_allocated: number;
  amount_refunded: number;
  amount_available: number;
  sub_total: number;
  line_items: InvoiceLineItem[];
  customer_notes: string | null;
  voided_at: number | null;
  generated_at: number;
  allocations: CreditNoteAllocation[];
  linked_refunds: LinkedPayment[];
  resource_version: number;
  deleted: boolean;
}
