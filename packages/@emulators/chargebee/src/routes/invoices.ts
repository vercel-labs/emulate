import type { AppEnv, Context } from "@emulators/core";
import type { ChargebeeInvoice, PaymentMethodType } from "../entities.js";
import {
  collectInvoice,
  createCreditNote,
  createOneOffInvoice,
  recalculateInvoice,
  recordOfflinePayment,
} from "../billing.js";
import { customerRow, formatCreditNote, formatInvoice, formatTransaction } from "../formatters.js";
import {
  blankParamError,
  chargebeeList,
  invalidStateError,
  num,
  paramError,
  paymentError,
  parseChargebeeBody,
  pickAddress,
  str,
  strOrNull,
  stringList,
} from "../helpers.js";
import { formatDate, formatMoney, renderSimplePdf } from "../pdf.js";
import { refundInvoice } from "../refunds.js";
import { nowSeconds, resourceVersion } from "../store.js";
import {
  api,
  findCreditNote,
  findCustomer,
  findInvoice,
  findPaymentSource,
  findSubscription,
  findTransaction,
  nested,
  parseCharges,
  parseItemRequests,
  type ChargebeeRouteContext,
} from "../route-utils.js";

const PAYMENT_METHODS = new Set<string>(["card", "cash", "check", "bank_transfer", "chargeback", "other"]);

function invoiceContent(rc: ChargebeeRouteContext, invoice: ChargebeeInvoice) {
  const { cs } = rc;
  const customer = cs.customers.findOneBy("cb_id", invoice.customer_id);
  return { invoice: formatInvoice(cs, invoice), ...(customer ? customerRow(cs, customer) : {}) };
}

export function invoiceRoutes(rc: ChargebeeRouteContext): void {
  const { app, cs, ctx, baseUrl } = rc;

  const listInvoices = (c: Context<AppEnv>, filter: (invoice: ChargebeeInvoice) => boolean) =>
    chargebeeList(
      c,
      cs.invoices.all().filter((invoice) => !invoice.deleted && filter(invoice)),
      "invoice",
      (invoice) => ({ invoice: formatInvoice(cs, invoice) }),
    );

  app.get(
    "/api/v2/invoices",
    api(cs, (c) => listInvoices(c, () => true)),
  );

  app.get(
    "/api/v2/customers/:id/invoices",
    api(cs, (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      return listInvoices(c, (invoice) => invoice.customer_id === customer.cb_id);
    }),
  );

  app.get(
    "/api/v2/subscriptions/:id/invoices",
    api(cs, (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      return listInvoices(c, (invoice) => invoice.subscription_id === sub.cb_id);
    }),
  );

  app.get(
    "/api/v2/invoices/:id",
    api(cs, (c) => c.json({ invoice: formatInvoice(cs, findInvoice(cs, c.req.param("id"))) })),
  );

  app.post(
    "/api/v2/invoices/create_for_charge_items_and_charges",
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      const customerId = str(body.customer_id);
      const subscriptionId = str(body.subscription_id);
      const subscription = subscriptionId ? findSubscription(cs, subscriptionId) : null;
      if (!customerId && !subscription) throw blankParamError("customer_id");
      const customer = findCustomer(cs, customerId ?? subscription!.customer_id);
      const autoCollection = str(body.auto_collection);
      if (autoCollection !== undefined && autoCollection !== "on" && autoCollection !== "off") {
        throw paramError("auto_collection", "must be on or off");
      }
      const result = await createOneOffInvoice(ctx, {
        customer,
        subscriptionId: subscription?.cb_id ?? null,
        itemPrices: parseItemRequests(body, "item_prices"),
        charges: parseCharges(body),
        couponIds: stringList(body.coupon_ids),
        currencyCode: str(body.currency_code)?.toUpperCase(),
        autoCollection,
        poNumber: strOrNull(body.po_number),
        notes: strOrNull(body.invoice_note),
      });
      return c.json({
        invoice: formatInvoice(cs, result.invoice),
        ...(result.transaction ? { transaction: formatTransaction(result.transaction) } : {}),
      });
    }),
  );

  app.post(
    "/api/v2/invoices/charge",
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      const amount = num(body.amount);
      if (amount === undefined) throw blankParamError("amount");
      const subscriptionId = str(body.subscription_id);
      const subscription = subscriptionId ? findSubscription(cs, subscriptionId) : null;
      const customerId = str(body.customer_id) ?? subscription?.customer_id;
      if (!customerId) throw blankParamError("customer_id");
      const customer = findCustomer(cs, customerId);
      const result = await createOneOffInvoice(ctx, {
        customer,
        subscriptionId: subscription?.cb_id ?? null,
        itemPrices: [],
        charges: [{ amount, description: str(body.description) ?? "Charge" }],
        couponIds: stringList(body.coupon_ids),
        currencyCode: str(body.currency_code)?.toUpperCase(),
        poNumber: strOrNull(body.po_number),
        notes: strOrNull(body.invoice_note),
      });
      return c.json({
        invoice: formatInvoice(cs, result.invoice),
        ...(result.transaction ? { transaction: formatTransaction(result.transaction) } : {}),
      });
    }),
  );

  app.post(
    "/api/v2/invoices/:id/pdf",
    api(cs, (c) => {
      const invoice = findInvoice(cs, c.req.param("id"));
      return c.json({
        download: {
          download_url: `${baseUrl}/_chargebee/invoices/${encodeURIComponent(invoice.cb_id)}/pdf`,
          valid_till: nowSeconds(cs) + 3600,
          mime_type: "application/pdf",
          object: "download",
        },
      });
    }),
  );

  app.get("/_chargebee/invoices/:id/pdf", (c) => {
    const invoice = cs.invoices.findOneBy("cb_id", c.req.param("id"));
    if (!invoice) return c.text("Invoice not found", 404);
    const customer = cs.customers.findOneBy("cb_id", invoice.customer_id);
    const lines = [
      `Invoice #${invoice.cb_id}`,
      `Status: ${invoice.status}`,
      `Date: ${formatDate(invoice.date)}   Due: ${formatDate(invoice.due_date)}`,
      `Customer: ${[customer?.first_name, customer?.last_name].filter(Boolean).join(" ") || customer?.company || invoice.customer_id}`,
      customer?.email ? `Email: ${customer.email}` : "",
      invoice.subscription_id ? `Subscription: ${invoice.subscription_id}` : "",
      "",
      ...invoice.line_items.map(
        (line) => `${line.description}  x${line.quantity}  ${formatMoney(line.amount, invoice.currency_code)}`,
      ),
      ...invoice.discounts.map(
        (discount) => `Discount: ${discount.description}  -${formatMoney(discount.amount, invoice.currency_code)}`,
      ),
      "",
      `Subtotal: ${formatMoney(invoice.sub_total, invoice.currency_code)}`,
      `Total: ${formatMoney(invoice.total, invoice.currency_code)}`,
      `Amount paid: ${formatMoney(invoice.amount_paid, invoice.currency_code)}`,
      `Amount due: ${formatMoney(invoice.amount_due, invoice.currency_code)}`,
    ].filter((line, index, all) => line !== "" || all[index - 1] !== "");
    const pdf = renderSimplePdf("Chargebee Emulator Invoice", lines);
    return c.body(pdf, 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="invoice-${invoice.cb_id}.pdf"`,
    });
  });

  app.post(
    "/api/v2/invoices/:id/record_payment",
    api(cs, async (c) => {
      const invoice = findInvoice(cs, c.req.param("id"));
      if (invoice.status === "voided") throw invalidStateError("Cannot record a payment on a voided invoice");
      const body = await parseChargebeeBody(c);
      const transaction = nested(body, "transaction");
      const method = str(transaction.payment_method) ?? "other";
      if (!PAYMENT_METHODS.has(method))
        throw paramError("transaction[payment_method]", "is not a valid payment method");
      const result = await recordOfflinePayment(ctx, invoice, {
        amount: num(transaction.amount) ?? invoice.amount_due,
        paymentMethod: method as PaymentMethodType,
        referenceNumber: strOrNull(transaction.reference_number),
        date: num(transaction.date),
      });
      return c.json({ invoice: formatInvoice(cs, result.invoice), transaction: formatTransaction(result.transaction) });
    }),
  );

  app.post(
    "/api/v2/invoices/:id/collect_payment",
    api(cs, async (c) => {
      const invoice = findInvoice(cs, c.req.param("id"));
      if (invoice.amount_due <= 0 || invoice.status === "voided") throw invalidStateError("Invoice has no amount due");
      const body = await parseChargebeeBody(c);
      const sourceId = str(body.payment_source_id);
      const paymentSource = sourceId ? findPaymentSource(cs, sourceId) : undefined;
      const outcome = await collectInvoice(ctx, invoice, {
        paymentSource,
        amount: num(body.amount),
        emitUpdated: true,
      });
      if (!outcome.ok && outcome.reason === "no_payment_source") {
        throw paymentError("Customer does not have a valid payment method", "payment_method_not_present");
      }
      if (!outcome.ok) throw paymentError("The payment was declined by the test gateway", "payment_processing_failed");
      return c.json({
        invoice: formatInvoice(cs, outcome.invoice),
        ...(outcome.transaction ? { transaction: formatTransaction(outcome.transaction) } : {}),
      });
    }),
  );

  app.post(
    "/api/v2/invoices/:id/void",
    api(cs, async (c) => {
      const invoice = findInvoice(cs, c.req.param("id"));
      if (invoice.status === "paid" || invoice.status === "voided") {
        throw invalidStateError(`Invoice in ${invoice.status} status cannot be voided`);
      }
      const body = await parseChargebeeBody(c);
      const voided = cs.invoices.update(invoice.id, {
        status: "voided",
        voided_at: nowSeconds(cs),
        void_reason_code: strOrNull(body.void_reason_code),
        amount_due: 0,
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("invoice_updated", invoiceContent(rc, voided));
      return c.json({ invoice: formatInvoice(cs, voided) });
    }),
  );

  app.post(
    "/api/v2/invoices/:id/write_off",
    api(cs, async (c) => {
      const invoice = findInvoice(cs, c.req.param("id"));
      if (invoice.amount_due <= 0 || invoice.status === "voided")
        throw invalidStateError("Invoice has no amount due to write off");
      const customer = findCustomer(cs, invoice.customer_id);
      const amount = invoice.amount_due;
      const creditNote = await createCreditNote(ctx, {
        customer,
        invoice,
        subscriptionId: invoice.subscription_id,
        type: "adjustment",
        reasonCode: "write_off",
        createReasonCode: "Write Off",
        amount,
        lines: [],
        customerNotes: null,
      });
      const current = cs.invoices.get(invoice.id)!;
      const written = cs.invoices.update(current.id, {
        amount_adjusted: current.amount_adjusted - amount,
        write_off_amount: current.write_off_amount + amount,
        amount_due: 0,
        status: "not_paid",
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("invoice_updated", invoiceContent(rc, written));
      return c.json({
        invoice: formatInvoice(cs, written),
        credit_note: formatCreditNote(cs.creditNotes.get(creditNote.id)!),
      });
    }),
  );

  app.post(
    "/api/v2/invoices/:id/delete",
    api(cs, async (c) => {
      const invoice = findInvoice(cs, c.req.param("id"));
      const snapshot = formatInvoice(cs, { ...invoice, deleted: true });
      for (const payment of invoice.linked_payments) {
        const txn = cs.transactions.findOneBy("cb_id", payment.txn_id);
        if (txn) {
          cs.transactions.update(txn.id, {
            linked_invoices: txn.linked_invoices.filter((link) => link.invoice_id !== invoice.cb_id),
            amount_unused: txn.amount_unused + payment.applied_amount,
          });
        }
      }
      cs.invoices.delete(invoice.id);
      const customer = cs.customers.findOneBy("cb_id", invoice.customer_id);
      await ctx.emit("invoice_deleted", { invoice: snapshot, ...(customer ? customerRow(cs, customer) : {}) });
      return c.json({ invoice: snapshot });
    }),
  );

  app.post(
    "/api/v2/invoices/:id/remove_payment",
    api(cs, async (c) => {
      const invoice = findInvoice(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const transactionId = str(body.transaction_id) ?? str(nested(body, "transaction").id);
      if (!transactionId) throw blankParamError("transaction_id");
      const payment = invoice.linked_payments.find((link) => link.txn_id === transactionId);
      if (!payment) throw paramError("transaction_id", "is not linked to this invoice");
      const transaction = findTransaction(cs, transactionId);
      cs.transactions.update(transaction.id, {
        linked_invoices: transaction.linked_invoices.filter((link) => link.invoice_id !== invoice.cb_id),
        amount_unused: transaction.amount_unused + payment.applied_amount,
        resource_version: resourceVersion(cs),
      });
      const updated = recalculateInvoice(cs, {
        ...invoice,
        amount_paid: invoice.amount_paid - payment.applied_amount,
        paid_at: null,
      });
      const unlinked = cs.invoices.update(updated.id, {
        amount_paid: invoice.amount_paid - payment.applied_amount,
        paid_at: null,
        linked_payments: invoice.linked_payments.filter((link) => link.txn_id !== transactionId),
      })!;
      await ctx.emit("invoice_updated", invoiceContent(rc, unlinked));
      return c.json({
        invoice: formatInvoice(cs, unlinked),
        transaction: formatTransaction(cs.transactions.get(transaction.id)!),
      });
    }),
  );

  app.post(
    "/api/v2/invoices/:id/remove_credit_note",
    api(cs, async (c) => {
      const invoice = findInvoice(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const creditNoteId = str(nested(body, "credit_note").id) ?? str(body.credit_note_id);
      if (!creditNoteId) throw blankParamError("credit_note[id]");
      const creditNote = findCreditNote(cs, creditNoteId);
      const allocation = creditNote.allocations.find((item) => item.invoice_id === invoice.cb_id);
      if (!allocation) throw paramError("credit_note[id]", "is not applied to this invoice");
      const updatedNote = cs.creditNotes.update(creditNote.id, {
        allocations: creditNote.allocations.filter((item) => item.invoice_id !== invoice.cb_id),
        amount_allocated: creditNote.amount_allocated - allocation.allocated_amount,
        amount_available: creditNote.amount_available + allocation.allocated_amount,
        status: "refund_due",
        type: "refundable",
        resource_version: resourceVersion(cs),
      })!;
      const isAdjustment = invoice.adjustment_credit_note_ids.includes(creditNote.cb_id);
      const updated = recalculateInvoice(cs, {
        ...invoice,
        amount_adjusted: isAdjustment ? invoice.amount_adjusted - allocation.allocated_amount : invoice.amount_adjusted,
        credits_applied: isAdjustment ? invoice.credits_applied : invoice.credits_applied - allocation.allocated_amount,
        paid_at: null,
      });
      const unlinked = cs.invoices.update(updated.id, {
        amount_adjusted: isAdjustment ? invoice.amount_adjusted - allocation.allocated_amount : invoice.amount_adjusted,
        credits_applied: isAdjustment ? invoice.credits_applied : invoice.credits_applied - allocation.allocated_amount,
        adjustment_credit_note_ids: invoice.adjustment_credit_note_ids.filter((id) => id !== creditNote.cb_id),
        applied_credits: invoice.applied_credits.filter((credit) => credit.cn_id !== creditNote.cb_id),
        issued_credit_note_ids: invoice.issued_credit_note_ids.includes(creditNote.cb_id)
          ? invoice.issued_credit_note_ids
          : [...invoice.issued_credit_note_ids, creditNote.cb_id],
      })!;
      const customer = findCustomer(cs, invoice.customer_id);
      cs.customers.update(customer.id, {
        refundable_credits: customer.refundable_credits + allocation.allocated_amount,
        resource_version: resourceVersion(cs),
      });
      await ctx.emit("invoice_updated", invoiceContent(rc, unlinked));
      await ctx.emit("credit_note_updated", {
        credit_note: formatCreditNote(updatedNote),
        ...customerRow(cs, cs.customers.get(customer.id)!),
      });
      return c.json({ invoice: formatInvoice(cs, unlinked), credit_note: formatCreditNote(updatedNote) });
    }),
  );

  app.post(
    "/api/v2/invoices/:id/apply_credits",
    api(cs, async (c) => {
      const invoice = findInvoice(cs, c.req.param("id"));
      if (invoice.amount_due <= 0 || invoice.status === "voided") throw invalidStateError("Invoice has no amount due");
      const customer = findCustomer(cs, invoice.customer_id);
      const now = nowSeconds(cs);
      let remaining = invoice.amount_due;
      let creditsApplied = invoice.credits_applied;
      const appliedCredits = [...invoice.applied_credits];
      const notes = cs.creditNotes
        .findBy("customer_id", customer.cb_id)
        .filter((note) => !note.deleted && note.status === "refund_due" && note.amount_available > 0)
        .sort((a, b) => a.id - b.id);
      for (const note of notes) {
        if (remaining <= 0) break;
        const applied = Math.min(note.amount_available, remaining);
        remaining -= applied;
        creditsApplied += applied;
        const updatedNote = cs.creditNotes.update(note.id, {
          amount_available: note.amount_available - applied,
          amount_allocated: note.amount_allocated + applied,
          status: note.amount_available - applied === 0 ? "adjusted" : "refund_due",
          allocations: [
            ...note.allocations,
            {
              invoice_id: invoice.cb_id,
              allocated_amount: applied,
              allocated_at: now,
              invoice_date: invoice.date,
              invoice_status: invoice.status,
            },
          ],
          resource_version: resourceVersion(cs),
        })!;
        appliedCredits.push({
          cn_id: note.cb_id,
          applied_amount: applied,
          applied_at: now,
          cn_reason_code: note.reason_code,
          cn_create_reason_code: note.create_reason_code,
          cn_date: note.date,
          cn_status: updatedNote.status,
        });
        cs.customers.update(customer.id, {
          refundable_credits: Math.max(0, cs.customers.get(customer.id)!.refundable_credits - applied),
        });
      }
      if (creditsApplied === invoice.credits_applied) throw invalidStateError("Customer has no refundable credits");
      const updated = recalculateInvoice(cs, {
        ...invoice,
        amount_adjusted: invoice.amount_adjusted + (creditsApplied - invoice.credits_applied),
      });
      const applied = cs.invoices.update(updated.id, {
        amount_adjusted: invoice.amount_adjusted,
        credits_applied: creditsApplied,
        applied_credits: appliedCredits,
        amount_due: Math.max(
          0,
          invoice.total - invoice.amount_paid - invoice.amount_adjusted - invoice.write_off_amount - creditsApplied,
        ),
      })!;
      const finalInvoice = cs.invoices.update(applied.id, {
        status: applied.amount_due === 0 ? "paid" : applied.status,
        paid_at: applied.amount_due === 0 ? (applied.paid_at ?? now) : applied.paid_at,
      })!;
      await ctx.emit("invoice_updated", invoiceContent(rc, finalInvoice));
      return c.json({ invoice: formatInvoice(cs, finalInvoice) });
    }),
  );

  app.post(
    "/api/v2/invoices/:id/update_details",
    api(cs, async (c) => {
      const invoice = findInvoice(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const updated = cs.invoices.update(invoice.id, {
        billing_address:
          body.billing_address !== undefined ? pickAddress(body.billing_address) : invoice.billing_address,
        shipping_address:
          body.shipping_address !== undefined ? pickAddress(body.shipping_address) : invoice.shipping_address,
        vat_number: body.vat_number !== undefined ? strOrNull(body.vat_number) : invoice.vat_number,
        po_number: body.po_number !== undefined ? strOrNull(body.po_number) : invoice.po_number,
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("invoice_updated", invoiceContent(rc, updated));
      return c.json({ invoice: formatInvoice(cs, updated) });
    }),
  );

  const refund = (offline: boolean) =>
    api(cs, async (c) => {
      const invoice = findInvoice(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const transaction = nested(body, "transaction");
      const method = str(transaction.payment_method) ?? "other";
      if (offline && !PAYMENT_METHODS.has(method))
        throw paramError("transaction[payment_method]", "is not a valid payment method");
      const result = await refundInvoice(ctx, invoice, {
        amount: num(body.refund_amount) ?? num(transaction.amount),
        reasonCode: strOrNull(nested(body, "credit_note").reason_code),
        customerNotes: strOrNull(body.customer_notes),
        offline: offline
          ? {
              paymentMethod: method as PaymentMethodType,
              referenceNumber: strOrNull(transaction.reference_number),
              date: num(transaction.date),
            }
          : undefined,
      });
      return c.json({
        invoice: formatInvoice(cs, result.invoice),
        transaction: formatTransaction(result.transaction),
        credit_note: formatCreditNote(result.creditNote),
      });
    });

  app.post("/api/v2/invoices/:id/refund", refund(false));
  app.post("/api/v2/invoices/:id/record_refund", refund(true));

  app.get(
    "/api/v2/invoices/:id/payments",
    api(cs, (c) => {
      const invoice = findInvoice(cs, c.req.param("id"));
      const transactions = cs.transactions
        .all()
        .filter(
          (txn) => txn.type === "payment" && txn.linked_invoices.some((link) => link.invoice_id === invoice.cb_id),
        );
      return chargebeeList(c, transactions, "transaction", (txn) => ({ transaction: formatTransaction(txn) }));
    }),
  );

  app.post(
    "/api/v2/invoices/:id/close",
    api(cs, (c) => c.json({ invoice: formatInvoice(cs, findInvoice(cs, c.req.param("id"))) })),
  );

  app.post(
    "/api/v2/invoices/:id/stop_dunning",
    api(cs, async (c) => {
      const invoice = findInvoice(cs, c.req.param("id"));
      const updated = cs.invoices.update(invoice.id, {
        dunning_status: invoice.dunning_status ? "stopped" : null,
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("invoice_updated", invoiceContent(rc, updated));
      return c.json({ invoice: formatInvoice(cs, updated) });
    }),
  );

  app.get(
    "/api/v2/invoices/payment_reference_numbers",
    api(cs, (c) => c.json({ list: [] })),
  );
}
