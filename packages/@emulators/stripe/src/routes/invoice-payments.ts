import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { expandedJson, parseStripeQuery, stripeError, stripeList } from "../helpers.js";
import { formatInvoicePayment, stripeExpandResolver } from "../formatters.js";

const PAYMENT_TYPES = ["payment_intent", "payment_record"];

/** InvoicePayments are created by finalizing invoices, so the API only reads them. */
export function invoicePaymentRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);

  app.get("/v1/invoice_payments/:id", (c) => {
    const id = c.req.param("id");
    const payment = ss.invoicePayments.findOneBy("stripe_id", id);
    if (!payment) {
      return stripeError(c, 404, "invalid_request_error", `No such invoice_payment: '${id}'`, "resource_missing", "id");
    }
    return expandedJson(c, formatInvoicePayment(payment), expand);
  });

  app.get("/v1/invoice_payments", (c) => {
    let items = ss.invoicePayments.all();
    const invoice = c.req.query("invoice");
    const status = c.req.query("status");
    const payment = parseStripeQuery(c).payment;
    if (invoice) items = items.filter((p) => p.invoice_id === invoice);
    if (status) items = items.filter((p) => p.status === status);
    if (payment && typeof payment === "object") {
      const filter = payment as Record<string, unknown>;
      if (typeof filter.type !== "string" || !PAYMENT_TYPES.includes(filter.type)) {
        return stripeError(
          c,
          400,
          "invalid_request_error",
          `Invalid payment[type]: must be one of ${PAYMENT_TYPES.join(", ")}`,
          undefined,
          "payment[type]",
        );
      }
      // Only PaymentIntent payments exist in the emulator.
      if (filter.type !== "payment_intent") items = [];
      if (typeof filter.payment_intent === "string") {
        items = items.filter((p) => p.payment_intent_id === filter.payment_intent);
      }
    }
    return stripeList(c, items, "/v1/invoice_payments", formatInvoicePayment, { created: (p) => p.created, expand });
  });
}
