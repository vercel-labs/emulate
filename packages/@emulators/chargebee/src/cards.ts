import type { CardDetails, ChargebeeCustomer, ChargebeePaymentSource, EventSource } from "./entities.js";
import type { ChargebeeCtx } from "./events.js";
import { customerRow, formatCard, formatPaymentSource } from "./formatters.js";
import { paramError } from "./helpers.js";
import { prefixedId } from "./ids.js";
import { resourceVersion } from "./store.js";

export const DEFAULT_TEST_CARD_NUMBER = "4111111111111111";
export const DECLINED_TEST_CARD_NUMBER = "4000000000000002";
export const TEST_GATEWAY_ACCOUNT_ID = "gw_emulate_test";

export interface CardInput {
  number?: string;
  expiry_month?: number;
  expiry_year?: number;
  first_name?: string | null;
  last_name?: string | null;
}

function brandFor(number: string): string {
  if (number.startsWith("4")) return "visa";
  if (/^5[1-5]/.test(number) || /^2[2-7]/.test(number)) return "mastercard";
  if (/^3[47]/.test(number)) return "american_express";
  if (number.startsWith("6")) return "discover";
  return "other";
}

export function cardDetails(input: CardInput): CardDetails {
  const number = (input.number ?? DEFAULT_TEST_CARD_NUMBER).replace(/\s|-/g, "");
  if (!/^\d{12,19}$/.test(number)) throw paramError("card[number]", "is not a valid card number");
  const expiryMonth = input.expiry_month ?? 12;
  const expiryYear = input.expiry_year ?? new Date().getUTCFullYear() + 5;
  if (expiryMonth < 1 || expiryMonth > 12) throw paramError("card[expiry_month]", "must be between 1 and 12");
  return {
    first_name: input.first_name ?? null,
    last_name: input.last_name ?? null,
    iin: number.slice(0, 6),
    last4: number.slice(-4),
    brand: brandFor(number),
    funding_type: "credit",
    expiry_month: expiryMonth,
    expiry_year: expiryYear,
    masked_number: `${"*".repeat(number.length - 4)}${number.slice(-4)}`,
  };
}

export interface AddCardOptions {
  replacePrimary?: boolean;
  referenceId?: string;
  source?: EventSource;
}

export async function addCardPaymentSource(
  ctx: ChargebeeCtx,
  customer: ChargebeeCustomer,
  input: CardInput,
  options: AddCardOptions = {},
): Promise<ChargebeePaymentSource> {
  const { cs } = ctx;
  const card = cardDetails(input);
  const paymentSource = cs.paymentSources.insert({
    cb_id: prefixedId("pm"),
    customer_id: customer.cb_id,
    type: "card",
    reference_id: options.referenceId ?? prefixedId("tok"),
    status: "valid",
    gateway: "chargebee",
    gateway_account_id: TEST_GATEWAY_ACCOUNT_ID,
    card,
    issuing_country: null,
    resource_version: resourceVersion(cs),
    deleted: false,
  });
  const hasPrimary =
    customer.primary_payment_source_id !== null &&
    cs.paymentSources.findOneBy("cb_id", customer.primary_payment_source_id)?.deleted === false;
  if (options.replacePrimary !== false || !hasPrimary) {
    cs.customers.update(customer.id, {
      primary_payment_source_id: paymentSource.cb_id,
      resource_version: resourceVersion(cs),
    });
  }
  const refreshed = cs.customers.get(customer.id)!;
  await ctx.emit(
    "payment_source_added",
    { payment_source: formatPaymentSource(paymentSource), ...customerRow(cs, refreshed) },
    options.source,
  );
  await ctx.emit(
    "card_added",
    { card: formatCard(paymentSource), customer: customerRow(cs, refreshed).customer },
    options.source,
  );
  return paymentSource;
}

export async function deletePaymentSource(
  ctx: ChargebeeCtx,
  paymentSource: ChargebeePaymentSource,
  source?: EventSource,
): Promise<ChargebeePaymentSource> {
  const { cs } = ctx;
  const deleted = cs.paymentSources.update(paymentSource.id, {
    deleted: true,
    resource_version: resourceVersion(cs),
  })!;
  const customer = cs.customers.findOneBy("cb_id", paymentSource.customer_id);
  if (customer) {
    const updates: Partial<ChargebeeCustomer> = { resource_version: resourceVersion(cs) };
    if (customer.primary_payment_source_id === paymentSource.cb_id) updates.primary_payment_source_id = null;
    if (customer.backup_payment_source_id === paymentSource.cb_id) updates.backup_payment_source_id = null;
    cs.customers.update(customer.id, updates);
  }
  const refreshed = customer ? cs.customers.get(customer.id)! : undefined;
  await ctx.emit(
    "payment_source_deleted",
    { payment_source: formatPaymentSource(deleted), ...(refreshed ? customerRow(cs, refreshed) : {}) },
    source,
  );
  if (deleted.card) {
    await ctx.emit(
      "card_deleted",
      { card: formatCard(deleted), ...(refreshed ? { customer: customerRow(cs, refreshed).customer } : {}) },
      source,
    );
  }
  return deleted;
}
