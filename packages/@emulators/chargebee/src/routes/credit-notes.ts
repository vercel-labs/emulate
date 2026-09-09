import type { ChargebeeCreditNote, CreditNoteType, PaymentMethodType } from "../entities.js";
import { createCreditNote, recalculateInvoice } from "../billing.js";
import { customerRow, formatCreditNote, formatInvoice, formatTransaction } from "../formatters.js";
import {
  blankParamError,
  chargebeeList,
  columnar,
  invalidStateError,
  num,
  paramError,
  parseChargebeeBody,
  str,
  strOrNull,
} from "../helpers.js";
import { formatDate, formatMoney, renderSimplePdf } from "../pdf.js";
import { refundCreditNote } from "../refunds.js";
import { nowSeconds, resourceVersion } from "../store.js";
import { api, findCreditNote, findCustomer, findInvoice, nested, type ChargebeeRouteContext } from "../route-utils.js";

const PAYMENT_METHODS = new Set<string>(["card", "cash", "check", "bank_transfer", "chargeback", "other"]);

export function creditNoteRoutes(rc: ChargebeeRouteContext): void {
  const { app, cs, ctx, baseUrl } = rc;

  const listNotes = (filter: (note: ChargebeeCreditNote) => boolean) =>
    cs.creditNotes.all().filter((note) => !note.deleted && filter(note));

  app.post(
    "/api/v2/credit_notes",
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      const invoiceId = str(body.reference_invoice_id);
      if (!invoiceId) throw blankParamError("reference_invoice_id");
      const invoice = findInvoice(cs, invoiceId);
      const customer = findCustomer(cs, invoice.customer_id);
      const type = str(body.type);
      if (type !== "adjustment" && type !== "refundable") throw paramError("type", "must be adjustment or refundable");
      const lineRows = columnar(body.line_items);
      const lines = lineRows.map((row, index) => {
        const reference = row.reference_line_item_id
          ? invoice.line_items.find((line) => line.id === row.reference_line_item_id)
          : undefined;
        const quantity = num(row.quantity) ?? reference?.quantity ?? 1;
        const unitAmount = num(row.unit_amount) ?? reference?.unit_amount ?? 0;
        const amount = num(row.amount) ?? unitAmount * quantity;
        if (amount <= 0) throw paramError(`line_items[amount][${index}]`, "must be greater than zero");
        return {
          id: `li_cn_${index}_${Date.now()}`,
          date_from: reference?.date_from ?? invoice.date,
          date_to: reference?.date_to ?? invoice.date,
          unit_amount: unitAmount,
          quantity,
          amount,
          pricing_model: reference?.pricing_model ?? ("flat_fee" as const),
          description: row.description ?? reference?.description ?? "Credit",
          entity_type: reference?.entity_type ?? ("adhoc" as const),
          entity_id: reference?.entity_id ?? null,
          discount_amount: 0,
          item_level_discount_amount: 0,
          subscription_id: invoice.subscription_id,
          customer_id: invoice.customer_id,
          metered: false,
          is_taxed: false,
          tax_amount: 0,
        };
      });
      const total = num(body.total) ?? lines.reduce((sum, line) => sum + line.amount, 0);
      if (total <= 0) throw blankParamError("total");
      const creditNote = await createCreditNote(ctx, {
        customer,
        invoice,
        subscriptionId: invoice.subscription_id,
        type: type as CreditNoteType,
        reasonCode: strOrNull(body.reason_code),
        createReasonCode: strOrNull(body.create_reason_code) ?? strOrNull(body.reason_code),
        amount: total,
        lines,
        customerNotes: strOrNull(body.customer_notes),
      });
      return c.json({
        credit_note: formatCreditNote(cs.creditNotes.get(creditNote.id)!),
        invoice: formatInvoice(cs, cs.invoices.get(invoice.id)!),
      });
    }),
  );

  app.get(
    "/api/v2/credit_notes",
    api(cs, (c) =>
      chargebeeList(
        c,
        listNotes(() => true),
        "credit_note",
        (note) => ({ credit_note: formatCreditNote(note) }),
      ),
    ),
  );

  app.get(
    "/api/v2/customers/:id/credit_notes",
    api(cs, (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      return chargebeeList(
        c,
        listNotes((note) => note.customer_id === customer.cb_id),
        "credit_note",
        (note) => ({
          credit_note: formatCreditNote(note),
        }),
      );
    }),
  );

  app.get(
    "/api/v2/credit_notes/:id",
    api(cs, (c) => c.json({ credit_note: formatCreditNote(findCreditNote(cs, c.req.param("id"))) })),
  );

  app.post(
    "/api/v2/credit_notes/:id/pdf",
    api(cs, (c) => {
      const note = findCreditNote(cs, c.req.param("id"));
      return c.json({
        download: {
          download_url: `${baseUrl}/_chargebee/credit_notes/${encodeURIComponent(note.cb_id)}/pdf`,
          valid_till: nowSeconds(cs) + 3600,
          mime_type: "application/pdf",
          object: "download",
        },
      });
    }),
  );

  app.get("/_chargebee/credit_notes/:id/pdf", (c) => {
    const note = cs.creditNotes.findOneBy("cb_id", c.req.param("id"));
    if (!note) return c.text("Credit note not found", 404);
    const lines = [
      `Credit Note ${note.cb_id}`,
      `Type: ${note.type}   Status: ${note.status}`,
      `Date: ${formatDate(note.date)}`,
      `Customer: ${note.customer_id}`,
      note.reference_invoice_id ? `Invoice: ${note.reference_invoice_id}` : "",
      "",
      ...note.line_items.map(
        (line) => `${line.description}  x${line.quantity}  ${formatMoney(line.amount, note.currency_code)}`,
      ),
      "",
      `Total: ${formatMoney(note.total, note.currency_code)}`,
      `Allocated: ${formatMoney(note.amount_allocated, note.currency_code)}`,
      `Refunded: ${formatMoney(note.amount_refunded, note.currency_code)}`,
      `Available: ${formatMoney(note.amount_available, note.currency_code)}`,
    ].filter((line, index, all) => line !== "" || all[index - 1] !== "");
    return c.body(renderSimplePdf("Chargebee Emulator Credit Note", lines), 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="credit-note-${note.cb_id}.pdf"`,
    });
  });

  app.post(
    "/api/v2/credit_notes/:id/void",
    api(cs, async (c) => {
      const note = findCreditNote(cs, c.req.param("id"));
      if (note.status === "voided") throw invalidStateError("Credit note is already voided");
      if (note.amount_refunded > 0) throw invalidStateError("Refunded credit notes cannot be voided");
      const customer = findCustomer(cs, note.customer_id);
      for (const allocation of note.allocations) {
        const invoice = cs.invoices.findOneBy("cb_id", allocation.invoice_id);
        if (!invoice) continue;
        const isAdjustment = invoice.adjustment_credit_note_ids.includes(note.cb_id);
        const recalculated = recalculateInvoice(cs, {
          ...invoice,
          amount_adjusted: isAdjustment
            ? invoice.amount_adjusted - allocation.allocated_amount
            : invoice.amount_adjusted,
          paid_at: null,
        });
        cs.invoices.update(recalculated.id, {
          amount_adjusted: isAdjustment
            ? invoice.amount_adjusted - allocation.allocated_amount
            : invoice.amount_adjusted,
          credits_applied: isAdjustment
            ? invoice.credits_applied
            : invoice.credits_applied - allocation.allocated_amount,
          adjustment_credit_note_ids: invoice.adjustment_credit_note_ids.filter((id) => id !== note.cb_id),
          issued_credit_note_ids: invoice.issued_credit_note_ids.filter((id) => id !== note.cb_id),
          applied_credits: invoice.applied_credits.filter((credit) => credit.cn_id !== note.cb_id),
        });
      }
      if (note.type === "refundable") {
        cs.customers.update(customer.id, {
          refundable_credits: Math.max(0, customer.refundable_credits - note.amount_available),
          resource_version: resourceVersion(cs),
        });
      }
      const voided = cs.creditNotes.update(note.id, {
        status: "voided",
        voided_at: nowSeconds(cs),
        amount_available: 0,
        allocations: [],
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("credit_note_updated", {
        credit_note: formatCreditNote(voided),
        ...customerRow(cs, cs.customers.get(customer.id)!),
      });
      return c.json({ credit_note: formatCreditNote(voided) });
    }),
  );

  app.post(
    "/api/v2/credit_notes/:id/delete",
    api(cs, async (c) => {
      const note = findCreditNote(cs, c.req.param("id"));
      const snapshot = formatCreditNote({ ...note, deleted: true });
      const customer = cs.customers.findOneBy("cb_id", note.customer_id);
      if (customer && note.type === "refundable") {
        cs.customers.update(customer.id, {
          refundable_credits: Math.max(0, customer.refundable_credits - note.amount_available),
          resource_version: resourceVersion(cs),
        });
      }
      for (const invoice of cs.invoices.all()) {
        if (
          !invoice.adjustment_credit_note_ids.includes(note.cb_id) &&
          !invoice.issued_credit_note_ids.includes(note.cb_id)
        )
          continue;
        cs.invoices.update(invoice.id, {
          adjustment_credit_note_ids: invoice.adjustment_credit_note_ids.filter((id) => id !== note.cb_id),
          issued_credit_note_ids: invoice.issued_credit_note_ids.filter((id) => id !== note.cb_id),
          resource_version: resourceVersion(cs),
        });
      }
      cs.creditNotes.delete(note.id);
      await ctx.emit("credit_note_deleted", {
        credit_note: snapshot,
        ...(customer ? customerRow(cs, cs.customers.get(customer.id)!) : {}),
      });
      return c.json({ credit_note: snapshot });
    }),
  );

  const refund = (offline: boolean) =>
    api(cs, async (c) => {
      const note = findCreditNote(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const transaction = nested(body, "transaction");
      const method = str(transaction.payment_method) ?? "other";
      if (offline && !PAYMENT_METHODS.has(method))
        throw paramError("transaction[payment_method]", "is not a valid payment method");
      const result = await refundCreditNote(ctx, note, {
        amount: num(body.refund_amount) ?? num(transaction.amount),
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
        credit_note: formatCreditNote(result.creditNote),
        transaction: formatTransaction(result.transaction),
      });
    });

  app.post("/api/v2/credit_notes/:id/refund", refund(false));
  app.post("/api/v2/credit_notes/:id/record_refund", refund(true));

  app.post(
    "/api/v2/credit_notes/:id/update",
    api(cs, async (c) => {
      const note = findCreditNote(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const updated = cs.creditNotes.update(note.id, {
        customer_notes: body.customer_notes !== undefined ? strOrNull(body.customer_notes) : note.customer_notes,
        resource_version: resourceVersion(cs),
      })!;
      const customer = cs.customers.findOneBy("cb_id", note.customer_id);
      await ctx.emit("credit_note_updated", {
        credit_note: formatCreditNote(updated),
        ...(customer ? customerRow(cs, customer) : {}),
      });
      return c.json({ credit_note: formatCreditNote(updated) });
    }),
  );
}
