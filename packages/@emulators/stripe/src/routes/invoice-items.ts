import type { Context, RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import {
  expandedJson,
  mergeMetadata,
  parseStripeBody,
  readBool,
  readInt,
  readNumber,
  stripeError,
  stripeId,
  stripeList,
} from "../helpers.js";
import { formatInvoice, formatInvoiceItem, stripeExpandResolver } from "../formatters.js";
import { eventBatch } from "../events.js";
import { nowFor } from "../clock.js";
import { attachInvoiceItem, emitDraftChange, invoiceNotEditable, syncInvoiceItemLine } from "../invoicing.js";
import { sendStripeError } from "./payment-methods.js";
import type { StripeInvoice, StripeInvoiceItem, StripePrice } from "../entities.js";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `pricing[price]`, the endive way to invoice an existing price. */
function readPricingPrice(body: Record<string, unknown>): string | undefined {
  const pricing = body.pricing;
  if (!pricing || typeof pricing !== "object") return undefined;
  return readString((pricing as Record<string, unknown>).price);
}

function readPeriod(value: unknown): { start?: number; end?: number } {
  if (!value || typeof value !== "object") return {};
  const period = value as Record<string, unknown>;
  return { start: readInt(period.start), end: readInt(period.end) };
}

/** Render a unit amount the way Stripe's decimal strings do: no trailing zeros. */
function decimalString(value: number): string {
  return String(Number(value.toFixed(12)));
}

export function invoiceItemRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);

  const notFound = (c: Context, id: string) =>
    stripeError(c, 404, "invalid_request_error", `No such invoiceitem: '${id}'`, "resource_missing", "id");

  const badParam = (c: Context, message: string, param: string, code?: string) =>
    stripeError(c, 400, "invalid_request_error", message, code, param);

  /** The invoice an item sits on, if it is anything other than a draft. */
  const lockedInvoice = (item: StripeInvoiceItem): StripeInvoice | undefined => {
    if (!item.invoice_id) return undefined;
    const inv = ss.invoices.findOneBy("stripe_id", item.invoice_id);
    return inv && inv.status !== "draft" ? inv : undefined;
  };

  const priceById = (c: Context, priceId: string): { price?: StripePrice; error?: Response } => {
    const price = ss.prices.findOneBy("stripe_id", priceId);
    if (!price) return { error: badParam(c, `No such price: '${priceId}'`, "pricing[price]", "resource_missing") };
    if (price.unit_amount === null) {
      return { error: badParam(c, `The price ${priceId} has no unit_amount.`, "pricing[price]") };
    }
    return { price };
  };

  app.post("/v1/invoiceitems", async (c) => {
    const body = await parseStripeBody(c);
    const customerId = readString(body.customer);
    if (!customerId) return badParam(c, "Missing required param: customer.", "customer", "parameter_missing");
    const customer = ss.customers.findOneBy("stripe_id", customerId);
    if (!customer) return badParam(c, `No such customer: '${customerId}'`, "customer", "resource_missing");

    let inv: StripeInvoice | undefined;
    const invoiceId = readString(body.invoice);
    if (invoiceId) {
      inv = ss.invoices.findOneBy("stripe_id", invoiceId);
      if (!inv) return badParam(c, `No such invoice: '${invoiceId}'`, "invoice", "resource_missing");
      if (inv.customer_id !== customerId) {
        return badParam(c, "The invoice belongs to a different customer than the invoice item.", "invoice");
      }
      if (inv.status !== "draft") return sendStripeError(c, invoiceNotEditable(inv));
    }

    const quantity = readInt(body.quantity) ?? 1;
    if (quantity < 0) return badParam(c, "Invalid quantity: must be at least 0.", "quantity");

    let price: StripePrice | undefined;
    const priceId = readPricingPrice(body);
    if (priceId) {
      const found = priceById(c, priceId);
      if (found.error) return found.error;
      price = found.price;
    }

    const requestedCurrency = readString(body.currency)?.toLowerCase();
    const currency = price?.currency ?? requestedCurrency ?? inv?.currency;
    let amount: number | undefined;
    let unitAmountDecimal: string | undefined;
    if (price) {
      if (requestedCurrency && requestedCurrency !== price.currency) {
        return badParam(
          c,
          `The currency ${requestedCurrency} does not match the price's currency ${price.currency}.`,
          "currency",
        );
      }
      amount = price.unit_amount! * quantity;
      unitAmountDecimal = String(price.unit_amount);
    } else if (readInt(body.amount) !== undefined) {
      amount = readInt(body.amount)!;
      unitAmountDecimal = decimalString(quantity > 0 ? amount / quantity : amount);
    } else if (readNumber(body.unit_amount_decimal) !== undefined) {
      const unit = readNumber(body.unit_amount_decimal)!;
      amount = Math.round(unit * quantity);
      unitAmountDecimal = decimalString(unit);
    }
    if (amount === undefined) {
      return badParam(c, "You must specify either `amount`, `pricing[price]` or `unit_amount_decimal`.", "amount");
    }
    if (!currency) return badParam(c, "Missing required param: currency.", "currency", "parameter_missing");
    if (inv && inv.currency !== currency) {
      return badParam(c, `The currency ${currency} does not match the invoice's currency ${inv.currency}.`, "currency");
    }

    const now = nowFor(ss, { customerId });
    const period = readPeriod(body.period);
    const product = price ? ss.products.findOneBy("stripe_id", price.product_id) : undefined;
    const item = ss.invoiceItems.insert({
      stripe_id: stripeId("ii"),
      customer_id: customerId,
      amount,
      currency,
      description: readString(body.description) ?? product?.name,
      discountable: readBool(body.discountable) ?? amount >= 0,
      metadata: mergeMetadata({}, body.metadata) ?? {},
      period: { start: period.start ?? now, end: period.end ?? period.start ?? now },
      price_id: price?.stripe_id,
      product_id: price?.product_id,
      unit_amount_decimal: unitAmountDecimal!,
      quantity,
      proration: false,
      date: now,
      test_clock: customer.test_clock,
    });

    const ev = eventBatch(ctx, c);
    if (inv) {
      const before = formatInvoice(ss, inv, baseUrl);
      const attached = attachInvoiceItem(ss, item, inv);
      ev.emit("invoiceitem.created", formatInvoiceItem(attached));
      emitDraftChange(ctx, ev, inv, before);
      await ev.commit();
      return expandedJson(c, formatInvoiceItem(attached), expand, body);
    }
    ev.emit("invoiceitem.created", formatInvoiceItem(item));
    await ev.commit();
    return expandedJson(c, formatInvoiceItem(item), expand, body);
  });

  app.get("/v1/invoiceitems/:id", (c) => {
    const id = c.req.param("id");
    const item = ss.invoiceItems.findOneBy("stripe_id", id);
    if (!item) return notFound(c, id);
    return expandedJson(c, formatInvoiceItem(item), expand);
  });

  app.post("/v1/invoiceitems/:id", async (c) => {
    const id = c.req.param("id");
    const item = ss.invoiceItems.findOneBy("stripe_id", id);
    if (!item) return notFound(c, id);
    const locked = lockedInvoice(item);
    if (locked) return sendStripeError(c, invoiceNotEditable(locked));
    const body = await parseStripeBody(c);

    const updates: Partial<StripeInvoiceItem> = {};
    let price = item.price_id ? ss.prices.findOneBy("stripe_id", item.price_id) : undefined;
    const priceId = readPricingPrice(body);
    if (priceId) {
      const found = priceById(c, priceId);
      if (found.error) return found.error;
      if (found.price!.currency !== item.currency) {
        return badParam(c, "The price's currency does not match the invoice item's currency.", "pricing[price]");
      }
      price = found.price;
      updates.price_id = price!.stripe_id;
      updates.product_id = price!.product_id;
      updates.unit_amount_decimal = String(price!.unit_amount);
    }
    const quantity = readInt(body.quantity) ?? item.quantity;
    updates.quantity = quantity;
    const amount = readInt(body.amount);
    // An item on a price is always unit_amount x quantity; a bare-amount item keeps its unit amount.
    if (price) {
      updates.amount = price.unit_amount! * quantity;
    } else if (amount !== undefined) {
      updates.amount = amount;
      updates.unit_amount_decimal = decimalString(quantity > 0 ? amount / quantity : amount);
    } else {
      updates.amount = Math.round(Number(item.unit_amount_decimal) * quantity);
    }
    if (body.description !== undefined) updates.description = readString(body.description);
    const discountable = readBool(body.discountable);
    if (discountable !== undefined) updates.discountable = discountable;
    const metadata = mergeMetadata(item.metadata, body.metadata);
    if (metadata) updates.metadata = metadata;
    const period = readPeriod(body.period);
    if (period.start !== undefined || period.end !== undefined) {
      updates.period = { start: period.start ?? item.period.start, end: period.end ?? item.period.end };
    }

    const inv = item.invoice_id ? ss.invoices.findOneBy("stripe_id", item.invoice_id) : undefined;
    const before = inv ? formatInvoice(ss, inv, baseUrl) : undefined;
    const updated = ss.invoiceItems.update(item.id, updates)!;
    syncInvoiceItemLine(ss, updated);
    if (inv && before) {
      const ev = eventBatch(ctx, c);
      emitDraftChange(ctx, ev, inv, before);
      await ev.commit();
    }
    return expandedJson(c, formatInvoiceItem(updated), expand, body);
  });

  app.delete("/v1/invoiceitems/:id", async (c) => {
    const id = c.req.param("id");
    const item = ss.invoiceItems.findOneBy("stripe_id", id);
    if (!item) return notFound(c, id);
    const locked = lockedInvoice(item);
    if (locked) return sendStripeError(c, invoiceNotEditable(locked));

    const inv = item.invoice_id ? ss.invoices.findOneBy("stripe_id", item.invoice_id) : undefined;
    const before = inv ? formatInvoice(ss, inv, baseUrl) : undefined;
    syncInvoiceItemLine(ss, item, true);
    ss.invoiceItems.delete(item.id);

    const ev = eventBatch(ctx, c);
    ev.emit("invoiceitem.deleted", formatInvoiceItem(item));
    if (inv && before) emitDraftChange(ctx, ev, inv, before);
    await ev.commit();
    return c.json({ id: item.stripe_id, object: "invoiceitem", deleted: true });
  });

  app.get("/v1/invoiceitems", (c) => {
    let items = ss.invoiceItems.all();
    const customer = c.req.query("customer");
    const invoice = c.req.query("invoice");
    const pending = readBool(c.req.query("pending"));
    if (customer) items = items.filter((ii) => ii.customer_id === customer);
    if (invoice) items = items.filter((ii) => ii.invoice_id === invoice);
    if (pending !== undefined) items = items.filter((ii) => !ii.invoice_id === pending);
    return stripeList(c, items, "/v1/invoiceitems", formatInvoiceItem, { created: (ii) => ii.date, expand });
  });
}
