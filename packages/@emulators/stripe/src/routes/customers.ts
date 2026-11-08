import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import {
  stripeId,
  parseStripeBody,
  stripeError,
  stripeList,
  expandedJson,
  generateInvoicePrefix,
  toUnixTimestamp,
} from "../helpers.js";
import { clockCustomers, MAX_CLOCK_CUSTOMERS } from "../clock.js";
import { formatCustomer, formatPaymentMethod, stripeExpandResolver } from "../formatters.js";
import { eventBatch, previousAttributes } from "../events.js";
import { testCardByPaymentMethod } from "../test-cards.js";
import { cancelSubscription, isEnded } from "../subscriptions.js";
import {
  attachPaymentMethod,
  detachCustomerPaymentMethods,
  notCustomersPaymentMethod,
  sendStripeError,
} from "./payment-methods.js";

import type { StripePaymentMethod } from "../entities.js";

const INVOICE_PREFIX = /^[A-Z0-9]{3,12}$/;

/** The `invoice_settings[default_payment_method]` param: a string id, "" to clear, or undefined when absent. */
function readDefaultPaymentMethod(body: Record<string, unknown>): string | undefined {
  const settings = body.invoice_settings;
  if (!settings || typeof settings !== "object") return undefined;
  const value = (settings as Record<string, unknown>).default_payment_method;
  return typeof value === "string" ? value : undefined;
}

function invalidInvoicePrefix(prefix: unknown) {
  return typeof prefix === "string" && !INVOICE_PREFIX.test(prefix);
}

export function customerRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);

  app.post("/v1/customers", async (c) => {
    const body = await parseStripeBody(c);
    const paymentMethod = typeof body.payment_method === "string" ? body.payment_method : undefined;
    const defaultPaymentMethod = readDefaultPaymentMethod(body);

    if (invalidInvoicePrefix(body.invoice_prefix)) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "Invalid invoice_prefix: must be 3 to 12 uppercase letters or numbers.",
        undefined,
        "invoice_prefix",
      );
    }
    // A new customer owns only the payment method attached in this same call.
    if (defaultPaymentMethod && defaultPaymentMethod !== paymentMethod) {
      return sendStripeError(c, notCustomersPaymentMethod(defaultPaymentMethod));
    }
    const testClockId = typeof body.test_clock === "string" && body.test_clock !== "" ? body.test_clock : undefined;
    const testClock = testClockId ? ss.testClocks.findOneBy("stripe_id", testClockId) : undefined;
    if (testClockId && !testClock) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `No such test_clock: '${testClockId}'`,
        "resource_missing",
        "test_clock",
      );
    }
    if (testClock && clockCustomers(ss, testClock.stripe_id).length >= MAX_CLOCK_CUSTOMERS) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `A test clock can have at most ${MAX_CLOCK_CUSTOMERS} customers.`,
        undefined,
        "test_clock",
      );
    }
    if (paymentMethod && !testCardByPaymentMethod(paymentMethod)) {
      const stored = ss.paymentMethods.findOneBy("stripe_id", paymentMethod);
      if (!stored) {
        return stripeError(
          c,
          400,
          "invalid_request_error",
          `No such PaymentMethod: '${paymentMethod}'`,
          "resource_missing",
          "payment_method",
        );
      }
    }

    const customer = ss.customers.insert({
      stripe_id: stripeId("cus"),
      email: (body.email as string) ?? null,
      name: (body.name as string) ?? null,
      description: (body.description as string) ?? null,
      metadata: (body.metadata as Record<string, string>) ?? {},
      invoice_prefix: typeof body.invoice_prefix === "string" ? body.invoice_prefix : generateInvoicePrefix(),
      next_invoice_sequence: 1,
      delinquent: false,
      ...(testClock && { test_clock: testClock.stripe_id, created: testClock.frozen_time }),
    });

    let attached: StripePaymentMethod | undefined;
    if (paymentMethod) {
      const result = attachPaymentMethod(ss, paymentMethod, customer.stripe_id);
      if (!result.ok) {
        ss.customers.delete(customer.id);
        return sendStripeError(c, result.error);
      }
      attached = result.value.pm;
    }

    const created =
      attached && defaultPaymentMethod
        ? ss.customers.update(customer.id, { invoice_settings: { default_payment_method: attached.stripe_id } })!
        : customer;

    const ev = eventBatch(ctx, c);
    ev.emit("customer.created", formatCustomer(created));
    if (attached) ev.emit("payment_method.attached", formatPaymentMethod(attached));
    await ev.commit();

    return expandedJson(c, formatCustomer(created), expand, body);
  });

  app.get("/v1/customers/:id", (c) => {
    const customer = ss.customers.findOneBy("stripe_id", c.req.param("id"));
    if (!customer)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such customer: '${c.req.param("id")}'`,
        "resource_missing",
      );
    return expandedJson(c, formatCustomer(customer), expand);
  });

  app.post("/v1/customers/:id", async (c) => {
    const customer = ss.customers.findOneBy("stripe_id", c.req.param("id"));
    if (!customer)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such customer: '${c.req.param("id")}'`,
        "resource_missing",
      );
    const body = await parseStripeBody(c);

    if (invalidInvoicePrefix(body.invoice_prefix)) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "Invalid invoice_prefix: must be 3 to 12 uppercase letters or numbers.",
        undefined,
        "invoice_prefix",
      );
    }
    const defaultPaymentMethod = readDefaultPaymentMethod(body);
    if (defaultPaymentMethod) {
      const pm = ss.paymentMethods.findOneBy("stripe_id", defaultPaymentMethod);
      if (!pm || pm.customer_id !== customer.stripe_id) {
        return sendStripeError(c, notCustomersPaymentMethod(defaultPaymentMethod));
      }
    }

    const updated = ss.customers.update(customer.id, {
      ...(body.email !== undefined && { email: body.email as string }),
      ...(body.name !== undefined && { name: body.name as string }),
      ...(body.description !== undefined && { description: body.description as string }),
      ...(body.metadata !== undefined && { metadata: body.metadata as Record<string, string> }),
      ...(typeof body.invoice_prefix === "string" && { invoice_prefix: body.invoice_prefix }),
      ...(defaultPaymentMethod !== undefined && {
        invoice_settings: {
          ...customer.invoice_settings,
          default_payment_method: defaultPaymentMethod === "" ? undefined : defaultPaymentMethod,
        },
      }),
    })!;

    const previous = previousAttributes(formatCustomer(customer), formatCustomer(updated));
    if (Object.keys(previous).length > 0) {
      const ev = eventBatch(ctx, c);
      ev.emit("customer.updated", formatCustomer(updated), previous);
      await ev.commit();
    }

    return expandedJson(c, formatCustomer(updated), expand, body);
  });

  app.delete("/v1/customers/:id", async (c) => {
    const customer = ss.customers.findOneBy("stripe_id", c.req.param("id"));
    if (!customer)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such customer: '${c.req.param("id")}'`,
        "resource_missing",
      );

    const ev = eventBatch(ctx, c);
    // Deleting a customer cancels its subscriptions, each with customer.subscription.deleted.
    for (const sub of ss.subscriptions.findBy("customer_id", customer.stripe_id)) {
      if (!isEnded(sub)) cancelSubscription(ctx, ev, sub);
    }

    // Cascade: nullify customer_id on related entities
    for (const pi of ss.paymentIntents.findBy("customer_id", customer.stripe_id)) {
      ss.paymentIntents.update(pi.id, { customer_id: null });
    }
    for (const ch of ss.charges.findBy("customer_id", customer.stripe_id)) {
      ss.charges.update(ch.id, { customer_id: null });
    }
    for (const cs of ss.checkoutSessions.findBy("customer_id", customer.stripe_id)) {
      ss.checkoutSessions.update(cs.id, { customer_id: null });
    }
    detachCustomerPaymentMethods(ss, customer.stripe_id);

    ss.customers.delete(customer.id);

    ev.emit("customer.deleted", { ...formatCustomer(customer), deleted: true });
    await ev.commit();

    return c.json({ id: customer.stripe_id, object: "customer", deleted: true });
  });

  app.get("/v1/customers", (c) => {
    // Customers on a test clock are listed only when the clock is named.
    const testClock = c.req.query("test_clock");
    let items = ss.customers.all().filter((cust) => (testClock ? cust.test_clock === testClock : !cust.test_clock));
    const email = c.req.query("email");
    if (email) items = items.filter((cust) => cust.email === email);
    return stripeList(c, items, "/v1/customers", formatCustomer, {
      created: (cust) => cust.created ?? toUnixTimestamp(cust.created_at),
      expand,
    });
  });
}
