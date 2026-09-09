import type { PlSupplierInvoice } from "../entities.js";
import {
  formatAppendix,
  formatCategoryWeights,
  formatInvoiceLine,
  formatSupplierInvoice,
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
  findSupplier,
  findSupplierInvoice,
  findTransaction,
  parseCategoryWeights,
  parseInvoiceLines,
  storeAppendix,
  type PlRouteContext,
} from "../route-utils.js";

const FILTERS = {
  id: true,
  invoice_number: { operators: ["eq", "in", "not_eq", "contains"] },
  external_reference: { operators: ["eq", "in"] },
  supplier_id: {
    operators: ["eq", "in", "not_eq"],
    get: (row: Json) => (row.supplier as { id: number } | null)?.id ?? null,
  },
  status: true,
  paid: true,
  date: true,
  deadline: true,
  currency: true,
  amount: true,
  label: true,
  created_at: true,
  updated_at: true,
} as const;
const SORT = ["id", "date", "deadline", "invoice_number", "amount", "created_at", "updated_at"];

export function importSupplierInvoice(ps: PlStore, body: Body): PlSupplierInvoice {
  const supplierId = num(body.supplier_id) ?? num((body.supplier as Body | undefined)?.id);
  const supplier = supplierId !== undefined ? findSupplier(ps, supplierId) : undefined;
  const date = dateOnly(body.date, "date", true) ?? today();
  const deadline = dateOnly(body.deadline, "deadline") ?? addDays(date, 30);
  const file = decodeFile(body);
  if (!file.content && !file.filename)
    throw unprocessable("Validation failed", [{ field: "file", message: "can't be blank" }]);
  const lines =
    Array.isArray(body.invoice_lines) && body.invoice_lines.length > 0 ? parseInvoiceLines(ps, body.invoice_lines) : [];
  const explicitAmount = num(body.currency_amount) ?? num(body.amount);
  const explicitBeforeTax = num(body.currency_amount_before_tax) ?? num(body.amount_before_tax);
  if (lines.length === 0 && explicitAmount === undefined)
    throw unprocessable("Validation failed", [
      { field: "amount", message: "can't be blank when no invoice line is provided" },
    ]);
  const totals =
    lines.length > 0
      ? invoiceTotals({ invoice_lines: lines, discount: null })
      : { total: explicitAmount ?? 0, before_tax: explicitBeforeTax ?? explicitAmount ?? 0, tax: 0 };
  const invoice = ps.supplierInvoices.insert({
    pl_id: nextId(ps),
    label: str(body.label) ?? `${supplier?.name ?? "Supplier"} - ${str(body.invoice_number) ?? date}`,
    invoice_number: strOrNull(body.invoice_number),
    supplier_id: supplier?.pl_id ?? null,
    currency: str(body.currency) ?? company(ps).currency,
    exchange_rate: num(body.exchange_rate) ?? 1,
    date,
    deadline,
    external_reference: strOrNull(body.external_reference),
    paid: bool(body.paid) ?? false,
    paid_amount: bool(body.paid) ? totals.total : 0,
    amount: totals.total,
    amount_before_tax: totals.before_tax,
    archived_at: null,
    filename: file.filename ?? "supplier-invoice.pdf",
    file_content: file.content,
    file_content_type: file.content_type,
    invoice_lines: lines,
    categories: Array.isArray(body.categories) ? parseCategoryWeights(ps, body) : [],
    transaction_ids: [],
    ledger_account_id: num(body.ledger_account_id) ?? supplier?.ledger_account_id ?? null,
  });
  logEvent(ps, "supplier_invoice.imported", String(invoice.pl_id), {
    invoice_number: invoice.invoice_number,
    supplier_id: invoice.supplier_id,
    amount: invoice.amount,
  });
  return invoice;
}

export function supplierInvoiceRoutes(rc: PlRouteContext): void {
  const { app, ps, fmt } = rc;

  route(
    app,
    "get",
    "/supplier_invoices",
    api(ps, (c) =>
      listResponse(
        c,
        ps.supplierInvoices
          .all()
          .filter((invoice) => !invoice.archived_at)
          .sort((a, b) => b.id - a.id)
          .map((invoice) => formatSupplierInvoice(fmt, invoice)),
        { filters: FILTERS, sortable: SORT },
      ),
    ),
  );

  route(
    app,
    "post",
    "/supplier_invoices/import",
    api(ps, async (c) => c.json(formatSupplierInvoice(fmt, importSupplierInvoice(ps, await parseJsonBody(c))), 201)),
  );
  route(
    app,
    "post",
    "/supplier_invoices",
    api(ps, async (c) => c.json(formatSupplierInvoice(fmt, importSupplierInvoice(ps, await parseJsonBody(c))), 201)),
  );

  route(
    app,
    "get",
    "/supplier_invoices/:id",
    api(ps, (c) => c.json(formatSupplierInvoice(fmt, findSupplierInvoice(ps, c.req.param("id"))))),
  );

  route(
    app,
    "put",
    "/supplier_invoices/:id",
    api(ps, async (c) => {
      const invoice = findSupplierInvoice(ps, c.req.param("id"));
      const body = await parseJsonBody(c);
      const supplierId = num(body.supplier_id);
      const updated = ps.supplierInvoices.update(invoice.id, {
        label: str(body.label) ?? invoice.label,
        invoice_number: body.invoice_number !== undefined ? strOrNull(body.invoice_number) : invoice.invoice_number,
        supplier_id: supplierId !== undefined ? findSupplier(ps, supplierId).pl_id : invoice.supplier_id,
        date: dateOnly(body.date, "date") ?? invoice.date,
        deadline: dateOnly(body.deadline, "deadline") ?? invoice.deadline,
        external_reference:
          body.external_reference !== undefined ? strOrNull(body.external_reference) : invoice.external_reference,
        amount: num(body.currency_amount) ?? num(body.amount) ?? invoice.amount,
        amount_before_tax:
          num(body.currency_amount_before_tax) ?? num(body.amount_before_tax) ?? invoice.amount_before_tax,
        ledger_account_id: num(body.ledger_account_id) ?? invoice.ledger_account_id,
      })!;
      return c.json(formatSupplierInvoice(fmt, updated));
    }),
  );

  route(
    app,
    "delete",
    "/supplier_invoices/:id",
    api(ps, (c) => {
      const invoice = findSupplierInvoice(ps, c.req.param("id"));
      ps.supplierInvoices.update(invoice.id, { archived_at: new Date().toISOString() });
      logEvent(ps, "supplier_invoice.archived", String(invoice.pl_id), {});
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "post",
    "/supplier_invoices/:id/mark_as_paid",
    api(ps, async (c) => {
      const invoice = findSupplierInvoice(ps, c.req.param("id"));
      const body = await parseJsonBody(c);
      const amount = num(body.amount) ?? invoice.amount - invoice.paid_amount;
      const paidAmount = Math.min(invoice.amount, invoice.paid_amount + amount);
      const updated = ps.supplierInvoices.update(invoice.id, {
        paid_amount: paidAmount,
        paid: paidAmount >= invoice.amount - 0.005,
      })!;
      logEvent(ps, "supplier_invoice.paid", String(updated.pl_id), { amount });
      return c.json(formatSupplierInvoice(fmt, updated));
    }),
  );

  route(
    app,
    "get",
    "/supplier_invoices/:id/invoice_lines",
    api(ps, (c) => {
      const invoice = findSupplierInvoice(ps, c.req.param("id"));
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
    "/supplier_invoices/:id/categories",
    api(ps, (c) =>
      listResponse(c, formatCategoryWeights(fmt, findSupplierInvoice(ps, c.req.param("id")).categories), {
        filters: { id: true },
        sortable: ["id"],
      }),
    ),
  );

  route(
    app,
    "put",
    "/supplier_invoices/:id/categories",
    api(ps, async (c) => {
      const invoice = findSupplierInvoice(ps, c.req.param("id"));
      const updated = ps.supplierInvoices.update(invoice.id, {
        categories: parseCategoryWeights(ps, await parseJsonBody(c)),
      })!;
      return c.json({ items: formatCategoryWeights(fmt, updated.categories), has_more: false, next_cursor: null });
    }),
  );

  route(
    app,
    "get",
    "/supplier_invoices/:id/matched_transactions",
    api(ps, (c) => {
      const invoice = findSupplierInvoice(ps, c.req.param("id"));
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
    "/supplier_invoices/:id/matched_transactions",
    api(ps, async (c) => {
      const invoice = findSupplierInvoice(ps, c.req.param("id"));
      const body = await parseJsonBody(c);
      const ids = Array.isArray(body.transaction_ids)
        ? body.transaction_ids.map((id) => num(id)).filter((id): id is number => id !== undefined)
        : [];
      const transactions = ids.map((id) => findTransaction(ps, id));
      for (const transaction of ps.transactions.all()) {
        const shouldMatch = ids.includes(transaction.pl_id);
        const matched = transaction.matched_supplier_invoice_ids.includes(invoice.pl_id);
        if (shouldMatch && !matched)
          ps.transactions.update(transaction.id, {
            matched_supplier_invoice_ids: [...transaction.matched_supplier_invoice_ids, invoice.pl_id],
          });
        if (!shouldMatch && matched)
          ps.transactions.update(transaction.id, {
            matched_supplier_invoice_ids: transaction.matched_supplier_invoice_ids.filter((id) => id !== invoice.pl_id),
          });
      }
      const paidAmount = Math.min(
        invoice.amount,
        transactions.reduce((sum, transaction) => sum + Math.abs(Math.min(0, transaction.amount)), 0),
      );
      const updated = ps.supplierInvoices.update(invoice.id, {
        transaction_ids: ids,
        paid_amount: Math.max(paidAmount, invoice.paid ? invoice.amount : 0),
        paid: invoice.paid || paidAmount >= invoice.amount - 0.005,
      })!;
      return c.json({
        items: updated.transaction_ids.map((id) => formatTransaction(fmt, findTransaction(ps, id))),
        has_more: false,
        next_cursor: null,
      });
    }),
  );

  route(
    app,
    "get",
    "/supplier_invoices/:id/appendices",
    api(ps, (c) => {
      const invoice = findSupplierInvoice(ps, c.req.param("id"));
      const appendices = ps.appendices
        .findBy("target_id", invoice.pl_id)
        .filter((appendix) => appendix.target_type === "supplier_invoice");
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
    "/supplier_invoices/:id/appendices",
    api(ps, async (c) => {
      const invoice = findSupplierInvoice(ps, c.req.param("id"));
      return c.json(formatAppendix(fmt, await storeAppendix(c, ps, "supplier_invoice", invoice.pl_id)), 201);
    }),
  );

  route(
    app,
    "delete",
    "/supplier_invoices/:id/appendices/:appendixId",
    api(ps, (c) => {
      const invoice = findSupplierInvoice(ps, c.req.param("id"));
      const appendix = ps.appendices.findOneBy("pl_id", requireInt(c.req.param("appendixId"), "Appendix"));
      if (!appendix || appendix.target_id !== invoice.pl_id || appendix.target_type !== "supplier_invoice")
        throw notFound("Appendix not found");
      ps.appendices.delete(appendix.id);
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/supplier_invoices/:id/file",
    api(ps, (c) => {
      const invoice = findSupplierInvoice(ps, c.req.param("id"));
      if (invoice.file_content)
        return c.body(Buffer.from(invoice.file_content, "base64"), 200, {
          "Content-Type": invoice.file_content_type ?? "application/pdf",
        });
      return c.body(
        Buffer.from(
          `%PDF-1.4 emulated\nSupplier invoice ${invoice.invoice_number ?? invoice.pl_id}\nTotal ${invoice.amount.toFixed(2)} ${invoice.currency}\n`,
        ),
        200,
        { "Content-Type": "application/pdf" },
      );
    }),
  );

  app.get("/_pennylane/files/supplier_invoices/:id/:name", (c) => {
    const invoice = ps.supplierInvoices.findOneBy("pl_id", Number(c.req.param("id")));
    if (!invoice) return c.text("Not found", 404);
    if (invoice.file_content)
      return c.body(Buffer.from(invoice.file_content, "base64"), 200, {
        "Content-Type": invoice.file_content_type ?? "application/pdf",
      });
    return c.body(
      Buffer.from(`%PDF-1.4 emulated\nSupplier invoice ${invoice.invoice_number ?? invoice.pl_id}\n`),
      200,
      { "Content-Type": "application/pdf" },
    );
  });
}
