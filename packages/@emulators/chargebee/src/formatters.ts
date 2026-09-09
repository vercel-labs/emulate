import type {
  ChargebeeCoupon,
  ChargebeeCreditNote,
  ChargebeeCustomer,
  ChargebeeEvent,
  ChargebeeHostedPage,
  ChargebeeInvoice,
  ChargebeeItem,
  ChargebeeItemFamily,
  ChargebeeItemPrice,
  ChargebeePaymentSource,
  ChargebeePortalSession,
  ChargebeeSubscription,
  ChargebeeTransaction,
  InvoiceLineItem,
  InvoiceDiscount,
} from "./entities.js";
import { genesisTime, nowSeconds, type ChargebeeStore } from "./store.js";
import { monthsInPeriod } from "./helpers.js";
import { TIME_MACHINE_ID } from "./ids.js";

type Json = Record<string, unknown>;

function compact(obj: Json): Json {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null));
}

function unix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

export function primaryPaymentSource(
  cs: ChargebeeStore,
  customer: ChargebeeCustomer,
): ChargebeePaymentSource | undefined {
  if (!customer.primary_payment_source_id) return undefined;
  const source = cs.paymentSources.findOneBy("cb_id", customer.primary_payment_source_id);
  return source && !source.deleted ? source : undefined;
}

export function rootCustomerId(cs: ChargebeeStore, customer: ChargebeeCustomer): string {
  let current = customer;
  const seen = new Set<string>();
  while (current.parent_id && !seen.has(current.cb_id)) {
    seen.add(current.cb_id);
    const parent = cs.customers.findOneBy("cb_id", current.parent_id);
    if (!parent) break;
    current = parent;
  }
  return current.cb_id;
}

export function formatCustomer(cs: ChargebeeStore, c: ChargebeeCustomer): Json {
  const primary = primaryPaymentSource(cs, c);
  const hasHierarchy = c.parent_id !== null || c.payment_owner_id !== null || c.invoice_owner_id !== null;
  return compact({
    id: c.cb_id,
    first_name: c.first_name,
    last_name: c.last_name,
    email: c.email,
    company: c.company,
    phone: c.phone,
    auto_collection: c.auto_collection,
    net_term_days: c.net_term_days,
    allow_direct_debit: c.allow_direct_debit,
    created_at: unix(c.created_at),
    taxability: c.taxability,
    updated_at: unix(c.updated_at),
    locale: c.locale,
    pii_cleared: "active",
    channel: c.channel,
    resource_version: c.resource_version,
    deleted: c.deleted,
    object: "customer",
    billing_address: c.billing_address ? { ...c.billing_address, object: "billing_address" } : undefined,
    vat_number: c.vat_number,
    card_status: primary?.card ? "valid" : "no_card",
    primary_payment_source_id: c.primary_payment_source_id,
    backup_payment_source_id: c.backup_payment_source_id,
    payment_method: primary
      ? {
          object: "payment_method",
          type: primary.type,
          reference_id: primary.reference_id,
          gateway: primary.gateway,
          gateway_account_id: primary.gateway_account_id,
          status: primary.status,
        }
      : undefined,
    promotional_credits: c.promotional_credits,
    refundable_credits: c.refundable_credits,
    excess_payments: c.excess_payments,
    unbilled_charges: c.unbilled_charges,
    preferred_currency_code: c.preferred_currency_code,
    meta_data: c.meta_data,
    relationship: hasHierarchy
      ? {
          parent_id: c.parent_id ?? undefined,
          payment_owner_id: c.payment_owner_id ?? c.cb_id,
          invoice_owner_id: c.invoice_owner_id ?? c.cb_id,
          root_id: rootCustomerId(cs, c),
        }
      : undefined,
    ...c.custom_fields,
  });
}

export function formatCard(ps: ChargebeePaymentSource): Json | undefined {
  if (!ps.card) return undefined;
  return compact({
    status: ps.status,
    gateway: ps.gateway,
    gateway_account_id: ps.gateway_account_id,
    first_name: ps.card.first_name,
    last_name: ps.card.last_name,
    iin: ps.card.iin,
    last4: ps.card.last4,
    card_type: ps.card.brand,
    funding_type: ps.card.funding_type,
    expiry_month: ps.card.expiry_month,
    expiry_year: ps.card.expiry_year,
    created_at: unix(ps.created_at),
    updated_at: unix(ps.updated_at),
    resource_version: ps.resource_version,
    object: "card",
    masked_number: ps.card.masked_number,
    customer_id: ps.customer_id,
    payment_source_id: ps.cb_id,
  });
}

export function customerRow(cs: ChargebeeStore, c: ChargebeeCustomer): Json {
  const primary = primaryPaymentSource(cs, c);
  return compact({
    customer: formatCustomer(cs, c),
    card: primary ? formatCard(primary) : undefined,
  });
}

export function formatItemFamily(f: ChargebeeItemFamily): Json {
  return compact({
    id: f.cb_id,
    name: f.name,
    description: f.description,
    status: f.status,
    resource_version: f.resource_version,
    updated_at: unix(f.updated_at),
    object: "item_family",
  });
}

export function formatItem(i: ChargebeeItem): Json {
  return compact({
    id: i.cb_id,
    name: i.name,
    external_name: i.external_name,
    description: i.description,
    status: i.status,
    resource_version: i.resource_version,
    updated_at: unix(i.updated_at),
    item_family_id: i.item_family_id,
    type: i.type,
    is_shippable: i.is_shippable,
    is_giftable: i.is_giftable,
    enabled_for_checkout: i.enabled_for_checkout,
    enabled_in_portal: i.enabled_in_portal,
    item_applicability: i.item_applicability,
    applicable_items: i.item_applicability === "restricted" ? i.applicable_items.map((id) => ({ id })) : undefined,
    metered: i.metered,
    unit: i.unit,
    archived_at: i.archived_at,
    deleted: i.status === "deleted",
    metadata: i.metadata,
    object: "item",
    ...i.custom_fields,
  });
}

export function formatItemPrice(p: ChargebeeItemPrice): Json {
  return compact({
    id: p.cb_id,
    name: p.name,
    item_family_id: p.item_family_id,
    item_id: p.item_id,
    description: p.description,
    status: p.status,
    external_name: p.external_name,
    pricing_model: p.pricing_model,
    price: p.pricing_model === "flat_fee" || p.pricing_model === "per_unit" ? (p.price ?? 0) : undefined,
    period: p.period,
    period_unit: p.period_unit,
    trial_period: p.trial_period,
    trial_period_unit: p.trial_period_unit,
    free_quantity: p.free_quantity,
    resource_version: p.resource_version,
    updated_at: unix(p.updated_at),
    created_at: unix(p.created_at),
    archived_at: p.archived_at,
    invoice_notes: p.invoice_notes,
    is_taxable: p.is_taxable,
    metadata: p.metadata,
    item_type: p.item_type,
    show_description_in_invoices: p.show_description_in_invoices,
    show_description_in_quotes: p.show_description_in_quotes,
    currency_code: p.currency_code,
    tiers: p.tiers.length > 0 ? p.tiers.map((tier) => ({ ...tier, object: "tier" })) : undefined,
    deleted: p.status === "deleted",
    object: "item_price",
    ...p.custom_fields,
  });
}

export function formatCoupon(c: ChargebeeCoupon): Json {
  return compact({
    id: c.cb_id,
    name: c.name,
    invoice_name: c.invoice_name,
    discount_type: c.discount_type,
    discount_percentage: c.discount_type === "percentage" ? c.discount_percentage : undefined,
    discount_amount: c.discount_type === "fixed_amount" ? c.discount_amount : undefined,
    currency_code: c.currency_code,
    duration_type: c.duration_type,
    duration_month: c.duration_month,
    valid_till: c.valid_till,
    max_redemptions: c.max_redemptions,
    status: c.status,
    apply_on: c.apply_on,
    created_at: unix(c.created_at),
    archived_at: c.archived_at,
    resource_version: c.resource_version,
    updated_at: unix(c.updated_at),
    redemptions: c.redemptions,
    object: "coupon",
    item_constraints: c.item_constraints.map((constraint) =>
      compact({
        item_type: constraint.item_type,
        constraint: constraint.constraint,
        item_price_ids: constraint.constraint === "specific" ? constraint.item_price_ids : undefined,
        object: "item_constraint",
      }),
    ),
    meta_data: c.meta_data,
  });
}

export function subscriptionMrr(s: ChargebeeSubscription): number {
  const recurring = s.subscription_items
    .filter((item) => item.item_type !== "charge")
    .reduce((sum, item) => sum + item.amount, 0);
  const months = monthsInPeriod(s.billing_period, s.billing_period_unit);
  return months > 0 ? Math.round(recurring / months) : 0;
}

export function formatSubscription(cs: ChargebeeStore, s: ChargebeeSubscription): Json {
  const dueInvoices = cs.invoices
    .findBy("subscription_id", s.cb_id)
    .filter((invoice) => invoice.status === "payment_due" || invoice.status === "not_paid");
  const totalDues = dueInvoices.reduce((sum, invoice) => sum + invoice.amount_due, 0);
  return compact({
    id: s.cb_id,
    customer_id: s.customer_id,
    status: s.status,
    currency_code: s.currency_code,
    subscription_items: s.subscription_items.map((item) => ({ ...item, object: "subscription_item" })),
    coupons: s.coupons.length > 0 ? s.coupons.map((coupon) => compact({ ...coupon, object: "coupon" })) : undefined,
    billing_period: s.billing_period,
    billing_period_unit: s.billing_period_unit,
    start_date: s.status === "future" ? s.start_date : undefined,
    trial_start: s.trial_start,
    trial_end: s.trial_end,
    current_term_start: s.current_term_start,
    current_term_end: s.current_term_end,
    next_billing_at: s.next_billing_at,
    started_at: s.started_at,
    activated_at: s.activated_at,
    cancelled_at: s.cancelled_at,
    cancel_reason: s.cancel_reason,
    cancel_reason_code: s.cancel_reason_code,
    cancel_schedule_created_at: s.cancel_schedule_created_at,
    pause_date: s.pause_date,
    resume_date: s.resume_date,
    created_at: unix(s.created_at),
    updated_at: unix(s.updated_at),
    has_scheduled_changes: s.scheduled_changes !== null,
    changes_scheduled_at: s.changes_scheduled_at,
    channel: s.channel,
    resource_version: s.resource_version,
    deleted: s.deleted,
    object: "subscription",
    due_invoices_count: dueInvoices.length,
    due_since:
      dueInvoices.length > 0 ? Math.min(...dueInvoices.map((invoice) => invoice.due_date ?? invoice.date)) : undefined,
    total_dues: dueInvoices.length > 0 ? totalDues : undefined,
    mrr: subscriptionMrr(s),
    exchange_rate: 1,
    base_currency_code: s.currency_code,
    auto_collection: s.auto_collection,
    po_number: s.po_number,
    invoice_notes: s.invoice_notes,
    shipping_address: s.shipping_address ? { ...s.shipping_address, object: "shipping_address" } : undefined,
    meta_data: s.meta_data,
    ...s.custom_fields,
  });
}

export function subscriptionRow(cs: ChargebeeStore, s: ChargebeeSubscription): Json {
  const customer = cs.customers.findOneBy("cb_id", s.customer_id);
  const primary = customer ? primaryPaymentSource(cs, customer) : undefined;
  return compact({
    subscription: formatSubscription(cs, s),
    customer: customer ? formatCustomer(cs, customer) : undefined,
    card: primary ? formatCard(primary) : undefined,
  });
}

export function formatLineItem(li: InvoiceLineItem): Json {
  return compact({
    id: li.id,
    date_from: li.date_from,
    date_to: li.date_to,
    unit_amount: li.unit_amount,
    quantity: li.quantity,
    amount: li.amount,
    pricing_model: li.pricing_model,
    is_taxed: li.is_taxed,
    tax_amount: li.tax_amount,
    object: "line_item",
    subscription_id: li.subscription_id,
    customer_id: li.customer_id,
    description: li.description,
    entity_type: li.entity_type,
    entity_id: li.entity_id,
    metered: li.metered,
    discount_amount: li.discount_amount,
    item_level_discount_amount: li.item_level_discount_amount,
  });
}

export function formatDiscount(d: InvoiceDiscount): Json {
  return compact({
    amount: d.amount,
    description: d.description,
    entity_type: d.entity_type,
    entity_id: d.entity_id,
    object: "discount",
  });
}

function creditNoteSummary(cs: ChargebeeStore, id: string): Json | undefined {
  const cn = cs.creditNotes.findOneBy("cb_id", id);
  if (!cn) return undefined;
  return compact({
    cn_id: cn.cb_id,
    cn_reason_code: cn.reason_code,
    cn_create_reason_code: cn.create_reason_code,
    cn_date: cn.date,
    cn_total: cn.total,
    cn_status: cn.status,
  });
}

export function formatInvoice(cs: ChargebeeStore, inv: ChargebeeInvoice): Json {
  return compact({
    id: inv.cb_id,
    customer_id: inv.customer_id,
    subscription_id: inv.subscription_id,
    recurring: inv.recurring,
    status: inv.status,
    price_type: "tax_exclusive",
    date: inv.date,
    due_date: inv.due_date,
    net_term_days: inv.net_term_days,
    exchange_rate: 1,
    total: inv.total,
    amount_paid: inv.amount_paid,
    amount_adjusted: inv.amount_adjusted,
    write_off_amount: inv.write_off_amount,
    credits_applied: inv.credits_applied,
    amount_due: inv.amount_due,
    paid_at: inv.paid_at,
    voided_at: inv.voided_at,
    void_reason_code: inv.void_reason_code,
    dunning_status: inv.dunning_status,
    updated_at: unix(inv.updated_at),
    resource_version: inv.resource_version,
    deleted: inv.deleted,
    object: "invoice",
    first_invoice: inv.first_invoice,
    amount_to_collect: inv.status === "voided" ? 0 : inv.amount_due,
    round_off_amount: 0,
    new_sales_amount: inv.first_invoice ? inv.total : 0,
    has_advance_charges: false,
    currency_code: inv.currency_code,
    base_currency_code: inv.currency_code,
    generated_at: inv.generated_at,
    is_gifted: false,
    term_finalized: true,
    channel: "web",
    tax: inv.tax,
    line_items: inv.line_items.map(formatLineItem),
    discounts: inv.discounts.length > 0 ? inv.discounts.map(formatDiscount) : undefined,
    taxes: [],
    line_item_taxes: [],
    line_item_discounts: [],
    sub_total: inv.sub_total,
    linked_payments: inv.linked_payments,
    applied_credits: inv.applied_credits,
    adjustment_credit_notes: inv.adjustment_credit_note_ids.map((id) => creditNoteSummary(cs, id)).filter(Boolean),
    issued_credit_notes: inv.issued_credit_note_ids.map((id) => creditNoteSummary(cs, id)).filter(Boolean),
    linked_orders: [],
    dunning_attempts: [],
    notes: inv.notes ? [{ entity_type: "invoice", note: inv.notes }] : undefined,
    billing_address: inv.billing_address ? { ...inv.billing_address, object: "billing_address" } : undefined,
    shipping_address: inv.shipping_address ? { ...inv.shipping_address, object: "shipping_address" } : undefined,
    po_number: inv.po_number,
    vat_number: inv.vat_number,
  });
}

export function formatTransaction(t: ChargebeeTransaction): Json {
  return compact({
    id: t.cb_id,
    customer_id: t.customer_id,
    subscription_id: t.subscription_id,
    gateway_account_id: t.gateway_account_id,
    payment_source_id: t.payment_source_id,
    payment_method: t.payment_method,
    gateway: t.gateway,
    type: t.type,
    date: t.date,
    settled_at: t.status === "success" ? t.date : undefined,
    exchange_rate: 1,
    amount: t.amount,
    id_at_gateway: t.id_at_gateway,
    status: t.status,
    error_code: t.error_code,
    error_text: t.error_text,
    updated_at: unix(t.updated_at),
    resource_version: t.resource_version,
    deleted: t.deleted,
    object: "transaction",
    masked_card_number: t.masked_card_number,
    reference_number: t.reference_number,
    refunded_txn_id: t.refunded_txn_id,
    currency_code: t.currency_code,
    base_currency_code: t.currency_code,
    amount_unused: t.amount_unused,
    linked_invoices: t.linked_invoices,
    linked_credit_notes: t.linked_credit_notes,
    linked_refunds: [],
  });
}

export function formatPaymentSource(ps: ChargebeePaymentSource): Json {
  return compact({
    id: ps.cb_id,
    updated_at: unix(ps.updated_at),
    resource_version: ps.resource_version,
    deleted: ps.deleted,
    object: "payment_source",
    customer_id: ps.customer_id,
    type: ps.type,
    reference_id: ps.reference_id,
    status: ps.status,
    gateway: ps.gateway,
    gateway_account_id: ps.gateway_account_id,
    issuing_country: ps.issuing_country,
    created_at: unix(ps.created_at),
    card: ps.card ? { ...ps.card, object: "card" } : undefined,
  });
}

export function hostedPageUrl(baseUrl: string, hp: ChargebeeHostedPage): string {
  return `${baseUrl}/pages/v3/${hp.cb_id}/`;
}

export function formatHostedPage(cs: ChargebeeStore, hp: ChargebeeHostedPage, baseUrl: string): Json {
  let content: Json | undefined;
  if (hp.content) {
    const customer = hp.content.customer_id ? cs.customers.findOneBy("cb_id", hp.content.customer_id) : undefined;
    const subscription = hp.content.subscription_id
      ? cs.subscriptions.findOneBy("cb_id", hp.content.subscription_id)
      : undefined;
    const invoice = hp.content.invoice_id ? cs.invoices.findOneBy("cb_id", hp.content.invoice_id) : undefined;
    const paymentSource = hp.content.payment_source_id
      ? cs.paymentSources.findOneBy("cb_id", hp.content.payment_source_id)
      : undefined;
    const primary = customer ? primaryPaymentSource(cs, customer) : undefined;
    content = compact({
      customer: customer ? formatCustomer(cs, customer) : undefined,
      subscription: subscription ? formatSubscription(cs, subscription) : undefined,
      invoice: invoice ? formatInvoice(cs, invoice) : undefined,
      card: primary ? formatCard(primary) : undefined,
      payment_source: paymentSource ? formatPaymentSource(paymentSource) : undefined,
    });
  }
  return compact({
    id: hp.cb_id,
    type: hp.type,
    url: hostedPageUrl(baseUrl, hp),
    state: hp.state,
    failure_reason: hp.failure_reason,
    pass_thru_content: hp.pass_thru_content,
    embed: hp.embed,
    created_at: unix(hp.created_at),
    expires_at: hp.expires_at,
    content,
    updated_at: unix(hp.updated_at),
    resource_version: hp.resource_version,
    object: "hosted_page",
  });
}

export function portalAccessUrl(baseUrl: string, ps: ChargebeePortalSession): string {
  return `${baseUrl}/portal/v2/authenticate?token=${encodeURIComponent(ps.token)}`;
}

export function formatPortalSession(cs: ChargebeeStore, ps: ChargebeePortalSession, baseUrl: string): Json {
  const customer = cs.customers.findOneBy("cb_id", ps.customer_id);
  const linked = customer
    ? [
        {
          customer_id: customer.cb_id,
          email: customer.email ?? undefined,
          has_billing_address: customer.billing_address !== null,
          has_payment_method: primaryPaymentSource(cs, customer) !== undefined,
          has_active_subscription: cs.subscriptions
            .findBy("customer_id", customer.cb_id)
            .some((sub) => sub.status === "active" || sub.status === "in_trial" || sub.status === "non_renewing"),
          object: "linked_customer",
        },
      ]
    : [];
  return compact({
    id: ps.cb_id,
    token: ps.token,
    access_url: portalAccessUrl(baseUrl, ps),
    redirect_url: ps.redirect_url,
    status: ps.status,
    created_at: unix(ps.created_at),
    expires_at: ps.expires_at,
    login_at: ps.login_at,
    logout_at: ps.logout_at,
    customer_id: ps.customer_id,
    resource_version: ps.resource_version,
    object: "portal_session",
    linked_customers: linked.map((item) => compact(item)),
  });
}

export function formatEvent(e: ChargebeeEvent): Json {
  return compact({
    id: e.cb_id,
    occurred_at: e.occurred_at,
    source: e.source,
    user: e.user,
    object: "event",
    api_version: "v2",
    content: e.content,
    event_type: e.event_type,
    webhook_status: e.webhook_status,
    webhooks: e.webhooks.length > 0 ? e.webhooks.map((hook) => ({ ...hook, object: "webhook" })) : undefined,
  });
}

export function formatCreditNote(cn: ChargebeeCreditNote): Json {
  return compact({
    id: cn.cb_id,
    customer_id: cn.customer_id,
    subscription_id: cn.subscription_id,
    reference_invoice_id: cn.reference_invoice_id,
    type: cn.type,
    reason_code: cn.reason_code,
    create_reason_code: cn.create_reason_code,
    status: cn.status,
    date: cn.date,
    price_type: "tax_exclusive",
    exchange_rate: 1,
    total: cn.total,
    amount_allocated: cn.amount_allocated,
    amount_refunded: cn.amount_refunded,
    amount_available: cn.amount_available,
    generated_at: cn.generated_at,
    voided_at: cn.voided_at,
    updated_at: unix(cn.updated_at),
    channel: "web",
    resource_version: cn.resource_version,
    deleted: cn.deleted,
    object: "credit_note",
    sub_total: cn.sub_total,
    round_off_amount: 0,
    fractional_correction: 0,
    currency_code: cn.currency_code,
    base_currency_code: cn.currency_code,
    line_items: cn.line_items.map(formatLineItem),
    discounts: [],
    taxes: [],
    line_item_taxes: [],
    line_item_discounts: [],
    linked_refunds: cn.linked_refunds,
    allocations: cn.allocations,
    customer_notes: cn.customer_notes,
  });
}

export function formatTimeMachine(cs: ChargebeeStore, status: "succeeded" | "in_progress" = "succeeded"): Json {
  return {
    name: TIME_MACHINE_ID,
    time_travel_status: status,
    genesis_time: genesisTime(cs),
    destination_time: nowSeconds(cs),
    object: "time_machine",
  };
}
