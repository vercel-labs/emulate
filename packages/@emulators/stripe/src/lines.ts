import type { StripeStore } from "./store.js";
import { priceBreakdown } from "./pricing.js";
import type { LineFields } from "./invoicing.js";
import type { PriceInterval, StripePrice, StripeSubscription, StripeSubscriptionItem } from "./entities.js";

const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

const CURRENCY_SYMBOLS: Record<string, string> = { usd: "$", eur: "€", gbp: "£", jpy: "¥" };

/** An amount in the smallest currency unit as an invoice line shows it, such as `$20.00`. */
export function formatMoney(amountDecimal: string, currency: string): string {
  const exponent = ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
  const major = Number(amountDecimal) / 10 ** exponent;
  let text = major.toFixed(exponent);
  if (Number(text) !== major) text = String(Number(major.toFixed(12)));
  const symbol = Object.hasOwn(CURRENCY_SYMBOLS, currency) ? CURRENCY_SYMBOLS[currency] : undefined;
  return symbol ? `${symbol}${text}` : `${currency.toUpperCase()} ${text}`;
}

/** How a price's billing interval reads after its amount: `/ month`, or `every 3 months`. */
export function intervalText(interval: PriceInterval, count: number): string {
  return count === 1 ? `/ ${interval}` : `every ${count} ${interval}s`;
}

export function productName(ss: StripeStore, price: StripePrice): string {
  return ss.products.findOneBy("stripe_id", price.product_id)?.name ?? price.stripe_id;
}

/**
 * The invoice lines that bill `quantity` units of a subscription item's recurring price for
 * `period`. Per-unit prices give one line and tiered prices one line per tier reached, plus
 * one for each flat fee. `metered` marks lines billed in arrears from meter usage.
 */
export function priceLines(
  ss: StripeStore,
  sub: Pick<StripeSubscription, "stripe_id" | "currency">,
  item: StripeSubscriptionItem,
  price: StripePrice,
  quantity: number,
  period: { start: number; end: number },
  metered = false,
): LineFields[] {
  const recurring = price.recurring!;
  const name = productName(ss, price);
  const every = intervalText(recurring.interval, recurring.interval_count);
  const base = {
    currency: sub.currency,
    discountable: true,
    metadata: {},
    period: { ...period },
    price_id: price.stripe_id,
    product_id: price.product_id,
    proration: false,
    subscription_item_id: item.stripe_id,
    subscription_id: sub.stripe_id,
    ...(metered && { metered: true }),
  };
  if (price.billing_scheme !== "tiered") {
    const [part] = priceBreakdown(price, quantity);
    return [
      {
        ...base,
        amount: part.amount,
        description: `${quantity} × ${name} (at ${formatMoney(part.unit_amount_decimal, sub.currency)} ${every})`,
        unit_amount_decimal: part.unit_amount_decimal,
        quantity,
      },
    ];
  }
  return priceBreakdown(price, quantity).map((part) => {
    const tier = (part.tier ?? 0) + 1;
    return {
      ...base,
      amount: part.amount,
      description:
        part.kind === "flat"
          ? `${name} (Tier ${tier} flat fee)`
          : `${part.quantity} × ${name} (Tier ${tier} at ${formatMoney(part.unit_amount_decimal, sub.currency)} ${every})`,
      unit_amount_decimal: part.unit_amount_decimal,
      quantity: part.quantity,
    };
  });
}
