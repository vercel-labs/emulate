import type { Context, RouteContext } from "@emulators/core";
import { getStripeStore, stripeStoreCheckpoint, type StripeStore } from "../store.js";
import {
  expandedJson,
  mergeMetadata,
  parseStripeBody,
  parseStripeQuery,
  readBool,
  readInt,
  stripeError,
  stripeList,
  stripeId,
  isRecord,
  readString,
} from "../helpers.js";
import { nowFor } from "../clock.js";
import { formatSubscription, stripeExpandResolver, subscriptionItems } from "../formatters.js";
import { eventBatch } from "../events.js";
import {
  cancelSubscription,
  checkItemSet,
  createSubscription,
  currentPeriodEnd,
  emitSubscriptionChange,
  endTrialNow,
  extendTrial,
  isEnded,
  MAX_TRIAL_SECONDS,
  meteredQuantityError,
  pauseSubscription,
  readSubscriptionPrice,
  requestedCancellation,
  resumeSubscription,
  sendTrialWillEnd,
  TRIAL_WILL_END_LEAD,
  unscheduleCancellation,
  type PaymentBehavior,
  type SubscriptionItemInput,
} from "../subscriptions.js";
import { isMetered } from "../metering.js";
import { sendStripeError, type StripeErrorSpec } from "./payment-methods.js";
import type {
  StripePrice,
  StripeSubscription,
  StripeSubscriptionCancellationDetails,
  SubscriptionCancellationFeedback,
} from "../entities.js";

const COLLECTION_METHODS = ["charge_automatically", "send_invoice"] as const;
const PAYMENT_BEHAVIORS = ["allow_incomplete", "default_incomplete", "error_if_incomplete"] as const;
const MISSING_PAYMENT_METHOD = ["cancel", "create_invoice", "pause"] as const;
const SAVE_DEFAULT = ["off", "on_subscription"] as const;
const CANCEL_AT_ENUM = ["max_billed_until", "max_period_end", "min_period_end"] as const;
const FEEDBACK: readonly SubscriptionCancellationFeedback[] = [
  "customer_service",
  "low_quality",
  "missing_features",
  "other",
  "switched_service",
  "too_complex",
  "too_expensive",
  "unused",
];
const LIST_STATUSES = [
  "active",
  "all",
  "canceled",
  "ended",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
] as const;

const PAUSE_TYPES = ["subscription"] as const;
const PAUSE_INVOICING = ["invoice", "pending_invoice_item"] as const;
const RESUME_ANCHORS = ["now", "unchanged"] as const;
const RESUME_PAYMENT_BEHAVIORS = ["resume_on_payment_attempt", "resume_on_payment_success"] as const;
const PRORATION_BEHAVIORS = ["always_invoice", "create_prorations", "none"] as const;

/** Why the pause endpoint refuses `sub`, following Stripe's list of subscriptions you can't pause. */
function pauseRefusal(sub: StripeSubscription): StripeErrorSpec | undefined {
  if (sub.collection_method !== "charge_automatically") {
    return invalid("Only subscriptions with collection_method=charge_automatically can be paused.").error;
  }
  if (sub.status === "trialing") {
    return invalid("A subscription in a free trial can't be paused. End the trial first by setting trial_end to now.")
      .error;
  }
  if (sub.status !== "active" && sub.status !== "past_due") {
    return invalid(`A subscription in status ${sub.status} can't be paused.`).error;
  }
  return undefined;
}

/** Params a canceled or expired subscription still accepts. */
const ENDED_EDITABLE = ["metadata", "cancellation_details", "expand"];
/** Params an incomplete subscription accepts. */
const INCOMPLETE_EDITABLE = ["metadata", "default_payment_method", "expand"];

type Parsed<T> = { ok: true; value: T } | { ok: false; error: StripeErrorSpec };

function invalid(message: string, param?: string, code?: string): { ok: false; error: StripeErrorSpec } {
  return { ok: false, error: { status: 400, type: "invalid_request_error", message, code, param } };
}

/** A form list (`items[0][price]`) arrives as an array; an indexed JSON object is accepted too. */
function readList(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value.filter((entry) => entry !== undefined);
  if (isRecord(value)) return Object.values(value);
  return undefined;
}

function readOneOf<T extends string>(value: unknown, allowed: readonly T[], param: string): Parsed<T | undefined> {
  if (value === undefined || value === "") return { ok: true, value: undefined };
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return { ok: true, value: value as T };
  }
  return invalid(`Invalid ${param}: must be one of ${allowed.join(", ")}`, param);
}

function readQuantity(value: unknown, param: string): Parsed<number | undefined> {
  if (value === undefined || value === "") return { ok: true, value: undefined };
  const quantity = readInt(value);
  if (quantity === undefined || quantity < 0)
    return invalid(`Invalid ${param}: must be a non-negative integer.`, param);
  return { ok: true, value: quantity };
}

function futureTimestamp(value: unknown, param: string, now: number): Parsed<number> {
  const at = readInt(value);
  if (at === undefined || at <= now) {
    return invalid("Invalid timestamp: must be an integer Unix timestamp in the future.", param);
  }
  return { ok: true, value: at };
}

/** A trial end from `trial_end` or `trial_period_days`, or undefined for no trial. */
function readTrial(body: Record<string, unknown>, now: number): Parsed<number | undefined> {
  const hasEnd = body.trial_end !== undefined && body.trial_end !== "";
  const hasDays = body.trial_period_days !== undefined && body.trial_period_days !== "";
  if (hasEnd && hasDays) {
    return invalid("You may only specify one of these parameters: trial_end, trial_period_days.", "trial_end");
  }
  if (hasEnd && readBool(body.trial_from_plan) === true) {
    return invalid("You may not set trial_from_plan=true together with trial_end.", "trial_from_plan");
  }
  if (hasEnd) {
    if (body.trial_end === "now") return { ok: true, value: undefined };
    const end = futureTimestamp(body.trial_end, "trial_end", now);
    if (!end.ok) return end;
    if (end.value - now > MAX_TRIAL_SECONDS) {
      return invalid("Invalid trial_end: must be at most 730 days in the future.", "trial_end");
    }
    return end;
  }
  if (hasDays) {
    const days = readInt(body.trial_period_days);
    if (days === undefined || days < 0 || days > 730) {
      return invalid("Invalid trial_period_days: must be an integer from 0 to 730.", "trial_period_days");
    }
    return { ok: true, value: days === 0 ? undefined : now + days * 86400 };
  }
  // Plans have no trial_period_days in the emulator, so trial_from_plan never starts a trial.
  return { ok: true, value: undefined };
}

function readMissingPaymentMethod(body: Record<string, unknown>) {
  const settings = isRecord(body.trial_settings) ? body.trial_settings : undefined;
  const endBehavior = settings && isRecord(settings.end_behavior) ? settings.end_behavior : undefined;
  return readOneOf(
    endBehavior?.missing_payment_method,
    MISSING_PAYMENT_METHOD,
    "trial_settings[end_behavior][missing_payment_method]",
  );
}

function readSaveDefault(body: Record<string, unknown>) {
  const settings = isRecord(body.payment_settings) ? body.payment_settings : undefined;
  return readOneOf(
    settings?.save_default_payment_method,
    SAVE_DEFAULT,
    "payment_settings[save_default_payment_method]",
  );
}

/** `cancel_at`: a future timestamp, one of the period-end enums, or "" to clear. */
function readCancelAt(value: unknown, now: number): Parsed<number | "period_end" | "" | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === "") return { ok: true, value: "" };
  if (typeof value === "string" && (CANCEL_AT_ENUM as readonly string[]).includes(value)) {
    return { ok: true, value: "period_end" };
  }
  return futureTimestamp(value, "cancel_at", now);
}

function readCancellationDetails(value: unknown): Parsed<StripeSubscriptionCancellationDetails | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value)) return invalid("Invalid cancellation_details: must be an object.", "cancellation_details");
  const details: StripeSubscriptionCancellationDetails = {};
  if (value.comment !== undefined) details.comment = readString(value.comment);
  if (value.feedback !== undefined) {
    const feedback = readOneOf(value.feedback, FEEDBACK, "cancellation_details[feedback]");
    if (!feedback.ok) return feedback;
    details.feedback = feedback.value;
  }
  return { ok: true, value: details };
}

/** A payment method a subscription may default to: one attached to its customer. */
function checkDefaultPaymentMethod(ss: StripeStore, id: string, customerId: string): StripeErrorSpec | undefined {
  const pm = ss.paymentMethods.findOneBy("stripe_id", id);
  if (!pm) {
    return {
      status: 400,
      type: "invalid_request_error",
      message: `No such PaymentMethod: '${id}'`,
      code: "resource_missing",
      param: "default_payment_method",
    };
  }
  if (pm.customer_id === customerId) return undefined;
  return {
    status: 400,
    type: "invalid_request_error",
    message: `The customer does not have a payment method with the ID ${id}. The payment method must be attached to the customer.`,
    code: "resource_missing",
    param: "default_payment_method",
  };
}

function readCreateItems(ss: StripeStore, value: unknown): Parsed<SubscriptionItemInput[]> {
  const list = readList(value);
  if (!list || list.length === 0) return invalid("Missing required param: items.", "items", "parameter_missing");
  const items: SubscriptionItemInput[] = [];
  for (const [i, raw] of list.entries()) {
    if (!isRecord(raw)) return invalid(`Invalid items[${i}]: must be an object.`, `items[${i}]`);
    const price = readSubscriptionPrice(ss, raw.price, `items[${i}][price]`);
    if (!price.ok) return price;
    const quantity = readQuantity(raw.quantity, `items[${i}][quantity]`);
    if (!quantity.ok) return quantity;
    if (quantity.value !== undefined && price.price.recurring?.usage_type === "metered") {
      return { ok: false, error: meteredQuantityError(`items[${i}]`) };
    }
    items.push({ price: price.price, quantity: quantity.value ?? 1, metadata: mergeMetadata({}, raw.metadata) ?? {} });
  }
  const set = checkItemSet(items.map((item) => item.price));
  if (set) return { ok: false, error: set };
  return { ok: true, value: items };
}

/** One change to the items of an existing subscription, from `items[i]`. */
interface ItemChange {
  id?: string;
  price?: StripePrice;
  quantity?: number;
  deleted: boolean;
  metadata?: unknown;
}

function readItemChanges(ss: StripeStore, sub: StripeSubscription, value: unknown): Parsed<ItemChange[]> {
  const list = readList(value);
  if (!list) return invalid("Invalid items: must be a list.", "items");
  const owned = new Set(subscriptionItems(ss, sub.stripe_id).map((item) => item.stripe_id));
  const changes: ItemChange[] = [];
  for (const [i, raw] of list.entries()) {
    if (!isRecord(raw)) return invalid(`Invalid items[${i}]: must be an object.`, `items[${i}]`);
    const id = readString(raw.id);
    if (id && !owned.has(id)) {
      return invalid(`No such subscription item: '${id}'`, `items[${i}][id]`, "resource_missing");
    }
    let price: StripePrice | undefined;
    if (raw.price !== undefined || !id) {
      const read = readSubscriptionPrice(ss, raw.price, `items[${i}][price]`);
      if (!read.ok) return read;
      price = read.price;
    }
    const quantity = readQuantity(raw.quantity, `items[${i}][quantity]`);
    if (!quantity.ok) return quantity;
    const priceId =
      price?.stripe_id ?? subscriptionItems(ss, sub.stripe_id).find((item) => item.stripe_id === id)?.price_id;
    if (quantity.value !== undefined && priceId && isMetered(ss, priceId)) {
      return { ok: false, error: meteredQuantityError(`items[${i}]`) };
    }
    changes.push({
      id,
      price,
      quantity: quantity.value,
      deleted: readBool(raw.deleted) === true,
      metadata: raw.metadata,
    });
  }
  return { ok: true, value: changes };
}

/** Apply item changes after checking the resulting set. New items join the current period. */
function applyItemChanges(
  ss: StripeStore,
  sub: StripeSubscription,
  changes: ItemChange[],
  now: number,
): StripeErrorSpec | undefined {
  const current = subscriptionItems(ss, sub.stripe_id);
  const priceOf = (priceId: string) => ss.prices.findOneBy("stripe_id", priceId)!;
  const result = new Map(current.map((item) => [item.stripe_id, priceOf(item.price_id)]));
  const added: StripePrice[] = [];
  for (const change of changes) {
    if (change.id && change.deleted) result.delete(change.id);
    else if (change.id && change.price) result.set(change.id, change.price);
    else if (!change.id && change.price && !change.deleted) added.push(change.price);
  }
  const prices = [...result.values(), ...added];
  if (prices.length === 0) return invalid("A subscription must have at least one active price.", "items").error;
  const set = checkItemSet(prices);
  if (set) return set;
  if (prices[0].currency !== sub.currency) {
    return invalid(
      "Currency and interval fields must match across all plans on this subscription. Found mismatch in currency field.",
      "items",
    ).error;
  }

  const period = { start: current[0].current_period_start, end: current[0].current_period_end };
  for (const change of changes) {
    const existing = change.id ? current.find((item) => item.stripe_id === change.id) : undefined;
    if (existing && change.deleted) {
      ss.subscriptionItems.delete(existing.id);
    } else if (existing) {
      ss.subscriptionItems.update(existing.id, {
        ...(change.price && { price_id: change.price.stripe_id }),
        ...(change.quantity !== undefined && { quantity: change.quantity }),
        ...(change.metadata !== undefined && { metadata: mergeMetadata(existing.metadata, change.metadata) }),
      });
    } else if (change.price && !change.deleted) {
      ss.subscriptionItems.insert({
        stripe_id: stripeId("si"),
        subscription_id: sub.stripe_id,
        price_id: change.price.stripe_id,
        quantity: change.quantity ?? 1,
        metadata: mergeMetadata({}, change.metadata) ?? {},
        created: now,
        current_period_start: period.start,
        current_period_end: period.end,
      });
    }
  }
  return undefined;
}

export function subscriptionRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);
  const render = (sub: StripeSubscription) => formatSubscription(ss, sub);

  const notFound = (c: Context, id: string) =>
    stripeError(c, 404, "invalid_request_error", `No such subscription: '${id}'`, "resource_missing", "id");

  app.post("/v1/subscriptions", async (c) => {
    const body = await parseStripeBody(c);
    const customerId = readString(body.customer);
    if (!customerId) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "Missing required param: customer.",
        "parameter_missing",
        "customer",
      );
    }
    if (!ss.customers.findOneBy("stripe_id", customerId)) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `No such customer: '${customerId}'`,
        "resource_missing",
        "customer",
      );
    }
    const now = nowFor(ss, { customerId });

    const items = readCreateItems(ss, body.items);
    if (!items.ok) return sendStripeError(c, items.error);
    const collection = readOneOf(body.collection_method, COLLECTION_METHODS, "collection_method");
    if (!collection.ok) return sendStripeError(c, collection.error);
    const collectionMethod = collection.value ?? "charge_automatically";
    const daysUntilDue = readInt(body.days_until_due);
    if (body.days_until_due !== undefined && body.days_until_due !== "") {
      if (collectionMethod !== "send_invoice") {
        return sendStripeError(
          c,
          invalid("days_until_due can only be set when collection_method is send_invoice.", "days_until_due").error,
        );
      }
      if (daysUntilDue === undefined || daysUntilDue < 0) {
        return sendStripeError(
          c,
          invalid("Invalid days_until_due: must be a non-negative integer.", "days_until_due").error,
        );
      }
    } else if (collectionMethod === "send_invoice") {
      return sendStripeError(
        c,
        invalid("Missing required param: days_until_due.", "days_until_due", "parameter_missing").error,
      );
    }

    const behaviorParam = body.payment_behavior;
    if (behaviorParam === "pending_if_incomplete") {
      return sendStripeError(
        c,
        invalid(
          "payment_behavior=pending_if_incomplete is only supported when updating a subscription.",
          "payment_behavior",
        ).error,
      );
    }
    const behavior = readOneOf(behaviorParam, PAYMENT_BEHAVIORS, "payment_behavior");
    if (!behavior.ok) return sendStripeError(c, behavior.error);
    const trial = readTrial(body, now);
    if (!trial.ok) return sendStripeError(c, trial.error);
    const missing = readMissingPaymentMethod(body);
    if (!missing.ok) return sendStripeError(c, missing.error);
    const saveDefault = readSaveDefault(body);
    if (!saveDefault.ok) return sendStripeError(c, saveDefault.error);
    const cancelAt = readCancelAt(body.cancel_at, now);
    if (!cancelAt.ok) return sendStripeError(c, cancelAt.error);
    const cancelAtPeriodEnd = readBool(body.cancel_at_period_end) ?? false;
    if (cancelAtPeriodEnd && cancelAt.value !== undefined && cancelAt.value !== "") {
      return sendStripeError(
        c,
        invalid("You may only specify one of these parameters: cancel_at, cancel_at_period_end.", "cancel_at").error,
      );
    }
    const defaultPaymentMethod = readString(body.default_payment_method);
    if (defaultPaymentMethod) {
      const foreign = checkDefaultPaymentMethod(ss, defaultPaymentMethod, customerId);
      if (foreign) return sendStripeError(c, foreign);
    }

    const paymentBehavior: PaymentBehavior = behavior.value ?? "allow_incomplete";
    const restore = paymentBehavior === "error_if_incomplete" ? stripeStoreCheckpoint(ss) : undefined;
    const ev = eventBatch(ctx, c);
    const result = createSubscription(ctx, ev, {
      customerId,
      items: items.value,
      collectionMethod,
      daysUntilDue: collectionMethod === "send_invoice" ? daysUntilDue : undefined,
      defaultPaymentMethod,
      description: readString(body.description),
      metadata: mergeMetadata({}, body.metadata) ?? {},
      trialEnd: trial.value,
      trialMissingPaymentMethod: missing.value,
      cancelAt: cancelAt.value === "period_end" ? "max_period_end" : cancelAt.value || undefined,
      cancelAtPeriodEnd,
      paymentBehavior,
      saveDefaultPaymentMethod: saveDefault.value,
      offSession: readBool(body.off_session),
    });
    if (!result.ok) {
      // Nothing is kept and no event is sent, as for a subscription that was never created.
      restore?.();
      return sendStripeError(c, result.error);
    }
    await ev.commit();
    return expandedJson(c, render(ss.subscriptions.get(result.sub.id) ?? result.sub), expand, body);
  });

  app.get("/v1/subscriptions", (c) => {
    const query = parseStripeQuery(c);
    const status = readString(query.status);
    if (status && !(LIST_STATUSES as readonly string[]).includes(status)) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `Invalid status: must be one of ${LIST_STATUSES.join(", ")}`,
        undefined,
        "status",
      );
    }
    let items = ss.subscriptions.all();
    if (!status) items = items.filter((sub) => sub.status !== "canceled");
    else if (status === "ended") items = items.filter(isEnded);
    else if (status !== "all") items = items.filter((sub) => sub.status === status);
    const customer = readString(query.customer);
    const testClock = readString(query.test_clock);
    // Subscriptions on a test clock are listed only when their customer or clock is named.
    if (!customer && !testClock) items = items.filter((sub) => !sub.test_clock);
    if (customer) items = items.filter((sub) => sub.customer_id === customer);
    const price = readString(query.price);
    if (price) {
      items = items.filter((sub) => subscriptionItems(ss, sub.stripe_id).some((item) => item.price_id === price));
    }
    const collection = readString(query.collection_method);
    if (collection) items = items.filter((sub) => sub.collection_method === collection);
    if (testClock) items = items.filter((sub) => sub.test_clock === testClock);
    return stripeList(c, items, "/v1/subscriptions", render, { created: (sub) => sub.created, expand });
  });

  app.get("/v1/subscriptions/:id", (c) => {
    const id = c.req.param("id");
    const sub = ss.subscriptions.findOneBy("stripe_id", id);
    if (!sub) return notFound(c, id);
    return expandedJson(c, render(sub), expand);
  });

  app.post("/v1/subscriptions/:id", async (c) => {
    const id = c.req.param("id");
    const found = ss.subscriptions.findOneBy("stripe_id", id);
    if (!found) return notFound(c, id);
    const body = await parseStripeBody(c);
    const now = nowFor(ss, { customerId: found.customer_id });

    const keys = Object.keys(body);
    if (isEnded(found) && keys.some((key) => !ENDED_EDITABLE.includes(key))) {
      return sendStripeError(
        c,
        invalid(
          `A subscription in status ${found.status} can only update its cancellation_details and metadata.`,
          keys.find((key) => !ENDED_EDITABLE.includes(key)),
        ).error,
      );
    }
    if (found.status === "incomplete" && keys.some((key) => !INCOMPLETE_EDITABLE.includes(key))) {
      return sendStripeError(
        c,
        invalid(
          "A subscription in status incomplete can only update its metadata and default_payment_method.",
          keys.find((key) => !INCOMPLETE_EDITABLE.includes(key)),
        ).error,
      );
    }

    const details = readCancellationDetails(body.cancellation_details);
    if (!details.ok) return sendStripeError(c, details.error);
    const cancelAt = readCancelAt(body.cancel_at, now);
    if (!cancelAt.ok) return sendStripeError(c, cancelAt.error);
    const cancelAtPeriodEnd = readBool(body.cancel_at_period_end);
    if (cancelAtPeriodEnd === true && cancelAt.value !== undefined && cancelAt.value !== "") {
      return sendStripeError(
        c,
        invalid("You may only specify one of these parameters: cancel_at, cancel_at_period_end.", "cancel_at").error,
      );
    }
    const missing = readMissingPaymentMethod(body);
    if (!missing.ok) return sendStripeError(c, missing.error);
    const saveDefault = readSaveDefault(body);
    if (!saveDefault.ok) return sendStripeError(c, saveDefault.error);
    const defaultPaymentMethod =
      typeof body.default_payment_method === "string" ? body.default_payment_method : undefined;
    if (defaultPaymentMethod) {
      const foreign = checkDefaultPaymentMethod(ss, defaultPaymentMethod, found.customer_id);
      if (foreign) return sendStripeError(c, foreign);
    }
    let trialEnd: number | "now" | undefined;
    if (body.trial_end !== undefined && body.trial_end !== "") {
      if (found.status !== "trialing") {
        return sendStripeError(
          c,
          invalid("trial_end can only be changed while the subscription is trialing.", "trial_end").error,
        );
      }
      if (body.trial_end === "now") {
        trialEnd = "now";
      } else {
        const end = futureTimestamp(body.trial_end, "trial_end", now);
        if (!end.ok) return sendStripeError(c, end.error);
        trialEnd = end.value;
      }
    }
    let itemChanges: ItemChange[] | undefined;
    if (body.items !== undefined) {
      const changes = readItemChanges(ss, found, body.items);
      if (!changes.ok) return sendStripeError(c, changes.error);
      itemChanges = changes.value;
    }

    const before = render(found);
    if (itemChanges) {
      const failed = applyItemChanges(ss, found, itemChanges, now);
      if (failed) return sendStripeError(c, failed);
    }

    const updates: Partial<StripeSubscription> = {};
    const metadata = mergeMetadata(found.metadata, body.metadata);
    if (metadata) updates.metadata = metadata;
    if (body.description !== undefined) updates.description = readString(body.description);
    if (details.value) updates.cancellation_details = { ...found.cancellation_details, ...details.value };
    if (defaultPaymentMethod !== undefined) updates.default_payment_method = defaultPaymentMethod || undefined;
    if (missing.value) updates.trial_missing_payment_method = missing.value;
    if (saveDefault.value) updates.save_default_payment_method = saveDefault.value;
    if (body.off_session !== undefined) updates.off_session = readBool(body.off_session);
    if (cancelAtPeriodEnd === true) {
      updates.cancel_at_period_end = true;
      updates.cancel_at = currentPeriodEnd(ss, found);
      updates.canceled_at = now;
      updates.cancellation_details = requestedCancellation(updates.cancellation_details ?? found.cancellation_details);
    } else if (
      cancelAt.value === "" ||
      (cancelAt.value === undefined && cancelAtPeriodEnd === false && found.cancel_at_period_end)
    ) {
      if (found.cancel_at !== undefined || found.cancel_at_period_end) {
        Object.assign(updates, unscheduleCancellation());
        // Details sent with the reactivation describe it, not the cancellation it undoes.
        if (details.value) updates.cancellation_details = details.value;
      }
    } else if (cancelAt.value !== undefined) {
      updates.cancel_at = cancelAt.value === "period_end" ? currentPeriodEnd(ss, found) : cancelAt.value;
      updates.canceled_at = now;
      updates.cancel_at_period_end = false;
      updates.cancellation_details = requestedCancellation(updates.cancellation_details ?? found.cancellation_details);
    }

    const ev = eventBatch(ctx, c);
    let sub = ss.subscriptions.update(found.id, updates)!;
    if (trialEnd === "now") {
      sub = endTrialNow(ctx, ev, sub, before);
    } else {
      if (trialEnd !== undefined) sub = extendTrial(ss, sub, trialEnd);
      emitSubscriptionChange(ss, ev, sub, before);
      // A trial shortened to within three days of its end is warned about in the same request.
      if (
        trialEnd !== undefined &&
        trialEnd - now <= TRIAL_WILL_END_LEAD &&
        sub.trial_will_end_sent_for !== sub.trial_end
      ) {
        sub = sendTrialWillEnd(ss, ev, sub);
      }
    }
    await ev.commit();
    return expandedJson(c, render(sub), expand, body);
  });

  app.post("/v1/subscriptions/:id/pause", async (c) => {
    const id = c.req.param("id");
    const sub = ss.subscriptions.findOneBy("stripe_id", id);
    if (!sub) return notFound(c, id);
    const body = await parseStripeBody(c);
    const type = readOneOf(body.type, PAUSE_TYPES, "type");
    if (!type.ok) return sendStripeError(c, type.error);
    const invoicing = readOneOf(body.invoicing_behavior, PAUSE_INVOICING, "invoicing_behavior");
    if (!invoicing.ok) return sendStripeError(c, invoicing.error);
    if (body.bill_for !== undefined && body.bill_for !== "" && !isRecord(body.bill_for)) {
      return sendStripeError(c, invalid("Invalid bill_for: must be an object.", "bill_for").error);
    }
    const refused = pauseRefusal(sub);
    if (refused) return sendStripeError(c, refused);

    const ev = eventBatch(ctx, c);
    const paused = pauseSubscription(ctx, ev, sub, "pause_requested", { endPeriod: true });
    await ev.commit();
    return expandedJson(c, render(paused), expand, body);
  });

  app.post("/v1/subscriptions/:id/resume", async (c) => {
    const id = c.req.param("id");
    const sub = ss.subscriptions.findOneBy("stripe_id", id);
    if (!sub) return notFound(c, id);
    const body = await parseStripeBody(c);
    const anchorParam = body.billing_cycle_anchor;
    if (anchorParam !== undefined && anchorParam !== "" && !isRecord(anchorParam)) {
      return sendStripeError(
        c,
        invalid("Invalid billing_cycle_anchor: must be an object.", "billing_cycle_anchor").error,
      );
    }
    const anchor = readOneOf(
      isRecord(anchorParam) ? anchorParam.type : undefined,
      RESUME_ANCHORS,
      "billing_cycle_anchor[type]",
    );
    if (!anchor.ok) return sendStripeError(c, anchor.error);
    const behavior = readOneOf(body.payment_behavior, RESUME_PAYMENT_BEHAVIORS, "payment_behavior");
    if (!behavior.ok) return sendStripeError(c, behavior.error);
    const proration = readOneOf(body.proration_behavior, PRORATION_BEHAVIORS, "proration_behavior");
    if (!proration.ok) return sendStripeError(c, proration.error);
    if (body.proration_date !== undefined && body.proration_date !== "" && readInt(body.proration_date) === undefined) {
      return sendStripeError(c, invalid(`Invalid integer: ${String(body.proration_date)}`, "proration_date").error);
    }
    if (sub.status !== "paused") {
      return sendStripeError(
        c,
        invalid(`Only a paused subscription can be resumed. This subscription is ${sub.status}.`).error,
      );
    }
    if (sub.collection_method !== "charge_automatically") {
      return sendStripeError(
        c,
        invalid("Only subscriptions with collection_method=charge_automatically can be resumed.").error,
      );
    }
    if (sub.pending_resume) {
      return sendStripeError(
        c,
        invalid(
          `This subscription is already resuming. Pay or void its resumption invoice (${sub.pending_resume.invoice_id}) first.`,
        ).error,
      );
    }

    const ev = eventBatch(ctx, c);
    const result = resumeSubscription(ctx, ev, sub, {
      anchor: anchor.value ?? "now",
      paymentBehavior: behavior.value ?? "resume_on_payment_attempt",
    });
    if (!result.ok) return sendStripeError(c, result.error);
    await ev.commit();
    return expandedJson(c, render(ss.subscriptions.get(result.sub.id) ?? result.sub), expand, body);
  });

  app.delete("/v1/subscriptions/:id", async (c) => {
    const id = c.req.param("id");
    const sub = ss.subscriptions.findOneBy("stripe_id", id);
    if (!sub) return notFound(c, id);
    if (isEnded(sub)) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `This subscription is already ${sub.status} and cannot be canceled again.`,
      );
    }
    const params = { ...parseStripeQuery(c), ...(await parseStripeBody(c)) };
    const details = readCancellationDetails(params.cancellation_details);
    if (!details.ok) return sendStripeError(c, details.error);
    const ev = eventBatch(ctx, c);
    const canceled = cancelSubscription(ctx, ev, sub, details.value);
    await ev.commit();
    return expandedJson(c, render(canceled), expand, params);
  });
}
