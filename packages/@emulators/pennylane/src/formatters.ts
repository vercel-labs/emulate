import type {
  InvoiceStatus,
  PlAppendix,
  PlBankAccount,
  PlCategory,
  PlCategoryGroup,
  PlCustomer,
  PlCustomerInvoice,
  PlFiscalYear,
  PlInvoiceLine,
  PlJournal,
  PlLedgerAccount,
  PlLedgerEntry,
  PlProduct,
  PlSupplier,
  PlSupplierInvoice,
  PlTransaction,
} from "./entities.js";
import { money, round2, today, type Json } from "./helpers.js";
import { company, type PlStore } from "./store.js";

export interface Fmt {
  ps: PlStore;
  baseUrl: string;
}

const API_PREFIX = "/api/external/v2";

function link(f: Fmt, path: string): string {
  return `${f.baseUrl}${API_PREFIX}${path}`;
}

export function lineAmounts(line: PlInvoiceLine): { before_tax: number; tax: number; total: number } {
  const gross = line.quantity * line.raw_currency_unit_price;
  const discounted = line.discount
    ? line.discount.type === "relative"
      ? gross * (1 - line.discount.value / 100)
      : gross - line.discount.value
    : gross;
  const rate = vatRateValue(line.vat_rate);
  const before = round2(discounted);
  const tax = round2(before * rate);
  return { before_tax: before, tax, total: round2(before + tax) };
}

export function vatRateValue(rate: string): number {
  const match = rate.match(/^[A-Z]{2}_(\d+)$/);
  if (!match) return 0;
  return Number(match[1]) / 1000;
}

export function invoiceTotals(invoice: { invoice_lines: PlInvoiceLine[]; discount: PlCustomerInvoice["discount"] }): {
  before_tax: number;
  tax: number;
  total: number;
} {
  const sums = invoice.invoice_lines.reduce(
    (acc, line) => {
      const amounts = lineAmounts(line);
      return {
        before_tax: acc.before_tax + amounts.before_tax,
        tax: acc.tax + amounts.tax,
        total: acc.total + amounts.total,
      };
    },
    { before_tax: 0, tax: 0, total: 0 },
  );
  if (invoice.discount) {
    const factor =
      invoice.discount.type === "relative"
        ? 1 - invoice.discount.value / 100
        : Math.max(0, 1 - invoice.discount.value / Math.max(sums.total, 0.01));
    return {
      before_tax: round2(sums.before_tax * factor),
      tax: round2(sums.tax * factor),
      total: round2(sums.total * factor),
    };
  }
  return { before_tax: round2(sums.before_tax), tax: round2(sums.tax), total: round2(sums.total) };
}

export function customerInvoiceStatus(invoice: PlCustomerInvoice): InvoiceStatus {
  if (invoice.draft) return "draft";
  if (invoice.cancelled_at) return invoice.paid_amount > 0 ? "partially_cancelled" : "cancelled";
  if (invoice.paid) return "paid";
  if (!invoice.customer_id) return "incomplete";
  return invoice.deadline < today() ? "late" : "upcoming";
}

export function formatInvoiceLine(line: PlInvoiceLine, currency: string): Json {
  const amounts = lineAmounts(line);
  return {
    id: line.id,
    label: line.label,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    raw_currency_unit_price: money(line.raw_currency_unit_price),
    currency_unit_price: money(line.raw_currency_unit_price),
    currency_amount: money(amounts.total),
    currency_amount_before_tax: money(amounts.before_tax),
    currency_tax: money(amounts.tax),
    amount: money(amounts.total),
    amount_before_tax: money(amounts.before_tax),
    tax: money(amounts.tax),
    currency,
    vat_rate: line.vat_rate,
    discount: line.discount,
    product: line.product_id ? { id: line.product_id } : null,
    ledger_account: line.ledger_account_id ? { id: line.ledger_account_id } : null,
  };
}

export function formatCustomerInvoice(f: Fmt, invoice: PlCustomerInvoice): Json {
  const totals = invoiceTotals(invoice);
  const remaining = round2(Math.max(0, totals.total - invoice.paid_amount));
  const customer = invoice.customer_id ? f.ps.customers.findOneBy("pl_id", invoice.customer_id) : undefined;
  return {
    id: invoice.pl_id,
    label: invoice.label,
    invoice_number: invoice.invoice_number,
    currency: invoice.currency,
    amount: money(totals.total),
    amount_before_tax: money(totals.before_tax),
    tax: money(totals.tax),
    currency_amount: money(totals.total),
    currency_amount_before_tax: money(totals.before_tax),
    currency_tax: money(totals.tax),
    exchange_rate: money(invoice.exchange_rate),
    date: invoice.date,
    deadline: invoice.deadline,
    paid: invoice.paid,
    remaining_amount: money(remaining),
    currency_remaining_amount: money(remaining),
    status: customerInvoiceStatus(invoice),
    draft: invoice.draft,
    imported: invoice.imported,
    external_reference: invoice.external_reference,
    pdf_invoice_free_text: invoice.pdf_invoice_free_text,
    pdf_invoice_subject: invoice.pdf_invoice_subject,
    special_mention: invoice.special_mention,
    discount: invoice.discount,
    language: invoice.language,
    transaction_reference: invoice.transaction_reference,
    archived_at: invoice.archived_at,
    cancelled_at: invoice.cancelled_at,
    sent_at: invoice.sent_at,
    filename: invoice.filename,
    file_url: invoice.filename ? link(f, `/customer_invoices/${invoice.pl_id}/file`) : null,
    public_file_url: invoice.filename
      ? `${f.baseUrl}/_pennylane/files/customer_invoices/${invoice.pl_id}/${encodeURIComponent(invoice.filename)}`
      : null,
    customer: customer
      ? { id: customer.pl_id, name: customer.name, url: link(f, `/customers/${customer.pl_id}`) }
      : null,
    invoice_lines: { url: link(f, `/customer_invoices/${invoice.pl_id}/invoice_lines`) },
    categories: { url: link(f, `/customer_invoices/${invoice.pl_id}/categories`) },
    matched_transactions: { url: link(f, `/customer_invoices/${invoice.pl_id}/matched_transactions`) },
    appendices: { url: link(f, `/customer_invoices/${invoice.pl_id}/appendices`) },
    credit_note_of: invoice.credit_note_of_id
      ? { id: invoice.credit_note_of_id, url: link(f, `/customer_invoices/${invoice.credit_note_of_id}`) }
      : null,
    created_at: invoice.created_at,
    updated_at: invoice.updated_at,
  };
}

export function formatSupplierInvoice(f: Fmt, invoice: PlSupplierInvoice): Json {
  const remaining = round2(Math.max(0, invoice.amount - invoice.paid_amount));
  const supplier = invoice.supplier_id ? f.ps.suppliers.findOneBy("pl_id", invoice.supplier_id) : undefined;
  return {
    id: invoice.pl_id,
    label: invoice.label,
    invoice_number: invoice.invoice_number,
    currency: invoice.currency,
    amount: money(invoice.amount),
    amount_before_tax: money(invoice.amount_before_tax),
    tax: money(round2(invoice.amount - invoice.amount_before_tax)),
    currency_amount: money(invoice.amount),
    currency_amount_before_tax: money(invoice.amount_before_tax),
    exchange_rate: money(invoice.exchange_rate),
    date: invoice.date,
    deadline: invoice.deadline,
    paid: invoice.paid,
    remaining_amount: money(remaining),
    status: invoice.paid ? "paid" : invoice.deadline < today() ? "late" : "upcoming",
    external_reference: invoice.external_reference,
    archived_at: invoice.archived_at,
    filename: invoice.filename,
    file_url: invoice.filename ? link(f, `/supplier_invoices/${invoice.pl_id}/file`) : null,
    public_file_url: invoice.filename
      ? `${f.baseUrl}/_pennylane/files/supplier_invoices/${invoice.pl_id}/${encodeURIComponent(invoice.filename)}`
      : null,
    supplier: supplier
      ? { id: supplier.pl_id, name: supplier.name, url: link(f, `/suppliers/${supplier.pl_id}`) }
      : null,
    ledger_account: invoice.ledger_account_id ? { id: invoice.ledger_account_id } : null,
    invoice_lines: { url: link(f, `/supplier_invoices/${invoice.pl_id}/invoice_lines`) },
    categories: { url: link(f, `/supplier_invoices/${invoice.pl_id}/categories`) },
    matched_transactions: { url: link(f, `/supplier_invoices/${invoice.pl_id}/matched_transactions`) },
    appendices: { url: link(f, `/supplier_invoices/${invoice.pl_id}/appendices`) },
    created_at: invoice.created_at,
    updated_at: invoice.updated_at,
  };
}

export function formatAppendix(f: Fmt, appendix: PlAppendix): Json {
  return {
    id: appendix.pl_id,
    filename: appendix.filename,
    content_type: appendix.content_type,
    size: appendix.size,
    url: `${f.baseUrl}/_pennylane/appendices/${appendix.pl_id}/${encodeURIComponent(appendix.filename)}`,
    created_at: appendix.created_at,
    updated_at: appendix.updated_at,
  };
}

export function formatCustomer(f: Fmt, customer: PlCustomer): Json {
  return {
    id: customer.pl_id,
    customer_type: customer.customer_type,
    name: customer.name,
    first_name: customer.first_name,
    last_name: customer.last_name,
    gender: customer.gender,
    reg_no: customer.reg_no,
    vat_number: customer.vat_number,
    emails: customer.emails,
    phone: customer.phone,
    billing_iban: customer.billing_iban,
    billing_address: customer.billing_address,
    delivery_address: customer.delivery_address,
    recipient: customer.recipient,
    reference: customer.reference,
    notes: customer.notes,
    payment_conditions: customer.payment_conditions,
    billing_language: customer.billing_language,
    external_reference: customer.external_reference,
    archived: customer.archived,
    invoices: {
      url: link(
        f,
        `/customer_invoices?filter=${encodeURIComponent(JSON.stringify([{ field: "customer_id", operator: "eq", value: customer.pl_id }]))}`,
      ),
    },
    created_at: customer.created_at,
    updated_at: customer.updated_at,
  };
}

export function formatSupplier(_f: Fmt, supplier: PlSupplier): Json {
  return {
    id: supplier.pl_id,
    name: supplier.name,
    reg_no: supplier.reg_no,
    vat_number: supplier.vat_number,
    iban: supplier.iban,
    emails: supplier.emails,
    billing_address: supplier.billing_address,
    payment_conditions: supplier.payment_conditions,
    recipient: supplier.recipient,
    notes: supplier.notes,
    external_reference: supplier.external_reference,
    ledger_account: supplier.ledger_account_id ? { id: supplier.ledger_account_id } : null,
    archived: supplier.archived,
    created_at: supplier.created_at,
    updated_at: supplier.updated_at,
  };
}

export function formatProduct(product: PlProduct): Json {
  const rate = vatRateValue(product.vat_rate);
  return {
    id: product.pl_id,
    label: product.label,
    description: product.description,
    price_before_tax: money(product.price_before_tax),
    price: money(product.price_before_tax * (1 + rate)),
    vat_rate: product.vat_rate,
    unit: product.unit,
    currency: product.currency,
    reference: product.reference,
    external_reference: product.external_reference,
    ledger_account: product.ledger_account_id ? { id: product.ledger_account_id } : null,
    created_at: product.created_at,
    updated_at: product.updated_at,
  };
}

export function formatCategoryGroup(group: PlCategoryGroup): Json {
  return {
    id: group.pl_id,
    label: group.label,
    direction: group.direction,
    external_reference: group.external_reference,
    created_at: group.created_at,
    updated_at: group.updated_at,
  };
}

export function formatCategory(f: Fmt, category: PlCategory): Json {
  const group = category.category_group_id
    ? f.ps.categoryGroups.findOneBy("pl_id", category.category_group_id)
    : undefined;
  return {
    id: category.pl_id,
    label: category.label,
    color: category.color,
    direction: category.direction,
    external_reference: category.external_reference,
    category_group: group ? { id: group.pl_id, label: group.label } : null,
    created_at: category.created_at,
    updated_at: category.updated_at,
  };
}

export function formatCategoryWeights(f: Fmt, weights: Array<{ category_id: number; weight: number }>): Json[] {
  return weights.map((entry) => {
    const category = f.ps.categories.findOneBy("pl_id", entry.category_id);
    return {
      id: entry.category_id,
      label: category?.label ?? null,
      weight: entry.weight,
      ...(category ? { color: category.color, direction: category.direction } : {}),
    };
  });
}

export function formatJournal(journal: PlJournal): Json {
  return {
    id: journal.pl_id,
    code: journal.code,
    label: journal.label,
    created_at: journal.created_at,
    updated_at: journal.updated_at,
  };
}

export function formatLedgerAccount(account: PlLedgerAccount): Json {
  return {
    id: account.pl_id,
    number: account.number,
    label: account.label,
    vat_rate: account.vat_rate,
    enabled: account.enabled,
    created_at: account.created_at,
    updated_at: account.updated_at,
  };
}

export function formatFiscalYear(year: PlFiscalYear): Json {
  return { id: year.pl_id, start_date: year.start_date, end_date: year.end_date, closed: year.closed };
}

export function formatBankAccount(f: Fmt, account: PlBankAccount): Json {
  const balance = f.ps.transactions
    .findBy("bank_account_id", account.pl_id)
    .reduce((sum, transaction) => sum + transaction.amount, account.balance);
  return {
    id: account.pl_id,
    label: account.label,
    bank_name: account.bank_name,
    iban: account.iban,
    bic: account.bic,
    currency: account.currency,
    balance: money(balance),
    ledger_account: account.ledger_account_id ? { id: account.ledger_account_id } : null,
    created_at: account.created_at,
    updated_at: account.updated_at,
  };
}

export function formatTransaction(f: Fmt, transaction: PlTransaction): Json {
  return {
    id: transaction.pl_id,
    label: transaction.label,
    amount: money(transaction.amount),
    currency: transaction.currency,
    currency_amount: money(transaction.currency_amount),
    date: transaction.date,
    fee: money(transaction.fee),
    archived: transaction.archived,
    external_reference: transaction.external_reference,
    bank_account: { id: transaction.bank_account_id, url: link(f, `/bank_accounts/${transaction.bank_account_id}`) },
    categories: { url: link(f, `/transactions/${transaction.pl_id}/categories`) },
    matched_invoices: { url: link(f, `/transactions/${transaction.pl_id}/matched_invoices`) },
    created_at: transaction.created_at,
    updated_at: transaction.updated_at,
  };
}

export function formatLedgerEntry(f: Fmt, entry: PlLedgerEntry): Json {
  const journal = f.ps.journals.findOneBy("pl_id", entry.journal_id);
  return {
    id: entry.pl_id,
    date: entry.date,
    label: entry.label,
    journal: journal ? { id: journal.pl_id, code: journal.code, label: journal.label } : { id: entry.journal_id },
    external_reference: entry.external_reference,
    source: entry.source_type ? { type: entry.source_type, id: entry.source_id } : null,
    lines: entry.lines.map((line) => formatLedgerEntryLine(f, entry, line)),
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };
}

export function formatLedgerEntryLine(f: Fmt, entry: PlLedgerEntry, line: PlLedgerEntry["lines"][number]): Json {
  const account = f.ps.ledgerAccounts.findOneBy("pl_id", line.ledger_account_id);
  return {
    id: line.id,
    ledger_entry: { id: entry.pl_id, date: entry.date, label: entry.label },
    ledger_account: account
      ? { id: account.pl_id, number: account.number, label: account.label }
      : { id: line.ledger_account_id },
    debit: money(line.debit),
    credit: money(line.credit),
    label: line.label ?? entry.label,
    lettering: line.lettering,
    date: entry.date,
  };
}

export function formatCompany(f: Fmt): Json {
  const c = company(f.ps);
  return {
    id: c.id,
    name: c.name,
    reg_no: c.reg_no,
    vat_number: c.vat_number,
    address: { address: c.address, postal_code: c.postal_code, city: c.city, country_alpha2: c.country_alpha2 },
    currency: c.currency,
    invoice_number_prefix: c.invoice_number_prefix,
  };
}
