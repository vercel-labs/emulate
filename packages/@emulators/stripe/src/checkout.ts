import { getStripeStore, stripeStoreCheckpoint, type StripeStore } from "./store.js";
import { generateInvoicePrefix, stripeId } from "./helpers.js";
import { nowFor } from "./clock.js";
import { eventBatch, type EventBatch, type EventBatchContext } from "./events.js";
import {
  defaultInvoicePayment,
  formatCheckoutSession,
  formatCustomer,
  formatPaymentIntent,
  formatPaymentMethod,
  formatSetupIntent,
} from "./formatters.js";
import {
  attemptPayment,
  attemptSetup,
  completeSetupAuthentication,
  newClientSecret,
  resolvePaymentMethod,
} from "./payments.js";
import { payInvoice, type InvoicingContext } from "./invoicing.js";
import { createSubscription } from "./subscriptions.js";
import { attachPaymentMethod, testCardOf, type StripeErrorSpec } from "./routes/payment-methods.js";
import type { StripeCheckoutSession, StripePaymentMethod } from "./entities.js";

export type CheckoutContext = EventBatchContext & InvoicingContext;

/** The hosted page's `payment_method` value for completing a free trial without a card. */
export const NO_CARD = "none";

/** The card the hosted page uses when the form names none. */
export const DEFAULT_CHECKOUT_CARD = "pm_card_visa";

const DAY = 86400;

export interface CheckoutInput {
  /** A test card id such as `pm_card_visa`, a stored `pm_`, or NO_CARD. */
  paymentMethod?: string;
  email?: string;
}

export type CheckoutCompletion =
  | { ok: true; session: StripeCheckoutSession }
  | { ok: false; status: number; message: string };

type Step<T> = { ok: true; value: T } | { ok: false; error: StripeErrorSpec };

function failed(status: number, message: string): StripeErrorSpec {
  return { status, type: "invalid_request_error", message };
}

/** A subscription-mode session may skip the card only with `if_required` and nothing due now. */
export function checkoutCanSkipCard(session: StripeCheckoutSession): boolean {
  return (
    session.mode === "subscription" &&
    session.payment_method_collection === "if_required" &&
    (session.amount_total ?? 0) === 0
  );
}

/** The customer is on the page, so a card that asks for 3D Secure is approved there. */
function needsAuthentication(pm: StripePaymentMethod): boolean {
  const card = testCardOf(pm);
  return card !== undefined && card.authentication !== "none";
}

/**
 * The session's customer, creating one when the session needs it: always in subscription
 * mode, and in payment mode with `customer_creation=always`. Sends customer.created.
 */
function sessionCustomer(
  ss: StripeStore,
  ev: EventBatch,
  session: StripeCheckoutSession,
  email: string | undefined,
): string | undefined {
  if (session.customer_id) return session.customer_id;
  if (session.mode !== "subscription" && session.customer_creation !== "always") return undefined;
  const customer = ss.customers.insert({
    stripe_id: stripeId("cus"),
    email: email ?? null,
    name: null,
    description: null,
    metadata: {},
    invoice_prefix: generateInvoicePrefix(),
    next_invoice_sequence: 1,
    delinquent: false,
  });
  ev.emit("customer.created", formatCustomer(customer));
  return customer.stripe_id;
}

/** Save a card for later through a SetupIntent, as Checkout does for a trial. */
function saveCard(ctx: CheckoutContext, ev: EventBatch, customerId: string, pmId: string): Step<StripePaymentMethod> {
  const ss = getStripeStore(ctx.store);
  const resolved = resolvePaymentMethod(ss, pmId, customerId);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const id = stripeId("seti");
  const si = ss.setupIntents.insert({
    stripe_id: id,
    status: "requires_confirmation",
    customer_id: customerId,
    payment_method: resolved.pm.stripe_id,
    usage: "off_session",
    metadata: {},
    created: nowFor(ss, { customerId }),
    client_secret: newClientSecret(id),
  });
  ev.emit("setup_intent.created", formatSetupIntent(si));
  const attempt = attemptSetup(ctx, ev, si, resolved.pm);
  if (attempt.status === "failed") return { ok: false, error: attempt.error };
  const done =
    attempt.status === "requires_action" ? completeSetupAuthentication(ctx, ev, attempt.si, "succeed") : attempt.si;
  const pm = done.payment_method ? ss.paymentMethods.findOneBy("stripe_id", done.payment_method) : undefined;
  if (done.status !== "succeeded" || !pm) return { ok: false, error: failed(402, "The card could not be saved.") };
  return { ok: true, value: pm };
}

/** Attach a card to the customer before the first invoice is charged with it. */
function attachCard(ctx: CheckoutContext, ev: EventBatch, customerId: string, pmId: string): Step<StripePaymentMethod> {
  const ss = getStripeStore(ctx.store);
  const attached = attachPaymentMethod(ss, pmId, customerId);
  if (!attached.ok) return { ok: false, error: attached.error };
  if (attached.value.attached) ev.emit("payment_method.attached", formatPaymentMethod(attached.value.pm));
  return { ok: true, value: attached.value.pm };
}

function completeSubscriptionMode(
  ctx: CheckoutContext,
  ev: EventBatch,
  session: StripeCheckoutSession,
  customerId: string,
  pmId: string | undefined,
): Step<Partial<StripeCheckoutSession>> {
  const ss = getStripeStore(ctx.store);
  const now = nowFor(ss, { customerId });
  const data = session.subscription_data ?? { metadata: {} };
  const trialEnd =
    data.trial_end ?? (data.trial_period_days !== undefined ? now + data.trial_period_days * DAY : undefined);
  const trial = trialEnd !== undefined && trialEnd > now;

  let pm: StripePaymentMethod | undefined;
  if (pmId) {
    const card = trial ? saveCard(ctx, ev, customerId, pmId) : attachCard(ctx, ev, customerId, pmId);
    if (!card.ok) return card;
    pm = card.value;
  }

  const items = session.line_items.flatMap((li) => {
    const price = ss.prices.findOneBy("stripe_id", li.price);
    return price?.recurring ? [{ price, quantity: li.quantity, metadata: {} }] : [];
  });
  // Without a trial the first invoice is charged below, with the customer present for 3D Secure.
  const created = createSubscription(ctx, ev, {
    customerId,
    items,
    collectionMethod: "charge_automatically",
    defaultPaymentMethod: pm?.stripe_id,
    description: data.description,
    metadata: { ...data.metadata },
    trialEnd: trial ? trialEnd : undefined,
    trialMissingPaymentMethod: data.missing_payment_method,
    cancelAtPeriodEnd: false,
    paymentBehavior: trial ? "allow_incomplete" : "default_incomplete",
  });
  if (!created.ok) return { ok: false, error: created.error };

  let invoice = created.sub.latest_invoice ? ss.invoices.findOneBy("stripe_id", created.sub.latest_invoice) : undefined;
  if (invoice && invoice.status === "open") {
    if (!pm) return { ok: false, error: failed(400, "A payment method is required to complete this checkout.") };
    const record = defaultInvoicePayment(ss, invoice.stripe_id);
    const pi = record ? ss.paymentIntents.findOneBy("stripe_id", record.payment_intent_id) : undefined;
    if (pi && needsAuthentication(pm)) ss.paymentIntents.update(pi.id, { authenticated: true });
    const paid = payInvoice(ctx, ev, invoice, { paymentMethod: pm.stripe_id, offSession: false });
    if (!paid.ok) return { ok: false, error: paid.error };
    invoice = paid.invoice;
  }

  return {
    ok: true,
    value: {
      subscription_id: created.sub.stripe_id,
      invoice_id: invoice?.stripe_id,
      payment_status: invoice?.status === "paid" ? "paid" : "unpaid",
    },
  };
}

function completePaymentMode(
  ctx: CheckoutContext,
  ev: EventBatch,
  session: StripeCheckoutSession,
  customerId: string | undefined,
  pmId: string,
): Step<Partial<StripeCheckoutSession>> {
  const ss = getStripeStore(ctx.store);
  const amount = session.amount_total ?? 0;
  // A session without line items has nothing to charge; it completes as paid, as it always has.
  if (amount === 0) return { ok: true, value: { payment_status: "paid" } };

  const resolved = resolvePaymentMethod(ss, pmId, customerId ?? null);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const id = stripeId("pi");
  let pi = ss.paymentIntents.insert({
    stripe_id: id,
    amount,
    currency: session.currency ?? "usd",
    status: "requires_payment_method",
    customer_id: customerId ?? null,
    description: null,
    payment_method: null,
    metadata: {},
    created: nowFor(ss, { customerId }),
    client_secret: newClientSecret(id),
  });
  ev.emit("payment_intent.created", formatPaymentIntent(pi));
  if (needsAuthentication(resolved.pm)) pi = ss.paymentIntents.update(pi.id, { authenticated: true })!;
  const attempt = attemptPayment(ctx, ev, pi, resolved.pm, { offSession: false });
  if (attempt.status === "failed") return { ok: false, error: attempt.error };
  return { ok: true, value: { payment_intent_id: pi.stripe_id, payment_status: "paid" } };
}

/**
 * Complete an open payment- or subscription-mode session the way the hosted page does when
 * the customer pays. On any failure nothing the attempt created is kept and no event is
 * sent, so the customer can try another card. Events carry a null request, as for every
 * event the hosted page causes, and checkout.session.completed comes last.
 */
export async function completeCheckoutSession(
  ctx: CheckoutContext,
  session: StripeCheckoutSession,
  input: CheckoutInput,
): Promise<CheckoutCompletion> {
  const ss = getStripeStore(ctx.store);
  const skipCard = input.paymentMethod === NO_CARD;
  if (skipCard && !checkoutCanSkipCard(session)) {
    return { ok: false, status: 400, message: "A payment method is required to complete this checkout." };
  }
  const pmId = skipCard ? undefined : (input.paymentMethod ?? DEFAULT_CHECKOUT_CARD);

  const restore = stripeStoreCheckpoint(ss);
  const ev = eventBatch(ctx);
  const existing = session.customer_id ? ss.customers.findOneBy("stripe_id", session.customer_id) : undefined;
  const email = existing?.email ?? input.email ?? session.customer_email;
  const customerId = sessionCustomer(ss, ev, session, email);

  const outcome =
    session.mode === "subscription"
      ? completeSubscriptionMode(ctx, ev, session, customerId!, pmId)
      : completePaymentMode(ctx, ev, session, customerId, pmId!);
  if (!outcome.ok) {
    restore();
    return { ok: false, status: outcome.error.status, message: outcome.error.message };
  }

  const customer = customerId ? ss.customers.findOneBy("stripe_id", customerId) : undefined;
  const updated = ss.checkoutSessions.update(session.id, {
    ...outcome.value,
    status: "complete",
    customer_id: customerId ?? null,
    customer_details: { email: customer?.email ?? email, name: customer?.name ?? undefined },
  })!;
  ev.emit("checkout.session.completed", formatCheckoutSession(updated, ctx.baseUrl));
  await ev.commit();
  return { ok: true, session: updated };
}
