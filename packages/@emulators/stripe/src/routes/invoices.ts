import type { Context, RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import {
  expandedJson,
  mergeMetadata,
  parseStripeBody,
  readBool,
  readEnum,
  readInt,
  stripeError,
  stripeList,
} from "../helpers.js";
import { formatInvoice, formatInvoiceLineItem, invoiceLines, stripeExpandResolver } from "../formatters.js";
import { eventBatch, previousAttributes } from "../events.js";
import {
  createInvoice,
  deleteDraftInvoice,
  finalizeInvoice,
  invoiceNotEditable,
  markInvoiceUncollectible,
  payInvoice,
  voidInvoice,
  type InvoiceResult,
} from "../invoicing.js";
import { sendStripeError } from "./payment-methods.js";
import type { StripeInvoice } from "../entities.js";

const COLLECTION_METHODS = ["charge_automatically", "send_invoice"] as const;
const PENDING_BEHAVIORS = ["exclude", "include"] as const;
const STATUSES = ["draft", "open", "paid", "uncollectible", "void"] as const;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function invoiceRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);
  const render = (inv: StripeInvoice) => formatInvoice(ss, inv, baseUrl);

  const notFound = (c: Context, id: string) =>
    stripeError(c, 404, "invalid_request_error", `No such invoice: '${id}'`, "resource_missing", "id");

  /** A default payment method must belong to the invoice's customer. */
  const foreignPaymentMethod = (c: Context, pmId: string, customerId: string) => {
    const pm = ss.paymentMethods.findOneBy("stripe_id", pmId);
    if (pm && pm.customer_id === customerId) return undefined;
    return stripeError(
      c,
      400,
      "invalid_request_error",
      pm
        ? "The provided PaymentMethod does not belong to this invoice's customer."
        : `No such PaymentMethod: '${pmId}'`,
      pm ? undefined : "resource_missing",
      "default_payment_method",
    );
  };

  /** Run one state change with its own event batch and answer with the invoice or the error. */
  const transition = async (
    c: Context,
    body: Record<string, unknown>,
    change: (inv: StripeInvoice, ev: ReturnType<typeof eventBatch>) => InvoiceResult,
  ) => {
    const id = c.req.param("id")!;
    const inv = ss.invoices.findOneBy("stripe_id", id);
    if (!inv) return notFound(c, id);
    const ev = eventBatch(ctx, c);
    const result = change(inv, ev);
    await ev.commit();
    if (!result.ok) return sendStripeError(c, result.error);
    return expandedJson(c, render(ss.invoices.get(result.invoice.id) ?? result.invoice), expand, body);
  };

  app.post("/v1/invoices", async (c) => {
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
    const collection = readEnum(c, body.collection_method, COLLECTION_METHODS, "collection_method");
    if (collection.error) return collection.error;
    const pending = readEnum(
      c,
      body.pending_invoice_items_behavior,
      PENDING_BEHAVIORS,
      "pending_invoice_items_behavior",
    );
    if (pending.error) return pending.error;
    const defaultPaymentMethod = readString(body.default_payment_method);
    if (defaultPaymentMethod) {
      const foreign = foreignPaymentMethod(c, defaultPaymentMethod, customerId);
      if (foreign) return foreign;
    }

    const ev = eventBatch(ctx, c);
    const inv = createInvoice(ctx, ev, {
      customerId,
      currency: readString(body.currency)?.toLowerCase(),
      collectionMethod: collection.value,
      autoAdvance: readBool(body.auto_advance),
      description: readString(body.description),
      footer: readString(body.footer),
      metadata: mergeMetadata({}, body.metadata),
      defaultPaymentMethod,
      dueDate: readInt(body.due_date),
      daysUntilDue: readInt(body.days_until_due),
      includePending: pending.value === "include",
    });
    await ev.commit();
    return expandedJson(c, render(ss.invoices.get(inv.id) ?? inv), expand, body);
  });

  app.get("/v1/invoices", (c) => {
    let items = ss.invoices.all();
    const customer = c.req.query("customer");
    const status = c.req.query("status");
    const collection = c.req.query("collection_method");
    const subscription = c.req.query("subscription");
    if (status && !(STATUSES as readonly string[]).includes(status)) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `Invalid status: must be one of ${STATUSES.join(", ")}`,
        undefined,
        "status",
      );
    }
    if (customer) items = items.filter((inv) => inv.customer_id === customer);
    if (status) items = items.filter((inv) => inv.status === status);
    if (collection) items = items.filter((inv) => inv.collection_method === collection);
    if (subscription) items = items.filter((inv) => inv.subscription_id === subscription);
    return stripeList(c, items, "/v1/invoices", render, { created: (inv) => inv.created, expand });
  });

  app.get("/v1/invoices/:id/lines", (c) => {
    const id = c.req.param("id");
    const inv = ss.invoices.findOneBy("stripe_id", id);
    if (!inv) return notFound(c, id);
    return stripeList(
      c,
      invoiceLines(ss, inv.stripe_id),
      `/v1/invoices/${inv.stripe_id}/lines`,
      formatInvoiceLineItem,
      {
        expand,
        order: "oldest_first",
      },
    );
  });

  app.get("/v1/invoices/:id", (c) => {
    const id = c.req.param("id");
    const inv = ss.invoices.findOneBy("stripe_id", id);
    if (!inv) return notFound(c, id);
    return expandedJson(c, render(inv), expand);
  });

  app.post("/v1/invoices/:id", async (c) => {
    const id = c.req.param("id");
    const inv = ss.invoices.findOneBy("stripe_id", id);
    if (!inv) return notFound(c, id);
    const body = await parseStripeBody(c);

    if (inv.status === "void" || inv.status === "paid") {
      const editable = ["metadata", "description", "footer", "expand"];
      if (Object.keys(body).some((key) => !editable.includes(key))) return sendStripeError(c, invoiceNotEditable(inv));
    }
    const draftOnly = ["collection_method", "days_until_due", "due_date", "currency"];
    if (inv.status !== "draft" && draftOnly.some((key) => body[key] !== undefined)) {
      return sendStripeError(c, invoiceNotEditable(inv));
    }
    const collection = readEnum(c, body.collection_method, COLLECTION_METHODS, "collection_method");
    if (collection.error) return collection.error;
    const defaultPaymentMethod =
      typeof body.default_payment_method === "string" ? body.default_payment_method : undefined;
    if (defaultPaymentMethod) {
      const foreign = foreignPaymentMethod(c, defaultPaymentMethod, inv.customer_id);
      if (foreign) return foreign;
    }

    const updates: Partial<StripeInvoice> = {};
    if (body.description !== undefined) updates.description = readString(body.description);
    if (body.footer !== undefined) updates.footer = readString(body.footer);
    const metadata = mergeMetadata(inv.metadata, body.metadata);
    if (metadata) updates.metadata = metadata;
    const autoAdvance = readBool(body.auto_advance);
    if (autoAdvance !== undefined) updates.auto_advance = autoAdvance;
    if (defaultPaymentMethod !== undefined) updates.default_payment_method = defaultPaymentMethod || undefined;
    if (collection.value) updates.collection_method = collection.value;
    const dueDate = readInt(body.due_date);
    const daysUntilDue = readInt(body.days_until_due);
    if (dueDate !== undefined) updates.due_date = dueDate;
    else if (daysUntilDue !== undefined) updates.due_date = inv.created + daysUntilDue * 86400;

    const before = render(inv);
    const updated = ss.invoices.update(inv.id, updates)!;
    const after = render(updated);
    const previous = previousAttributes(before, after);
    if (Object.keys(previous).length > 0) {
      const ev = eventBatch(ctx, c);
      ev.emit("invoice.updated", after, previous);
      await ev.commit();
    }
    return expandedJson(c, after, expand, body);
  });

  app.delete("/v1/invoices/:id", async (c) => {
    const id = c.req.param("id");
    const inv = ss.invoices.findOneBy("stripe_id", id);
    if (!inv) return notFound(c, id);
    const ev = eventBatch(ctx, c);
    const result = deleteDraftInvoice(ctx, ev, inv);
    await ev.commit();
    if (!result.ok) return sendStripeError(c, result.error);
    return c.json({ id: inv.stripe_id, object: "invoice", deleted: true });
  });

  app.post("/v1/invoices/:id/finalize", async (c) => {
    const body = await parseStripeBody(c);
    const autoAdvance = readBool(body.auto_advance);
    return transition(c, body, (inv, ev) => {
      const current = autoAdvance === undefined ? inv : ss.invoices.update(inv.id, { auto_advance: autoAdvance })!;
      return finalizeInvoice(ctx, ev, current);
    });
  });

  app.post("/v1/invoices/:id/pay", async (c) => {
    const body = await parseStripeBody(c);
    return transition(c, body, (inv, ev) =>
      payInvoice(ctx, ev, inv, {
        paymentMethod: readString(body.payment_method),
        offSession: readBool(body.off_session),
        paidOutOfBand: readBool(body.paid_out_of_band),
      }),
    );
  });

  app.post("/v1/invoices/:id/void", async (c) => {
    const body = await parseStripeBody(c);
    return transition(c, body, (inv, ev) => voidInvoice(ctx, ev, inv));
  });

  app.post("/v1/invoices/:id/mark_uncollectible", async (c) => {
    const body = await parseStripeBody(c);
    return transition(c, body, (inv, ev) => markInvoiceUncollectible(ctx, ev, inv));
  });
}
