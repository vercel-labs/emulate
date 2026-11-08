import type { Store } from "@emulators/core";
import { getStripeStore, type StripeStore } from "./store.js";
import { randomBase62, stripeId } from "./helpers.js";
import { nowFor } from "./clock.js";
import { formatCharge, formatPaymentIntent, formatPaymentMethod, formatSetupIntent } from "./formatters.js";
import type { EventBatch } from "./events.js";
import { declineFor, errorDocUrl, testCardByPaymentMethod, type CardDecline, type TestCard } from "./test-cards.js";
import {
  attachPaymentMethod,
  cardError,
  insertCardPaymentMethod,
  testCardOf,
  type StripeErrorSpec,
} from "./routes/payment-methods.js";
import type {
  StripeCharge,
  StripeNextAction,
  StripePaymentError,
  StripePaymentIntent,
  StripePaymentMethod,
  StripeSetupIntent,
  SimulatedCardBehavior,
} from "./entities.js";

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

const SETUP_AUTHENTICATION_FAILURE_MESSAGE =
  "The latest attempt to set up the payment method has failed because authentication failed. Provide a new payment method to attempt to fulfill this SetupIntent again.";

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

type ChargeBehavior = Pick<TestCard, "charge" | "authentication" | "decline">;

/** How a charge on `pm` behaves: as simulated through the emulator route, else as its test card. */
function chargeBehavior(pm: StripePaymentMethod): ChargeBehavior | undefined {
  return pm.simulated ?? testCardOf(pm);
}

function needsAuthentication(card: ChargeBehavior | undefined, offSession: boolean): boolean {
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

export const SIMULATED_BEHAVIORS = ["succeed", "decline", "require_authentication"] as const;
export type SimulatedBehaviorName = (typeof SIMULATED_BEHAVIORS)[number];

/** The charge behaviour /_stripe/simulate/payment_methods/:id stores on a payment method. */
export function simulatedBehavior(name: SimulatedBehaviorName, declineCode = "generic_decline"): SimulatedCardBehavior {
  if (name === "decline") return { charge: "decline", authentication: "none", decline: declineFor(declineCode) };
  if (name === "require_authentication") return { charge: "succeed", authentication: "always" };
  return { charge: "succeed", authentication: "none" };
}

/** Charge the card once any authentication is done: the test card decides the outcome. */
function charge(
  ctx: PaymentContext,
  ev: EventBatch,
  pi: StripePaymentIntent,
  pm: StripePaymentMethod,
  threeDSecure: boolean,
): PaymentAttempt {
  const card = chargeBehavior(pm);
  if (card?.charge === "decline" && card.decline) return decline(ctx, ev, pi, pm, card.decline, threeDSecure);
  return succeed(ctx, ev, pi, pm, threeDSecure);
}

/** The 3D Secure step, which the emulator's simulate route completes in place of Stripe.js. */
function threeDSecureAction(ctx: PaymentContext, intentPath: string): StripeNextAction {
  return {
    type: "use_stripe_sdk",
    use_stripe_sdk: {
      source: stripeId("src"),
      stripe_js: `${ctx.baseUrl}/_stripe/simulate/${intentPath}/authenticate`,
      type: "three_d_secure_redirect",
    },
  };
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
    next_action: threeDSecureAction(ctx, `payment_intents/${pi.stripe_id}`),
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
  if (!pi.authenticated && needsAuthentication(chargeBehavior(pm), offSession)) {
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

export type SetupAttempt =
  | { status: "succeeded"; si: StripeSetupIntent }
  | { status: "requires_action"; si: StripeSetupIntent }
  | { status: "failed"; si: StripeSetupIntent; error: StripeErrorSpec };

/** A failed setup clears the payment method, which stays visible in last_setup_error. */
function failSetup(
  ctx: PaymentContext,
  ev: EventBatch,
  si: StripeSetupIntent,
  lastError: StripePaymentError,
): StripeSetupIntent {
  const ss = getStripeStore(ctx.store);
  const updated = ss.setupIntents.update(si.id, {
    status: "requires_payment_method",
    payment_method: undefined,
    next_action: undefined,
    last_setup_error: lastError,
  })!;
  ev.emit("setup_intent.setup_failed", formatSetupIntent(updated));
  return updated;
}

/** The issuer refused the card, so it cannot be saved. */
function declineSetup(
  ctx: PaymentContext,
  ev: EventBatch,
  si: StripeSetupIntent,
  pm: StripePaymentMethod,
  reason: CardDecline,
): SetupAttempt {
  const pmObject = formatPaymentMethod(pm);
  const failed = failSetup(ctx, ev, si, {
    type: "card_error",
    code: reason.code,
    decline_code: reason.decline_code,
    message: reason.message,
    doc_url: errorDocUrl(reason.code),
    param: reason.param,
    payment_method: pmObject,
  });
  return {
    status: "failed",
    si: failed,
    error: cardError(reason, { setup_intent: formatSetupIntent(failed), payment_method: pmObject }),
  };
}

/** Save the card: attach it to the intent's customer, if any, and mark the intent succeeded. */
function completeSetup(
  ctx: PaymentContext,
  ev: EventBatch,
  si: StripeSetupIntent,
  pm: StripePaymentMethod,
): SetupAttempt {
  const ss = getStripeStore(ctx.store);
  if (si.customer_id && pm.customer_id !== si.customer_id) {
    const attached = attachPaymentMethod(ss, pm.stripe_id, si.customer_id);
    if (!attached.ok) return { status: "failed", si, error: attached.error };
    if (attached.value.attached) ev.emit("payment_method.attached", formatPaymentMethod(attached.value.pm));
  }
  const updated = ss.setupIntents.update(si.id, {
    status: "succeeded",
    payment_method: pm.stripe_id,
    last_setup_error: undefined,
    next_action: undefined,
  })!;
  ev.emit("setup_intent.succeeded", formatSetupIntent(updated));
  return { status: "succeeded", si: updated };
}

/**
 * Run one confirmation of SetupIntent `si` with `pm`. The customer is present when a card is
 * set up, so every card that asks for 3D Secure asks here, and issuer declines fail at once.
 * Cards whose charges fail later (0341) set up fine. Writes the intent's new state and emits
 * its events on `ev`; the caller commits.
 */
export function attemptSetup(
  ctx: PaymentContext,
  ev: EventBatch,
  si: StripeSetupIntent,
  pm: StripePaymentMethod,
): SetupAttempt {
  const card = testCardOf(pm);
  if (card?.attach === "decline" && card.decline) return declineSetup(ctx, ev, si, pm, card.decline);
  if (card && card.authentication !== "none") {
    const ss = getStripeStore(ctx.store);
    const updated = ss.setupIntents.update(si.id, {
      status: "requires_action",
      payment_method: pm.stripe_id,
      last_setup_error: undefined,
      next_action: threeDSecureAction(ctx, `setup_intents/${si.stripe_id}`),
    })!;
    ev.emit("setup_intent.requires_action", formatSetupIntent(updated));
    return { status: "requires_action", si: updated };
  }
  return completeSetup(ctx, ev, si, pm);
}

/** Finish the 3D Secure step of a SetupIntent in `requires_action`, as the customer would. */
export function completeSetupAuthentication(
  ctx: PaymentContext,
  ev: EventBatch,
  si: StripeSetupIntent,
  result: "succeed" | "fail",
): StripeSetupIntent {
  const ss = getStripeStore(ctx.store);
  const pm = si.payment_method ? ss.paymentMethods.findOneBy("stripe_id", si.payment_method) : undefined;
  if (result === "succeed" && pm) {
    const attempt = completeSetup(ctx, ev, si, pm);
    if (attempt.status !== "failed") return attempt.si;
  }
  return failSetup(ctx, ev, si, {
    type: "invalid_request_error",
    code: "setup_intent_authentication_failure",
    message: SETUP_AUTHENTICATION_FAILURE_MESSAGE,
    doc_url: errorDocUrl("setup_intent_authentication_failure"),
    payment_method: pm ? formatPaymentMethod(pm) : undefined,
  });
}
