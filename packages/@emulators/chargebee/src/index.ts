import type { Hono } from "@emulators/core";
import type { AppEnv, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import {
  applyCoupons,
  buildInvoice,
  linesForItems,
  planItemPrice,
  resolveCoupons,
  resolveItems,
  type ItemRequest,
} from "./billing.js";
import { DECLINED_TEST_CARD_NUMBER, DEFAULT_TEST_CARD_NUMBER, TEST_GATEWAY_ACCOUNT_ID, cardDetails } from "./cards.js";
import type {
  Address,
  AutoCollection,
  ChargebeeInvoice,
  ChargebeePaymentSource,
  CouponItemConstraint,
  CustomFields,
  ItemType,
  PeriodUnit,
  PriceTier,
  PricingModel,
  SubscriptionCoupon,
  SubscriptionItem,
  SubscriptionStatus,
  TrialPeriodUnit,
} from "./entities.js";
import { WEBHOOK_OWNER, chargebeeWebhookHeaders, createEmitter, type ChargebeeCtx } from "./events.js";
import { addPeriod } from "./helpers.js";
import { chargebeeId, prefixedId } from "./ids.js";
import { catalogRoutes } from "./routes/catalog.js";
import { couponRoutes } from "./routes/coupons.js";
import { creditNoteRoutes } from "./routes/credit-notes.js";
import { customerRoutes } from "./routes/customers.js";
import { estimateRoutes } from "./routes/estimates.js";
import { eventRoutes } from "./routes/events.js";
import { hostedPageRoutes } from "./routes/hosted-pages.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { invoiceRoutes } from "./routes/invoices.js";
import { paymentSourceRoutes } from "./routes/payment-sources.js";
import { portalSessionRoutes } from "./routes/portal-sessions.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";
import { timeMachineRoutes } from "./routes/time-machines.js";
import { transactionRoutes } from "./routes/transactions.js";
import type { ChargebeeRouteContext } from "./route-utils.js";
import {
  genesisTime,
  getChargebeeStore,
  nowSeconds,
  resourceVersion,
  setSiteName,
  type ChargebeeStore,
} from "./store.js";

export { getChargebeeStore, nowSeconds, type ChargebeeStore } from "./store.js";
export * from "./entities.js";
export { DEFAULT_TEST_CARD_NUMBER, DECLINED_TEST_CARD_NUMBER } from "./cards.js";

type SeedCustomFields = Record<`cf_${string}`, string>;
type SeedTimestamp = number | string;

export interface ChargebeeSeedConfig {
  port?: number;
  baseUrl?: string;
  site?: string;
  api_keys?: Array<{ key: string; name?: string }>;
  item_families?: Array<{ id?: string; name: string; description?: string }>;
  items?: Array<
    {
      id?: string;
      name: string;
      type?: ItemType;
      item_family?: string;
      description?: string;
      external_name?: string;
      enabled_for_checkout?: boolean;
      enabled_in_portal?: boolean;
      metered?: boolean;
      unit?: string;
      metadata?: Record<string, unknown>;
    } & SeedCustomFields
  >;
  item_prices?: Array<
    {
      id?: string;
      name?: string;
      external_name?: string;
      description?: string;
      item: string;
      pricing_model?: PricingModel;
      price?: number;
      currency_code?: string;
      period?: number;
      period_unit?: PeriodUnit;
      trial_period?: number;
      trial_period_unit?: TrialPeriodUnit;
      free_quantity?: number;
      tiers?: PriceTier[];
      metadata?: Record<string, unknown>;
    } & SeedCustomFields
  >;
  coupons?: Array<{
    id?: string;
    name: string;
    invoice_name?: string;
    discount_type: "fixed_amount" | "percentage";
    discount_amount?: number;
    discount_percentage?: number;
    currency_code?: string;
    duration_type?: "one_time" | "forever" | "limited_period";
    duration_month?: number;
    apply_on?: "invoice_amount" | "each_specified_item";
    item_constraints?: CouponItemConstraint[];
    max_redemptions?: number;
  }>;
  customers?: Array<
    {
      id?: string;
      first_name?: string;
      last_name?: string;
      email?: string;
      company?: string;
      phone?: string;
      locale?: string;
      auto_collection?: AutoCollection;
      net_term_days?: number;
      preferred_currency_code?: string;
      vat_number?: string;
      billing_address?: Address;
      meta_data?: Record<string, unknown>;
      parent_id?: string;
      card?: { number?: string; expiry_month?: number; expiry_year?: number; first_name?: string; last_name?: string };
    } & SeedCustomFields
  >;
  subscriptions?: Array<
    {
      id?: string;
      customer: string;
      items: Array<{ item_price: string; quantity?: number; unit_price?: number }>;
      status?: SubscriptionStatus;
      trial_end?: SeedTimestamp;
      start_date?: SeedTimestamp;
      current_term_start?: SeedTimestamp;
      current_term_end?: SeedTimestamp;
      coupons?: string[];
      auto_collection?: AutoCollection;
      po_number?: string;
      invoice_notes?: string;
      meta_data?: Record<string, unknown>;
      create_invoice?: boolean;
    } & SeedCustomFields
  >;
  webhooks?: Array<{
    url: string;
    events?: string[];
    username?: string;
    password?: string;
  }>;
}

export const DEFAULT_SITE = "emulate-test";
export const DEFAULT_API_KEY = "test_emulate_chargebee_api_key";
export const DEFAULT_ITEM_FAMILY_ID = "local-products";
export const DEFAULT_PLAN_ITEM_ID = "pro-plan";
export const DEFAULT_PLAN_MONTHLY_PRICE_ID = "pro-plan-USD-Monthly";
export const DEFAULT_PLAN_YEARLY_PRICE_ID = "pro-plan-USD-Yearly";
export const DEFAULT_ADDON_ITEM_ID = "extra-seats";
export const DEFAULT_ADDON_PRICE_ID = "extra-seats-USD-Monthly";
export const DEFAULT_CHARGE_ITEM_ID = "setup-fee";
export const DEFAULT_CHARGE_PRICE_ID = "setup-fee-USD";
export const DEFAULT_COUPON_ID = "WELCOME10";
export const DEFAULT_CUSTOMER_ID = "local-customer";
export const DEFAULT_SUBSCRIPTION_ID = "local-subscription";

export const DEFAULT_SEED: ChargebeeSeedConfig = {
  site: DEFAULT_SITE,
  api_keys: [{ key: DEFAULT_API_KEY, name: "Local API Key" }],
  item_families: [{ id: DEFAULT_ITEM_FAMILY_ID, name: "Local Products" }],
  items: [
    { id: DEFAULT_PLAN_ITEM_ID, name: "Pro Plan", type: "plan", item_family: DEFAULT_ITEM_FAMILY_ID },
    { id: DEFAULT_ADDON_ITEM_ID, name: "Extra Seats", type: "addon", item_family: DEFAULT_ITEM_FAMILY_ID },
    { id: DEFAULT_CHARGE_ITEM_ID, name: "Setup Fee", type: "charge", item_family: DEFAULT_ITEM_FAMILY_ID },
  ],
  item_prices: [
    {
      id: DEFAULT_PLAN_MONTHLY_PRICE_ID,
      item: DEFAULT_PLAN_ITEM_ID,
      name: "Pro Plan USD Monthly",
      pricing_model: "flat_fee",
      price: 2000,
      currency_code: "USD",
      period: 1,
      period_unit: "month",
    },
    {
      id: DEFAULT_PLAN_YEARLY_PRICE_ID,
      item: DEFAULT_PLAN_ITEM_ID,
      name: "Pro Plan USD Yearly",
      pricing_model: "flat_fee",
      price: 20000,
      currency_code: "USD",
      period: 1,
      period_unit: "year",
    },
    {
      id: DEFAULT_ADDON_PRICE_ID,
      item: DEFAULT_ADDON_ITEM_ID,
      name: "Extra Seats USD Monthly",
      pricing_model: "per_unit",
      price: 500,
      currency_code: "USD",
      period: 1,
      period_unit: "month",
    },
    {
      id: DEFAULT_CHARGE_PRICE_ID,
      item: DEFAULT_CHARGE_ITEM_ID,
      name: "Setup Fee USD",
      pricing_model: "flat_fee",
      price: 4900,
      currency_code: "USD",
    },
  ],
  coupons: [
    {
      id: DEFAULT_COUPON_ID,
      name: "Welcome 10%",
      discount_type: "percentage",
      discount_percentage: 10,
      duration_type: "one_time",
      apply_on: "invoice_amount",
    },
  ],
  customers: [
    {
      id: DEFAULT_CUSTOMER_ID,
      first_name: "Test",
      last_name: "Customer",
      email: "test@example.com",
      company: "Example Inc",
      card: { number: DEFAULT_TEST_CARD_NUMBER },
    },
  ],
  subscriptions: [
    {
      id: DEFAULT_SUBSCRIPTION_ID,
      customer: DEFAULT_CUSTOMER_ID,
      items: [{ item_price: DEFAULT_PLAN_MONTHLY_PRICE_ID }],
    },
  ],
};

function toUnix(value: SeedTimestamp | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

function customFieldsOf(entry: Record<string, unknown>): CustomFields {
  const out: CustomFields = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key.startsWith("cf_") && value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function seedCard(
  cs: ChargebeeStore,
  customerId: string,
  card: NonNullable<NonNullable<ChargebeeSeedConfig["customers"]>[number]["card"]>,
): ChargebeePaymentSource {
  return cs.paymentSources.insert({
    cb_id: prefixedId("pm"),
    customer_id: customerId,
    type: "card",
    reference_id: prefixedId("tok"),
    status: "valid",
    gateway: "chargebee",
    gateway_account_id: TEST_GATEWAY_ACCOUNT_ID,
    card: cardDetails({
      number: card.number,
      expiry_month: card.expiry_month,
      expiry_year: card.expiry_year,
      first_name: card.first_name ?? null,
      last_name: card.last_name ?? null,
    }),
    issuing_country: null,
    resource_version: resourceVersion(cs),
    deleted: false,
  });
}

function seedPayment(cs: ChargebeeStore, invoice: ChargebeeInvoice, source: ChargebeePaymentSource): void {
  if (invoice.amount_due <= 0 || source.card?.last4 === DECLINED_TEST_CARD_NUMBER.slice(-4)) return;
  const now = nowSeconds(cs);
  const transaction = cs.transactions.insert({
    cb_id: prefixedId("txn"),
    customer_id: invoice.customer_id,
    subscription_id: invoice.subscription_id,
    payment_source_id: source.cb_id,
    payment_method: "card",
    gateway: "chargebee",
    gateway_account_id: source.gateway_account_id,
    type: "payment",
    date: invoice.date,
    amount: invoice.amount_due,
    status: "success",
    currency_code: invoice.currency_code,
    reference_number: null,
    id_at_gateway: prefixedId("gw", 12),
    error_code: null,
    error_text: null,
    masked_card_number: source.card?.masked_number ?? null,
    refunded_txn_id: null,
    amount_unused: 0,
    linked_invoices: [
      {
        invoice_id: invoice.cb_id,
        applied_amount: invoice.amount_due,
        applied_at: now,
        invoice_date: invoice.date,
        invoice_total: invoice.total,
        invoice_status: "paid",
      },
    ],
    linked_credit_notes: [],
    resource_version: resourceVersion(cs),
    deleted: false,
  });
  cs.invoices.update(invoice.id, {
    status: "paid",
    amount_paid: invoice.amount_due,
    amount_due: 0,
    paid_at: invoice.date,
    linked_payments: [
      {
        txn_id: transaction.cb_id,
        applied_amount: invoice.amount_due,
        applied_at: now,
        txn_status: "success",
        txn_date: invoice.date,
        txn_amount: invoice.amount_due,
      },
    ],
    resource_version: resourceVersion(cs),
  });
}

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: ChargebeeSeedConfig,
  webhooks?: WebhookDispatcher,
): void {
  const cs = getChargebeeStore(store);
  genesisTime(cs);
  if (config.site) setSiteName(cs, config.site);

  for (const key of config.api_keys ?? []) {
    if (!key.key || cs.apiKeys.findOneBy("key", key.key)) continue;
    cs.apiKeys.insert({ key: key.key, name: key.name ?? "API Key" });
  }
  if (cs.apiKeys.count() === 0) {
    cs.apiKeys.insert({ key: DEFAULT_API_KEY, name: "Local API Key" });
  }

  for (const family of config.item_families ?? []) {
    const id = family.id ?? slug(family.name);
    if (cs.itemFamilies.findOneBy("cb_id", id)) continue;
    cs.itemFamilies.insert({
      cb_id: id,
      name: family.name,
      description: family.description ?? null,
      status: "active",
      resource_version: resourceVersion(cs),
    });
  }

  for (const item of config.items ?? []) {
    const id = item.id ?? slug(item.name);
    if (cs.items.findOneBy("cb_id", id)) continue;
    const familyRef = item.item_family ?? cs.itemFamilies.all()[0]?.cb_id ?? DEFAULT_ITEM_FAMILY_ID;
    let family =
      cs.itemFamilies.findOneBy("cb_id", familyRef) ?? cs.itemFamilies.all().find((f) => f.name === familyRef);
    if (!family) {
      family = cs.itemFamilies.insert({
        cb_id: slug(familyRef) || DEFAULT_ITEM_FAMILY_ID,
        name: familyRef,
        description: null,
        status: "active",
        resource_version: resourceVersion(cs),
      });
    }
    cs.items.insert({
      cb_id: id,
      name: item.name,
      external_name: item.external_name ?? null,
      description: item.description ?? null,
      type: item.type ?? "plan",
      item_family_id: family.cb_id,
      status: "active",
      enabled_for_checkout: item.enabled_for_checkout ?? true,
      enabled_in_portal: item.enabled_in_portal ?? true,
      item_applicability: "all",
      applicable_items: [],
      metered: item.metered ?? false,
      unit: item.unit ?? null,
      is_shippable: false,
      is_giftable: false,
      metadata: item.metadata ?? null,
      custom_fields: customFieldsOf(item),
      archived_at: null,
      resource_version: resourceVersion(cs),
    });
  }

  for (const price of config.item_prices ?? []) {
    const item =
      cs.items.findOneBy("cb_id", price.item) ?? cs.items.all().find((candidate) => candidate.name === price.item);
    if (!item) continue;
    const currency = (price.currency_code ?? "USD").toUpperCase();
    const period = item.type === "charge" ? null : (price.period ?? 1);
    const periodUnit = item.type === "charge" ? null : (price.period_unit ?? "month");
    const label = { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" };
    const suffix =
      period !== null && periodUnit !== null
        ? `${currency}-${period === 1 ? label[periodUnit] : `${period}-${label[periodUnit]}`}`
        : currency;
    const id = price.id ?? `${item.cb_id}-${suffix}`;
    if (cs.itemPrices.findOneBy("cb_id", id)) continue;
    const pricingModel = price.pricing_model ?? "flat_fee";
    cs.itemPrices.insert({
      cb_id: id,
      name: price.name ?? `${item.name} ${suffix}`,
      external_name: price.external_name ?? null,
      description: price.description ?? null,
      item_id: item.cb_id,
      item_family_id: item.item_family_id,
      item_type: item.type,
      status: "active",
      pricing_model: pricingModel,
      price: pricingModel === "flat_fee" || pricingModel === "per_unit" ? (price.price ?? 0) : null,
      currency_code: currency,
      period,
      period_unit: periodUnit,
      trial_period: price.trial_period ?? null,
      trial_period_unit: price.trial_period ? (price.trial_period_unit ?? "day") : null,
      free_quantity: price.free_quantity ?? 0,
      tiers: price.tiers ?? [],
      is_taxable: true,
      show_description_in_invoices: false,
      show_description_in_quotes: false,
      invoice_notes: null,
      metadata: price.metadata ?? null,
      custom_fields: customFieldsOf(price),
      archived_at: null,
      resource_version: resourceVersion(cs),
    });
  }

  for (const coupon of config.coupons ?? []) {
    const id = coupon.id ?? slug(coupon.name).toUpperCase();
    if (cs.coupons.findOneBy("cb_id", id)) continue;
    cs.coupons.insert({
      cb_id: id,
      name: coupon.name,
      invoice_name: coupon.invoice_name ?? null,
      discount_type: coupon.discount_type,
      discount_amount: coupon.discount_amount ?? null,
      discount_percentage: coupon.discount_percentage ?? null,
      currency_code: coupon.currency_code?.toUpperCase() ?? null,
      duration_type: coupon.duration_type ?? "forever",
      duration_month: coupon.duration_month ?? null,
      valid_till: null,
      max_redemptions: coupon.max_redemptions ?? null,
      status: "active",
      apply_on: coupon.apply_on ?? "invoice_amount",
      item_constraints: coupon.item_constraints ?? [],
      redemptions: 0,
      meta_data: null,
      archived_at: null,
      resource_version: resourceVersion(cs),
    });
  }

  for (const customer of config.customers ?? []) {
    const id = customer.id ?? chargebeeId();
    if (cs.customers.findOneBy("cb_id", id)) continue;
    if (customer.email && cs.customers.findOneBy("email", customer.email)) continue;
    const created = cs.customers.insert({
      cb_id: id,
      first_name: customer.first_name ?? null,
      last_name: customer.last_name ?? null,
      email: customer.email ?? null,
      company: customer.company ?? null,
      phone: customer.phone ?? null,
      locale: customer.locale ?? null,
      auto_collection: customer.auto_collection ?? "on",
      net_term_days: customer.net_term_days ?? 0,
      allow_direct_debit: false,
      taxability: "taxable",
      preferred_currency_code: customer.preferred_currency_code ?? null,
      billing_address: customer.billing_address ?? null,
      vat_number: customer.vat_number ?? null,
      meta_data: customer.meta_data ?? null,
      custom_fields: customFieldsOf(customer),
      primary_payment_source_id: null,
      backup_payment_source_id: null,
      promotional_credits: 0,
      refundable_credits: 0,
      excess_payments: 0,
      unbilled_charges: 0,
      parent_id: customer.parent_id ?? null,
      payment_owner_id: null,
      invoice_owner_id: null,
      channel: "web",
      resource_version: resourceVersion(cs),
      deleted: false,
    });
    if (customer.card) {
      const source = seedCard(cs, created.cb_id, customer.card);
      cs.customers.update(created.id, { primary_payment_source_id: source.cb_id });
    }
  }

  for (const entry of config.subscriptions ?? []) {
    const id = entry.id ?? chargebeeId();
    if (cs.subscriptions.findOneBy("cb_id", id)) continue;
    const customer = cs.customers.findOneBy("cb_id", entry.customer) ?? cs.customers.findOneBy("email", entry.customer);
    if (!customer) continue;
    const rows: ItemRequest[] = entry.items.map((item) => ({
      item_price_id: item.item_price,
      quantity: item.quantity,
      unit_price: item.unit_price,
    }));
    let items: SubscriptionItem[];
    try {
      items = resolveItems(cs, rows);
    } catch {
      continue;
    }
    const plan = planItemPrice(cs, items);
    const now = nowSeconds(cs);
    const period = plan.period ?? 1;
    const periodUnit = plan.period_unit ?? "month";
    const startDate = toUnix(entry.start_date);
    const trialEnd =
      toUnix(entry.trial_end) ??
      (plan.trial_period && plan.trial_period_unit ? addPeriod(now, plan.trial_period, plan.trial_period_unit) : null);
    const status: SubscriptionStatus =
      entry.status ??
      (startDate !== undefined && startDate > now ? "future" : trialEnd && trialEnd > now ? "in_trial" : "active");
    const termStart = toUnix(entry.current_term_start) ?? now;
    const termEnd = toUnix(entry.current_term_end) ?? addPeriod(termStart, period, periodUnit);
    const inTerm = status === "active" || status === "non_renewing" || status === "paused";
    let coupons: SubscriptionCoupon[];
    try {
      coupons = resolveCoupons(cs, entry.coupons ?? [], termStart);
    } catch {
      coupons = [];
    }
    const source = customer.primary_payment_source_id
      ? cs.paymentSources.findOneBy("cb_id", customer.primary_payment_source_id)
      : undefined;
    const subscription = cs.subscriptions.insert({
      cb_id: id,
      customer_id: customer.cb_id,
      status,
      currency_code: plan.currency_code,
      subscription_items: items,
      coupons,
      billing_period: period,
      billing_period_unit: periodUnit,
      start_date: status === "future" ? (startDate ?? termStart) : null,
      trial_start: status === "in_trial" ? now : null,
      trial_end: status === "in_trial" ? (trialEnd ?? addPeriod(now, 14, "day")) : null,
      current_term_start: inTerm ? termStart : null,
      current_term_end: inTerm ? termEnd : null,
      next_billing_at:
        status === "active" || status === "non_renewing"
          ? termEnd
          : status === "in_trial"
            ? (trialEnd ?? addPeriod(now, 14, "day"))
            : status === "future"
              ? (startDate ?? termStart)
              : null,
      started_at: status === "future" ? null : termStart,
      activated_at: inTerm ? termStart : null,
      cancelled_at: status === "cancelled" ? now : status === "non_renewing" ? termEnd : null,
      cancel_reason: null,
      cancel_reason_code: null,
      cancel_schedule_created_at: status === "non_renewing" ? now : null,
      pause_date: status === "paused" ? now : null,
      resume_date: null,
      auto_collection: entry.auto_collection ?? (source ? null : "off"),
      po_number: entry.po_number ?? null,
      invoice_notes: entry.invoice_notes ?? null,
      shipping_address: null,
      meta_data: entry.meta_data ?? null,
      custom_fields: customFieldsOf(entry),
      scheduled_changes: null,
      changes_scheduled_at: null,
      channel: "web",
      resource_version: resourceVersion(cs),
      deleted: false,
    });
    for (const coupon of coupons) {
      const entity = cs.coupons.findOneBy("cb_id", coupon.coupon_id)!;
      cs.coupons.update(entity.id, { redemptions: entity.redemptions + 1 });
    }
    if (inTerm && entry.create_invoice !== false) {
      const lines = linesForItems(cs, items, customer.cb_id, subscription.cb_id, termStart, termEnd, true);
      const discounts = applyCoupons(
        cs,
        coupons.map((coupon) => coupon.coupon_id),
        lines,
      );
      if (discounts.length > 0) {
        cs.subscriptions.update(subscription.id, {
          coupons: coupons.map((coupon) => ({ ...coupon, applied_count: 1 })),
        });
      }
      const invoice = buildInvoice(cs, {
        customer,
        subscription: cs.subscriptions.get(subscription.id)!,
        lines,
        discounts,
        recurring: true,
        date: termStart,
      });
      if (source && (subscription.auto_collection ?? customer.auto_collection) === "on")
        seedPayment(cs, invoice, source);
    }
  }

  if (config.webhooks && webhooks) {
    webhooks.setHeaderFactory(chargebeeWebhookHeaders);
    for (const webhook of config.webhooks) {
      const secret = webhook.username && webhook.password ? `${webhook.username}:${webhook.password}` : undefined;
      webhooks.register({
        url: webhook.url,
        events: webhook.events && webhook.events.length > 0 ? webhook.events : ["*"],
        active: true,
        secret,
        owner: WEBHOOK_OWNER,
      });
    }
  }
}

function seedDefaults(store: Store, baseUrl: string): void {
  seedFromConfig(store, baseUrl, DEFAULT_SEED);
}

export const chargebeePlugin: ServicePlugin = {
  name: "chargebee",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    webhooks.setHeaderFactory(chargebeeWebhookHeaders);
    const cs = getChargebeeStore(store);
    const ctx: ChargebeeCtx = { cs, baseUrl, emit: createEmitter(cs, webhooks) };
    const rc: ChargebeeRouteContext = { app, cs, ctx, baseUrl, webhooks };
    customerRoutes(rc);
    catalogRoutes(rc);
    couponRoutes(rc);
    subscriptionRoutes(rc);
    invoiceRoutes(rc);
    creditNoteRoutes(rc);
    transactionRoutes(rc);
    paymentSourceRoutes(rc);
    hostedPageRoutes(rc);
    portalSessionRoutes(rc);
    estimateRoutes(rc);
    eventRoutes(rc);
    timeMachineRoutes(rc);
    inspectorRoutes(rc);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default chargebeePlugin;
