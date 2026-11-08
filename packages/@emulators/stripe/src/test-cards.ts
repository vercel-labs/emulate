import { createHash } from "crypto";

/** The error a card raises when it is declined or rejected. Mirrors the card_error body Stripe returns. */
export interface CardDecline {
  code: string;
  decline_code?: string;
  message: string;
  param?: string;
}

export type CardBrand = "visa" | "mastercard" | "amex";

/**
 * When a card asks for 3D Secure. `always` asks on every charge. `on_setup` asks when the card
 * is set up and on on-session charges, but not on off-session charges once it has been set up.
 */
export type CardAuthentication = "none" | "always" | "on_setup";

export interface TestCard {
  number: string;
  /** Magic PaymentMethod ids (`pm_card_visa`) that stand for this card. */
  paymentMethods: string[];
  /** Magic token ids (`tok_visa`) accepted as `card[token]`. */
  tokens: string[];
  brand: CardBrand;
  display_brand: string;
  funding: "credit" | "debit";
  country: string;
  last4: string;
  fingerprint: string;
  /** Tokenization fails with this error, so no PaymentMethod can be created. */
  invalid?: CardDecline;
  /** Whether attaching the card to a customer succeeds. Issuer declines fail with `decline`. */
  attach: "succeed" | "decline";
  /** Outcome of a charge once any required authentication is done. Declines fail with `decline`. */
  charge: "succeed" | "decline";
  authentication: CardAuthentication;
  decline?: CardDecline;
}

const GENERIC_DECLINE: CardDecline = {
  code: "card_declined",
  decline_code: "generic_decline",
  message: "Your card was declined.",
};

const INSUFFICIENT_FUNDS: CardDecline = {
  code: "card_declined",
  decline_code: "insufficient_funds",
  message: "Your card has insufficient funds.",
};

/** Stripe's fingerprint is stable per card number. Here it is derived from the number itself. */
function fingerprintOf(number: string): string {
  const digest = createHash("sha256").update(`stripe-emulator:${number}`).digest();
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < 16; i++) out += alphabet[digest[i] % 62];
  return out;
}

const NETWORK_BRANDS: Record<CardBrand, string> = {
  visa: "visa",
  mastercard: "mastercard",
  amex: "american_express",
};

type CardSpec = Omit<TestCard, "last4" | "fingerprint" | "display_brand" | "attach" | "charge" | "authentication"> &
  Partial<Pick<TestCard, "attach" | "charge" | "authentication">>;

function card(spec: CardSpec): TestCard {
  return {
    attach: "succeed",
    charge: "succeed",
    authentication: "none",
    ...spec,
    display_brand: NETWORK_BRANDS[spec.brand],
    last4: spec.number.slice(-4),
    fingerprint: fingerprintOf(spec.number),
  };
}

/** An issuer decline: it cannot be attached to a customer and every charge fails. */
function declined(spec: Omit<CardSpec, "attach" | "charge"> & { decline: CardDecline }): TestCard {
  return card({ ...spec, attach: "decline", charge: "decline" });
}

/** Stripe's documented test cards. See https://docs.stripe.com/testing. */
export const TEST_CARDS: readonly TestCard[] = [
  card({
    number: "4242424242424242",
    paymentMethods: ["pm_card_visa", "pm_card_us"],
    tokens: ["tok_visa", "tok_us"],
    brand: "visa",
    funding: "credit",
    country: "US",
  }),
  card({
    number: "4000056655665556",
    paymentMethods: ["pm_card_visa_debit"],
    tokens: ["tok_visa_debit"],
    brand: "visa",
    funding: "debit",
    country: "US",
  }),
  card({
    number: "5555555555554444",
    paymentMethods: ["pm_card_mastercard"],
    tokens: ["tok_mastercard"],
    brand: "mastercard",
    funding: "credit",
    country: "US",
  }),
  card({
    number: "378282246310005",
    paymentMethods: ["pm_card_amex"],
    tokens: ["tok_amex"],
    brand: "amex",
    funding: "credit",
    country: "US",
  }),
  declined({
    number: "4000000000000002",
    paymentMethods: ["pm_card_visa_chargeDeclined", "pm_card_chargeDeclined"],
    tokens: ["tok_visa_chargeDeclined", "tok_chargeDeclined"],
    brand: "visa",
    funding: "credit",
    country: "US",
    decline: GENERIC_DECLINE,
  }),
  declined({
    number: "4000000000009995",
    paymentMethods: ["pm_card_visa_chargeDeclinedInsufficientFunds", "pm_card_chargeDeclinedInsufficientFunds"],
    tokens: ["tok_visa_chargeDeclinedInsufficientFunds", "tok_chargeDeclinedInsufficientFunds"],
    brand: "visa",
    funding: "credit",
    country: "US",
    decline: INSUFFICIENT_FUNDS,
  }),
  declined({
    number: "4000000000009987",
    paymentMethods: ["pm_card_visa_chargeDeclinedLostCard", "pm_card_chargeDeclinedLostCard"],
    tokens: ["tok_visa_chargeDeclinedLostCard", "tok_chargeDeclinedLostCard"],
    brand: "visa",
    funding: "credit",
    country: "US",
    decline: { code: "card_declined", decline_code: "lost_card", message: "Your card was declined." },
  }),
  declined({
    number: "4000000000009979",
    paymentMethods: ["pm_card_visa_chargeDeclinedStolenCard", "pm_card_chargeDeclinedStolenCard"],
    tokens: ["tok_visa_chargeDeclinedStolenCard", "tok_chargeDeclinedStolenCard"],
    brand: "visa",
    funding: "credit",
    country: "US",
    decline: { code: "card_declined", decline_code: "stolen_card", message: "Your card was declined." },
  }),
  declined({
    number: "4000000000000069",
    paymentMethods: ["pm_card_chargeDeclinedExpiredCard"],
    tokens: ["tok_visa_chargeDeclinedExpiredCard", "tok_chargeDeclinedExpiredCard"],
    brand: "visa",
    funding: "credit",
    country: "US",
    decline: { code: "expired_card", message: "Your card has expired.", param: "exp_month" },
  }),
  declined({
    number: "4000000000000127",
    paymentMethods: ["pm_card_chargeDeclinedIncorrectCvc"],
    tokens: ["tok_visa_chargeDeclinedIncorrectCvc", "tok_chargeDeclinedIncorrectCvc"],
    brand: "visa",
    funding: "credit",
    country: "US",
    decline: { code: "incorrect_cvc", message: "Your card's security code is incorrect.", param: "cvc" },
  }),
  declined({
    number: "4000000000000119",
    paymentMethods: ["pm_card_chargeDeclinedProcessingError"],
    tokens: ["tok_visa_chargeDeclinedProcessingError", "tok_chargeDeclinedProcessingError"],
    brand: "visa",
    funding: "credit",
    country: "US",
    decline: {
      code: "processing_error",
      message: "An error occurred while processing your card. Try again in a little bit.",
    },
  }),
  declined({
    number: "4000000000006975",
    paymentMethods: ["pm_card_visa_chargeDeclinedVelocityLimitExceeded"],
    tokens: ["tok_visa_chargeDeclinedVelocityLimitExceeded"],
    brand: "visa",
    funding: "credit",
    country: "US",
    decline: {
      code: "card_declined",
      decline_code: "card_velocity_exceeded",
      message: "Your card was declined for making repeated attempts too frequently or exceeding its amount limit.",
    },
  }),
  card({
    number: "4000000000000341",
    paymentMethods: ["pm_card_chargeCustomerFail"],
    tokens: ["tok_chargeCustomerFail", "tok_visa_chargeCustomerFail"],
    brand: "visa",
    funding: "credit",
    country: "US",
    charge: "decline",
    decline: GENERIC_DECLINE,
  }),
  card({
    number: "4000002760003184",
    paymentMethods: ["pm_card_authenticationRequired"],
    tokens: ["tok_authenticationRequired"],
    brand: "visa",
    funding: "credit",
    country: "DE",
    authentication: "always",
  }),
  card({
    number: "4000002500003155",
    paymentMethods: ["pm_card_authenticationRequiredOnSetup"],
    tokens: ["tok_authenticationRequiredOnSetup"],
    brand: "visa",
    funding: "credit",
    country: "FR",
    authentication: "on_setup",
  }),
  card({
    number: "4000008260003178",
    paymentMethods: ["pm_card_authenticationRequiredChargeDeclinedInsufficientFunds"],
    tokens: ["tok_authenticationRequiredChargeDeclinedInsufficientFunds"],
    brand: "visa",
    funding: "credit",
    country: "GB",
    authentication: "on_setup",
    charge: "decline",
    decline: INSUFFICIENT_FUNDS,
  }),
  card({
    number: "4242424242424241",
    paymentMethods: [],
    tokens: [],
    brand: "visa",
    funding: "credit",
    country: "US",
    invalid: { code: "incorrect_number", message: "Your card number is incorrect.", param: "number" },
  }),
];

const byNumber = new Map(TEST_CARDS.map((c) => [c.number, c]));
const byPaymentMethod = new Map(TEST_CARDS.flatMap((c) => c.paymentMethods.map((id) => [id, c] as const)));
const byToken = new Map(TEST_CARDS.flatMap((c) => c.tokens.map((id) => [id, c] as const)));

export function testCardByNumber(number: string): TestCard | undefined {
  return byNumber.get(number.replace(/[\s-]/g, ""));
}

/** The card a magic PaymentMethod id such as `pm_card_visa` stands for. */
export function testCardByPaymentMethod(id: string): TestCard | undefined {
  return byPaymentMethod.get(id);
}

export function testCardByToken(id: string): TestCard | undefined {
  return byToken.get(id);
}

export function passesLuhn(number: string): boolean {
  if (!/^\d{12,19}$/.test(number)) return false;
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let digit = number.charCodeAt(number.length - 1 - i) - 48;
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * The error Stripe's test mode raises for a raw number, or undefined when the number is a
 * test card that tokenizes. Numbers outside the table are treated as live cards.
 */
export function rawNumberError(number: string): CardDecline | undefined {
  const known = testCardByNumber(number);
  if (known) return known.invalid;
  const digits = number.replace(/[\s-]/g, "");
  if (!passesLuhn(digits)) {
    return { code: "incorrect_number", message: "Your card number is incorrect.", param: "number" };
  }
  return {
    code: "card_declined",
    decline_code: "test_mode_live_card",
    message:
      "Your card was declined. Your request was in test mode, but used a non test (live) card. For a list of valid test cards, visit: https://docs.stripe.com/testing.",
  };
}

/**
 * The issuer decline codes Billing cannot retry with the same payment method, from
 * https://docs.stripe.com/billing/revenue-recovery/smart-retries#non-retryable-decline-codes.
 */
export const HARD_DECLINE_CODES: ReadonlySet<string> = new Set([
  "incorrect_number",
  "lost_card",
  "pickup_card",
  "stolen_card",
  "revocation_of_authorization",
  "revocation_of_all_authorizations",
  "authentication_required",
  "highest_risk_level",
  "transaction_not_allowed",
]);

export function isHardDecline(error: { code?: string; decline_code?: string } | undefined): boolean {
  if (!error) return false;
  return HARD_DECLINE_CODES.has(error.decline_code ?? "") || HARD_DECLINE_CODES.has(error.code ?? "");
}

/**
 * Codes that Stripe reports as the error `code` itself rather than as a `decline_code` of
 * `card_declined`, with the message and param of the matching test card.
 */
const TOP_LEVEL_DECLINES: Record<string, CardDecline> = {
  expired_card: { code: "expired_card", message: "Your card has expired.", param: "exp_month" },
  incorrect_cvc: { code: "incorrect_cvc", message: "Your card's security code is incorrect.", param: "cvc" },
  incorrect_number: { code: "incorrect_number", message: "Your card number is incorrect.", param: "number" },
  processing_error: {
    code: "processing_error",
    message: "An error occurred while processing your card. Try again in a little bit.",
  },
};

const DECLINE_MESSAGES: Record<string, string> = {
  authentication_required: "Your card was declined. This transaction requires authentication.",
  card_velocity_exceeded:
    "Your card was declined for making repeated attempts too frequently or exceeding its amount limit.",
  insufficient_funds: "Your card has insufficient funds.",
};

/** The decline codes Stripe documents at https://docs.stripe.com/declines/codes. */
export const DECLINE_CODES: readonly string[] = [
  "authentication_required",
  "approve_with_id",
  "call_issuer",
  "card_not_supported",
  "card_velocity_exceeded",
  "currency_not_supported",
  "do_not_honor",
  "do_not_try_again",
  "duplicate_transaction",
  "expired_card",
  "fraudulent",
  "generic_decline",
  "highest_risk_level",
  "incorrect_number",
  "incorrect_cvc",
  "incorrect_pin",
  "incorrect_zip",
  "insufficient_funds",
  "invalid_account",
  "invalid_amount",
  "invalid_cvc",
  "invalid_expiry_month",
  "invalid_expiry_year",
  "invalid_number",
  "invalid_pin",
  "issuer_not_available",
  "lost_card",
  "merchant_blacklist",
  "new_account_information_available",
  "no_action_taken",
  "not_permitted",
  "offline_pin_required",
  "online_or_offline_pin_required",
  "pickup_card",
  "pin_try_exceeded",
  "processing_error",
  "reenter_transaction",
  "restricted_card",
  "revocation_of_all_authorizations",
  "revocation_of_authorization",
  "security_violation",
  "service_not_allowed",
  "stolen_card",
  "stop_payment_order",
  "testmode_decline",
  "transaction_not_allowed",
  "try_again_later",
  "withdrawal_count_limit_exceeded",
];

/** The card error a decline with `declineCode` raises. */
export function declineFor(declineCode: string): CardDecline {
  const topLevel = TOP_LEVEL_DECLINES[declineCode];
  if (topLevel) return { ...topLevel };
  return {
    code: declineCode === "authentication_required" ? "authentication_required" : "card_declined",
    decline_code: declineCode,
    message: DECLINE_MESSAGES[declineCode] ?? "Your card was declined.",
  };
}

/** `https://docs.stripe.com/error-codes/card-declined` for `card_declined`. */
export function errorDocUrl(code: string): string {
  return `https://docs.stripe.com/error-codes/${code.replace(/_/g, "-")}`;
}
