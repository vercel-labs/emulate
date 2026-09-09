import type { AppEnv, Context, Handler, Hono, WebhookDispatcher } from "@emulators/core";
import type { ChargeRequest, ItemRequest } from "./billing.js";
import type {
  ChargebeeApiKey,
  ChargebeeCoupon,
  ChargebeeCreditNote,
  ChargebeeCustomer,
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
import type { ChargebeeCtx } from "./events.js";
import { ChargebeeApiError, authenticate, columnar, notFoundError, num, sendApiError, type Body } from "./helpers.js";
import type { ChargebeeStore } from "./store.js";

export interface ChargebeeRouteContext {
  app: Hono<AppEnv>;
  cs: ChargebeeStore;
  ctx: ChargebeeCtx;
  baseUrl: string;
  webhooks: WebhookDispatcher;
}

export type ApiHandler = (c: Context<AppEnv>, key: ChargebeeApiKey) => Promise<Response> | Response;

export function api(cs: ChargebeeStore, handler: ApiHandler): Handler<AppEnv> {
  return async (c) => {
    const key = authenticate(c, cs);
    if (key instanceof Response) return key;
    try {
      return await handler(c, key);
    } catch (error) {
      if (error instanceof ChargebeeApiError) return sendApiError(c, error);
      throw error;
    }
  };
}

export function guard<T>(fn: () => T, c: Context<AppEnv>): T | Response {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ChargebeeApiError) return sendApiError(c, error);
    throw error;
  }
}

function live<T extends object>(entity: T | undefined): T {
  if (!entity || (entity as { deleted?: boolean }).deleted) throw notFoundError();
  return entity;
}

export function findCustomer(cs: ChargebeeStore, id: string): ChargebeeCustomer {
  return live(cs.customers.findOneBy("cb_id", id));
}

export function findSubscription(cs: ChargebeeStore, id: string): ChargebeeSubscription {
  return live(cs.subscriptions.findOneBy("cb_id", id));
}

export function findInvoice(cs: ChargebeeStore, id: string): ChargebeeInvoice {
  return live(cs.invoices.findOneBy("cb_id", id));
}

export function findItemFamily(cs: ChargebeeStore, id: string): ChargebeeItemFamily {
  const family = cs.itemFamilies.findOneBy("cb_id", id);
  if (!family || family.status === "deleted") throw notFoundError();
  return family;
}

export function findItem(cs: ChargebeeStore, id: string): ChargebeeItem {
  const item = cs.items.findOneBy("cb_id", id);
  if (!item || item.status === "deleted") throw notFoundError();
  return item;
}

export function findItemPrice(cs: ChargebeeStore, id: string): ChargebeeItemPrice {
  const price = cs.itemPrices.findOneBy("cb_id", id);
  if (!price || price.status === "deleted") throw notFoundError();
  return price;
}

export function findCoupon(cs: ChargebeeStore, id: string): ChargebeeCoupon {
  const coupon = cs.coupons.findOneBy("cb_id", id);
  if (!coupon || coupon.status === "deleted") throw notFoundError();
  return coupon;
}

export function findPaymentSource(cs: ChargebeeStore, id: string): ChargebeePaymentSource {
  return live(cs.paymentSources.findOneBy("cb_id", id));
}

export function findTransaction(cs: ChargebeeStore, id: string): ChargebeeTransaction {
  return live(cs.transactions.findOneBy("cb_id", id));
}

export function findCreditNote(cs: ChargebeeStore, id: string): ChargebeeCreditNote {
  return live(cs.creditNotes.findOneBy("cb_id", id));
}

export function findHostedPage(cs: ChargebeeStore, id: string): ChargebeeHostedPage {
  return live(cs.hostedPages.findOneBy("cb_id", id));
}

export function findPortalSession(cs: ChargebeeStore, id: string): ChargebeePortalSession {
  return live(cs.portalSessions.findOneBy("cb_id", id));
}

export function parseItemRequests(body: Body, key = "subscription_items"): ItemRequest[] {
  return columnar(body[key])
    .filter((row) => row.item_price_id)
    .map((row) => ({
      item_price_id: row.item_price_id,
      quantity: num(row.quantity),
      unit_price: num(row.unit_price),
    }));
}

export function parseCharges(body: Body): ChargeRequest[] {
  return columnar(body.charges)
    .filter((row) => num(row.amount) !== undefined)
    .map((row) => ({
      amount: num(row.amount)!,
      description: row.description ?? "Charge",
    }));
}

export function nested(body: Body, key: string): Body {
  const value = body[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Body) : {};
}
