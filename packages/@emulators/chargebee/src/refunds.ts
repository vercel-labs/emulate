import type {
  ChargebeeCreditNote,
  ChargebeeInvoice,
  ChargebeeTransaction,
  EventSource,
  PaymentMethodType,
} from "./entities.js";
import type { ChargebeeCtx } from "./events.js";
import { adhocLines } from "./billing.js";
import { customerRow, formatCreditNote, formatInvoice, formatTransaction } from "./formatters.js";
import { invalidStateError, paramError } from "./helpers.js";
import { prefixedId } from "./ids.js";
import { nextSequence, nowSeconds, resourceVersion } from "./store.js";

export interface RefundInput {
  amount?: number;
  reasonCode?: string | null;
  customerNotes?: string | null;
  offline?: { paymentMethod: PaymentMethodType; referenceNumber?: string | null; date?: number };
  source?: EventSource;
}

export function refundedAmount(ctx: ChargebeeCtx, invoice: ChargebeeInvoice): number {
  return invoice.issued_credit_note_ids
    .map((id) => ctx.cs.creditNotes.findOneBy("cb_id", id))
    .filter((cn): cn is ChargebeeCreditNote => !!cn && cn.status === "refunded")
    .reduce((sum, cn) => sum + cn.amount_refunded, 0);
}

export async function refundInvoice(
  ctx: ChargebeeCtx,
  invoice: ChargebeeInvoice,
  input: RefundInput,
): Promise<{ transaction: ChargebeeTransaction; creditNote: ChargebeeCreditNote; invoice: ChargebeeInvoice }> {
  const { cs } = ctx;
  const now = nowSeconds(cs);
  const refundable = invoice.amount_paid - refundedAmount(ctx, invoice);
  if (refundable <= 0) throw invalidStateError("Invoice has no refundable payments");
  const amount = Math.min(input.amount ?? refundable, refundable);
  if (amount <= 0) throw paramError("refund_amount", "must be greater than zero");

  const lastPayment = [...invoice.linked_payments].reverse().find((payment) => payment.txn_status === "success");
  const original = lastPayment ? cs.transactions.findOneBy("cb_id", lastPayment.txn_id) : undefined;
  const customer = cs.customers.findOneBy("cb_id", invoice.customer_id)!;
  const date = input.offline?.date ?? now;

  const creditNote = cs.creditNotes.insert({
    cb_id: `CN-${nextSequence(cs, "credit_note")}`,
    customer_id: invoice.customer_id,
    subscription_id: invoice.subscription_id,
    reference_invoice_id: invoice.cb_id,
    type: "refundable",
    reason_code: input.reasonCode ?? "other",
    create_reason_code: "Refund",
    status: "refunded",
    date,
    currency_code: invoice.currency_code,
    total: amount,
    amount_allocated: 0,
    amount_refunded: amount,
    amount_available: 0,
    sub_total: amount,
    line_items: adhocLines([{ amount, description: "Refund" }], invoice.customer_id, invoice.subscription_id, date),
    customer_notes: input.customerNotes ?? null,
    voided_at: null,
    generated_at: now,
    allocations: [],
    linked_refunds: [],
    resource_version: resourceVersion(cs),
    deleted: false,
  });

  const transaction = cs.transactions.insert({
    cb_id: prefixedId("txn"),
    customer_id: invoice.customer_id,
    subscription_id: invoice.subscription_id,
    payment_source_id: input.offline ? null : (original?.payment_source_id ?? null),
    payment_method: input.offline?.paymentMethod ?? original?.payment_method ?? "card",
    gateway: input.offline ? "not_applicable" : (original?.gateway ?? "chargebee"),
    gateway_account_id: input.offline ? null : (original?.gateway_account_id ?? null),
    type: "refund",
    date,
    amount,
    status: "success",
    currency_code: invoice.currency_code,
    reference_number: input.offline?.referenceNumber ?? null,
    id_at_gateway: input.offline ? null : prefixedId("gw", 12),
    error_code: null,
    error_text: null,
    masked_card_number: original?.masked_card_number ?? null,
    refunded_txn_id: original?.cb_id ?? null,
    amount_unused: 0,
    linked_invoices: [
      {
        invoice_id: invoice.cb_id,
        applied_amount: amount,
        applied_at: now,
        invoice_date: invoice.date,
        invoice_total: invoice.total,
        invoice_status: invoice.status,
      },
    ],
    linked_credit_notes: [
      {
        cn_id: creditNote.cb_id,
        applied_amount: amount,
        applied_at: now,
        cn_reference_invoice_id: invoice.cb_id,
        cn_total: amount,
        cn_status: "refunded",
        cn_date: date,
        cn_reason_code: creditNote.reason_code,
      },
    ],
    resource_version: resourceVersion(cs),
    deleted: false,
  });

  const linkedNote = cs.creditNotes.update(creditNote.id, {
    linked_refunds: [
      {
        txn_id: transaction.cb_id,
        applied_amount: amount,
        applied_at: now,
        txn_status: "success",
        txn_date: date,
        txn_amount: amount,
      },
    ],
  })!;
  const updatedInvoice = cs.invoices.update(invoice.id, {
    issued_credit_note_ids: [...invoice.issued_credit_note_ids, creditNote.cb_id],
    resource_version: resourceVersion(cs),
  })!;

  await ctx.emit(
    "credit_note_created",
    {
      credit_note: formatCreditNote(linkedNote),
      ...customerRow(cs, customer),
      invoice: formatInvoice(cs, updatedInvoice),
    },
    input.source,
  );
  await ctx.emit(
    "payment_refunded",
    {
      transaction: formatTransaction(transaction),
      invoice: formatInvoice(cs, updatedInvoice),
      credit_note: formatCreditNote(linkedNote),
      ...customerRow(cs, customer),
    },
    input.source,
  );
  return { transaction, creditNote: linkedNote, invoice: updatedInvoice };
}

export async function refundCreditNote(
  ctx: ChargebeeCtx,
  creditNote: ChargebeeCreditNote,
  input: RefundInput,
): Promise<{ transaction: ChargebeeTransaction; creditNote: ChargebeeCreditNote }> {
  const { cs } = ctx;
  const now = nowSeconds(cs);
  if (creditNote.status !== "refund_due" || creditNote.amount_available <= 0) {
    throw invalidStateError("Credit note has no refundable amount");
  }
  const amount = Math.min(input.amount ?? creditNote.amount_available, creditNote.amount_available);
  if (amount <= 0) throw paramError("refund_amount", "must be greater than zero");
  const customer = cs.customers.findOneBy("cb_id", creditNote.customer_id)!;
  const date = input.offline?.date ?? now;

  const transaction = cs.transactions.insert({
    cb_id: prefixedId("txn"),
    customer_id: creditNote.customer_id,
    subscription_id: creditNote.subscription_id,
    payment_source_id: input.offline ? null : customer.primary_payment_source_id,
    payment_method: input.offline?.paymentMethod ?? "card",
    gateway: input.offline ? "not_applicable" : "chargebee",
    gateway_account_id: input.offline ? null : "gw_emulate_test",
    type: "refund",
    date,
    amount,
    status: "success",
    currency_code: creditNote.currency_code,
    reference_number: input.offline?.referenceNumber ?? null,
    id_at_gateway: input.offline ? null : prefixedId("gw", 12),
    error_code: null,
    error_text: null,
    masked_card_number: null,
    refunded_txn_id: null,
    amount_unused: 0,
    linked_invoices: [],
    linked_credit_notes: [
      {
        cn_id: creditNote.cb_id,
        applied_amount: amount,
        applied_at: now,
        cn_reference_invoice_id: creditNote.reference_invoice_id,
        cn_total: creditNote.total,
        cn_status: creditNote.amount_available - amount === 0 ? "refunded" : "refund_due",
        cn_date: creditNote.date,
        cn_reason_code: creditNote.reason_code,
      },
    ],
    resource_version: resourceVersion(cs),
    deleted: false,
  });

  const remaining = creditNote.amount_available - amount;
  const updated = cs.creditNotes.update(creditNote.id, {
    amount_refunded: creditNote.amount_refunded + amount,
    amount_available: remaining,
    status: remaining === 0 ? "refunded" : "refund_due",
    linked_refunds: [
      ...creditNote.linked_refunds,
      {
        txn_id: transaction.cb_id,
        applied_amount: amount,
        applied_at: now,
        txn_status: "success",
        txn_date: date,
        txn_amount: amount,
      },
    ],
    resource_version: resourceVersion(cs),
  })!;
  cs.customers.update(customer.id, {
    refundable_credits: Math.max(0, customer.refundable_credits - amount),
    resource_version: resourceVersion(cs),
  });
  const refreshed = cs.customers.get(customer.id)!;
  await ctx.emit(
    "payment_refunded",
    {
      transaction: formatTransaction(transaction),
      credit_note: formatCreditNote(updated),
      ...customerRow(cs, refreshed),
    },
    input.source,
  );
  await ctx.emit(
    "credit_note_updated",
    { credit_note: formatCreditNote(updated), ...customerRow(cs, refreshed) },
    input.source,
  );
  return { transaction, creditNote: updated };
}
