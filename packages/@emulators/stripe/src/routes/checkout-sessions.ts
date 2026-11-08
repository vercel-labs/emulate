import type { Context, RouteContext } from "@emulators/core";
import { renderCardPage, renderCheckoutPage, escapeHtml } from "@emulators/core";
import type { CheckoutLineItem, CheckoutPaymentMethodOption } from "@emulators/core";
import { getStripeStore, type StripeStore } from "../store.js";
import {
  stripeId,
  parseStripeBody,
  stripeError,
  stripeList,
  expandedJson,
  mergeMetadata,
  readEnum,
  readInt,
} from "../helpers.js";
import {
  checkoutHasTrial,
  checkoutLineAmount,
  checkoutLineItemId,
  formatCheckoutLineItem,
  formatCheckoutSession as formatSession,
  stripeExpandResolver,
} from "../formatters.js";
import { eventBatch } from "../events.js";
import { nowFor } from "../clock.js";
import { checkItemSet, intervalText, MAX_TRIAL_SECONDS, meteredQuantityError } from "../subscriptions.js";
import { checkoutCanSkipCard, completeCheckoutSession, DEFAULT_CHECKOUT_CARD, NO_CARD } from "../checkout.js";
import { sendStripeError, type StripeErrorSpec } from "./payment-methods.js";
import type {
  StripeCheckoutLineItem,
  StripeCheckoutSession,
  StripeCheckoutSubscriptionData,
  StripePrice,
} from "../entities.js";

const SERVICE_LABEL = "Stripe";

const MODES = ["payment", "setup", "subscription"] as const;
const CUSTOMER_CREATION = ["always", "if_required"] as const;
const PAYMENT_METHOD_COLLECTION = ["always", "if_required"] as const;
const MISSING_PAYMENT_METHOD = ["cancel", "create_invoice", "pause"] as const;

const DAY = 86400;
const MIN_LIFETIME = 30 * 60;
const MAX_LIFETIME = DAY;
/** A trial set with `subscription_data[trial_end]` must end at least 48 hours from now. */
const MIN_TRIAL_END_LEAD = 2 * DAY;

/** Test cards the hosted page offers, with what each one does. */
const CARD_CHOICES: Array<[string, string]> = [
  ["pm_card_visa", "Visa 4242 4242 4242 4242 (succeeds)"],
  ["pm_card_mastercard", "Mastercard 5555 5555 5555 4444 (succeeds)"],
  ["pm_card_amex", "American Express 3782 822463 10005 (succeeds)"],
  ["pm_card_authenticationRequired", "Visa 4000 0027 6000 3184 (3D Secure on every payment)"],
  ["pm_card_authenticationRequiredOnSetup", "Visa 4000 0025 0000 3155 (3D Secure when saved)"],
  ["pm_card_chargeCustomerFail", "Visa 4000 0000 0000 0341 (saves, later charges decline)"],
  ["pm_card_chargeDeclined", "Visa 4000 0000 0000 0002 (declined)"],
  ["pm_card_chargeDeclinedInsufficientFunds", "Visa 4000 0000 0000 9995 (insufficient funds)"],
];

type Parsed<T> = { ok: true; value: T } | { ok: false; error: StripeErrorSpec };

function invalid(message: string, param?: string, code?: string): { ok: false; error: StripeErrorSpec } {
  return { ok: false, error: { status: 400, type: "invalid_request_error", message, code, param } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readLineItems(
  ss: StripeStore,
  value: unknown,
): Parsed<Array<{ item: StripeCheckoutLineItem; price: StripePrice }>> {
  if (value === undefined) return { ok: true, value: [] };
  const list = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : undefined;
  if (!list) return invalid("line_items must be an array.", "line_items");
  const items: Array<{ item: StripeCheckoutLineItem; price: StripePrice }> = [];
  for (const [i, li] of list.entries()) {
    if (!isRecord(li)) return invalid(`Invalid line_items[${i}]: must be an object.`, `line_items[${i}]`);
    if (!li.price || typeof li.price !== "string") {
      return invalid(`Missing required param: line_items[${i}][price].`, `line_items[${i}][price]`);
    }
    const price = ss.prices.findOneBy("stripe_id", li.price);
    if (!price) return invalid(`No such price: '${li.price}'`, `line_items[${i}][price]`, "resource_missing");
    if (!price.active) {
      return invalid(
        "The price specified is inactive. This field only accepts active prices.",
        `line_items[${i}][price]`,
      );
    }
    // Metered prices bill usage, so a line for one carries no quantity.
    const metered = price.recurring?.usage_type === "metered";
    if (metered && li.quantity !== undefined && li.quantity !== "") {
      return { ok: false, error: meteredQuantityError(`line_items[${i}]`) };
    }
    const quantity = metered ? 1 : readInt(li.quantity);
    if (quantity === undefined || quantity < 1) {
      return invalid(`Invalid line_items[${i}][quantity]: must be a positive integer.`, `line_items[${i}][quantity]`);
    }
    items.push({ item: { stripe_id: stripeId("li"), price: price.stripe_id, quantity }, price });
  }
  return { ok: true, value: items };
}

/** The line item rules of each mode. */
function checkModeItems(mode: StripeCheckoutSession["mode"], prices: StripePrice[]): StripeErrorSpec | undefined {
  if (mode === "payment") {
    if (prices.some((p) => p.type === "recurring")) {
      return invalid(
        "You specified `payment` mode but passed a recurring price. Either switch to `subscription` mode or use only one-time prices.",
        "line_items",
      ).error;
    }
    return undefined;
  }
  if (mode !== "subscription") return undefined;
  if (prices.length === 0)
    return invalid("Missing required param: line_items.", "line_items", "parameter_missing").error;
  const recurring = prices.filter((p) => p.type === "recurring");
  if (recurring.length === 0) {
    return invalid(
      "You must provide at least one recurring price in `subscription` mode when using prices.",
      "line_items",
    ).error;
  }
  if (recurring.length !== prices.length) {
    return invalid("The emulator does not support one-time prices in `subscription` mode.", "line_items").error;
  }
  const set = checkItemSet(recurring);
  return set ? { ...set, param: "line_items" } : undefined;
}

function readSubscriptionData(value: unknown, now: number): Parsed<StripeCheckoutSubscriptionData> {
  if (value === undefined) return { ok: true, value: { metadata: {} } };
  if (!isRecord(value)) return invalid("Invalid subscription_data: must be an object.", "subscription_data");
  const data: StripeCheckoutSubscriptionData = {
    metadata: mergeMetadata({}, value.metadata) ?? {},
    description: readString(value.description),
  };
  const hasEnd = value.trial_end !== undefined && value.trial_end !== "";
  const hasDays = value.trial_period_days !== undefined && value.trial_period_days !== "";
  if (hasEnd && hasDays) {
    return invalid(
      "You may only specify one of these parameters: subscription_data[trial_end], subscription_data[trial_period_days].",
      "subscription_data[trial_end]",
    );
  }
  if (hasDays) {
    const days = readInt(value.trial_period_days);
    if (days === undefined || days < 1 || days > 730) {
      return invalid(
        "Invalid subscription_data[trial_period_days]: must be an integer from 1 to 730.",
        "subscription_data[trial_period_days]",
      );
    }
    data.trial_period_days = days;
  }
  if (hasEnd) {
    const end = readInt(value.trial_end);
    if (end === undefined || end < now + MIN_TRIAL_END_LEAD || end - now > MAX_TRIAL_SECONDS) {
      return invalid(
        "Invalid subscription_data[trial_end]: must be at least 48 hours and at most 730 days in the future.",
        "subscription_data[trial_end]",
      );
    }
    data.trial_end = end;
  }
  const settings = isRecord(value.trial_settings) ? value.trial_settings : undefined;
  const endBehavior = settings && isRecord(settings.end_behavior) ? settings.end_behavior : undefined;
  const missing = endBehavior?.missing_payment_method;
  if (missing !== undefined && missing !== "") {
    const param = "subscription_data[trial_settings][end_behavior][missing_payment_method]";
    if (typeof missing !== "string" || !(MISSING_PAYMENT_METHOD as readonly string[]).includes(missing)) {
      return invalid(`Invalid ${param}: must be one of ${MISSING_PAYMENT_METHOD.join(", ")}`, param);
    }
    data.missing_payment_method = missing as StripeCheckoutSubscriptionData["missing_payment_method"];
  }
  return { ok: true, value: data };
}

export function checkoutSessionRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);

  const notFound = (c: Context) =>
    stripeError(
      c,
      404,
      "invalid_request_error",
      `No such checkout session: '${c.req.param("id")}'`,
      "resource_missing",
    );

  app.post("/v1/checkout/sessions", async (c) => {
    const body = await parseStripeBody(c);
    if (!body.mode)
      return stripeError(c, 400, "invalid_request_error", "Missing required param: mode.", undefined, "mode");
    const modeParam = readEnum(c, body.mode, MODES, "mode");
    if (modeParam.error) return modeParam.error;
    const mode = modeParam.value!;

    const customerId = readString(body.customer);
    if (customerId && !ss.customers.findOneBy("stripe_id", customerId)) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `No such customer: '${customerId}'`,
        "resource_missing",
        "customer",
      );
    }
    const customerEmail = readString(body.customer_email);
    if (customerId && customerEmail) {
      return sendStripeError(
        c,
        invalid("You may only specify one of these parameters: customer, customer_email.", "customer").error,
      );
    }
    const creation = readEnum(c, body.customer_creation, CUSTOMER_CREATION, "customer_creation");
    if (creation.error) return creation.error;
    if (creation.value && mode === "subscription") {
      return sendStripeError(
        c,
        invalid("`customer_creation` can only be used in `payment` and `setup` mode.", "customer_creation").error,
      );
    }
    const collection = readEnum(
      c,
      body.payment_method_collection,
      PAYMENT_METHOD_COLLECTION,
      "payment_method_collection",
    );
    if (collection.error) return collection.error;
    if (collection.value && mode !== "subscription") {
      return sendStripeError(
        c,
        invalid("`payment_method_collection` can only be used in `subscription` mode.", "payment_method_collection")
          .error,
      );
    }
    if (body.subscription_data !== undefined && mode !== "subscription") {
      return sendStripeError(
        c,
        invalid("`subscription_data` can only be used in `subscription` mode.", "subscription_data").error,
      );
    }
    const clientReference = readString(body.client_reference_id);
    if (clientReference && clientReference.length > 200) {
      return sendStripeError(
        c,
        invalid("Invalid client_reference_id: must be at most 200 characters.", "client_reference_id").error,
      );
    }

    const now = nowFor(ss, { customerId });
    const lines = readLineItems(ss, body.line_items);
    if (!lines.ok) return sendStripeError(c, lines.error);
    const modeError = checkModeItems(
      mode,
      lines.value.map((line) => line.price),
    );
    if (modeError) return sendStripeError(c, modeError);
    const subscriptionData = readSubscriptionData(body.subscription_data, now);
    if (!subscriptionData.ok) return sendStripeError(c, subscriptionData.error);

    let expiresAt = now + MAX_LIFETIME;
    if (body.expires_at !== undefined && body.expires_at !== "") {
      const at = readInt(body.expires_at);
      if (at === undefined || at < now + MIN_LIFETIME || at > now + MAX_LIFETIME) {
        return sendStripeError(
          c,
          invalid(
            "The `expires_at` timestamp must be between 30 minutes and 24 hours from Checkout Session creation.",
            "expires_at",
          ).error,
        );
      }
      expiresAt = at;
    }

    // `payment_method_types` was removed from the request in endive and is ignored.
    const draft: Omit<StripeCheckoutSession, "id" | "created_at" | "updated_at"> = {
      stripe_id: stripeId("cs_test", 58),
      mode,
      status: "open",
      payment_status: "unpaid",
      customer_id: customerId ?? null,
      success_url: readString(body.success_url) ?? null,
      cancel_url: readString(body.cancel_url) ?? null,
      line_items: lines.value.map((line) => line.item),
      metadata: mergeMetadata({}, body.metadata) ?? {},
      created: now,
      expires_at: expiresAt,
      client_reference_id: clientReference,
      customer_email: customerEmail,
      customer_creation: customerId
        ? undefined
        : mode === "subscription"
          ? "always"
          : (creation.value ?? "if_required"),
      payment_method_collection: mode === "subscription" ? (collection.value ?? "always") : undefined,
      subscription_data: mode === "subscription" ? subscriptionData.value : undefined,
    };
    if (lines.value.length > 0) {
      const sessionLike = draft as StripeCheckoutSession;
      const amount = lines.value.reduce(
        (sum, line) => sum + checkoutLineAmount(sessionLike, line.price, line.item.quantity),
        0,
      );
      draft.currency = lines.value[0].price.currency;
      draft.amount_subtotal = amount;
      draft.amount_total = amount;
    }
    const session = ss.checkoutSessions.insert(draft);
    return expandedJson(c, formatSession(session, baseUrl), expand, body);
  });

  app.get("/v1/checkout/sessions/:id/line_items", (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session) return notFound(c);
    const rows = session.line_items.map((_, index) => ({
      id: index + 1,
      stripe_id: checkoutLineItemId(session, index),
      created_at: session.created_at,
      updated_at: session.updated_at,
      index,
    }));
    return stripeList(
      c,
      rows,
      `/v1/checkout/sessions/${session.stripe_id}/line_items`,
      (row) => formatCheckoutLineItem(ss, session, row.index),
      { expand, order: "oldest_first" },
    );
  });

  app.get("/v1/checkout/sessions/:id", (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session) return notFound(c);
    return expandedJson(c, formatSession(session, baseUrl), expand);
  });

  app.post("/v1/checkout/sessions/:id/expire", async (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session) return notFound(c);
    if (session.status !== "open") {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "Only open sessions can be expired.",
        "checkout_session_not_open",
      );
    }
    const body = await parseStripeBody(c);
    const updated = ss.checkoutSessions.update(session.id, { status: "expired" })!;

    const ev = eventBatch(ctx, c);
    ev.emit("checkout.session.expired", formatSession(updated, baseUrl));
    await ev.commit();

    return expandedJson(c, formatSession(updated, baseUrl), expand, body);
  });

  app.get("/v1/checkout/sessions", (c) => {
    let items = ss.checkoutSessions.all();
    const customerId = c.req.query("customer");
    const status = c.req.query("status");
    const paymentStatus = c.req.query("payment_status");
    const subscription = c.req.query("subscription");
    const paymentIntent = c.req.query("payment_intent");
    if (customerId) items = items.filter((s) => s.customer_id === customerId);
    if (status) items = items.filter((s) => s.status === status);
    if (paymentStatus) items = items.filter((s) => s.payment_status === paymentStatus);
    if (subscription) items = items.filter((s) => s.subscription_id === subscription);
    if (paymentIntent) items = items.filter((s) => s.payment_intent_id === paymentIntent);
    return stripeList(c, items, "/v1/checkout/sessions", (s) => formatSession(s, baseUrl), {
      created: (s) => s.created ?? formatSession(s, baseUrl).created,
      expand,
    });
  });

  const renderSession = (
    session: StripeCheckoutSession,
    options: { errorMessage?: string; email?: string; paymentMethod?: string } = {},
  ) => {
    const lineItems: CheckoutLineItem[] = session.line_items.map((li) => {
      const priceObj = ss.prices.findOneBy("stripe_id", li.price);
      const product = priceObj ? ss.products.findOneBy("stripe_id", priceObj.product_id) : undefined;
      const unitPrice = priceObj?.unit_amount ?? 0;
      const recurring = priceObj?.recurring;
      // Usage is billed later, so a metered line adds nothing to what is due today.
      const metered = recurring?.usage_type === "metered";
      return {
        name: product?.name ?? li.price,
        quantity: li.quantity,
        unitPrice,
        totalPrice: metered ? 0 : unitPrice * li.quantity,
        currency: priceObj?.currency ?? "usd",
        intervalLabel: recurring ? intervalText(recurring.interval, recurring.interval_count) : undefined,
      };
    });

    const subtotal = lineItems.reduce((sum, li) => sum + li.totalPrice, 0);
    const currency = lineItems.length > 0 ? lineItems[0].currency : "usd";
    const subscription = session.mode === "subscription";
    const total = subscription ? (session.amount_total ?? 0) : subtotal;
    const chosen = options.paymentMethod ?? DEFAULT_CHECKOUT_CARD;
    const paymentMethodOptions: CheckoutPaymentMethodOption[] = CARD_CHOICES.map(([value, label]) => ({
      value,
      label,
      selected: value === chosen,
    }));
    if (checkoutCanSkipCard(session)) {
      paymentMethodOptions.push({
        value: NO_CARD,
        label: "No card (start the free trial)",
        selected: chosen === NO_CARD,
      });
    }
    const customer = session.customer_id ? ss.customers.findOneBy("stripe_id", session.customer_id) : undefined;

    return renderCheckoutPage(
      {
        lineItems,
        subtotal,
        total,
        currency,
        sessionId: session.stripe_id,
        cancelUrl: session.cancel_url,
        paymentMethodOptions,
        email: customer?.email ?? options.email ?? session.customer_email,
        errorMessage: options.errorMessage,
        submitLabel: subscription ? (checkoutHasTrial(session) ? "Start trial" : "Subscribe") : undefined,
      },
      SERVICE_LABEL,
    );
  };

  app.get("/checkout/:id", (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session) {
      return c.html(
        renderCardPage(
          "Session Not Found",
          "This checkout session does not exist.",
          '<p class="empty">The session ID is invalid or has been removed.</p>',
          SERVICE_LABEL,
        ),
        404,
      );
    }
    if (session.status !== "open") {
      return c.html(
        renderCardPage(
          "Session Expired",
          "This checkout session is no longer available.",
          `<p class="empty">Status: ${escapeHtml(session.status)}</p>`,
          SERVICE_LABEL,
        ),
      );
    }
    return c.html(renderSession(session));
  });

  app.post("/checkout/:id/complete", async (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session || session.status !== "open") {
      return c.redirect("/checkout/" + c.req.param("id"));
    }
    const form = await parseStripeBody(c);
    const paymentMethod = readString(form.payment_method);
    const email = readString(form.email);

    let updated: StripeCheckoutSession;
    if (session.mode === "setup") {
      updated = ss.checkoutSessions.update(session.id, { status: "complete", payment_status: "paid" })!;
      // Completed on the hosted page, not through the API, so the event carries no request.
      const ev = eventBatch(ctx);
      ev.emit("checkout.session.completed", formatSession(updated, baseUrl));
      await ev.commit();
    } else {
      const result = await completeCheckoutSession(ctx, session, { paymentMethod, email });
      if (!result.ok) {
        const status = result.status === 402 ? 402 : 400;
        return c.html(renderSession(session, { errorMessage: result.message, email, paymentMethod }), status);
      }
      updated = result.session;
    }

    if (session.success_url) {
      const url = session.success_url.replace("{CHECKOUT_SESSION_ID}", updated.stripe_id);
      return c.redirect(url);
    }

    return c.html(
      renderCardPage(
        "Payment Complete",
        "Your payment was successful.",
        '<p class="empty check">Payment received</p>',
        SERVICE_LABEL,
      ),
    );
  });
}
