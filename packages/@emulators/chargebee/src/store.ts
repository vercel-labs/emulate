import { Store, type Collection } from "@emulators/core";
import type {
  ChargebeeApiKey,
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
} from "./entities.js";

export interface ChargebeeStore {
  raw: Store;
  apiKeys: Collection<ChargebeeApiKey>;
  customers: Collection<ChargebeeCustomer>;
  itemFamilies: Collection<ChargebeeItemFamily>;
  items: Collection<ChargebeeItem>;
  itemPrices: Collection<ChargebeeItemPrice>;
  coupons: Collection<ChargebeeCoupon>;
  subscriptions: Collection<ChargebeeSubscription>;
  invoices: Collection<ChargebeeInvoice>;
  transactions: Collection<ChargebeeTransaction>;
  paymentSources: Collection<ChargebeePaymentSource>;
  hostedPages: Collection<ChargebeeHostedPage>;
  portalSessions: Collection<ChargebeePortalSession>;
  events: Collection<ChargebeeEvent>;
  creditNotes: Collection<ChargebeeCreditNote>;
}

export function getChargebeeStore(store: Store): ChargebeeStore {
  return {
    raw: store,
    apiKeys: store.collection<ChargebeeApiKey>("chargebee.api_keys", ["key"]),
    customers: store.collection<ChargebeeCustomer>("chargebee.customers", ["cb_id", "email", "parent_id"]),
    itemFamilies: store.collection<ChargebeeItemFamily>("chargebee.item_families", ["cb_id"]),
    items: store.collection<ChargebeeItem>("chargebee.items", ["cb_id", "item_family_id", "type"]),
    itemPrices: store.collection<ChargebeeItemPrice>("chargebee.item_prices", ["cb_id", "item_id", "item_family_id"]),
    coupons: store.collection<ChargebeeCoupon>("chargebee.coupons", ["cb_id"]),
    subscriptions: store.collection<ChargebeeSubscription>("chargebee.subscriptions", [
      "cb_id",
      "customer_id",
      "status",
    ]),
    invoices: store.collection<ChargebeeInvoice>("chargebee.invoices", ["cb_id", "customer_id", "subscription_id"]),
    transactions: store.collection<ChargebeeTransaction>("chargebee.transactions", [
      "cb_id",
      "customer_id",
      "subscription_id",
    ]),
    paymentSources: store.collection<ChargebeePaymentSource>("chargebee.payment_sources", ["cb_id", "customer_id"]),
    hostedPages: store.collection<ChargebeeHostedPage>("chargebee.hosted_pages", ["cb_id"]),
    portalSessions: store.collection<ChargebeePortalSession>("chargebee.portal_sessions", ["cb_id", "token"]),
    events: store.collection<ChargebeeEvent>("chargebee.events", ["cb_id", "event_type"]),
    creditNotes: store.collection<ChargebeeCreditNote>("chargebee.credit_notes", [
      "cb_id",
      "customer_id",
      "reference_invoice_id",
    ]),
  };
}

const CLOCK_OFFSET_KEY = "chargebee.clock_offset_seconds";
const GENESIS_KEY = "chargebee.genesis_time";
const SITE_KEY = "chargebee.site";
const SEQUENCE_PREFIX = "chargebee.sequence.";

export function nowSeconds(cs: ChargebeeStore): number {
  const offset = cs.raw.getData<number>(CLOCK_OFFSET_KEY) ?? 0;
  return Math.floor(Date.now() / 1000) + offset;
}

export function resourceVersion(cs: ChargebeeStore): number {
  const offset = cs.raw.getData<number>(CLOCK_OFFSET_KEY) ?? 0;
  return Date.now() + offset * 1000;
}

export function clockOffset(cs: ChargebeeStore): number {
  return cs.raw.getData<number>(CLOCK_OFFSET_KEY) ?? 0;
}

export function setClockTo(cs: ChargebeeStore, destination: number): void {
  cs.raw.setData(CLOCK_OFFSET_KEY, destination - Math.floor(Date.now() / 1000));
}

export function resetClock(cs: ChargebeeStore): void {
  cs.raw.setData(CLOCK_OFFSET_KEY, 0);
}

export function genesisTime(cs: ChargebeeStore): number {
  const existing = cs.raw.getData<number>(GENESIS_KEY);
  if (existing !== undefined) return existing;
  const now = nowSeconds(cs);
  cs.raw.setData(GENESIS_KEY, now);
  return now;
}

export function setGenesisTime(cs: ChargebeeStore, value: number): void {
  cs.raw.setData(GENESIS_KEY, value);
}

export function siteName(cs: ChargebeeStore): string {
  return cs.raw.getData<string>(SITE_KEY) ?? "emulate-test";
}

export function setSiteName(cs: ChargebeeStore, value: string): void {
  cs.raw.setData(SITE_KEY, value);
}

export function nextSequence(cs: ChargebeeStore, name: string): number {
  const key = `${SEQUENCE_PREFIX}${name}`;
  const next = (cs.raw.getData<number>(key) ?? 0) + 1;
  cs.raw.setData(key, next);
  return next;
}

export function clearSiteData(cs: ChargebeeStore): void {
  cs.customers.clear();
  cs.itemFamilies.clear();
  cs.items.clear();
  cs.itemPrices.clear();
  cs.coupons.clear();
  cs.subscriptions.clear();
  cs.invoices.clear();
  cs.transactions.clear();
  cs.paymentSources.clear();
  cs.hostedPages.clear();
  cs.portalSessions.clear();
  cs.events.clear();
  cs.creditNotes.clear();
}
