import { readBool, readInt, isRecord, readString } from "./helpers.js";
import type {
  PriceInterval,
  StripePrice,
  StripePriceRecurring,
  StripePriceTier,
  StripePriceTransformQuantity,
} from "./entities.js";

/** The Price fields a create request decides. Product, ids and timestamps are the caller's. */
export type PriceDefinition = Pick<
  StripePrice,
  | "currency"
  | "unit_amount"
  | "unit_amount_decimal"
  | "type"
  | "active"
  | "metadata"
  | "billing_scheme"
  | "recurring"
  | "tiers"
  | "tiers_mode"
  | "transform_quantity"
  | "lookup_key"
  | "nickname"
  | "tax_behavior"
>;

/** A rejected price param, rendered by the caller as a 400 `invalid_request_error`. */
export interface PriceParamError {
  message: string;
  param: string;
  code?: string;
}

export interface ReadPriceOptions {
  /** The status of a billing meter, or undefined when none has that id. Without it no meter exists. */
  meterStatus?: (id: string) => "active" | "inactive" | undefined;
}

const INTERVALS: readonly PriceInterval[] = ["day", "week", "month", "year"];

/** Stripe allows at most three years between billings. */
const MAX_INTERVAL_COUNT: Record<PriceInterval, number> = { day: 1095, week: 156, month: 36, year: 3 };

const MAX_LOOKUP_KEY_LENGTH = 200;

/**
 * A non-negative amount in the smallest currency unit as Stripe renders a decimal string:
 * at most 12 decimal places, no leading or trailing zeros. Anything else reads as undefined.
 */
export function normalizeDecimal(value: unknown): string | undefined {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    text = value.toFixed(12);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return undefined;
  }
  const match = /^(\d+)(?:\.(\d{1,12}))?$/.exec(text);
  if (!match) return undefined;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * A quantity rounded to the 12 decimal places Stripe keeps, so sums of decimal usage such as
 * 0.1 + 0.2 do not carry binary floating-point noise.
 */
export function roundQuantity(quantity: number): number {
  return Number(quantity.toFixed(12));
}

/** A non-negative quantity as a decimal string, such as `2.75`, the way `quantity_decimal` shows it. */
export function quantityDecimal(quantity: number): string {
  return normalizeDecimal(quantity) ?? String(quantity);
}

/** The integer form of a decimal amount, or null when it has a fractional part. */
export function wholeAmount(decimal: string | undefined): number | null {
  return decimal !== undefined && /^\d+$/.test(decimal) ? Number(decimal) : null;
}

/**
 * Read one amount given as an integer param or as its `_decimal` twin. Both at once is an
 * error. `paramOf` turns a field name into the param name errors report.
 */
function readAmount(
  source: Record<string, unknown>,
  name: "unit_amount" | "flat_amount",
  paramOf: (field: string) => string = (field) => field,
): { decimal?: string; error?: PriceParamError } {
  const present = (value: unknown) => value !== undefined && value !== "";
  const intValue = source[name];
  const decimalValue = source[`${name}_decimal`];
  if (present(intValue) && present(decimalValue)) {
    return {
      error: {
        message: `You may only specify one of these parameters: ${paramOf(name)}, ${paramOf(`${name}_decimal`)}.`,
        param: paramOf(name),
      },
    };
  }
  if (present(intValue)) {
    const amount = readInt(intValue);
    if (amount === undefined || amount < 0) {
      return { error: { message: `Invalid ${paramOf(name)}: must be a non-negative integer.`, param: paramOf(name) } };
    }
    return { decimal: String(amount) };
  }
  if (present(decimalValue)) {
    const decimal = normalizeDecimal(decimalValue);
    if (decimal === undefined) {
      const param = paramOf(`${name}_decimal`);
      return {
        error: { message: `Invalid ${param}: must be a non-negative decimal with at most 12 decimal places.`, param },
      };
    }
    return { decimal };
  }
  return {};
}

function readRecurring(
  value: unknown,
  options: ReadPriceOptions,
): { recurring?: StripePriceRecurring; error?: PriceParamError } {
  if (value === undefined || value === "") return {};
  if (!isRecord(value)) return { error: { message: "Invalid recurring: must be an object.", param: "recurring" } };
  const interval = value.interval;
  if (interval === undefined || interval === "") {
    return { error: { message: "Missing required param: recurring[interval].", param: "recurring[interval]" } };
  }
  if (typeof interval !== "string" || !(INTERVALS as readonly string[]).includes(interval)) {
    return {
      error: {
        message: "Invalid recurring[interval]: must be one of day, month, week, or year",
        param: "recurring[interval]",
      },
    };
  }
  const unit = interval as PriceInterval;

  let intervalCount = 1;
  if (value.interval_count !== undefined && value.interval_count !== "") {
    const count = readInt(value.interval_count);
    if (count === undefined || count < 1) {
      return {
        error: {
          message: "Invalid recurring[interval_count]: must be at least 1.",
          param: "recurring[interval_count]",
        },
      };
    }
    intervalCount = count;
  }
  if (intervalCount > MAX_INTERVAL_COUNT[unit]) {
    return {
      error: {
        message: "The maximum allowed interval is 3 years (3 years, 36 months, or 156 weeks).",
        param: "recurring[interval_count]",
      },
    };
  }

  const usageType = value.usage_type ?? "licensed";
  if (usageType !== "licensed" && usageType !== "metered") {
    return {
      error: {
        message: "Invalid recurring[usage_type]: must be one of licensed or metered",
        param: "recurring[usage_type]",
      },
    };
  }

  const meter = readString(value.meter);
  if (usageType === "metered") {
    if (!meter) {
      return {
        error: {
          message: "Metered prices must be backed by a meter. Pass recurring[meter].",
          param: "recurring[meter]",
          code: "parameter_missing",
        },
      };
    }
    const status = options.meterStatus?.(meter);
    if (!status) {
      return {
        error: { message: `No such billing meter: '${meter}'`, param: "recurring[meter]", code: "resource_missing" },
      };
    }
    if (status !== "active") {
      return {
        error: {
          message: `The billing meter '${meter}' is inactive. Only active meters can be attached to a price.`,
          param: "recurring[meter]",
        },
      };
    }
  } else if (meter) {
    return {
      error: {
        message: "recurring[meter] can only be set when recurring[usage_type] is metered.",
        param: "recurring[meter]",
      },
    };
  }

  return {
    recurring: { interval: unit, interval_count: intervalCount, usage_type: usageType, ...(meter && { meter }) },
  };
}

function readTiers(value: unknown): { tiers?: StripePriceTier[]; error?: PriceParamError } {
  const list = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : undefined;
  if (!list || list.length === 0) return { error: { message: "Missing required param: tiers.", param: "tiers" } };

  const tiers: StripePriceTier[] = [];
  let previous = 0;
  for (const [i, raw] of list.entries()) {
    const prefix = `tiers[${i}][`;
    if (!isRecord(raw)) return { error: { message: `Invalid tiers[${i}]: must be an object.`, param: "tiers" } };
    const last = i === list.length - 1;
    const tier: StripePriceTier = {};

    if (raw.up_to === "inf") {
      if (!last) {
        return { error: { message: "Only the last tier may have up_to set to inf.", param: `${prefix}up_to]` } };
      }
    } else {
      const upTo = readInt(raw.up_to);
      if (upTo === undefined) {
        return {
          error: { message: `Invalid ${prefix}up_to]: must be a positive integer or inf.`, param: `${prefix}up_to]` },
        };
      }
      if (last) return { error: { message: "The last tier must have up_to set to inf.", param: "tiers" } };
      if (upTo <= previous) {
        return {
          error: {
            message: "Each tier's up_to must be greater than the up_to of the tier before it.",
            param: `${prefix}up_to]`,
          },
        };
      }
      tier.up_to = upTo;
      previous = upTo;
    }

    const paramOf = (field: string) => `${prefix}${field}]`;
    const unit = readAmount(raw, "unit_amount", paramOf);
    if (unit.error) return { error: unit.error };
    const flat = readAmount(raw, "flat_amount", paramOf);
    if (flat.error) return { error: flat.error };
    if (unit.decimal === undefined && flat.decimal === undefined) {
      return {
        error: { message: `Tier ${i} must have at least one of unit_amount or flat_amount.`, param: `tiers[${i}]` },
      };
    }
    if (unit.decimal !== undefined) tier.unit_amount_decimal = unit.decimal;
    if (flat.decimal !== undefined) tier.flat_amount_decimal = flat.decimal;
    tiers.push(tier);
  }
  return { tiers };
}

function readTransformQuantity(value: unknown): {
  transform?: StripePriceTransformQuantity;
  error?: PriceParamError;
} {
  if (value === undefined || value === "") return {};
  if (!isRecord(value)) {
    return { error: { message: "Invalid transform_quantity: must be an object.", param: "transform_quantity" } };
  }
  const divideBy = readInt(value.divide_by);
  if (divideBy === undefined || divideBy < 1) {
    return {
      error: {
        message: "Invalid transform_quantity[divide_by]: must be a positive integer.",
        param: "transform_quantity[divide_by]",
      },
    };
  }
  if (value.round !== "up" && value.round !== "down") {
    return {
      error: {
        message: "Invalid transform_quantity[round]: must be one of up or down",
        param: "transform_quantity[round]",
      },
    };
  }
  return { transform: { divide_by: divideBy, round: value.round } };
}

/**
 * Validate the params of `POST /v1/prices` (or a seeded price) and return the fields they
 * define. Product resolution and lookup key uniqueness are left to the caller.
 */
export function readPriceParams(
  input: Record<string, unknown>,
  options: ReadPriceOptions = {},
): { price?: PriceDefinition; error?: PriceParamError } {
  const currency = readString(input.currency)?.toLowerCase();
  if (!currency) {
    return { error: { message: "Missing required param: currency.", param: "currency", code: "parameter_missing" } };
  }
  if (!/^[a-z]{3}$/.test(currency)) {
    return { error: { message: `Invalid currency: ${currency}.`, param: "currency" } };
  }

  const scheme = input.billing_scheme ?? "per_unit";
  if (scheme !== "per_unit" && scheme !== "tiered") {
    return {
      error: { message: "Invalid billing_scheme: must be one of per_unit or tiered", param: "billing_scheme" },
    };
  }

  const recurring = readRecurring(input.recurring, options);
  if (recurring.error) return { error: recurring.error };

  const transform = readTransformQuantity(input.transform_quantity);
  if (transform.error) return { error: transform.error };

  const tiersMode = input.tiers_mode;
  if (tiersMode !== undefined && tiersMode !== "" && tiersMode !== "graduated" && tiersMode !== "volume") {
    return { error: { message: "Invalid tiers_mode: must be one of graduated or volume", param: "tiers_mode" } };
  }

  const definition: PriceDefinition = {
    currency,
    unit_amount: null,
    type: recurring.recurring ? "recurring" : "one_time",
    active: readBool(input.active) ?? true,
    metadata: isRecord(input.metadata)
      ? Object.fromEntries(Object.entries(input.metadata).map(([k, v]) => [k, String(v)]))
      : {},
    billing_scheme: scheme,
  };
  if (recurring.recurring) definition.recurring = recurring.recurring;

  if (scheme === "tiered") {
    if (input.tiers === undefined || input.tiers === "") {
      return { error: { message: "Missing required param: tiers.", param: "tiers", code: "parameter_missing" } };
    }
    if (tiersMode === undefined || tiersMode === "") {
      return {
        error: { message: "Missing required param: tiers_mode.", param: "tiers_mode", code: "parameter_missing" },
      };
    }
    const unit = readAmount(input, "unit_amount");
    if (unit.decimal !== undefined || unit.error) {
      return { error: { message: "unit_amount cannot be set when billing_scheme is tiered.", param: "unit_amount" } };
    }
    if (transform.transform) {
      return {
        error: { message: "transform_quantity cannot be combined with tiers.", param: "transform_quantity" },
      };
    }
    const tiers = readTiers(input.tiers);
    if (tiers.error) return { error: tiers.error };
    definition.tiers = tiers.tiers;
    definition.tiers_mode = tiersMode as "graduated" | "volume";
  } else {
    if (input.tiers !== undefined || (tiersMode !== undefined && tiersMode !== "")) {
      return {
        error: { message: "tiers and tiers_mode require billing_scheme to be tiered.", param: "billing_scheme" },
      };
    }
    const unit = readAmount(input, "unit_amount");
    if (unit.error) return { error: unit.error };
    if (unit.decimal !== undefined) {
      definition.unit_amount_decimal = unit.decimal;
      definition.unit_amount = wholeAmount(unit.decimal);
    }
    if (transform.transform) definition.transform_quantity = transform.transform;
  }

  const lookupKey = readString(input.lookup_key);
  if (lookupKey !== undefined) {
    if (lookupKey.length > MAX_LOOKUP_KEY_LENGTH) {
      return {
        error: { message: "Invalid lookup_key: must be at most 200 characters.", param: "lookup_key" },
      };
    }
    definition.lookup_key = lookupKey;
  }
  const nickname = readString(input.nickname);
  if (nickname !== undefined) definition.nickname = nickname;

  const taxBehavior = input.tax_behavior;
  if (taxBehavior !== undefined && taxBehavior !== "") {
    if (taxBehavior !== "exclusive" && taxBehavior !== "inclusive" && taxBehavior !== "unspecified") {
      return {
        error: {
          message: "Invalid tax_behavior: must be one of exclusive, inclusive, or unspecified",
          param: "tax_behavior",
        },
      };
    }
    definition.tax_behavior = taxBehavior;
  }

  return { price: definition };
}

/** The unit amount of a per-unit price as a decimal string. Prices stored without one charge 0. */
export function unitAmountDecimal(price: StripePrice): string | undefined {
  if (price.billing_scheme === "tiered") return undefined;
  return price.unit_amount_decimal ?? (price.unit_amount !== null ? String(price.unit_amount) : undefined);
}

/** The quantity a price bills after `transform_quantity` (package pricing) is applied. */
export function transformedQuantity(price: StripePrice, quantity: number): number {
  const transform = price.transform_quantity;
  if (!transform) return quantity;
  const packages = quantity / transform.divide_by;
  return transform.round === "up" ? Math.ceil(packages) : Math.floor(packages);
}

/**
 * One part of a price's amount: the units charged at one unit price, or one flat fee. Invoice
 * lines are built from these, one line per part.
 */
export interface PriceComponent {
  /** Index into `price.tiers`. Absent for per-unit prices. */
  tier?: number;
  kind: "unit" | "flat";
  /** Units counted in this part, before `transform_quantity`. A flat fee counts 1. */
  quantity: number;
  /** The unit price, or the flat fee, in the smallest currency unit. */
  unit_amount_decimal: string;
  amount: number;
}

function tierComponents(tier: StripePriceTier, index: number, units: number): PriceComponent[] {
  const parts: PriceComponent[] = [];
  if (tier.unit_amount_decimal !== undefined) {
    parts.push({
      tier: index,
      kind: "unit",
      quantity: units,
      unit_amount_decimal: tier.unit_amount_decimal,
      amount: Math.round(units * Number(tier.unit_amount_decimal)),
    });
  }
  if (tier.flat_amount_decimal !== undefined) {
    parts.push({
      tier: index,
      kind: "flat",
      quantity: 1,
      unit_amount_decimal: tier.flat_amount_decimal,
      amount: Math.round(Number(tier.flat_amount_decimal)),
    });
  }
  return parts;
}

/**
 * How `quantity` units of `price` are charged. Graduated tiers charge each tier for the units
 * that fall in it, plus the flat fee of every tier reached. Volume tiers charge every unit at
 * the tier the whole quantity falls in. A quantity of 0 still reaches the first tier, so its
 * flat fee is billed, as Stripe documents.
 */
export function priceBreakdown(price: StripePrice, quantity: number): PriceComponent[] {
  const tiers = price.billing_scheme === "tiered" ? (price.tiers ?? []) : undefined;
  if (!tiers) {
    const unit = unitAmountDecimal(price) ?? "0";
    return [
      {
        kind: "unit",
        quantity,
        unit_amount_decimal: unit,
        amount: Math.round(transformedQuantity(price, quantity) * Number(unit)),
      },
    ];
  }

  if (price.tiers_mode === "volume") {
    const index = tiers.findIndex((tier) => tier.up_to === undefined || quantity <= tier.up_to);
    const at = index === -1 ? tiers.length - 1 : index;
    return tierComponents(tiers[at], at, quantity);
  }

  const parts: PriceComponent[] = [];
  let lower = 0;
  for (const [index, tier] of tiers.entries()) {
    const upper = tier.up_to ?? Infinity;
    const units = Math.max(0, roundQuantity(Math.min(quantity, upper) - lower));
    if (units === 0 && index > 0) break;
    parts.push(...tierComponents(tier, index, units));
    lower = upper;
  }
  return parts;
}

/** The amount `quantity` units of `price` cost, in the smallest currency unit. */
export function priceAmount(price: StripePrice, quantity: number): number {
  return priceBreakdown(price, quantity).reduce((sum, part) => sum + part.amount, 0);
}
