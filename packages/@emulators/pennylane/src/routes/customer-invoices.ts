import type { Context } from "@emulators/core";
import type { PlCustomerInvoice } from "../entities.js";
import {
  customerInvoiceStatus,
  formatAppendix,
  formatCategoryWeights,
  formatCustomerInvoice,
  formatInvoiceLine,
  formatTransaction,
  invoiceTotals,
} from "../formatters.js";
import {
  addDays,
  api,
  bool,
  dateOnly,
  listResponse,
  notFound,
  num,
  parseJsonBody,
  requireInt,
  route,
  str,
  strOrNull,
  today,
  unprocessable,
  type Body,
  type Json,
} from "../helpers.js";
import { company, logEvent, nextId, type PlStore } from "../store.js";
import {
  decodeFile,
  findCustomer,
  findCustomerInvoice,
  findTransaction,
  parseCategoryWeights,
  parseDiscount,
  parseInvoiceLines,
  storeAppendix,
  type PlRouteContext,
} from "../route-utils.js";

const INVOICE_FILTERS = {
  id: true,
  invoice_number: { operators: ["eq", "in", "not_eq", "contains", "starts_with"] },
  external_reference: { operators: ["eq", "in"] },
  customer_id: {
    operators: ["eq", "in", "not_eq"],
    get: (row: Json) => (row.customer as { id: number } | null)?.id ?? null,
  },
  status: true,
  paid: true,
  draft: true,
  date: true,
  deadline: true,
  currency: true,
  amount: true,
  label: true,
  created_at: true,
  updated_at: true,
} as const;
const INVOICE_SORT = ["id", "date", "deadline", "invoice_number", "amount", "created_at", "updated_at"];

export function nextInvoiceNumber(ps: PlStore, date: string): string {
  const prefix = `${company(ps).invoice_number_prefix}${date.slice(0, 4)}-`;
  const taken = ps.customerInvoices
    .all()
    .map((invoice) => invoice.invoice_number)
    .filter((number): number is string => !!number && number.startsWith(prefix))
    .map((number) => Number.parseInt(number.slice(prefix.length), 10))
    .filter(Number.isFinite);
  const next = (taken.length > 0 ? Math.max(...taken) : 0) + 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

export interface CreateInvoiceInput {
  body: Body;
  imported: boolean;
  draft: boolean;
}

export function createCustomerInvoice(ps: PlStore, input: CreateInvoiceInput): PlCustomerInvoice {
  const { body } = input;
  const customerId = num(body.customer_id) ?? num((body.customer as Body | undefined)?.id);
  const customer = customerId !== undefined ? findCustomer(ps, customerId) : undefined;
  if (customerId === undefined && !input.draft)
    throw unprocessable("Validation failed", [{ field: "customer_id", message: "can't be blank" }]);
  const date = dateOnly(body.date, "date", !input.draft) ?? today();
  const deadline =
    dateOnly(body.deadline, "deadline") ??
    addDays(
      date,
      customer?.payment_conditions === "upon_receipt"
        ? 0
        : Number.parseInt(customer?.payment_conditions ?? "30", 10) || 30,
    );
  if (deadline < date)
    throw unprocessable("Validation failed", [{ field: "deadline", message: "must be on or after the invoice date" }]);
  const explicitNumber = strOrNull(body.invoice_number);
  if (input.imported && !explicitNumber)
    throw unprocessable("Validation failed", [{ field: "invoice_number", message: "can't be blank" }]);
  if (explicitNumber && ps.customerInvoices.findOneBy("invoice_number", explicitNumber))
    throw unprocessable("Validation failed", [{ field: "invoice_number", message: "has already been taken" }]);
  const externalReference = strOrNull(body.external_reference);
  const file = decodeFile(body);
  if (input.imported && !file.content && !file.filename)
    throw unprocessable("Validation failed", [{ field: "file", message: "can't be blank" }]);
  const lines = body.invoice_lines !== undefined || !input.imported ? parseInvoiceLines(ps, body.invoice_lines) : [];
  const currencyAmount = num(body.currency_amount) ?? num(body.amount);
  const importedLines =
    lines.length === 0 && input.imported && currencyAmount !== undefined
      ? [
          {
            id: nextId(ps),
            label: str(body.label) ?? `Invoice ${explicitNumber}`,
            description: null,
            quantity: 1,
            unit: "piece",
            raw_currency_unit_price: currencyAmount / (1 + (num(body.vat_rate_value) ?? 0)),
            vat_rate: str(body.vat_rate) ?? "FR_0",
            discount: null,
            product_id: null,
            ledger_account_id: null,
          },
        ]
      : lines;
  const invoice = ps.customerInvoices.insert({
    pl_id: nextId(ps),
    label:
      str(body.label) ??
      (customer ? `${customer.name} - ${explicitNumber ?? "draft"}` : (explicitNumber ?? "Draft invoice")),
    invoice_number: input.draft ? null : (explicitNumber ?? nextInvoiceNumber(ps, date)),
    customer_id: customer?.pl_id ?? null,
    currency: str(body.currency) ?? company(ps).currency,
    exchange_rate: num(body.exchange_rate) ?? 1,
    date,
    deadline,
    external_reference: externalReference,
    pdf_invoice_free_text: strOrNull(body.pdf_invoice_free_text),
    pdf_invoice_subject: strOrNull(body.pdf_invoice_subject),
    special_mention: strOrNull(body.special_mention),
    language: str(body.language) ?? customer?.billing_language ?? "fr_FR",
    draft: input.draft,
    imported: input.imported,
    paid: bool(body.paid) ?? false,
    paid_amount: 0,
    cancelled_at: null,
    archived_at: null,
    filename: file.filename ?? (input.draft ? null : `${explicitNumber ?? "invoice"}.pdf`),
    file_content: file.content,
    file_content_type: file.content_type,
    invoice_lines: importedLines,
    categories: Array.isArray(body.categories) ? parseCategoryWeights(ps, body) : [],
    transaction_ids: [],
    transaction_reference: strOrNull(body.transaction_reference),
    discount: parseDiscount(body.discount) ?? null,
    credit_note_of_id: null,
    sent_at: null,
  });
  if (invoice.paid) ps.customerInvoices.update(invoice.id, { paid_amount: invoiceTotals(invoice).total });
  const stored = ps.customerInvoices.get(invoice.id)!;
  logEvent(
    ps,
    input.imported
      ? "customer_invoice.imported"
      : input.draft
        ? "customer_invoice.drafted"
        : "customer_invoice.created",
    String(stored.pl_id),
    {
      invoice_number: stored.invoice_number,
      external_reference: stored.external_reference,
      customer_id: stored.customer_id,
      amount: invoiceTotals(stored).total,
    },
  );
  return stored;
}

export function customerInvoiceRoutes(rc: PlRouteContext): void {
  const { app, ps, fmt, baseUrl } = rc;

  const listInvoices = (c: Context, rows: PlCustomerInvoice[]) =>
    listResponse(
      c,
      rows
        .filter((invoice) => !invoice.archived_at)
        .sort((a, b) => b.id - a.id)
        .map((invoice) => formatCustomerInvoice(fmt, invoice)),
      { filters: INVOICE_FILTERS, sortable: INVOICE_SORT },
    );

  route(
    app,
    "get",
    "/customer_invoices",
    api(ps, (c) => listInvoices(c, ps.customerInvoices.all())),
  );

  route(
    app,
    "post",
    "/customer_invoices",
    api(ps, async (c) => {
      const body = await parseJsonBody(c);
      const draft = bool(body.draft) ?? true;
      const invoice = createCustomerInvoice(ps, { body, imported: false, draft });
      return c.json(formatCustomerInvoice(fmt, invoice), 201);
    }),
  );

  route(
    app,
    "post",
    "/customer_invoices/import",
    api(ps, async (c) => {
      const body = await parseJsonBody(c);
      const invoice = createCustomerInvoice(ps, { body, imported: true, draft: false });
      return c.json(formatCustomerInvoice(fmt, invoice), 201);
    }),
  );

  route(
    app,
    "get",
    "/customer_invoices/:id",
    api(ps, (c) => c.json(formatCustomerInvoice(fmt, findCustomerInvoice(ps, c.req.param("id"))))),
  );

  route(
    app,
    "put",
    "/customer_invoices/:id",
    api(ps, async (c) => {
      const invoice = findCustomerInvoice(ps, c.req.param("id"));
      const body = await parseJsonBody(c);
      const editable: Partial<PlCustomerInvoice> = {
        external_reference:
          body.external_reference !== undefined ? strOrNull(body.external_reference) : invoice.external_reference,
        pdf_invoice_free_text:
          body.pdf_invoice_free_text !== undefined
            ? strOrNull(body.pdf_invoice_free_text)
            : invoice.pdf_invoice_free_text,
        pdf_invoice_subject:
          body.pdf_invoice_subject !== undefined ? strOrNull(body.pdf_invoice_subject) : invoice.pdf_invoice_subject,
        special_mention: body.special_mention !== undefined ? strOrNull(body.special_mention) : invoice.special_mention,
        transaction_reference:
          body.transaction_reference !== undefined
            ? strOrNull(body.transaction_reference)
            : invoice.transaction_reference,
        label: str(body.label) ?? invoice.label,
      };
      if (invoice.draft) {
        const customerId = num(body.customer_id) ?? num((body.customer as Body | undefined)?.id);
        Object.assign(editable, {
          customer_id: customerId !== undefined ? findCustomer(ps, customerId).pl_id : invoice.customer_id,
          date: dateOnly(body.date, "date") ?? invoice.date,
          deadline: dateOnly(body.deadline, "deadline") ?? invoice.deadline,
          currency: str(body.currency) ?? invoice.currency,
          language: str(body.language) ?? invoice.language,
          invoice_lines:
            body.invoice_lines !== undefined ? parseInvoiceLines(ps, body.invoice_lines) : invoice.invoice_lines,
          discount: parseDiscount(body.discount) ?? invoice.discount,
        });
      } else if (body.invoice_lines !== undefined || body.date !== undefined || body.customer_id !== undefined) {
        throw unprocessable("Validation failed", [
          {
            field: "invoice",
            message:
              "finalized invoices only accept external_reference, pdf_invoice_free_text, pdf_invoice_subject, special_mention, transaction_reference, and label",
          },
        ]);
      }
      const updated = ps.customerInvoices.update(invoice.id, editable)!;
      logEvent(ps, "customer_invoice.updated", String(updated.pl_id), { invoice_number: updated.invoice_number });
      return c.json(formatCustomerInvoice(fmt, updated));
    }),
  );

  route(
    app,
    "delete",
    "/customer_invoices/:id",
    api(ps, (c) => {
      const invoice = findCustomerInvoice(ps, c.req.param("id"));
      if (!invoice.draft)
        throw unprocessable("Validation failed", [
          {
            field: "invoice",
            message: "only draft invoices can be deleted; finalized invoices must be cancelled with a credit note",
          },
        ]);
      ps.customerInvoices.delete(invoice.id);
      logEvent(ps, "customer_invoice.deleted", String(invoice.pl_id), {});
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "post",
    "/customer_invoices/:id/finalize",
    api(ps, async (c) => {
      const invoice = findCustomerInvoice(ps, c.req.param("id"));
      if (!invoice.draft)
        throw unprocessable("Validation failed", [{ field: "invoice", message: "is already finalized" }]);
      if (!invoice.customer_id)
        throw unprocessable("Validation failed", [{ field: "customer_id", message: "can't be blank" }]);
      if (invoice.invoice_lines.length === 0)
        throw unprocessable("Validation failed", [
          { field: "invoice_lines", message: "must contain at least one line" },
        ]);
      const body = await parseJsonBody(c);
      const date = dateOnly(body.date, "date") ?? (invoice.date < today() ? today() : invoice.date);
      const invoiceNumber = nextInvoiceNumber(ps, date);
      const updated = ps.customerInvoices.update(invoice.id, {
        draft: false,
        date,
        deadline: invoice.deadline < date ? addDays(date, 30) : invoice.deadline,
        invoice_number: invoiceNumber,
        filename: `${invoiceNumber}.pdf`,
        label: invoice.label.replace(/draft$/i, invoiceNumber),
      })!;
      logEvent(ps, "customer_invoice.finalized", String(updated.pl_id), { invoice_number: invoiceNumber });
      return c.json(formatCustomerInvoice(fmt, updated));
    }),
  );

  route(
    app,
    "post",
    "/customer_invoices/:id/mark_as_paid",
    api(ps, async (c) => {
      const invoice = findCustomerInvoice(ps, c.req.param("id"));
      if (invoice.draft)
        throw unprocessable("Validation failed", [
          { field: "invoice", message: "draft invoices cannot be marked as paid" },
        ]);
      const body = await parseJsonBody(c);
      const total = invoiceTotals(invoice).total;
      const amount = num(body.amount) ?? total - invoice.paid_amount;
      const paidAmount = Math.min(total, invoice.paid_amount + amount);
      const updated = ps.customerInvoices.update(invoice.id, {
        paid_amount: paidAmount,
        paid: paidAmount >= total - 0.005,
      })!;
      logEvent(ps, "customer_invoice.paid", String(updated.pl_id), { invoice_number: updated.invoice_number, amount });
      return c.json(formatCustomerInvoice(fmt, updated));
    }),
  );

  route(
    app,
    "post",
    "/customer_invoices/:id/send_by_email",
    api(ps, async (c) => {
      const invoice = findCustomerInvoice(ps, c.req.param("id"));
      if (invoice.draft)
        throw unprocessable("Validation failed", [{ field: "invoice", message: "draft invoices cannot be sent" }]);
      const body = await parseJsonBody(c);
      const customer = invoice.customer_id ? ps.customers.findOneBy("pl_id", invoice.customer_id) : undefined;
      const recipients = Array.isArray(body.recipients) ? body.recipients.map(String) : (customer?.emails ?? []);
      if (recipients.length === 0)
        throw unprocessable("Validation failed", [{ field: "recipients", message: "can't be blank" }]);
      const updated = ps.customerInvoices.update(invoice.id, { sent_at: new Date().toISOString() })!;
      logEvent(ps, "customer_invoice.sent", String(updated.pl_id), {
        invoice_number: updated.invoice_number,
        recipients,
        subject: str(body.subject) ?? null,
      });
      return c.json({ sent: true, recipients, invoice: formatCustomerInvoice(fmt, updated) });
    }),
  );

  route(
    app,
    "post",
    "/customer_invoices/:id/cancel",
    api(ps, async (c) => {
      const invoice = findCustomerInvoice(ps, c.req.param("id"));
      if (invoice.draft)
        throw unprocessable("Validation failed", [
          { field: "invoice", message: "draft invoices can be deleted instead" },
        ]);
      if (invoice.cancelled_at)
        throw unprocessable("Validation failed", [{ field: "invoice", message: "is already cancelled" }]);
      const body = await parseJsonBody(c);
      const date = dateOnly(body.date, "date") ?? today();
      const creditNumber = nextInvoiceNumber(ps, date).replace(company(ps).invoice_number_prefix, "AV-");
      const creditNote = ps.customerInvoices.insert({
        ...stripEntity(invoice),
        pl_id: nextId(ps),
        label: `Credit note for ${invoice.invoice_number}`,
        invoice_number: creditNumber,
        date,
        deadline: date,
        invoice_lines: invoice.invoice_lines.map((line) => ({ ...line, id: nextId(ps), quantity: -line.quantity })),
        paid: true,
        paid_amount: 0,
        cancelled_at: null,
        credit_note_of_id: invoice.pl_id,
        filename: `${creditNumber}.pdf`,
        file_content: null,
        sent_at: null,
        transaction_ids: [],
      });
      const updated = ps.customerInvoices.update(invoice.id, { cancelled_at: new Date().toISOString() })!;
      logEvent(ps, "customer_invoice.cancelled", String(updated.pl_id), {
        invoice_number: updated.invoice_number,
        credit_note: creditNumber,
      });
      return c.json({
        invoice: formatCustomerInvoice(fmt, updated),
        credit_note: formatCustomerInvoice(fmt, creditNote),
      });
    }),
  );

  route(
    app,
    "get",
    "/customer_invoices/:id/invoice_lines",
    api(ps, (c) => {
      const invoice = findCustomerInvoice(ps, c.req.param("id"));
      return listResponse(
        c,
        invoice.invoice_lines.map((line) => formatInvoiceLine(line, invoice.currency)),
        { filters: { id: true, label: true }, sortable: ["id"] },
      );
    }),
  );

  route(
    app,
    "get",
    "/customer_invoices/:id/categories",
    api(ps, (c) => {
      const invoice = findCustomerInvoice(ps, c.req.param("id"));
      return listResponse(c, formatCategoryWeights(fmt, invoice.categories), {
        filters: { id: true },
        sortable: ["id"],
      });
    }),
  );

  route(
    app,
    "put",
    "/customer_invoices/:id/categories",
    api(ps, async (c) => {
      const invoice = findCustomerInvoice(ps, c.req.param("id"));
      const body = await parseJsonBody(c);
      const updated = ps.customerInvoices.update(invoice.id, { categories: parseCategoryWeights(ps, body) })!;
      return c.json({ items: formatCategoryWeights(fmt, updated.categories), has_more: false, next_cursor: null });
    }),
  );

  route(
    app,
    "get",
    "/customer_invoices/:id/matched_transactions",
    api(ps, (c) => {
      const invoice = findCustomerInvoice(ps, c.req.param("id"));
      const transactions = invoice.transaction_ids
        .map((id) => ps.transactions.findOneBy("pl_id", id))
        .filter((transaction): transaction is NonNullable<typeof transaction> => !!transaction);
      return listResponse(
        c,
        transactions.map((transaction) => formatTransaction(fmt, transaction)),
        { filters: { id: true }, sortable: ["id", "date"] },
      );
    }),
  );

  route(
    app,
    "put",
    "/customer_invoices/:id/matched_transactions",
    api(ps, async (c) => {
      const invoice = findCustomerInvoice(ps, c.req.param("id"));
      if (invoice.draft)
        throw unprocessable("Validation failed", [{ field: "invoice", message: "draft invoices cannot be matched" }]);
      const body = await parseJsonBody(c);
      const ids = Array.isArray(body.transaction_ids)
        ? body.transaction_ids.map((id) => num(id)).filter((id): id is number => id !== undefined)
        : [];
      const transactions = ids.map((id) => findTransaction(ps, id));
      for (const transaction of ps.transactions.all()) {
        const shouldMatch = ids.includes(transaction.pl_id);
        const matched = transaction.matched_customer_invoice_ids.includes(invoice.pl_id);
        if (shouldMatch && !matched)
          ps.transactions.update(transaction.id, {
            matched_customer_invoice_ids: [...transaction.matched_customer_invoice_ids, invoice.pl_id],
          });
        if (!shouldMatch && matched)
          ps.transactions.update(transaction.id, {
            matched_customer_invoice_ids: transaction.matched_customer_invoice_ids.filter((id) => id !== invoice.pl_id),
          });
      }
      const total = invoiceTotals(invoice).total;
      const paidAmount = Math.min(
        total,
        transactions.reduce((sum, transaction) => sum + Math.max(0, transaction.amount), 0),
      );
      const updated = ps.customerInvoices.update(invoice.id, {
        transaction_ids: ids,
        paid_amount: Math.max(paidAmount, invoice.paid ? total : 0),
        paid: invoice.paid || paidAmount >= total - 0.005,
      })!;
      logEvent(ps, "customer_invoice.matched", String(updated.pl_id), { transaction_ids: ids, paid: updated.paid });
      return c.json({
        items: ids.map((id) => formatTransaction(fmt, findTransaction(ps, id))),
        has_more: false,
        next_cursor: null,
      });
    }),
  );

  route(
    app,
    "get",
    "/customer_invoices/:id/appendices",
    api(ps, (c) => {
      const invoice = findCustomerInvoice(ps, c.req.param("id"));
      const appendices = ps.appendices
        .findBy("target_id", invoice.pl_id)
        .filter((appendix) => appendix.target_type === "customer_invoice");
      return listResponse(
        c,
        appendices.map((appendix) => formatAppendix(fmt, appendix)),
        { filters: { id: true, filename: true }, sortable: ["id", "created_at"] },
      );
    }),
  );

  route(
    app,
    "post",
    "/customer_invoices/:id/appendices",
    api(ps, async (c) => {
      const invoice = findCustomerInvoice(ps, c.req.param("id"));
      const appendix = await storeAppendix(c, ps, "customer_invoice", invoice.pl_id);
      return c.json(formatAppendix(fmt, appendix), 201);
    }),
  );

  route(
    app,
    "delete",
    "/customer_invoices/:id/appendices/:appendixId",
    api(ps, (c) => {
      const invoice = findCustomerInvoice(ps, c.req.param("id"));
      const appendix = ps.appendices.findOneBy("pl_id", requireInt(c.req.param("appendixId"), "Appendix"));
      if (!appendix || appendix.target_id !== invoice.pl_id || appendix.target_type !== "customer_invoice")
        throw notFound("Appendix not found");
      ps.appendices.delete(appendix.id);
      logEvent(ps, "appendix.deleted", String(appendix.pl_id), { filename: appendix.filename });
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/customer_invoices/:id/file",
    api(ps, (c) => {
      const invoice = findCustomerInvoice(ps, c.req.param("id"));
      return invoiceFile(c, invoice);
    }),
  );

  app.get("/_pennylane/files/customer_invoices/:id/:name", (c) => {
    const invoice = ps.customerInvoices.findOneBy("pl_id", Number(c.req.param("id")));
    if (!invoice) return c.text("Not found", 404);
    return invoiceFile(c, invoice);
  });

  app.get("/_pennylane/appendices/:id/:name", (c) => {
    const appendix = ps.appendices.findOneBy("pl_id", Number(c.req.param("id")));
    if (!appendix) return c.text("Not found", 404);
    return c.body(Buffer.from(appendix.content, "base64"), 200, {
      "Content-Type": appendix.content_type,
      "Content-Disposition": `inline; filename="${appendix.filename}"`,
    });
  });

  function invoiceFile(c: Context, invoice: PlCustomerInvoice): Response {
    if (invoice.file_content)
      return c.body(Buffer.from(invoice.file_content, "base64"), 200, {
        "Content-Type": invoice.file_content_type ?? "application/pdf",
        "Content-Disposition": `inline; filename="${invoice.filename ?? "invoice.pdf"}"`,
      });
    const totals = invoiceTotals(invoice);
    const text = `%PDF-1.4 emulated\nInvoice ${invoice.invoice_number ?? "(draft)"}\nStatus ${customerInvoiceStatus(invoice)}\nTotal ${totals.total.toFixed(2)} ${invoice.currency}\nBase URL ${baseUrl}\n`;
    return c.body(Buffer.from(text), 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${invoice.filename ?? "invoice.pdf"}"`,
    });
  }
}

function stripEntity<T extends { id: number; created_at: string; updated_at: string }>(
  entity: T,
): Omit<T, "id" | "created_at" | "updated_at"> {
  const { id: _id, created_at: _created, updated_at: _updated, ...rest } = entity;
  return rest;
}
