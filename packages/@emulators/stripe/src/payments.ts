import type { Store } from "@emulators/core";
import { getStripeStore, type StripeStore } from "./store.js";
import { randomBase62, stripeId } from "./helpers.js";
import { nowFor } from "./clock.js";
import { formatCharge, formatPaymentIntent, formatPaymentMethod } from "./formatters.js";
import type { EventBatch } from "./events.js";
import { errorDocUrl, testCardByPaymentMethod, type CardDecline, type TestCard } from "./test-cards.js";
import {
  attachPaymentMethod,
  cardError,
  insertCardPaymentMethod,
  testCardOf,
  type StripeErrorSpec,
} from "./routes/payment-methods.js";
import type { StripeCharge, StripePaymentError, StripePaymentIntent, StripePaymentMethod } from "./entities.js";

export interface PaymentContext {
  store: Store;
  baseUrl: string;
}

/**
 * Who started the attempt. A direct API confirmation that needs 3D Secure off-session is
 * declined with `authentication_required`. Billing leaves the intent in `requires_action`
 * so the invoice can ask the customer to authenticate.
 */
export type PaymentInitiator = "api" | "billing";

export interface AttemptOptions {
  offSession?: boolean;
  initiator?: PaymentInitiator;
}

export type PaymentAttempt =
  | { status: "succeeded"; pi: StripePaymentIntent; charge: StripeCharge }
  | { status: "requires_action"; pi: StripePaymentIntent }
  | { status: "failed"; pi: StripePaymentIntent; charge?: StripeCharge; error: StripeErrorSpec };

const AUTHENTICATION_REQUIRED: CardDecline = {
  code: "authentication_required",
  decline_code: "authentication_required",
  message: "Your card was declined. This transaction requires authentication.",
};

const AUTHENTICATION_FAILURE_MESSAGE =
  "The provided PaymentMethod has failed authentication. You can provide payment_method_data or a new PaymentMethod to attempt to fulfill this PaymentIntent again.";

export function newClientSecret(piId: string): string {
  return `${piId}_secret_${randomBase62(25)}`;
}

function invalidPaymentMethod(message: string, param: string, code?: string): StripeErrorSpec {
  return { status: 400, type: "invalid_request_error", message, code, param };
}

/**
 * Resolve the `payment_method` param of an intent. A test card id such as `pm_card_visa`
 * becomes a new unattached `pm_`, as on Stripe. A stored payment method must not have been
 * used already without a customer, and must belong to the intent's customer if it is attached.
 */
export function resolvePaymentMethod(
  ss: StripeStore,
  id: string,
  customerId: string | null,
  param = "payment_method",
): { ok: true; pm: StripePaymentMethod } | { ok: false; error: StripeErrorSpec } {
  const magic = testCardByPaymentMethod(id);
  if (magic) return { ok: true, pm: insertCardPaymentMethod(ss, magic) };

  const pm = ss.paymentMethods.findOneBy("stripe_id", id);
  if (!pm)
    return { ok: false, error: invalidPaymentMethod(`No such PaymentMethod: '${id}'`, param, "resource_missing") };
  if (pm.detached) {
    return {
      ok: false,
      error: invalidPaymentMethod(
        "The provided PaymentMethod was previously used with a PaymentIntent without Customer attachment, shared with a connected account without Customer attachment, or was detached from a Customer. It may not be used again. To use a PaymentMethod multiple times, you must attach it to a Customer first.",
        param,
      ),
    };
  }
  if (pm.customer_id && pm.customer_id !== customerId) {
    const message = customerId
      ? "The provided PaymentMethod belongs to a different Customer. Provide the Customer the PaymentMethod is attached to."
      : "The provided PaymentMethod belongs to a Customer, but you did not provide a Customer. Provide the Customer the PaymentMethod is attached to.";
    return { ok: false, error: invalidPaymentMethod(message, param) };
  }
  return { ok: true, pm };
}

function needsAuthentication(card: TestCard | undefined, offSession: boolean): boolean {
  if (!card) return false;
  return card.authentication === "always" || (card.authentication === "on_setup" && !offSession);
}

function digits(length: number): string {
  let out = "";
  while (out.length < length) out += Math.floor(Math.random() * 10).toString();
  return out;
}

function insertCharge(
  ss: StripeStore,
  pi: StripePaymentIntent,
  pm: StripePaymentMethod,
  outcome: { decline?: CardDecline; threeDSecure: boolean },
): StripeCharge {
  const succeeded = !outcome.decline;
  return ss.charges.insert({
    stripe_id: stripeId("ch"),
    amount: pi.amount,
    currency: pi.currency,
    status: succeeded ? "succeeded" : "failed",
    customer_id: pi.customer_id,
    payment_intent_id: pi.stripe_id,
    description: pi.description,
    metadata: { ...pi.metadata },
    payment_method: pm.stripe_id,
    failure_code: outcome.decline?.code,
    failure_message: outcome.decline?.message,
    decline_code: outcome.decline ? (outcome.decline.decline_code ?? outcome.decline.code) : undefined,
    created: nowFor(ss, { customerId: pi.customer_id }),
    card: { ...pm.card },
    billing_details: structuredClone(pm.billing_details),
    three_d_secure: outcome.threeDSecure || undefined,
    authorization_code: succeeded ? digits(6) : undefined,
    network_transaction_id: succeeded ? digits(15) : undefined,
  });
}

/** A payment method used without a customer can never be used or attached again. */
function consume(ss: StripeStore, pm: StripePaymentMethod): void {
  const current = ss.paymentMethods.get(pm.id);
  if (current && !current.customer_id) ss.paymentMethods.update(current.id, { detached: true });
}

function decline(
  ctx: PaymentContext,
  ev: EventBatch,
  pi: StripePaymentIntent,
  pm: StripePaymentMethod,
  reason: CardDecline,
  threeDSecure: boolean,
): PaymentAttempt {
  const ss = getStripeStore(ctx.store);
  const charge = insertCharge(ss, pi, pm, { decline: reason, threeDSecure });
  const pmObject = formatPaymentMethod(pm);
  const lastError: StripePaymentError = {
    type: "card_error",
    code: reason.code,
    decline_code: reason.decline_code,
    message: reason.message,
    doc_url: errorDocUrl(reason.code),
    param: reason.param,
    charge: charge.stripe_id,
    payment_method: pmObject,
  };
  // A failed attempt clears the payment method, which stays visible in last_payment_error.
  const updated = ss.paymentIntents.update(pi.id, {
    status: "requires_payment_method",
    payment_method: null,
    latest_charge: charge.stripe_id,
    last_payment_error: lastError,
    next_action: undefined,
    authenticated: undefined,
  })!;
  consume(ss, pm);

  ev.emit("payment_intent.payment_failed", formatPaymentIntent(updated));
  ev.emit("charge.failed", formatCharge(charge));
  return {
    status: "failed",
    pi: updated,
    charge,
    error: cardError(reason, {
      charge: charge.stripe_id,
      payment_intent: formatPaymentIntent(updated),
      payment_method: pmObject,
    }),
  };
}

function succeed(
  ctx: PaymentContext,
  ev: EventBatch,
  pi: StripePaymentIntent,
  pm: StripePaymentMethod,
  threeDSecure: boolean,
): PaymentAttempt {
  const ss = getStripeStore(ctx.store);
  const charge = insertCharge(ss, pi, pm, { threeDSecure });
  const updated = ss.paymentIntents.update(pi.id, {
    status: "succeeded",
    payment_method: pm.stripe_id,
    amount_received: pi.amount,
    latest_charge: charge.stripe_id,
    last_payment_error: undefined,
    next_action: undefined,
    authenticated: undefined,
  })!;
  ev.emit("payment_intent.succeeded", formatPaymentIntent(updated));
  ev.emit("charge.succeeded", formatCharge(charge));

  const saveTo = updated.setup_future_usage ? updated.customer_id : null;
  if (saveTo && pm.customer_id !== saveTo) {
    const attached = attachPaymentMethod(ss, pm.stripe_id, saveTo);
    if (attached.ok && attached.value.attached) {
      ev.emit("payment_method.attached", formatPaymentMethod(attached.value.pm));
      return { status: "succeeded", pi: updated, charge };
    }
  }
  consume(ss, pm);
  return { status: "succeeded", pi: updated, charge };
}

/** Charge the card once any authentication is done: the test card decides the outcome. */
function charge(
  ctx: PaymentContext,
  ev: EventBatch,
  pi: StripePaymentIntent,
  pm: StripePaymentMethod,
  threeDSecure: boolean,
): PaymentAttempt {
  const card = testCardOf(pm);
  if (card?.charge === "decline" && card.decline) return decline(ctx, ev, pi, pm, card.decline, threeDSecure);
  return succeed(ctx, ev, pi, pm, threeDSecure);
}

function requireAction(
  ctx: PaymentContext,
  ev: EventBatch,
  pi: StripePaymentIntent,
  pm: StripePaymentMethod,
): PaymentAttempt {
  const ss = getStripeStore(ctx.store);
  const updated = ss.paymentIntents.update(pi.id, {
    status: "requires_action",
    payment_method: pm.stripe_id,
    last_payment_error: undefined,
    next_action: {
      type: "use_stripe_sdk",
      use_stripe_sdk: {
        source: stripeId("src"),
        stripe_js: `${ctx.baseUrl}/_stripe/simulate/payment_intents/${pi.stripe_id}/authenticate`,
        type: "three_d_secure_redirect",
      },
    },
  })!;
  ev.emit("payment_intent.requires_action", formatPaymentIntent(updated));
  return { status: "requires_action", pi: updated };
}

/**
 * Run one confirmation of `pi` with `pm` against the test card's behaviour. Writes the
 * charge and the intent's new state and emits their events on `ev`; the caller commits.
 */
export function attemptPayment(
  ctx: PaymentContext,
  ev: EventBatch,
  pi: StripePaymentIntent,
  pm: StripePaymentMethod,
  options: AttemptOptions = {},
): PaymentAttempt {
  const offSession = options.offSession ?? false;
  const initiator = options.initiator ?? "api";
  if (!pi.authenticated && needsAuthentication(testCardOf(pm), offSession)) {
    if (offSession && initiator === "api") return decline(ctx, ev, pi, pm, AUTHENTICATION_REQUIRED, false);
    return requireAction(ctx, ev, pi, pm);
  }
  return charge(ctx, ev, pi, pm, pi.authenticated ?? false);
}

/**
 * Finish the 3D Secure step of an intent in `requires_action`, as the customer would.
 * A manually confirmed intent goes back to `requires_confirmation`; others are charged.
 */
export function completeAuthentication(
  ctx: PaymentContext,
  ev: EventBatch,
  pi: StripePaymentIntent,
  result: "succeed" | "fail",
): StripePaymentIntent {
  const ss = getStripeStore(ctx.store);
  const pm = pi.payment_method ? ss.paymentMethods.findOneBy("stripe_id", pi.payment_method) : undefined;

  if (result === "fail" || !pm) {
    const failed = ss.paymentIntents.update(pi.id, {
      status: "requires_payment_method",
      payment_method: null,
      next_action: undefined,
      authenticated: undefined,
      last_payment_error: {
        type: "invalid_request_error",
        code: "payment_intent_authentication_failure",
        message: AUTHENTICATION_FAILURE_MESSAGE,
        doc_url: errorDocUrl("payment_intent_authentication_failure"),
        payment_method: pm ? formatPaymentMethod(pm) : undefined,
      },
    })!;
    ev.emit("payment_intent.payment_failed", formatPaymentIntent(failed));
    return failed;
  }

  if (pi.confirmation_method === "manual") {
    return ss.paymentIntents.update(pi.id, {
      status: "requires_confirmation",
      next_action: undefined,
      authenticated: true,
    })!;
  }
  const authenticated = ss.paymentIntents.update(pi.id, { authenticated: true })!;
  return charge(ctx, ev, authenticated, pm, true).pi;
}
