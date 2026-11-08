import type { Context, RouteContext } from "@emulators/core";
import { getStripeStore, type StripeStore } from "../store.js";
import {
  expandedJson,
  parseStripeBody,
  readInt,
  stripeError,
  stripeId,
  stripeList,
  type StripeErrorExtras,
} from "../helpers.js";
import { formatCustomer, formatPaymentMethod, stripeExpandResolver } from "../formatters.js";
import { eventBatch, previousAttributes } from "../events.js";
import { nowFor } from "../clock.js";
import {
  errorDocUrl,
  rawNumberError,
  testCardByNumber,
  testCardByPaymentMethod,
  testCardByToken,
  type CardDecline,
  type TestCard,
} from "../test-cards.js";
import type {
  StripeAddress,
  StripeBillingDetails,
  StripeCustomer,
  StripePaymentMethod,
  StripePaymentMethodCard,
} from "../entities.js";

/** A Stripe error described as data, so shared logic can fail without a request context. */
export interface StripeErrorSpec {
  status: number;
  type: "invalid_request_error" | "card_error";
  message: string;
  code?: string;
  param?: string;
  extras?: StripeErrorExtras;
}

export function sendStripeError(c: Context, spec: StripeErrorSpec) {
  return stripeError(c, spec.status, spec.type, spec.message, spec.code, spec.param, spec.extras);
}

/** The 402 card_error Stripe returns for a decline. */
export function cardError(decline: CardDecline, extras: StripeErrorExtras = {}): StripeErrorSpec {
  return {
    status: 402,
    type: "card_error",
    message: decline.message,
    code: decline.code,
    param: decline.param,
    extras: { decline_code: decline.decline_code, doc_url: errorDocUrl(decline.code), ...extras },
  };
}

function noSuchPaymentMethod(id: string, param = "payment_method"): StripeErrorSpec {
  return {
    status: 404,
    type: "invalid_request_error",
    message: `No such PaymentMethod: '${id}'`,
    code: "resource_missing",
    param,
  };
}

/** Test card magic ids get an expiry a year from now, like the cards Stripe generates for them. */
function defaultExpiry(): Pick<StripePaymentMethodCard, "exp_month" | "exp_year"> {
  const now = new Date();
  return { exp_month: now.getUTCMonth() + 1, exp_year: now.getUTCFullYear() + 1 };
}

export function insertCardPaymentMethod(
  ss: StripeStore,
  testCard: TestCard,
  fields: Partial<Pick<StripePaymentMethod, "customer_id" | "billing_details" | "metadata" | "allow_redisplay">> & {
    card?: Partial<StripePaymentMethodCard>;
  } = {},
): StripePaymentMethod {
  return ss.paymentMethods.insert({
    stripe_id: stripeId("pm"),
    type: "card",
    customer_id: fields.customer_id,
    card: { number: testCard.number, ...defaultExpiry(), ...fields.card },
    billing_details: fields.billing_details ?? {},
    allow_redisplay: fields.allow_redisplay ?? "unspecified",
    metadata: fields.metadata ?? {},
    created: nowFor(ss, { customerId: fields.customer_id }),
  });
}

/** The test card behind a stored payment method. Every stored card comes from the table. */
export function testCardOf(pm: StripePaymentMethod): TestCard | undefined {
  return testCardByNumber(pm.card.number);
}

export interface AttachOutcome {
  pm: StripePaymentMethod;
  /** False when the payment method already belonged to this customer. */
  attached: boolean;
}

/**
 * Attach a stored payment method or a magic test id (which clones into a new `pm_`) to a
 * customer. Every check runs before anything is written, so a failure stores nothing.
 */
export function attachPaymentMethod(
  ss: StripeStore,
  id: string,
  customerId: string,
): { ok: true; value: AttachOutcome } | { ok: false; error: StripeErrorSpec } {
  const magic = testCardByPaymentMethod(id);
  if (magic) {
    if (magic.attach === "decline" && magic.decline) return { ok: false, error: cardError(magic.decline) };
    const pm = insertCardPaymentMethod(ss, magic, { customer_id: customerId, card: { cvc_check: "pass" } });
    return { ok: true, value: { pm, attached: true } };
  }

  const pm = ss.paymentMethods.findOneBy("stripe_id", id);
  if (!pm) return { ok: false, error: noSuchPaymentMethod(id) };
  if (pm.detached) {
    return {
      ok: false,
      error: {
        status: 400,
        type: "invalid_request_error",
        message:
          "This PaymentMethod was previously used without being attached to a Customer or was detached from a Customer, and may not be used again.",
      },
    };
  }
  if (pm.customer_id === customerId) return { ok: true, value: { pm, attached: false } };
  if (pm.customer_id) {
    return {
      ok: false,
      error: {
        status: 400,
        type: "invalid_request_error",
        message: "The payment method you provided has already been attached to a customer.",
      },
    };
  }
  const testCard = testCardOf(pm);
  if (testCard?.attach === "decline" && testCard.decline) return { ok: false, error: cardError(testCard.decline) };

  const updated = ss.paymentMethods.update(pm.id, {
    customer_id: customerId,
    card: { ...pm.card, cvc_check: pm.card.cvc_check === "unchecked" ? "pass" : pm.card.cvc_check },
  })!;
  return { ok: true, value: { pm: updated, attached: true } };
}

/** The 400 for a default payment method that does not belong to the customer. */
export function notCustomersPaymentMethod(id: string): StripeErrorSpec {
  return {
    status: 400,
    type: "invalid_request_error",
    message: `The customer does not have a payment method with the ID ${id}. The payment method must be attached to the customer.`,
    code: "resource_missing",
    param: "invoice_settings[default_payment_method]",
  };
}

/** Detach every payment method of a customer that is being deleted. No events are sent for them. */
export function detachCustomerPaymentMethods(ss: StripeStore, customerId: string): void {
  for (const pm of ss.paymentMethods.findBy("customer_id", customerId)) {
    ss.paymentMethods.update(pm.id, { customer_id: undefined, detached: true });
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const ADDRESS_KEYS = ["city", "country", "line1", "line2", "postal_code", "state"] as const;

/** Merge a `billing_details` param into existing details. An empty string clears a field. */
function mergeBillingDetails(current: StripeBillingDetails, input: unknown): StripeBillingDetails {
  if (!input || typeof input !== "object") return current;
  const raw = input as Record<string, unknown>;
  const next: StripeBillingDetails = { ...current };
  for (const key of ["email", "name", "phone"] as const) {
    const value = readString(raw[key]);
    if (value !== undefined) next[key] = value === "" ? undefined : value;
  }
  if (raw.address && typeof raw.address === "object") {
    const rawAddress = raw.address as Record<string, unknown>;
    const address: StripeAddress = { ...current.address };
    for (const key of ADDRESS_KEYS) {
      const value = readString(rawAddress[key]);
      if (value !== undefined) address[key] = value === "" ? undefined : value;
    }
    next.address = address;
  }
  return next;
}

/** Stripe's metadata update: keys merge in, and an empty string removes a key. */
export function mergeMetadata(current: Record<string, string>, input: unknown): Record<string, string> {
  if (input === "") return {};
  if (!input || typeof input !== "object") return current;
  const next = { ...current };
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === "" || value === null) delete next[key];
    else next[key] = String(value);
  }
  return next;
}

function readAllowRedisplay(value: unknown): StripePaymentMethod["allow_redisplay"] | undefined {
  return value === "always" || value === "limited" || value === "unspecified" ? value : undefined;
}

export function paymentMethodRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);

  app.post("/v1/payment_methods", async (c) => {
    const body = await parseStripeBody(c);
    if (body.type === undefined) {
      return stripeError(c, 400, "invalid_request_error", "Missing required param: type.", "parameter_missing", "type");
    }
    if (body.type !== "card") {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `Invalid type: the emulator supports only card payment methods, not '${String(body.type)}'.`,
        undefined,
        "type",
      );
    }
    const card = (body.card && typeof body.card === "object" ? body.card : {}) as Record<string, unknown>;
    const token = readString(card.token);
    const number = readString(card.number);

    let testCard: TestCard | undefined;
    let cardFields: Partial<StripePaymentMethodCard> = {};
    if (token !== undefined) {
      testCard = testCardByToken(token);
      if (!testCard) {
        return stripeError(
          c,
          400,
          "invalid_request_error",
          `No such token: '${token}'`,
          "resource_missing",
          "card[token]",
        );
      }
    } else if (number !== undefined) {
      const rejected = rawNumberError(number);
      if (rejected) return sendStripeError(c, cardError(rejected));
      testCard = testCardByNumber(number)!;
      const expMonth = readInt(card.exp_month);
      const expYear = readInt(card.exp_year);
      if (expMonth === undefined || expYear === undefined) {
        const param = expMonth === undefined ? "card[exp_month]" : "card[exp_year]";
        return stripeError(
          c,
          400,
          "invalid_request_error",
          `Missing required param: ${param}.`,
          "parameter_missing",
          param,
        );
      }
      cardFields = {
        exp_month: expMonth,
        exp_year: expYear,
        cvc_check: readString(card.cvc) ? "unchecked" : undefined,
      };
    } else {
      return stripeError(c, 400, "invalid_request_error", "Missing required param: card.", "parameter_missing", "card");
    }

    const pm = insertCardPaymentMethod(ss, testCard, {
      card: cardFields,
      billing_details: mergeBillingDetails({}, body.billing_details),
      metadata: mergeMetadata({}, body.metadata),
      allow_redisplay: readAllowRedisplay(body.allow_redisplay),
    });
    return expandedJson(c, formatPaymentMethod(pm), expand, body);
  });

  app.get("/v1/payment_methods/:id", (c) => {
    const id = c.req.param("id");
    const magic = testCardByPaymentMethod(id);
    // A magic id stands for a fresh card each time it is used, as it does on Stripe.
    const pm = magic ? insertCardPaymentMethod(ss, magic) : ss.paymentMethods.findOneBy("stripe_id", id);
    if (!pm) return sendStripeError(c, noSuchPaymentMethod(id));
    return expandedJson(c, formatPaymentMethod(pm), expand);
  });

  app.post("/v1/payment_methods/:id", async (c) => {
    const id = c.req.param("id");
    const pm = ss.paymentMethods.findOneBy("stripe_id", id);
    if (!pm) return sendStripeError(c, noSuchPaymentMethod(id));
    const body = await parseStripeBody(c);
    if (!pm.customer_id) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "You must save this PaymentMethod to a customer before you can update it.",
      );
    }

    const card = (body.card && typeof body.card === "object" ? body.card : {}) as Record<string, unknown>;
    const expMonth = readInt(card.exp_month);
    const expYear = readInt(card.exp_year);
    const updated = ss.paymentMethods.update(pm.id, {
      billing_details: mergeBillingDetails(pm.billing_details, body.billing_details),
      metadata: mergeMetadata(pm.metadata, body.metadata),
      allow_redisplay: readAllowRedisplay(body.allow_redisplay) ?? pm.allow_redisplay,
      card: {
        ...pm.card,
        ...(expMonth !== undefined && { exp_month: expMonth }),
        ...(expYear !== undefined && { exp_year: expYear }),
      },
    })!;

    const previous = previousAttributes(formatPaymentMethod(pm), formatPaymentMethod(updated));
    if (Object.keys(previous).length > 0) {
      const ev = eventBatch(ctx, c);
      ev.emit("payment_method.updated", formatPaymentMethod(updated), previous);
      await ev.commit();
    }
    return expandedJson(c, formatPaymentMethod(updated), expand, body);
  });

  app.post("/v1/payment_methods/:id/attach", async (c) => {
    const id = c.req.param("id");
    const body = await parseStripeBody(c);
    if (!testCardByPaymentMethod(id) && !ss.paymentMethods.findOneBy("stripe_id", id)) {
      return sendStripeError(c, noSuchPaymentMethod(id));
    }
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

    const result = attachPaymentMethod(ss, id, customerId);
    if (!result.ok) return sendStripeError(c, result.error);
    if (result.value.attached) {
      const ev = eventBatch(ctx, c);
      ev.emit("payment_method.attached", formatPaymentMethod(result.value.pm));
      await ev.commit();
    }
    return expandedJson(c, formatPaymentMethod(result.value.pm), expand, body);
  });

  app.post("/v1/payment_methods/:id/detach", async (c) => {
    const id = c.req.param("id");
    const body = await parseStripeBody(c);
    const pm = ss.paymentMethods.findOneBy("stripe_id", id);
    if (!pm && !testCardByPaymentMethod(id)) return sendStripeError(c, noSuchPaymentMethod(id));
    if (!pm?.customer_id) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "The payment method you provided is not attached to a customer so detachment is impossible.",
      );
    }

    const before = formatPaymentMethod(pm);
    const detached = ss.paymentMethods.update(pm.id, { customer_id: undefined, detached: true })!;
    const ev = eventBatch(ctx, c);
    ev.emit("payment_method.detached", formatPaymentMethod(detached), { customer: before.customer });

    // A detached card cannot stay the customer's default.
    const customer = ss.customers.findOneBy("stripe_id", pm.customer_id);
    if (customer && customer.invoice_settings?.default_payment_method === pm.stripe_id) {
      const cleared = ss.customers.update(customer.id, {
        invoice_settings: { ...customer.invoice_settings, default_payment_method: undefined },
      })!;
      ev.emit(
        "customer.updated",
        formatCustomer(cleared),
        previousAttributes(formatCustomer(customer), formatCustomer(cleared)),
      );
    }
    await ev.commit();
    return expandedJson(c, formatPaymentMethod(detached), expand, body);
  });

  const listFor = (c: Context, items: StripePaymentMethod[], url: string) => {
    const type = c.req.query("type");
    const filtered = type ? items.filter((pm) => pm.type === type) : items;
    return stripeList(c, filtered, url, formatPaymentMethod, { created: (pm) => pm.created, expand });
  };

  app.get("/v1/payment_methods", (c) => {
    const customerId = c.req.query("customer");
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
    const items = customerId ? ss.paymentMethods.findBy("customer_id", customerId) : ss.paymentMethods.all();
    return listFor(c, items, "/v1/payment_methods");
  });

  const findCustomer = (c: Context): StripeCustomer | Response => {
    const id = c.req.param("id")!;
    return (
      ss.customers.findOneBy("stripe_id", id) ??
      stripeError(c, 404, "invalid_request_error", `No such customer: '${id}'`, "resource_missing", "customer")
    );
  };

  app.get("/v1/customers/:id/payment_methods", (c) => {
    const customer = findCustomer(c);
    if (customer instanceof Response) return customer;
    return listFor(
      c,
      ss.paymentMethods.findBy("customer_id", customer.stripe_id),
      `/v1/customers/${customer.stripe_id}/payment_methods`,
    );
  });

  app.get("/v1/customers/:id/payment_methods/:pm", (c) => {
    const customer = findCustomer(c);
    if (customer instanceof Response) return customer;
    const id = c.req.param("pm");
    const pm = ss.paymentMethods.findOneBy("stripe_id", id);
    if (!pm || pm.customer_id !== customer.stripe_id) return sendStripeError(c, noSuchPaymentMethod(id));
    return expandedJson(c, formatPaymentMethod(pm), expand);
  });
}
