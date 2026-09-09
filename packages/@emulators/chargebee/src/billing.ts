import type {
  Address,
  AutoCollection,
  ChargebeeCreditNote,
  ChargebeeCustomer,
  ChargebeeInvoice,
  ChargebeeItemPrice,
  ChargebeePaymentSource,
  ChargebeeSubscription,
  ChargebeeTransaction,
  CreditNoteType,
  CustomFields,
  EventSource,
  InvoiceDiscount,
  InvoiceLineItem,
  MetaData,
  PaymentMethodType,
  SubscriptionCoupon,
  SubscriptionItem,
} from "./entities.js";
import type { ChargebeeCtx } from "./events.js";
import {
  customerRow,
  formatCreditNote,
  formatInvoice,
  formatSubscription,
  formatTransaction,
  primaryPaymentSource,
} from "./formatters.js";
import {
  ChargebeeApiError,
  addPeriod,
  blankParamError,
  duplicateError,
  invalidStateError,
  paramError,
  paymentError,
  roundMoney,
} from "./helpers.js";
import { chargebeeId, prefixedId } from "./ids.js";
import { nextSequence, nowSeconds, resourceVersion, type ChargebeeStore } from "./store.js";

export interface ItemRequest {
  item_price_id: string;
  quantity?: number;
  unit_price?: number;
}

export interface ChargeRequest {
  amount: number;
  description: string;
}

export function priceFor(
  ip: ChargebeeItemPrice,
  requestedQuantity: number | undefined,
  unitPriceOverride?: number,
): { quantity: number; unit_price: number; amount: number } {
  const quantity = ip.pricing_model === "flat_fee" ? 1 : Math.max(0, requestedQuantity ?? 1);
  if (ip.pricing_model === "flat_fee") {
    const unit = unitPriceOverride ?? ip.price ?? 0;
    return { quantity, unit_price: unit, amount: unit };
  }
  if (ip.pricing_model === "per_unit") {
    const unit = unitPriceOverride ?? ip.price ?? 0;
    const billable = Math.max(0, quantity - ip.free_quantity);
    return { quantity, unit_price: unit, amount: roundMoney(unit * billable) };
  }
  const tiers = [...ip.tiers].sort((a, b) => a.starting_unit - b.starting_unit);
  let amount = 0;
  if (ip.pricing_model === "tiered") {
    for (const tier of tiers) {
      const upper = tier.ending_unit ?? Number.POSITIVE_INFINITY;
      const units = Math.max(0, Math.min(quantity, upper) - tier.starting_unit + 1);
      amount += units * tier.price;
    }
  } else {
    const tier =
      tiers.find(
        (candidate) => quantity >= candidate.starting_unit && quantity <= (candidate.ending_unit ?? Infinity),
      ) ?? tiers[tiers.length - 1];
    if (tier) {
      amount = ip.pricing_model === "volume" ? quantity * tier.price : tier.price;
    }
  }
  amount = roundMoney(amount);
  return { quantity, unit_price: quantity > 0 ? roundMoney(amount / quantity) : 0, amount };
}

export function resolveItems(
  cs: ChargebeeStore,
  rows: ItemRequest[],
  param = "subscription_items",
): SubscriptionItem[] {
  if (rows.length === 0) throw blankParamError(`${param}[item_price_id][0]`);
  const items = rows.map((row, index) => {
    if (!row.item_price_id) throw blankParamError(`${param}[item_price_id][${index}]`);
    const ip = cs.itemPrices.findOneBy("cb_id", row.item_price_id);
    if (!ip || ip.status === "deleted") {
      throw paramError(
        `${param}[item_price_id][${index}]`,
        `${row.item_price_id} is not a valid item price id`,
        "resource_not_found",
      );
    }
    if (ip.status === "archived") {
      throw paramError(`${param}[item_price_id][${index}]`, `${row.item_price_id} is archived`, "param_wrong_value");
    }
    const priced = priceFor(ip, row.quantity, row.unit_price);
    return {
      item_price_id: ip.cb_id,
      item_type: ip.item_type,
      quantity: priced.quantity,
      unit_price: priced.unit_price,
      amount: priced.amount,
      free_quantity: ip.free_quantity,
    } satisfies SubscriptionItem;
  });
  const plans = items.filter((item) => item.item_type === "plan");
  if (plans.length !== 1) {
    throw paramError(`${param}[item_price_id]`, "exactly one plan item price is required", "param_wrong_value");
  }
  const currencies = new Set(items.map((item) => cs.itemPrices.findOneBy("cb_id", item.item_price_id)!.currency_code));
  if (currencies.size > 1) {
    throw paramError(`${param}[item_price_id]`, "all item prices must use the same currency", "param_wrong_value");
  }
  return items;
}

export function planItemPrice(cs: ChargebeeStore, items: SubscriptionItem[]): ChargebeeItemPrice {
  const plan = items.find((item) => item.item_type === "plan")!;
  return cs.itemPrices.findOneBy("cb_id", plan.item_price_id)!;
}

function lineDescription(ip: ChargebeeItemPrice | undefined, fallback: string): string {
  return ip?.external_name ?? ip?.name ?? fallback;
}

export function linesForItems(
  cs: ChargebeeStore,
  items: SubscriptionItem[],
  customerId: string,
  subscriptionId: string | null,
  from: number,
  to: number,
  includeCharges: boolean,
): InvoiceLineItem[] {
  const lines: InvoiceLineItem[] = [];
  for (const item of items) {
    if (item.item_type === "charge" && !includeCharges) continue;
    const ip = cs.itemPrices.findOneBy("cb_id", item.item_price_id);
    lines.push({
      id: prefixedId("li"),
      date_from: from,
      date_to: item.item_type === "charge" ? from : to,
      unit_amount: item.unit_price,
      quantity: item.quantity,
      amount: item.amount,
      pricing_model: ip?.pricing_model ?? "flat_fee",
      description: lineDescription(ip, item.item_price_id),
      entity_type: `${item.item_type}_item_price`,
      entity_id: item.item_price_id,
      discount_amount: 0,
      item_level_discount_amount: 0,
      subscription_id: subscriptionId,
      customer_id: customerId,
      metered: ip ? cs.items.findOneBy("cb_id", ip.item_id)?.metered === true : false,
      is_taxed: false,
      tax_amount: 0,
    });
  }
  return lines;
}

export function adhocLines(charges: ChargeRequest[], customerId: string, subscriptionId: string | null, at: number) {
  return charges.map(
    (charge): InvoiceLineItem => ({
      id: prefixedId("li"),
      date_from: at,
      date_to: at,
      unit_amount: charge.amount,
      quantity: 1,
      amount: charge.amount,
      pricing_model: "flat_fee",
      description: charge.description,
      entity_type: "adhoc",
      entity_id: null,
      discount_amount: 0,
      item_level_discount_amount: 0,
      subscription_id: subscriptionId,
      customer_id: customerId,
      metered: false,
      is_taxed: false,
      tax_amount: 0,
    }),
  );
}

export function resolveCoupons(cs: ChargebeeStore, couponIds: string[], at: number): SubscriptionCoupon[] {
  return couponIds.map((couponId, index) => {
    const coupon = cs.coupons.findOneBy("cb_id", couponId);
    if (!coupon || coupon.status === "deleted") {
      throw paramError(`coupon_ids[${index}]`, `${couponId} is not a valid coupon id`, "resource_not_found");
    }
    if (coupon.status !== "active") {
      throw paramError(`coupon_ids[${index}]`, `${couponId} is not active`, "param_wrong_value");
    }
    if (coupon.valid_till !== null && coupon.valid_till < at) {
      throw paramError(`coupon_ids[${index}]`, `${couponId} has expired`, "param_wrong_value");
    }
    return {
      coupon_id: coupon.cb_id,
      apply_till:
        coupon.duration_type === "limited_period" && coupon.duration_month
          ? addPeriod(at, coupon.duration_month, "month")
          : null,
      applied_count: 0,
    };
  });
}

export function applicableCoupons(sub: ChargebeeSubscription, cs: ChargebeeStore, at: number): SubscriptionCoupon[] {
  return sub.coupons.filter((entry) => {
    const coupon = cs.coupons.findOneBy("cb_id", entry.coupon_id);
    if (!coupon) return false;
    if (coupon.duration_type === "one_time") return entry.applied_count === 0;
    if (coupon.duration_type === "limited_period") return entry.apply_till === null || entry.apply_till >= at;
    return true;
  });
}

export function applyCoupons(cs: ChargebeeStore, couponIds: string[], lines: InvoiceLineItem[]): InvoiceDiscount[] {
  const discounts: InvoiceDiscount[] = [];
  let remaining = lines.reduce((sum, line) => sum + line.amount, 0);
  for (const couponId of couponIds) {
    const coupon = cs.coupons.findOneBy("cb_id", couponId);
    if (!coupon || remaining <= 0) continue;
    const targets =
      coupon.apply_on === "each_specified_item"
        ? lines.filter((line) => {
            if (!line.entity_id) return false;
            const constraint = coupon.item_constraints.find(
              (candidate) => `${candidate.item_type}_item_price` === line.entity_type,
            );
            if (!constraint) return coupon.item_constraints.length === 0;
            if (constraint.constraint === "all") return true;
            if (constraint.constraint === "specific") return constraint.item_price_ids.includes(line.entity_id);
            return false;
          })
        : lines;
    const base = targets.reduce((sum, line) => sum + line.amount - line.discount_amount, 0);
    if (base <= 0) continue;
    let amount =
      coupon.discount_type === "percentage"
        ? roundMoney((base * (coupon.discount_percentage ?? 0)) / 100)
        : Math.min(coupon.discount_amount ?? 0, base);
    amount = Math.min(amount, remaining);
    if (amount <= 0) continue;
    if (coupon.apply_on === "each_specified_item") {
      let left = amount;
      targets.forEach((line, index) => {
        const share = index === targets.length - 1 ? left : Math.min(left, roundMoney((amount * line.amount) / base));
        line.discount_amount += share;
        line.item_level_discount_amount += share;
        left -= share;
      });
    }
    remaining -= amount;
    discounts.push({
      amount,
      description: coupon.invoice_name ?? coupon.name,
      entity_type: coupon.apply_on === "each_specified_item" ? "item_level_coupon" : "document_level_coupon",
      entity_id: coupon.cb_id,
    });
  }
  return discounts;
}

export function effectiveAutoCollection(
  customer: ChargebeeCustomer,
  sub?: ChargebeeSubscription | null,
): AutoCollection {
  return sub?.auto_collection ?? customer.auto_collection;
}

export interface InvoiceInput {
  customer: ChargebeeCustomer;
  subscription?: ChargebeeSubscription | null;
  lines: InvoiceLineItem[];
  discounts: InvoiceDiscount[];
  recurring: boolean;
  date: number;
  poNumber?: string | null;
  notes?: string | null;
  currencyCode?: string;
}

export function buildInvoice(cs: ChargebeeStore, input: InvoiceInput): ChargebeeInvoice {
  const now = nowSeconds(cs);
  const subTotal = input.lines.reduce((sum, line) => sum + line.amount, 0);
  const discounts = [...input.discounts];
  let total = Math.max(0, subTotal - discounts.reduce((sum, discount) => sum + discount.amount, 0));
  let creditsApplied = 0;
  if (total > 0 && input.customer.promotional_credits > 0) {
    creditsApplied = Math.min(total, input.customer.promotional_credits);
    total -= creditsApplied;
    discounts.push({
      amount: creditsApplied,
      description: "Promotional Credits",
      entity_type: "promotional_credits",
      entity_id: null,
    });
    cs.customers.update(input.customer.id, {
      promotional_credits: input.customer.promotional_credits - creditsApplied,
      resource_version: resourceVersion(cs),
    });
  }
  const dueDate = input.date + input.customer.net_term_days * 86400;
  const existingForSubscription = input.subscription
    ? cs.invoices.findBy("subscription_id", input.subscription.cb_id).length
    : 0;
  return cs.invoices.insert({
    cb_id: String(nextSequence(cs, "invoice")),
    customer_id: input.customer.cb_id,
    subscription_id: input.subscription?.cb_id ?? null,
    recurring: input.recurring,
    status: total === 0 ? "paid" : dueDate > now ? "posted" : "payment_due",
    date: input.date,
    due_date: dueDate,
    net_term_days: input.customer.net_term_days,
    currency_code:
      input.currencyCode ?? input.subscription?.currency_code ?? input.customer.preferred_currency_code ?? "USD",
    total,
    amount_paid: 0,
    amount_adjusted: 0,
    write_off_amount: 0,
    credits_applied: creditsApplied,
    amount_due: total,
    sub_total: subTotal,
    tax: 0,
    paid_at: total === 0 ? input.date : null,
    voided_at: null,
    void_reason_code: null,
    first_invoice: input.recurring && existingForSubscription === 0,
    line_items: input.lines,
    discounts,
    linked_payments: [],
    applied_credits: [],
    adjustment_credit_note_ids: [],
    issued_credit_note_ids: [],
    billing_address: input.customer.billing_address,
    shipping_address: input.subscription?.shipping_address ?? null,
    po_number: input.poNumber ?? input.subscription?.po_number ?? null,
    notes: input.notes ?? input.subscription?.invoice_notes ?? null,
    vat_number: input.customer.vat_number,
    dunning_status: null,
    generated_at: now,
    resource_version: resourceVersion(cs),
    deleted: false,
  });
}

export function recalculateInvoice(cs: ChargebeeStore, invoice: ChargebeeInvoice): ChargebeeInvoice {
  const now = nowSeconds(cs);
  const amountDue = Math.max(
    0,
    invoice.total - invoice.amount_paid - invoice.amount_adjusted - invoice.write_off_amount,
  );
  let status = invoice.status;
  if (status !== "voided") {
    if (amountDue === 0) status = "paid";
    else if (invoice.write_off_amount > 0) status = "not_paid";
    else if (invoice.dunning_status === "exhausted") status = "not_paid";
    else
      status = (invoice.due_date ?? invoice.date) > now && invoice.dunning_status === null ? "posted" : "payment_due";
  }
  return cs.invoices.update(invoice.id, {
    amount_due: amountDue,
    status,
    paid_at: status === "paid" ? (invoice.paid_at ?? now) : invoice.paid_at,
    resource_version: resourceVersion(cs),
  })!;
}

export function cardDeclines(source: ChargebeePaymentSource | null | undefined): boolean {
  return source?.card?.last4 === "0002";
}

function invoiceContent(cs: ChargebeeStore, invoice: ChargebeeInvoice, transaction?: ChargebeeTransaction) {
  const customer = cs.customers.findOneBy("cb_id", invoice.customer_id);
  const subscription = invoice.subscription_id ? cs.subscriptions.findOneBy("cb_id", invoice.subscription_id) : null;
  const content: Record<string, unknown> = { invoice: formatInvoice(cs, invoice) };
  if (customer) Object.assign(content, customerRow(cs, customer));
  if (subscription) content.subscription = formatSubscription(cs, subscription);
  if (transaction) content.transaction = formatTransaction(transaction);
  return content;
}

export interface CollectOptions {
  paymentSource?: ChargebeePaymentSource | null;
  amount?: number;
  source?: EventSource;
  emitUpdated?: boolean;
}

export type CollectOutcome =
  | { ok: true; invoice: ChargebeeInvoice; transaction: ChargebeeTransaction | null }
  | {
      ok: false;
      reason: "no_payment_source" | "declined";
      invoice: ChargebeeInvoice;
      transaction: ChargebeeTransaction | null;
    };

export async function collectInvoice(
  ctx: ChargebeeCtx,
  invoice: ChargebeeInvoice,
  options: CollectOptions = {},
): Promise<CollectOutcome> {
  const { cs } = ctx;
  if (invoice.amount_due <= 0 || invoice.status === "voided") return { ok: true, invoice, transaction: null };
  const customer = cs.customers.findOneBy("cb_id", invoice.customer_id)!;
  const source = options.paymentSource ?? primaryPaymentSource(cs, customer) ?? null;
  if (!source) return { ok: false, reason: "no_payment_source", invoice, transaction: null };

  const now = nowSeconds(cs);
  const amount = Math.min(options.amount ?? invoice.amount_due, invoice.amount_due);
  const declined = cardDeclines(source);
  const transaction = cs.transactions.insert({
    cb_id: prefixedId("txn"),
    customer_id: customer.cb_id,
    subscription_id: invoice.subscription_id,
    payment_source_id: source.cb_id,
    payment_method: source.type === "card" ? "card" : "other",
    gateway: "chargebee",
    gateway_account_id: source.gateway_account_id,
    type: "payment",
    date: now,
    amount,
    status: declined ? "failure" : "success",
    currency_code: invoice.currency_code,
    reference_number: null,
    id_at_gateway: prefixedId("gw", 12),
    error_code: declined ? "card_declined" : null,
    error_text: declined ? "The card was declined by the test gateway" : null,
    masked_card_number: source.card?.masked_number ?? null,
    refunded_txn_id: null,
    amount_unused: 0,
    linked_invoices: [
      {
        invoice_id: invoice.cb_id,
        applied_amount: declined ? 0 : amount,
        applied_at: now,
        invoice_date: invoice.date,
        invoice_total: invoice.total,
        invoice_status: invoice.status,
      },
    ],
    linked_credit_notes: [],
    resource_version: resourceVersion(cs),
    deleted: false,
  });

  if (declined) {
    const failed = cs.invoices.update(invoice.id, {
      dunning_status: "in_progress",
      status: "payment_due",
      resource_version: resourceVersion(cs),
    })!;
    await ctx.emit("payment_failed", invoiceContent(cs, failed, transaction), options.source);
    return { ok: false, reason: "declined", invoice: failed, transaction };
  }

  const paid = recalculateInvoice(cs, {
    ...invoice,
    amount_paid: invoice.amount_paid + amount,
    dunning_status: invoice.dunning_status === "in_progress" ? "success" : invoice.dunning_status,
  });
  const linked = cs.invoices.update(paid.id, {
    amount_paid: invoice.amount_paid + amount,
    dunning_status: invoice.dunning_status === "in_progress" ? "success" : invoice.dunning_status,
    linked_payments: [
      ...invoice.linked_payments,
      {
        txn_id: transaction.cb_id,
        applied_amount: amount,
        applied_at: now,
        txn_status: "success",
        txn_date: now,
        txn_amount: amount,
      },
    ],
  })!;
  cs.transactions.update(transaction.id, {
    linked_invoices: [{ ...transaction.linked_invoices[0], invoice_status: linked.status }],
  });
  await ctx.emit("payment_succeeded", invoiceContent(cs, linked, transaction), options.source);
  if (options.emitUpdated) await ctx.emit("invoice_updated", invoiceContent(cs, linked), options.source);
  return { ok: true, invoice: linked, transaction };
}

export interface OfflinePaymentInput {
  amount: number;
  paymentMethod: PaymentMethodType;
  referenceNumber?: string | null;
  date?: number;
  source?: EventSource;
}

export async function recordOfflinePayment(
  ctx: ChargebeeCtx,
  invoice: ChargebeeInvoice,
  input: OfflinePaymentInput,
): Promise<{ invoice: ChargebeeInvoice; transaction: ChargebeeTransaction }> {
  const { cs } = ctx;
  const now = nowSeconds(cs);
  const date = input.date ?? now;
  const amount = Math.min(input.amount, invoice.amount_due);
  if (amount <= 0) throw invalidStateError("Invoice has no amount due");
  const transaction = cs.transactions.insert({
    cb_id: prefixedId("txn"),
    customer_id: invoice.customer_id,
    subscription_id: invoice.subscription_id,
    payment_source_id: null,
    payment_method: input.paymentMethod,
    gateway: "not_applicable",
    gateway_account_id: null,
    type: "payment",
    date,
    amount,
    status: "success",
    currency_code: invoice.currency_code,
    reference_number: input.referenceNumber ?? null,
    id_at_gateway: null,
    error_code: null,
    error_text: null,
    masked_card_number: null,
    refunded_txn_id: null,
    amount_unused: 0,
    linked_invoices: [
      {
        invoice_id: invoice.cb_id,
        applied_amount: amount,
        applied_at: now,
        invoice_date: invoice.date,
        invoice_total: invoice.total,
        invoice_status: invoice.status,
      },
    ],
    linked_credit_notes: [],
    resource_version: resourceVersion(cs),
    deleted: false,
  });
  const updated = recalculateInvoice(cs, {
    ...invoice,
    amount_paid: invoice.amount_paid + amount,
    dunning_status: invoice.dunning_status === "in_progress" ? "success" : invoice.dunning_status,
  });
  const linked = cs.invoices.update(updated.id, {
    amount_paid: invoice.amount_paid + amount,
    dunning_status: invoice.dunning_status === "in_progress" ? "success" : invoice.dunning_status,
    linked_payments: [
      ...invoice.linked_payments,
      {
        txn_id: transaction.cb_id,
        applied_amount: amount,
        applied_at: now,
        txn_status: "success",
        txn_date: date,
        txn_amount: amount,
      },
    ],
  })!;
  cs.transactions.update(transaction.id, {
    linked_invoices: [{ ...transaction.linked_invoices[0], invoice_status: linked.status }],
  });
  await ctx.emit("payment_succeeded", invoiceContent(cs, linked, transaction), input.source);
  await ctx.emit("invoice_updated", invoiceContent(cs, linked), input.source);
  return { invoice: linked, transaction };
}

export interface GenerateInvoiceOptions {
  includeCharges: boolean;
  source?: EventSource;
  extraLines?: InvoiceLineItem[];
  extraDiscounts?: InvoiceDiscount[];
}

export async function generateTermInvoice(
  ctx: ChargebeeCtx,
  sub: ChargebeeSubscription,
  from: number,
  to: number,
  options: GenerateInvoiceOptions,
): Promise<{
  subscription: ChargebeeSubscription;
  invoice: ChargebeeInvoice;
  transaction: ChargebeeTransaction | null;
}> {
  const { cs } = ctx;
  const customer = cs.customers.findOneBy("cb_id", sub.customer_id)!;
  const lines = [
    ...linesForItems(cs, sub.subscription_items, customer.cb_id, sub.cb_id, from, to, options.includeCharges),
    ...(options.extraLines ?? []),
  ];
  const coupons = applicableCoupons(sub, cs, from);
  const discounts = [
    ...applyCoupons(
      cs,
      coupons.map((coupon) => coupon.coupon_id),
      lines,
    ),
    ...(options.extraDiscounts ?? []),
  ];
  const appliedIds = new Set(discounts.map((discount) => discount.entity_id));
  const updatedSub = cs.subscriptions.update(sub.id, {
    coupons: sub.coupons.map((coupon) =>
      appliedIds.has(coupon.coupon_id) ? { ...coupon, applied_count: coupon.applied_count + 1 } : coupon,
    ),
    resource_version: resourceVersion(cs),
  })!;
  let invoice = buildInvoice(cs, {
    customer,
    subscription: updatedSub,
    lines,
    discounts,
    recurring: true,
    date: from,
  });
  let transaction: ChargebeeTransaction | null = null;
  if (effectiveAutoCollection(customer, updatedSub) === "on" && invoice.amount_due > 0) {
    const outcome = await collectInvoice(ctx, invoice, { source: options.source });
    invoice = outcome.invoice;
    transaction = outcome.transaction;
    if (outcome.ok) {
      await ctx.emit("invoice_generated", invoiceContent(cs, invoice), options.source);
      return { subscription: updatedSub, invoice, transaction };
    }
  }
  await ctx.emit("invoice_generated", invoiceContent(cs, invoice), options.source);
  return { subscription: updatedSub, invoice, transaction };
}

export interface CreateSubscriptionInput {
  customer: ChargebeeCustomer;
  id?: string;
  items: ItemRequest[];
  couponIds?: string[];
  trialEnd?: number;
  startDate?: number;
  autoCollection?: AutoCollection | null;
  poNumber?: string | null;
  invoiceNotes?: string | null;
  metaData?: MetaData;
  customFields?: CustomFields;
  shippingAddress?: Address | null;
  source?: EventSource;
  invoiceImmediately?: boolean;
}

export interface SubscriptionResult {
  subscription: ChargebeeSubscription;
  invoice?: ChargebeeInvoice;
  transaction?: ChargebeeTransaction | null;
  creditNotes?: ChargebeeCreditNote[];
}

export function subscriptionContent(cs: ChargebeeStore, sub: ChargebeeSubscription): Record<string, unknown> {
  const customer = cs.customers.findOneBy("cb_id", sub.customer_id);
  return {
    subscription: formatSubscription(cs, sub),
    ...(customer ? customerRow(cs, customer) : {}),
  };
}

export async function createSubscription(
  ctx: ChargebeeCtx,
  input: CreateSubscriptionInput,
): Promise<SubscriptionResult> {
  const { cs } = ctx;
  const now = nowSeconds(cs);
  const id = input.id ?? chargebeeId();
  if (cs.subscriptions.findOneBy("cb_id", id)) throw duplicateError("id", id);

  const items = resolveItems(cs, input.items);
  const plan = planItemPrice(cs, items);
  const period = plan.period ?? 1;
  const periodUnit = plan.period_unit ?? "month";
  const start = input.startDate !== undefined && input.startDate > now ? input.startDate : now;

  let trialEnd: number | null = null;
  if (input.trialEnd !== undefined) {
    trialEnd = input.trialEnd > start ? input.trialEnd : null;
  } else if (plan.trial_period && plan.trial_period_unit) {
    trialEnd = addPeriod(start, plan.trial_period, plan.trial_period_unit);
  }

  const status = start > now ? "future" : trialEnd && trialEnd > now ? "in_trial" : "active";
  const coupons = resolveCoupons(cs, input.couponIds ?? [], start);
  const autoCollection = input.autoCollection ?? null;

  const base = {
    cb_id: id,
    customer_id: input.customer.cb_id,
    currency_code: plan.currency_code,
    subscription_items: items,
    coupons,
    billing_period: period,
    billing_period_unit: periodUnit,
    cancelled_at: null,
    cancel_reason: null,
    cancel_reason_code: null,
    cancel_schedule_created_at: null,
    pause_date: null,
    resume_date: null,
    auto_collection: autoCollection,
    po_number: input.poNumber ?? null,
    invoice_notes: input.invoiceNotes ?? null,
    shipping_address: input.shippingAddress ?? null,
    meta_data: input.metaData ?? null,
    custom_fields: input.customFields ?? {},
    scheduled_changes: null,
    changes_scheduled_at: null,
    channel: "web" as const,
    resource_version: resourceVersion(cs),
    deleted: false,
  };

  if (status === "active" && (input.invoiceImmediately ?? true)) {
    const previewLines = linesForItems(
      cs,
      items,
      input.customer.cb_id,
      id,
      start,
      addPeriod(start, period, periodUnit),
      true,
    );
    const previewDiscounts = applyCoupons(
      cs,
      coupons.map((coupon) => coupon.coupon_id),
      previewLines,
    );
    const previewTotal =
      previewLines.reduce((sum, line) => sum + line.amount, 0) -
      previewDiscounts.reduce((sum, discount) => sum + discount.amount, 0) -
      input.customer.promotional_credits;
    if (
      previewTotal > 0 &&
      effectiveAutoCollection(input.customer, { auto_collection: autoCollection } as ChargebeeSubscription) === "on" &&
      !primaryPaymentSource(cs, input.customer)
    ) {
      throw paymentError("Customer does not have a valid payment method", "payment_method_not_present");
    }
  }

  let subscription: ChargebeeSubscription;
  if (status === "future") {
    subscription = cs.subscriptions.insert({
      ...base,
      status,
      start_date: start,
      trial_start: null,
      trial_end: trialEnd,
      current_term_start: null,
      current_term_end: null,
      next_billing_at: start,
      started_at: null,
      activated_at: null,
    });
  } else if (status === "in_trial") {
    subscription = cs.subscriptions.insert({
      ...base,
      status,
      start_date: null,
      trial_start: start,
      trial_end: trialEnd,
      current_term_start: null,
      current_term_end: null,
      next_billing_at: trialEnd,
      started_at: start,
      activated_at: null,
    });
  } else {
    const termEnd = addPeriod(start, period, periodUnit);
    subscription = cs.subscriptions.insert({
      ...base,
      status,
      start_date: null,
      trial_start: null,
      trial_end: null,
      current_term_start: start,
      current_term_end: termEnd,
      next_billing_at: termEnd,
      started_at: start,
      activated_at: start,
    });
  }

  for (const coupon of coupons) {
    const entity = cs.coupons.findOneBy("cb_id", coupon.coupon_id)!;
    cs.coupons.update(entity.id, { redemptions: entity.redemptions + 1, resource_version: resourceVersion(cs) });
  }

  await ctx.emit("subscription_created", subscriptionContent(cs, subscription), input.source);

  if (status !== "active" || input.invoiceImmediately === false) {
    return { subscription };
  }
  const result = await generateTermInvoice(ctx, subscription, start, subscription.current_term_end!, {
    includeCharges: true,
    source: input.source,
  });
  return { subscription: result.subscription, invoice: result.invoice, transaction: result.transaction };
}

export async function renewSubscription(ctx: ChargebeeCtx, sub: ChargebeeSubscription): Promise<ChargebeeSubscription> {
  const { cs } = ctx;
  const now = nowSeconds(cs);
  const source: EventSource = "scheduled_job";

  if (sub.status === "non_renewing") {
    const cancelled = cs.subscriptions.update(sub.id, {
      status: "cancelled",
      cancelled_at: sub.current_term_end ?? sub.trial_end ?? now,
      next_billing_at: null,
      scheduled_changes: null,
      changes_scheduled_at: null,
      resource_version: resourceVersion(cs),
    })!;
    await ctx.emit("subscription_cancelled", subscriptionContent(cs, cancelled), source);
    return cancelled;
  }

  if (sub.status === "future") {
    const start = sub.start_date ?? now;
    if (sub.trial_end && sub.trial_end > start) {
      const started = cs.subscriptions.update(sub.id, {
        status: "in_trial",
        start_date: null,
        trial_start: start,
        started_at: start,
        next_billing_at: sub.trial_end,
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("subscription_started", subscriptionContent(cs, started), source);
      return started;
    }
    const termEnd = addPeriod(start, sub.billing_period, sub.billing_period_unit);
    const started = cs.subscriptions.update(sub.id, {
      status: "active",
      start_date: null,
      started_at: start,
      activated_at: start,
      current_term_start: start,
      current_term_end: termEnd,
      next_billing_at: termEnd,
      resource_version: resourceVersion(cs),
    })!;
    await ctx.emit("subscription_started", subscriptionContent(cs, started), source);
    await ctx.emit("subscription_activated", subscriptionContent(cs, started), source);
    const result = await generateTermInvoice(ctx, started, start, termEnd, { includeCharges: true, source });
    return result.subscription;
  }

  if (sub.status === "in_trial") {
    const start = sub.trial_end ?? now;
    const termEnd = addPeriod(start, sub.billing_period, sub.billing_period_unit);
    const activated = cs.subscriptions.update(sub.id, {
      status: "active",
      activated_at: start,
      current_term_start: start,
      current_term_end: termEnd,
      next_billing_at: termEnd,
      resource_version: resourceVersion(cs),
    })!;
    await ctx.emit("subscription_activated", subscriptionContent(cs, activated), source);
    const result = await generateTermInvoice(ctx, activated, start, termEnd, { includeCharges: true, source });
    return result.subscription;
  }

  if (sub.status !== "active") return sub;

  const start = sub.current_term_end ?? now;
  let items = sub.subscription_items;
  let periodInfo = { period: sub.billing_period, unit: sub.billing_period_unit };
  if (sub.scheduled_changes) {
    items = sub.scheduled_changes.subscription_items;
    const plan = planItemPrice(cs, items);
    periodInfo = { period: plan.period ?? 1, unit: plan.period_unit ?? "month" };
  }
  const termEnd = addPeriod(start, periodInfo.period, periodInfo.unit);
  const renewed = cs.subscriptions.update(sub.id, {
    subscription_items: items,
    billing_period: periodInfo.period,
    billing_period_unit: periodInfo.unit,
    scheduled_changes: null,
    changes_scheduled_at: null,
    current_term_start: start,
    current_term_end: termEnd,
    next_billing_at: termEnd,
    coupons: sub.coupons.filter((coupon) => coupon.apply_till === null || coupon.apply_till >= start),
    resource_version: resourceVersion(cs),
  })!;
  if (sub.scheduled_changes) await ctx.emit("subscription_changed", subscriptionContent(cs, renewed), source);
  await ctx.emit("subscription_renewed", subscriptionContent(cs, renewed), source);
  const result = await generateTermInvoice(ctx, renewed, start, termEnd, { includeCharges: false, source });
  return result.subscription;
}

export async function processDueRenewals(ctx: ChargebeeCtx): Promise<void> {
  const { cs } = ctx;
  const now = nowSeconds(cs);
  for (const original of cs.subscriptions.all()) {
    let sub = original;
    let guard = 0;
    while (sub.next_billing_at !== null && sub.next_billing_at <= now && guard < 240) {
      guard++;
      if (sub.status === "active" && sub.pause_date !== null && sub.pause_date <= now) {
        sub = cs.subscriptions.update(sub.id, {
          status: "paused",
          next_billing_at: null,
          resource_version: resourceVersion(cs),
        })!;
        await ctx.emit("subscription_paused", subscriptionContent(cs, sub), "scheduled_job");
        break;
      }
      const renewed = await renewSubscription(ctx, sub);
      if (renewed.next_billing_at === sub.next_billing_at && renewed.status === sub.status) break;
      sub = renewed;
    }
    if (sub.status === "paused" && sub.resume_date !== null && sub.resume_date <= now) {
      await resumeSubscription(ctx, sub, { option: "immediately", source: "scheduled_job" });
    }
  }
}

export function prorationRatio(sub: ChargebeeSubscription, at: number): number {
  if (sub.current_term_start === null || sub.current_term_end === null) return 0;
  const span = sub.current_term_end - sub.current_term_start;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (sub.current_term_end - at) / span));
}

export interface ProrationOptions {
  prorate: boolean;
  newCharges?: SubscriptionItem[];
  charges?: ChargeRequest[];
}

export function computeProration(
  cs: ChargebeeStore,
  current: ChargebeeSubscription,
  newItems: SubscriptionItem[],
  at: number,
  options: ProrationOptions,
): { lines: InvoiceLineItem[]; credits: number } {
  const ratio = options.prorate ? prorationRatio(current, at) : 0;
  const termEnd = current.current_term_end ?? at;
  const lines: InvoiceLineItem[] = [];
  let credits = 0;

  if (ratio > 0) {
    const oldByPrice = new Map(current.subscription_items.map((item) => [item.item_price_id, item]));
    for (const item of newItems) {
      if (item.item_type === "charge") continue;
      const previous = oldByPrice.get(item.item_price_id);
      const delta = item.amount - (previous?.amount ?? 0);
      if (delta === 0) continue;
      const prorated = roundMoney(delta * ratio);
      if (prorated > 0) {
        const ip = cs.itemPrices.findOneBy("cb_id", item.item_price_id);
        const [line] = linesForItems(cs, [item], current.customer_id, current.cb_id, at, termEnd, false);
        lines.push({
          ...line,
          amount: prorated,
          unit_amount: item.quantity > 0 ? roundMoney(prorated / item.quantity) : prorated,
          description: `${lineDescription(ip, item.item_price_id)} - Prorated Charges`,
        });
      } else {
        credits += -prorated;
      }
    }
    for (const previous of current.subscription_items) {
      if (previous.item_type === "charge") continue;
      if (newItems.some((item) => item.item_price_id === previous.item_price_id)) continue;
      credits += roundMoney(previous.amount * ratio);
    }
  }

  const newCharges = options.newCharges ?? [];
  if (newCharges.length > 0) {
    lines.push(...linesForItems(cs, newCharges, current.customer_id, current.cb_id, at, at, true));
  }
  lines.push(...adhocLines(options.charges ?? [], current.customer_id, current.cb_id, at));
  return { lines, credits };
}

export interface ChangeItemsInput {
  items?: ItemRequest[];
  charges?: ChargeRequest[];
  replaceItemsList?: boolean;
  prorate?: boolean;
  invoiceImmediately?: boolean;
  endOfTerm?: boolean;
  couponIds?: string[];
  replaceCouponList?: boolean;
  updates?: Partial<
    Pick<
      ChargebeeSubscription,
      | "auto_collection"
      | "po_number"
      | "invoice_notes"
      | "shipping_address"
      | "meta_data"
      | "custom_fields"
      | "trial_end"
    >
  >;
  source?: EventSource;
}

export async function changeSubscription(
  ctx: ChargebeeCtx,
  sub: ChargebeeSubscription,
  input: ChangeItemsInput,
): Promise<SubscriptionResult> {
  const { cs } = ctx;
  const now = nowSeconds(cs);
  if (sub.status === "cancelled") throw invalidStateError("Subscription is cancelled");
  const customer = cs.customers.findOneBy("cb_id", sub.customer_id)!;

  let newItems = sub.subscription_items;
  let itemsChanged = false;
  if (input.items && input.items.length > 0) {
    if (input.replaceItemsList) {
      newItems = resolveItems(cs, input.items);
    } else {
      const merged = new Map<string, ItemRequest>();
      for (const item of sub.subscription_items) {
        merged.set(item.item_price_id, {
          item_price_id: item.item_price_id,
          quantity: item.quantity,
          unit_price: item.unit_price,
        });
      }
      for (const row of input.items) {
        const existing = merged.get(row.item_price_id);
        const incomingPlan = cs.itemPrices.findOneBy("cb_id", row.item_price_id)?.item_type === "plan";
        if (incomingPlan) {
          for (const key of merged.keys()) {
            if (cs.itemPrices.findOneBy("cb_id", key)?.item_type === "plan" && key !== row.item_price_id)
              merged.delete(key);
          }
        }
        merged.set(row.item_price_id, {
          item_price_id: row.item_price_id,
          quantity: row.quantity ?? existing?.quantity,
          unit_price: row.unit_price ?? (existing && row.unit_price === undefined ? undefined : row.unit_price),
        });
      }
      newItems = resolveItems(cs, [...merged.values()]);
    }
    itemsChanged = JSON.stringify(newItems) !== JSON.stringify(sub.subscription_items);
  }

  let coupons = sub.coupons;
  if (input.couponIds) {
    const resolved = resolveCoupons(cs, input.couponIds, now);
    coupons = input.replaceCouponList
      ? resolved
      : [...sub.coupons, ...resolved.filter((entry) => !sub.coupons.some((c) => c.coupon_id === entry.coupon_id))];
    for (const entry of resolved) {
      if (sub.coupons.some((existing) => existing.coupon_id === entry.coupon_id)) continue;
      const coupon = cs.coupons.findOneBy("cb_id", entry.coupon_id)!;
      cs.coupons.update(coupon.id, { redemptions: coupon.redemptions + 1, resource_version: resourceVersion(cs) });
    }
  }

  const updates = input.updates ?? {};

  if (input.endOfTerm && itemsChanged && sub.status === "active") {
    const scheduled = cs.subscriptions.update(sub.id, {
      ...updates,
      coupons,
      scheduled_changes: { subscription_items: newItems },
      changes_scheduled_at: sub.current_term_end,
      resource_version: resourceVersion(cs),
    })!;
    await ctx.emit("subscription_changes_scheduled", subscriptionContent(cs, scheduled), input.source);
    return { subscription: scheduled };
  }

  const plan = planItemPrice(cs, newItems);
  const planChanged = plan.cb_id !== planItemPrice(cs, sub.subscription_items).cb_id;
  const changed = cs.subscriptions.update(sub.id, {
    ...updates,
    subscription_items: newItems,
    coupons,
    currency_code: plan.currency_code,
    billing_period: planChanged ? (plan.period ?? 1) : sub.billing_period,
    billing_period_unit: planChanged ? (plan.period_unit ?? "month") : sub.billing_period_unit,
    resource_version: resourceVersion(cs),
  })!;
  await ctx.emit("subscription_changed", subscriptionContent(cs, changed), input.source);

  const charges = input.charges ?? [];
  const newCharges = itemsChanged
    ? newItems.filter(
        (item) =>
          item.item_type === "charge" &&
          !sub.subscription_items.some((old) => old.item_price_id === item.item_price_id),
      )
    : [];
  if (changed.status !== "active" || (!itemsChanged && charges.length === 0)) {
    return { subscription: changed };
  }

  const termStart = changed.current_term_start ?? now;
  const proration = computeProration(cs, { ...changed, subscription_items: sub.subscription_items }, newItems, now, {
    prorate: input.prorate !== false && itemsChanged,
    newCharges,
    charges,
  });
  const allLines = proration.lines;
  const credits = proration.credits;
  const chargeTotal = allLines.reduce((sum, line) => sum + line.amount, 0);

  if (chargeTotal > credits && (input.invoiceImmediately ?? true)) {
    const discounts: InvoiceDiscount[] =
      credits > 0
        ? [{ amount: credits, description: "Prorated Credits", entity_type: "prorated_credits", entity_id: null }]
        : [];
    let invoice = buildInvoice(cs, {
      customer,
      subscription: changed,
      lines: allLines,
      discounts,
      recurring: true,
      date: now,
    });
    let transaction: ChargebeeTransaction | null = null;
    if (effectiveAutoCollection(customer, changed) === "on" && invoice.amount_due > 0) {
      const outcome = await collectInvoice(ctx, invoice, { source: input.source });
      invoice = outcome.invoice;
      transaction = outcome.transaction;
    }
    await ctx.emit("invoice_generated", invoiceContent(cs, invoice), input.source);
    return { subscription: changed, invoice, transaction };
  }

  const leftover = credits - chargeTotal;
  if (leftover > 0) {
    const reference = cs.invoices
      .findBy("subscription_id", changed.cb_id)
      .filter((invoice) => invoice.recurring && invoice.status !== "voided" && invoice.date >= termStart)
      .sort((a, b) => b.id - a.id)[0];
    const creditNote = await createCreditNote(ctx, {
      customer,
      invoice: reference ?? null,
      subscriptionId: changed.cb_id,
      type: reference && reference.amount_due > 0 ? "adjustment" : "refundable",
      reasonCode: "subscription_change",
      createReasonCode: "Subscription Change",
      amount: Math.min(leftover, reference?.total ?? leftover),
      lines: [],
      customerNotes: null,
      source: input.source,
    });
    return { subscription: changed, creditNotes: [creditNote] };
  }
  return { subscription: changed };
}

export interface CancelInput {
  endOfTerm?: boolean;
  cancelAt?: number;
  creditOption?: "none" | "prorate" | "full";
  reasonCode?: string | null;
  source?: EventSource;
}

export async function cancelSubscription(
  ctx: ChargebeeCtx,
  sub: ChargebeeSubscription,
  input: CancelInput,
): Promise<SubscriptionResult> {
  const { cs } = ctx;
  const now = nowSeconds(cs);
  if (sub.status === "cancelled") throw invalidStateError("Subscription is already cancelled");
  const customer = cs.customers.findOneBy("cb_id", sub.customer_id)!;

  const scheduledAt = input.cancelAt !== undefined && input.cancelAt > now ? input.cancelAt : null;
  if (input.endOfTerm || scheduledAt !== null) {
    if (sub.status === "paused") throw invalidStateError("Paused subscriptions cannot be scheduled for cancellation");
    const cancelledAt = scheduledAt ?? sub.current_term_end ?? sub.trial_end ?? sub.start_date ?? now;
    const scheduled = cs.subscriptions.update(sub.id, {
      status: "non_renewing",
      cancelled_at: cancelledAt,
      next_billing_at: cancelledAt,
      cancel_reason_code: input.reasonCode ?? null,
      cancel_schedule_created_at: now,
      scheduled_changes: null,
      changes_scheduled_at: null,
      resource_version: resourceVersion(cs),
    })!;
    await ctx.emit("subscription_cancellation_scheduled", subscriptionContent(cs, scheduled), input.source);
    return { subscription: scheduled };
  }

  const wasActive = sub.status === "active" || sub.status === "non_renewing";
  const cancelled = cs.subscriptions.update(sub.id, {
    status: "cancelled",
    cancelled_at: now,
    cancel_reason: input.reasonCode ? null : "not_paid" === input.reasonCode ? "not_paid" : null,
    cancel_reason_code: input.reasonCode ?? null,
    cancel_schedule_created_at: null,
    current_term_end: wasActive ? now : sub.current_term_end,
    next_billing_at: null,
    pause_date: null,
    resume_date: null,
    scheduled_changes: null,
    changes_scheduled_at: null,
    resource_version: resourceVersion(cs),
  })!;
  await ctx.emit("subscription_cancelled", subscriptionContent(cs, cancelled), input.source);

  const creditNotes: ChargebeeCreditNote[] = [];
  const creditOption = input.creditOption ?? "none";
  if (wasActive && creditOption !== "none") {
    const ratio = prorationRatio(sub, now);
    const invoice = cs.invoices
      .findBy("subscription_id", sub.cb_id)
      .filter(
        (candidate) =>
          candidate.recurring && candidate.status === "paid" && candidate.date >= (sub.current_term_start ?? 0),
      )
      .sort((a, b) => b.id - a.id)[0];
    if (invoice) {
      const recurringTotal = invoice.line_items
        .filter((line) => line.entity_type !== "charge_item_price" && line.entity_type !== "adhoc")
        .reduce((sum, line) => sum + line.amount - line.discount_amount, 0);
      const amount = creditOption === "full" ? recurringTotal : roundMoney(recurringTotal * ratio);
      if (amount > 0) {
        creditNotes.push(
          await createCreditNote(ctx, {
            customer,
            invoice,
            subscriptionId: sub.cb_id,
            type: "refundable",
            reasonCode: "subscription_cancellation",
            createReasonCode: "Subscription Cancellation",
            amount: Math.min(amount, invoice.total),
            lines: [],
            customerNotes: null,
            source: input.source,
          }),
        );
      }
    }
  }
  return { subscription: cancelled, creditNotes };
}

export async function removeScheduledCancellation(
  ctx: ChargebeeCtx,
  sub: ChargebeeSubscription,
  source?: EventSource,
): Promise<ChargebeeSubscription> {
  const { cs } = ctx;
  if (sub.status !== "non_renewing") throw invalidStateError("Subscription has no scheduled cancellation");
  const wasTrial = sub.trial_end !== null && sub.activated_at === null;
  const restored = cs.subscriptions.update(sub.id, {
    status: wasTrial ? "in_trial" : "active",
    cancelled_at: null,
    cancel_schedule_created_at: null,
    cancel_reason_code: null,
    next_billing_at: wasTrial ? sub.trial_end : sub.current_term_end,
    resource_version: resourceVersion(cs),
  })!;
  await ctx.emit("subscription_scheduled_cancellation_removed", subscriptionContent(cs, restored), source);
  return restored;
}

export interface ReactivateInput {
  trialEnd?: number;
  invoiceImmediately?: boolean;
  source?: EventSource;
}

export async function reactivateSubscription(
  ctx: ChargebeeCtx,
  sub: ChargebeeSubscription,
  input: ReactivateInput,
): Promise<SubscriptionResult> {
  const { cs } = ctx;
  const now = nowSeconds(cs);
  if (sub.status === "non_renewing") {
    const restored = await removeScheduledCancellation(ctx, sub, input.source);
    return { subscription: restored };
  }
  if (sub.status !== "cancelled") throw invalidStateError("Subscription is not cancelled");
  const customer = cs.customers.findOneBy("cb_id", sub.customer_id)!;
  if (input.trialEnd !== undefined && input.trialEnd > now) {
    const trial = cs.subscriptions.update(sub.id, {
      status: "in_trial",
      trial_start: now,
      trial_end: input.trialEnd,
      current_term_start: null,
      current_term_end: null,
      next_billing_at: input.trialEnd,
      cancelled_at: null,
      cancel_reason: null,
      cancel_reason_code: null,
      resource_version: resourceVersion(cs),
    })!;
    await ctx.emit("subscription_reactivated", subscriptionContent(cs, trial), input.source);
    return { subscription: trial };
  }
  const termEnd = addPeriod(now, sub.billing_period, sub.billing_period_unit);
  if (
    effectiveAutoCollection(customer, sub) === "on" &&
    !primaryPaymentSource(cs, customer) &&
    sub.subscription_items.some((item) => item.amount > 0)
  ) {
    throw paymentError("Customer does not have a valid payment method", "payment_method_not_present");
  }
  const active = cs.subscriptions.update(sub.id, {
    status: "active",
    activated_at: sub.activated_at ?? now,
    current_term_start: now,
    current_term_end: termEnd,
    next_billing_at: termEnd,
    cancelled_at: null,
    cancel_reason: null,
    cancel_reason_code: null,
    resource_version: resourceVersion(cs),
  })!;
  await ctx.emit("subscription_reactivated", subscriptionContent(cs, active), input.source);
  if (input.invoiceImmediately === false) return { subscription: active };
  const result = await generateTermInvoice(ctx, active, now, termEnd, { includeCharges: false, source: input.source });
  return { subscription: result.subscription, invoice: result.invoice, transaction: result.transaction };
}

export interface PauseInput {
  option: "immediately" | "end_of_term" | "specific_date";
  pauseDate?: number;
  resumeDate?: number;
  source?: EventSource;
}

export async function pauseSubscription(
  ctx: ChargebeeCtx,
  sub: ChargebeeSubscription,
  input: PauseInput,
): Promise<ChargebeeSubscription> {
  const { cs } = ctx;
  const now = nowSeconds(cs);
  if (sub.status !== "active") throw invalidStateError("Only active subscriptions can be paused");
  if (input.option === "immediately") {
    const paused = cs.subscriptions.update(sub.id, {
      status: "paused",
      pause_date: now,
      resume_date: input.resumeDate ?? null,
      next_billing_at: null,
      resource_version: resourceVersion(cs),
    })!;
    await ctx.emit("subscription_paused", subscriptionContent(cs, paused), input.source);
    return paused;
  }
  const pauseDate = input.option === "end_of_term" ? (sub.current_term_end ?? now) : (input.pauseDate ?? now);
  if (pauseDate <= now) {
    return pauseSubscription(ctx, sub, { ...input, option: "immediately" });
  }
  const scheduled = cs.subscriptions.update(sub.id, {
    pause_date: pauseDate,
    resume_date: input.resumeDate ?? null,
    resource_version: resourceVersion(cs),
  })!;
  await ctx.emit("subscription_pause_scheduled", subscriptionContent(cs, scheduled), input.source);
  return scheduled;
}

export interface ResumeInput {
  option: "immediately" | "specific_date";
  resumeDate?: number;
  source?: EventSource;
}

export async function resumeSubscription(
  ctx: ChargebeeCtx,
  sub: ChargebeeSubscription,
  input: ResumeInput,
): Promise<SubscriptionResult> {
  const { cs } = ctx;
  const now = nowSeconds(cs);
  if (sub.status !== "paused") throw invalidStateError("Only paused subscriptions can be resumed");
  if (input.option === "specific_date" && input.resumeDate !== undefined && input.resumeDate > now) {
    const scheduled = cs.subscriptions.update(sub.id, {
      resume_date: input.resumeDate,
      resource_version: resourceVersion(cs),
    })!;
    await ctx.emit("subscription_resumption_scheduled", subscriptionContent(cs, scheduled), input.source);
    return { subscription: scheduled };
  }
  const termEnd = addPeriod(now, sub.billing_period, sub.billing_period_unit);
  const resumed = cs.subscriptions.update(sub.id, {
    status: "active",
    pause_date: null,
    resume_date: null,
    current_term_start: now,
    current_term_end: termEnd,
    next_billing_at: termEnd,
    resource_version: resourceVersion(cs),
  })!;
  await ctx.emit("subscription_resumed", subscriptionContent(cs, resumed), input.source);
  const result = await generateTermInvoice(ctx, resumed, now, termEnd, { includeCharges: false, source: input.source });
  return { subscription: result.subscription, invoice: result.invoice, transaction: result.transaction };
}

export async function changeTermEnd(
  ctx: ChargebeeCtx,
  sub: ChargebeeSubscription,
  termEndsAt: number,
  source?: EventSource,
): Promise<ChargebeeSubscription> {
  const { cs } = ctx;
  const now = nowSeconds(cs);
  if (sub.status !== "active" && sub.status !== "non_renewing") {
    throw invalidStateError("Term end can only be changed for active subscriptions");
  }
  if (termEndsAt <= now) throw paramError("term_ends_at", "must be in the future");
  const changed = cs.subscriptions.update(sub.id, {
    current_term_end: termEndsAt,
    next_billing_at: sub.status === "non_renewing" ? termEndsAt : termEndsAt,
    cancelled_at: sub.status === "non_renewing" ? termEndsAt : sub.cancelled_at,
    resource_version: resourceVersion(cs),
  })!;
  await ctx.emit("subscription_changed", subscriptionContent(cs, changed), source);
  return changed;
}

export interface CreditNoteInput {
  customer: ChargebeeCustomer;
  invoice: ChargebeeInvoice | null;
  subscriptionId: string | null;
  type: CreditNoteType;
  reasonCode: string | null;
  createReasonCode: string | null;
  amount: number;
  lines: InvoiceLineItem[];
  customerNotes: string | null;
  source?: EventSource;
}

export async function createCreditNote(ctx: ChargebeeCtx, input: CreditNoteInput): Promise<ChargebeeCreditNote> {
  const { cs } = ctx;
  const now = nowSeconds(cs);
  if (input.amount <= 0) throw paramError("total", "must be greater than zero");
  const lines =
    input.lines.length > 0
      ? input.lines
      : adhocLines(
          [{ amount: input.amount, description: input.createReasonCode ?? "Credit" }],
          input.customer.cb_id,
          input.subscriptionId,
          now,
        );
  const applyToInvoice = input.type === "adjustment" && input.invoice && input.invoice.amount_due > 0;
  const allocated = applyToInvoice ? Math.min(input.amount, input.invoice!.amount_due) : 0;
  const creditNote = cs.creditNotes.insert({
    cb_id: `CN-${nextSequence(cs, "credit_note")}`,
    customer_id: input.customer.cb_id,
    subscription_id: input.subscriptionId,
    reference_invoice_id: input.invoice?.cb_id ?? null,
    type: input.type,
    reason_code: input.reasonCode,
    create_reason_code: input.createReasonCode,
    status: input.type === "adjustment" ? "adjusted" : "refund_due",
    date: now,
    currency_code: input.invoice?.currency_code ?? input.customer.preferred_currency_code ?? "USD",
    total: input.amount,
    amount_allocated: allocated,
    amount_refunded: 0,
    amount_available: input.type === "adjustment" ? input.amount - allocated : input.amount,
    sub_total: input.amount,
    line_items: lines,
    customer_notes: input.customerNotes,
    voided_at: null,
    generated_at: now,
    allocations: applyToInvoice
      ? [
          {
            invoice_id: input.invoice!.cb_id,
            allocated_amount: allocated,
            allocated_at: now,
            invoice_date: input.invoice!.date,
            invoice_status: input.invoice!.status,
          },
        ]
      : [],
    linked_refunds: [],
    resource_version: resourceVersion(cs),
    deleted: false,
  });

  if (input.invoice) {
    if (applyToInvoice) {
      const adjusted = recalculateInvoice(cs, {
        ...input.invoice,
        amount_adjusted: input.invoice.amount_adjusted + allocated,
      });
      cs.invoices.update(adjusted.id, {
        amount_adjusted: input.invoice.amount_adjusted + allocated,
        adjustment_credit_note_ids: [...input.invoice.adjustment_credit_note_ids, creditNote.cb_id],
      });
    } else {
      cs.invoices.update(input.invoice.id, {
        issued_credit_note_ids: [...input.invoice.issued_credit_note_ids, creditNote.cb_id],
        resource_version: resourceVersion(cs),
      });
    }
  }
  if (input.type === "refundable") {
    cs.customers.update(input.customer.id, {
      refundable_credits: input.customer.refundable_credits + input.amount,
      resource_version: resourceVersion(cs),
    });
  }
  const refreshedCustomer = cs.customers.get(input.customer.id)!;
  const refreshedInvoice = input.invoice ? cs.invoices.get(input.invoice.id) : undefined;
  await ctx.emit(
    "credit_note_created",
    {
      credit_note: formatCreditNote(creditNote),
      ...customerRow(cs, refreshedCustomer),
      ...(refreshedInvoice ? { invoice: formatInvoice(cs, refreshedInvoice) } : {}),
    },
    input.source,
  );
  return creditNote;
}

export interface OneOffInvoiceInput {
  customer: ChargebeeCustomer;
  subscriptionId?: string | null;
  itemPrices: ItemRequest[];
  charges: ChargeRequest[];
  couponIds: string[];
  currencyCode?: string;
  autoCollection?: AutoCollection;
  poNumber?: string | null;
  notes?: string | null;
  source?: EventSource;
}

export async function createOneOffInvoice(
  ctx: ChargebeeCtx,
  input: OneOffInvoiceInput,
): Promise<{ invoice: ChargebeeInvoice; transaction: ChargebeeTransaction | null }> {
  const { cs } = ctx;
  const now = nowSeconds(cs);
  if (input.itemPrices.length === 0 && input.charges.length === 0) {
    throw blankParamError("item_prices[item_price_id][0]");
  }
  const items: SubscriptionItem[] = input.itemPrices.map((row, index) => {
    const ip = cs.itemPrices.findOneBy("cb_id", row.item_price_id);
    if (!ip || ip.status === "deleted") {
      throw paramError(
        `item_prices[item_price_id][${index}]`,
        `${row.item_price_id} is not a valid item price id`,
        "resource_not_found",
      );
    }
    if (ip.item_type !== "charge") {
      throw paramError(`item_prices[item_price_id][${index}]`, "only charge item prices can be invoiced directly");
    }
    const priced = priceFor(ip, row.quantity, row.unit_price);
    return {
      item_price_id: ip.cb_id,
      item_type: ip.item_type,
      quantity: priced.quantity,
      unit_price: priced.unit_price,
      amount: priced.amount,
      free_quantity: ip.free_quantity,
    };
  });
  const subscription = input.subscriptionId ? cs.subscriptions.findOneBy("cb_id", input.subscriptionId) : null;
  const lines = [
    ...linesForItems(cs, items, input.customer.cb_id, subscription?.cb_id ?? null, now, now, true),
    ...adhocLines(input.charges, input.customer.cb_id, subscription?.cb_id ?? null, now),
  ];
  resolveCoupons(cs, input.couponIds, now);
  const discounts = applyCoupons(cs, input.couponIds, lines);
  const currency =
    input.currencyCode ??
    (items[0] ? cs.itemPrices.findOneBy("cb_id", items[0].item_price_id)!.currency_code : undefined) ??
    subscription?.currency_code ??
    input.customer.preferred_currency_code ??
    "USD";
  let invoice = buildInvoice(cs, {
    customer: input.customer,
    subscription,
    lines,
    discounts,
    recurring: false,
    date: now,
    poNumber: input.poNumber,
    notes: input.notes,
    currencyCode: currency,
  });
  let transaction: ChargebeeTransaction | null = null;
  const autoCollection = input.autoCollection ?? effectiveAutoCollection(input.customer, subscription);
  if (autoCollection === "on" && invoice.amount_due > 0) {
    const outcome = await collectInvoice(ctx, invoice, { source: input.source });
    invoice = outcome.invoice;
    transaction = outcome.transaction;
  }
  await ctx.emit("invoice_generated", invoiceContent(cs, invoice), input.source);
  return { invoice, transaction };
}

export function previewInvoice(
  cs: ChargebeeStore,
  customer: ChargebeeCustomer | null,
  lines: InvoiceLineItem[],
  couponIds: string[],
): { lines: InvoiceLineItem[]; discounts: InvoiceDiscount[]; sub_total: number; total: number } {
  const discounts = applyCoupons(cs, couponIds, lines);
  const subTotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const total = Math.max(
    0,
    subTotal - discounts.reduce((sum, discount) => sum + discount.amount, 0) - (customer?.promotional_credits ?? 0),
  );
  return { lines, discounts, sub_total: subTotal, total };
}

export function assertNotDeleted<T extends { deleted: boolean }>(entity: T | undefined): T {
  if (!entity || entity.deleted)
    throw new ChargebeeApiError(404, {
      message: "Sorry, we couldn't find that resource",
      type: "invalid_request",
      api_error_code: "resource_not_found",
    });
  return entity;
}
