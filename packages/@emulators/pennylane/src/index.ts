import type { AppEnv, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import type { CategoryDirection, CustomerType, PlAddress, PlInvoiceLine } from "./entities.js";
import type { Fmt } from "./formatters.js";
import { invoiceTotals } from "./formatters.js";
import { addDays, today } from "./helpers.js";
import { accountingRoutes } from "./routes/accounting.js";
import { catalogRoutes } from "./routes/catalog.js";
import { customerInvoiceRoutes, nextInvoiceNumber } from "./routes/customer-invoices.js";
import { customerRoutes } from "./routes/customers.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { miscRoutes } from "./routes/misc.js";
import { supplierInvoiceRoutes } from "./routes/supplier-invoices.js";
import type { PlRouteContext } from "./route-utils.js";
import {
  claimId,
  getPlStore,
  logEvent,
  nextId,
  setAppendixContentTypes,
  setCompany,
  type PlCompany,
  type PlStore,
} from "./store.js";

export { getPlStore, type PlStore, DEFAULT_APPENDIX_CONTENT_TYPES } from "./store.js";
export * from "./entities.js";
export { invoiceTotals, customerInvoiceStatus } from "./formatters.js";

export interface PennylaneSeedLine {
  label: string;
  quantity?: number;
  unit_price?: number;
  vat_rate?: string;
  unit?: string;
  product?: string;
  description?: string;
}

export interface PennylaneSeedCustomerInvoice {
  id?: number;
  customer: string;
  invoice_number?: string;
  external_reference?: string;
  label?: string;
  date?: string;
  deadline?: string;
  currency?: string;
  draft?: boolean;
  imported?: boolean;
  paid?: boolean;
  paid_amount?: number;
  lines?: PennylaneSeedLine[];
  amount?: number;
  categories?: Array<{ category: string; weight?: number }>;
  appendices?: Array<{ filename: string; content_type?: string; content?: string }>;
}

export interface PennylaneSeedConfig {
  port?: number;
  baseUrl?: string;
  api_keys?: Array<{ key: string; description?: string }>;
  company?: Partial<PlCompany>;
  appendix_content_types?: string[];
  customers?: Array<{
    id?: number;
    name: string;
    customer_type?: CustomerType;
    first_name?: string;
    last_name?: string;
    reg_no?: string;
    vat_number?: string;
    emails?: string[];
    billing_address?: Partial<PlAddress>;
    payment_conditions?: string;
    external_reference?: string;
    billing_language?: string;
  }>;
  suppliers?: Array<{
    id?: number;
    name: string;
    reg_no?: string;
    vat_number?: string;
    iban?: string;
    emails?: string[];
    external_reference?: string;
    ledger_account?: string;
  }>;
  products?: Array<{
    id?: number;
    label: string;
    price_before_tax: number;
    vat_rate?: string;
    unit?: string;
    description?: string;
    reference?: string;
    external_reference?: string;
    ledger_account?: string;
  }>;
  category_groups?: Array<{ id?: number; label: string; direction?: CategoryDirection }>;
  categories?: Array<{
    id?: number;
    label: string;
    color?: string;
    direction?: CategoryDirection;
    group?: string;
    external_reference?: string;
  }>;
  journals?: Array<{ code: string; label: string }>;
  ledger_accounts?: Array<{ number: string; label: string; vat_rate?: string }>;
  fiscal_years?: Array<{ start_date: string; end_date: string; closed?: boolean }>;
  bank_accounts?: Array<{
    id?: number;
    label: string;
    bank_name?: string;
    iban?: string;
    bic?: string;
    currency?: string;
    balance?: number;
  }>;
  transactions?: Array<{
    id?: number;
    bank_account?: string;
    label: string;
    amount: number;
    date?: string;
    currency?: string;
    categories?: Array<{ category: string; weight?: number }>;
    match_invoice?: string;
  }>;
  customer_invoices?: PennylaneSeedCustomerInvoice[];
  supplier_invoices?: Array<{
    id?: number;
    supplier: string;
    invoice_number?: string;
    label?: string;
    date?: string;
    deadline?: string;
    amount: number;
    amount_before_tax?: number;
    paid?: boolean;
    external_reference?: string;
    filename?: string;
  }>;
}

export const DEFAULT_API_KEY = "test_emulate_pennylane_api_key";
export const DEFAULT_CUSTOMER_NAME = "Acme SAS";
export const DEFAULT_CUSTOMER_ID = 200001;
export const DEFAULT_MSP_CUSTOMER_NAME = "Nimbus MSP";
export const DEFAULT_MSP_CUSTOMER_ID = 200002;
export const DEFAULT_INDIVIDUAL_CUSTOMER_ID = 200003;
export const DEFAULT_SUPPLIER_NAME = "Cloud Hosting Ltd";
export const DEFAULT_SUPPLIER_ID = 200101;
export const DEFAULT_PAID_INVOICE_NUMBER = "F-2026-0001";
export const DEFAULT_PAID_INVOICE_ID = 300001;
export const DEFAULT_OPEN_INVOICE_NUMBER = "F-2026-0002";
export const DEFAULT_OPEN_INVOICE_ID = 300002;
export const DEFAULT_CHARGEBEE_INVOICE_NUMBER = "INV-000123";
export const DEFAULT_CHARGEBEE_INVOICE_ID = 300003;
export const DEFAULT_DRAFT_INVOICE_ID = 300004;
export const DEFAULT_SUPPLIER_INVOICE_ID = 300101;
export const DEFAULT_BANK_ACCOUNT_ID = 400001;

const thisYear = today().slice(0, 4);

export const DEFAULT_SEED: PennylaneSeedConfig = {
  api_keys: [{ key: DEFAULT_API_KEY, description: "Local API token" }],
  company: { name: "Emulate SAS", invoice_number_prefix: "F-" },
  customers: [
    {
      id: DEFAULT_CUSTOMER_ID,
      name: DEFAULT_CUSTOMER_NAME,
      reg_no: "552100554",
      vat_number: "FR40552100554",
      emails: ["billing@acme.example"],
      billing_address: { address: "12 rue des Lilas", postal_code: "69001", city: "Lyon" },
      external_reference: "cb_acme",
    },
    {
      id: DEFAULT_MSP_CUSTOMER_ID,
      name: DEFAULT_MSP_CUSTOMER_NAME,
      vat_number: "FR12987654321",
      emails: ["finance@nimbus.example"],
      billing_address: { address: "8 avenue de la Gare", postal_code: "33000", city: "Bordeaux" },
      external_reference: "cb_nimbus",
      payment_conditions: "45_days",
    },
    {
      id: DEFAULT_INDIVIDUAL_CUSTOMER_ID,
      name: "Jeanne Martin",
      customer_type: "individual",
      first_name: "Jeanne",
      last_name: "Martin",
      emails: ["jeanne.martin@example.com"],
    },
  ],
  suppliers: [
    {
      id: DEFAULT_SUPPLIER_ID,
      name: DEFAULT_SUPPLIER_NAME,
      vat_number: "GB123456789",
      emails: ["ap@cloudhosting.example"],
      iban: "GB29NWBK60161331926819",
      ledger_account: "604000",
    },
  ],
  products: [
    {
      label: "Managed EDR - per endpoint",
      price_before_tax: 8,
      vat_rate: "FR_200",
      unit: "endpoint",
      reference: "EDR-STD",
      external_reference: "edr_standard",
    },
    { label: "SOC monitoring - monthly", price_before_tax: 250, vat_rate: "FR_200", unit: "month", reference: "SOC-M" },
    {
      label: "Security awareness training",
      price_before_tax: 45,
      vat_rate: "FR_200",
      unit: "seat",
      reference: "TRAIN-01",
    },
  ],
  category_groups: [
    { label: "Revenue lines", direction: "revenue" },
    { label: "Operating expenses", direction: "expense" },
  ],
  categories: [
    { label: "Managed services", color: "#2563eb", direction: "revenue", group: "Revenue lines" },
    { label: "Training", color: "#16a34a", direction: "revenue", group: "Revenue lines" },
    { label: "Hosting", color: "#dc2626", direction: "expense", group: "Operating expenses" },
  ],
  journals: [
    { code: "VT", label: "Ventes" },
    { code: "AC", label: "Achats" },
    { code: "BQ", label: "Banque" },
    { code: "OD", label: "Operations diverses" },
  ],
  ledger_accounts: [
    { number: "411000", label: "Clients" },
    { number: "401000", label: "Fournisseurs" },
    { number: "512000", label: "Banque" },
    { number: "604000", label: "Achats de prestations de services" },
    { number: "706000", label: "Prestations de services", vat_rate: "FR_200" },
    { number: "445710", label: "TVA collectee" },
    { number: "445660", label: "TVA deductible" },
  ],
  fiscal_years: [
    { start_date: `${Number(thisYear) - 1}-01-01`, end_date: `${Number(thisYear) - 1}-12-31`, closed: true },
    { start_date: `${thisYear}-01-01`, end_date: `${thisYear}-12-31` },
  ],
  bank_accounts: [
    {
      id: DEFAULT_BANK_ACCOUNT_ID,
      label: "Compte courant",
      bank_name: "Qonto",
      iban: "FR7616798000010000012345678",
      bic: "QNTOFRP1XXX",
      currency: "EUR",
      balance: 12500,
    },
  ],
  customer_invoices: [
    {
      id: DEFAULT_PAID_INVOICE_ID,
      customer: DEFAULT_CUSTOMER_NAME,
      invoice_number: DEFAULT_PAID_INVOICE_NUMBER,
      external_reference: "cb_inv_0001",
      date: `${thisYear}-01-15`,
      deadline: `${thisYear}-02-14`,
      paid: true,
      lines: [
        { label: "Managed EDR - per endpoint", quantity: 25, product: "Managed EDR - per endpoint" },
        { label: "SOC monitoring - monthly", quantity: 1, product: "SOC monitoring - monthly" },
      ],
      categories: [{ category: "Managed services" }],
      appendices: [
        { filename: "detail-F-2026-0001.pdf", content_type: "application/pdf", content: "%PDF-1.4 emulated appendix" },
      ],
    },
    {
      id: DEFAULT_OPEN_INVOICE_ID,
      customer: DEFAULT_MSP_CUSTOMER_NAME,
      invoice_number: DEFAULT_OPEN_INVOICE_NUMBER,
      external_reference: "cb_inv_0002",
      date: today(),
      lines: [{ label: "Security awareness training", quantity: 12, product: "Security awareness training" }],
      categories: [{ category: "Training" }],
    },
    {
      id: DEFAULT_CHARGEBEE_INVOICE_ID,
      customer: DEFAULT_CUSTOMER_NAME,
      invoice_number: DEFAULT_CHARGEBEE_INVOICE_NUMBER,
      external_reference: DEFAULT_CHARGEBEE_INVOICE_NUMBER,
      label: "Chargebee invoice INV-000123",
      imported: true,
      date: today(),
      amount: 1200,
    },
    {
      id: DEFAULT_DRAFT_INVOICE_ID,
      customer: "Jeanne Martin",
      draft: true,
      lines: [{ label: "Security awareness training", quantity: 1, product: "Security awareness training" }],
    },
  ],
  supplier_invoices: [
    {
      id: DEFAULT_SUPPLIER_INVOICE_ID,
      supplier: DEFAULT_SUPPLIER_NAME,
      invoice_number: "CH-88231",
      date: addDays(today(), -20),
      amount: 540,
      amount_before_tax: 450,
      filename: "CH-88231.pdf",
    },
  ],
  transactions: [
    {
      bank_account: "Compte courant",
      label: `VIR ACME SAS ${DEFAULT_PAID_INVOICE_NUMBER}`,
      amount: 540,
      date: `${thisYear}-02-10`,
      match_invoice: DEFAULT_PAID_INVOICE_NUMBER,
    },
    {
      bank_account: "Compte courant",
      label: "PRLV CLOUD HOSTING",
      amount: -540,
      date: addDays(today(), -5),
      categories: [{ category: "Hosting" }],
    },
  ],
};

function pickId(ps: PlStore, id: number | undefined): number {
  return id !== undefined ? claimId(ps, id) : nextId(ps);
}

function seedLines(ps: PlStore, lines: PennylaneSeedLine[]): PlInvoiceLine[] {
  return lines.map((line) => {
    const product = line.product
      ? ps.products
          .all()
          .find(
            (candidate) =>
              candidate.label.toLowerCase() === line.product!.toLowerCase() ||
              candidate.reference === line.product ||
              candidate.external_reference === line.product,
          )
      : undefined;
    return {
      id: nextId(ps),
      label: line.label,
      description: line.description ?? product?.description ?? null,
      quantity: line.quantity ?? 1,
      unit: line.unit ?? product?.unit ?? "piece",
      raw_currency_unit_price: line.unit_price ?? product?.price_before_tax ?? 0,
      vat_rate: line.vat_rate ?? product?.vat_rate ?? "FR_200",
      discount: null,
      product_id: product?.pl_id ?? null,
      ledger_account_id: product?.ledger_account_id ?? null,
    };
  });
}

function seedCategories(
  ps: PlStore,
  entries: Array<{ category: string; weight?: number }> | undefined,
): Array<{ category_id: number; weight: number }> {
  if (!entries || entries.length === 0) return [];
  const resolved = entries.flatMap((entry) => {
    const category = ps.categories
      .all()
      .find(
        (candidate) =>
          candidate.label.toLowerCase() === entry.category.toLowerCase() || String(candidate.pl_id) === entry.category,
      );
    return category ? [{ category_id: category.pl_id, weight: entry.weight ?? 0 }] : [];
  });
  const unweighted = resolved.filter((entry) => entry.weight === 0).length;
  const assigned = resolved.reduce((sum, entry) => sum + entry.weight, 0);
  return resolved.map((entry) =>
    entry.weight === 0 ? { ...entry, weight: unweighted > 0 ? (1 - assigned) / unweighted : 0 } : entry,
  );
}

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: PennylaneSeedConfig,
  _webhooks?: WebhookDispatcher,
): void {
  const ps = getPlStore(store);
  if (config.company) setCompany(ps, config.company);
  if (config.appendix_content_types)
    setAppendixContentTypes(
      ps,
      config.appendix_content_types.map((type) => type.toLowerCase()),
    );

  for (const entry of config.api_keys ?? []) {
    if (!entry.key || ps.apiKeys.findOneBy("key", entry.key)) continue;
    ps.apiKeys.insert({ key: entry.key, description: entry.description ?? "API token" });
  }
  if (ps.apiKeys.count() === 0) ps.apiKeys.insert({ key: DEFAULT_API_KEY, description: "Local API token" });

  for (const entry of config.ledger_accounts ?? []) {
    if (ps.ledgerAccounts.findOneBy("number", entry.number)) continue;
    ps.ledgerAccounts.insert({
      pl_id: nextId(ps),
      number: entry.number,
      label: entry.label,
      vat_rate: entry.vat_rate ?? null,
      enabled: true,
    });
  }
  const accountByNumber = (number: string | undefined) =>
    number ? (ps.ledgerAccounts.findOneBy("number", number)?.pl_id ?? null) : null;

  for (const entry of config.journals ?? []) {
    if (ps.journals.findOneBy("code", entry.code.toUpperCase())) continue;
    ps.journals.insert({ pl_id: nextId(ps), code: entry.code.toUpperCase(), label: entry.label });
  }

  for (const entry of config.fiscal_years ?? []) {
    if (ps.fiscalYears.all().some((year) => year.start_date === entry.start_date)) continue;
    ps.fiscalYears.insert({
      pl_id: nextId(ps),
      start_date: entry.start_date,
      end_date: entry.end_date,
      closed: entry.closed ?? false,
    });
  }

  for (const entry of config.category_groups ?? []) {
    if (ps.categoryGroups.all().some((group) => group.label.toLowerCase() === entry.label.toLowerCase())) continue;
    ps.categoryGroups.insert({
      pl_id: pickId(ps, entry.id),
      label: entry.label,
      direction: entry.direction ?? "both",
      external_reference: null,
    });
  }

  for (const entry of config.categories ?? []) {
    if (ps.categories.all().some((category) => category.label.toLowerCase() === entry.label.toLowerCase())) continue;
    const group = entry.group
      ? ps.categoryGroups.all().find((candidate) => candidate.label.toLowerCase() === entry.group!.toLowerCase())
      : undefined;
    ps.categories.insert({
      pl_id: pickId(ps, entry.id),
      label: entry.label,
      color: entry.color ?? "#1f77b4",
      direction: entry.direction ?? group?.direction ?? "both",
      external_reference: entry.external_reference ?? null,
      category_group_id: group?.pl_id ?? null,
    });
  }

  for (const entry of config.customers ?? []) {
    if (
      (entry.id && ps.customers.findOneBy("pl_id", entry.id)) ||
      ps.customers.all().some((customer) => customer.name.toLowerCase() === entry.name.toLowerCase())
    )
      continue;
    const type = entry.customer_type ?? "company";
    ps.customers.insert({
      pl_id: pickId(ps, entry.id),
      customer_type: type,
      name: entry.name,
      first_name: type === "individual" ? (entry.first_name ?? entry.name.split(" ")[0]) : null,
      last_name: type === "individual" ? (entry.last_name ?? entry.name.split(" ").slice(1).join(" ")) : null,
      gender: null,
      reg_no: entry.reg_no ?? null,
      vat_number: entry.vat_number ?? null,
      emails: entry.emails ?? [],
      phone: null,
      billing_iban: null,
      billing_address: entry.billing_address
        ? {
            address: entry.billing_address.address ?? "",
            postal_code: entry.billing_address.postal_code ?? "",
            city: entry.billing_address.city ?? "",
            country_alpha2: entry.billing_address.country_alpha2 ?? "FR",
          }
        : null,
      delivery_address: null,
      recipient: null,
      reference: null,
      notes: null,
      payment_conditions: entry.payment_conditions ?? "30_days",
      billing_language: entry.billing_language ?? "fr_FR",
      external_reference: entry.external_reference ?? null,
      archived: false,
    });
  }
  const customerByName = (name: string) =>
    ps.customers
      .all()
      .find(
        (customer) =>
          customer.name.toLowerCase() === name.toLowerCase() ||
          String(customer.pl_id) === name ||
          customer.external_reference === name,
      );

  for (const entry of config.suppliers ?? []) {
    if (
      (entry.id && ps.suppliers.findOneBy("pl_id", entry.id)) ||
      ps.suppliers.all().some((supplier) => supplier.name.toLowerCase() === entry.name.toLowerCase())
    )
      continue;
    ps.suppliers.insert({
      pl_id: pickId(ps, entry.id),
      name: entry.name,
      reg_no: entry.reg_no ?? null,
      vat_number: entry.vat_number ?? null,
      iban: entry.iban ?? null,
      emails: entry.emails ?? [],
      billing_address: null,
      payment_conditions: "30_days",
      external_reference: entry.external_reference ?? null,
      recipient: null,
      notes: null,
      ledger_account_id: accountByNumber(entry.ledger_account),
      archived: false,
    });
  }
  const supplierByName = (name: string) =>
    ps.suppliers
      .all()
      .find((supplier) => supplier.name.toLowerCase() === name.toLowerCase() || String(supplier.pl_id) === name);

  for (const entry of config.products ?? []) {
    if (ps.products.all().some((product) => product.label.toLowerCase() === entry.label.toLowerCase())) continue;
    ps.products.insert({
      pl_id: pickId(ps, entry.id),
      label: entry.label,
      description: entry.description ?? null,
      price_before_tax: entry.price_before_tax,
      vat_rate: entry.vat_rate ?? "FR_200",
      unit: entry.unit ?? "piece",
      currency: "EUR",
      reference: entry.reference ?? null,
      external_reference: entry.external_reference ?? null,
      ledger_account_id: accountByNumber(entry.ledger_account) ?? accountByNumber("706000"),
    });
  }

  for (const entry of config.bank_accounts ?? []) {
    if (
      (entry.id && ps.bankAccounts.findOneBy("pl_id", entry.id)) ||
      ps.bankAccounts.all().some((account) => account.label.toLowerCase() === entry.label.toLowerCase())
    )
      continue;
    ps.bankAccounts.insert({
      pl_id: pickId(ps, entry.id),
      label: entry.label,
      bank_name: entry.bank_name ?? "Bank",
      iban: entry.iban ?? "FR7600000000000000000000000",
      bic: entry.bic ?? "EMULFRPP",
      currency: entry.currency ?? "EUR",
      balance: entry.balance ?? 0,
      ledger_account_id: accountByNumber("512000"),
    });
  }

  for (const entry of config.customer_invoices ?? []) {
    if (entry.id && ps.customerInvoices.findOneBy("pl_id", entry.id)) continue;
    if (entry.invoice_number && ps.customerInvoices.findOneBy("invoice_number", entry.invoice_number)) continue;
    const customer = customerByName(entry.customer);
    if (!customer) continue;
    const date = entry.date ?? today();
    const draft = entry.draft ?? false;
    const lines = entry.lines
      ? seedLines(ps, entry.lines)
      : entry.amount !== undefined
        ? [
            {
              id: nextId(ps),
              label: entry.label ?? `Invoice ${entry.invoice_number ?? ""}`.trim(),
              description: null,
              quantity: 1,
              unit: "piece",
              raw_currency_unit_price: entry.amount / 1.2,
              vat_rate: "FR_200",
              discount: null,
              product_id: null,
              ledger_account_id: null,
            },
          ]
        : [];
    const invoiceNumber = draft ? null : (entry.invoice_number ?? nextInvoiceNumber(ps, date));
    const invoice = ps.customerInvoices.insert({
      pl_id: pickId(ps, entry.id),
      label: entry.label ?? `${customer.name} - ${invoiceNumber ?? "draft"}`,
      invoice_number: invoiceNumber,
      customer_id: customer.pl_id,
      currency: entry.currency ?? "EUR",
      exchange_rate: 1,
      date,
      deadline: entry.deadline ?? addDays(date, Number.parseInt(customer.payment_conditions, 10) || 30),
      external_reference: entry.external_reference ?? null,
      pdf_invoice_free_text: null,
      pdf_invoice_subject: null,
      special_mention: null,
      language: customer.billing_language,
      draft,
      imported: entry.imported ?? false,
      paid: false,
      paid_amount: 0,
      cancelled_at: null,
      archived_at: null,
      filename: invoiceNumber ? `${invoiceNumber}.pdf` : null,
      file_content: null,
      file_content_type: null,
      invoice_lines: lines,
      categories: seedCategories(ps, entry.categories),
      transaction_ids: [],
      transaction_reference: null,
      discount: null,
      credit_note_of_id: null,
      sent_at: null,
    });
    const total = invoiceTotals(invoice).total;
    const paidAmount = entry.paid ? total : (entry.paid_amount ?? 0);
    if (paidAmount > 0)
      ps.customerInvoices.update(invoice.id, { paid_amount: paidAmount, paid: paidAmount >= total - 0.005 });
    for (const appendix of entry.appendices ?? []) {
      const buffer = Buffer.from(appendix.content ?? `%PDF-1.4 ${appendix.filename}`, "utf8");
      ps.appendices.insert({
        pl_id: nextId(ps),
        target_type: "customer_invoice",
        target_id: invoice.pl_id,
        filename: appendix.filename,
        content_type: appendix.content_type ?? "application/pdf",
        size: buffer.byteLength,
        content: buffer.toString("base64"),
      });
    }
  }

  for (const entry of config.supplier_invoices ?? []) {
    if (entry.id && ps.supplierInvoices.findOneBy("pl_id", entry.id)) continue;
    const supplier = supplierByName(entry.supplier);
    if (!supplier) continue;
    if (
      entry.invoice_number &&
      ps.supplierInvoices
        .findBy("supplier_id", supplier.pl_id)
        .some((invoice) => invoice.invoice_number === entry.invoice_number)
    )
      continue;
    const date = entry.date ?? today();
    ps.supplierInvoices.insert({
      pl_id: pickId(ps, entry.id),
      label: entry.label ?? `${supplier.name} - ${entry.invoice_number ?? date}`,
      invoice_number: entry.invoice_number ?? null,
      supplier_id: supplier.pl_id,
      currency: "EUR",
      exchange_rate: 1,
      date,
      deadline: entry.deadline ?? addDays(date, 30),
      external_reference: entry.external_reference ?? null,
      paid: entry.paid ?? false,
      paid_amount: entry.paid ? entry.amount : 0,
      amount: entry.amount,
      amount_before_tax: entry.amount_before_tax ?? entry.amount / 1.2,
      archived_at: null,
      filename: entry.filename ?? `${entry.invoice_number ?? "supplier-invoice"}.pdf`,
      file_content: null,
      file_content_type: null,
      invoice_lines: [],
      categories: [],
      transaction_ids: [],
      ledger_account_id: supplier.ledger_account_id,
    });
  }

  for (const entry of config.transactions ?? []) {
    if (entry.id && ps.transactions.findOneBy("pl_id", entry.id)) continue;
    const bankAccount = entry.bank_account
      ? ps.bankAccounts
          .all()
          .find(
            (account) =>
              account.label.toLowerCase() === entry.bank_account!.toLowerCase() ||
              String(account.pl_id) === entry.bank_account,
          )
      : ps.bankAccounts.all()[0];
    if (!bankAccount) continue;
    if (
      ps.transactions
        .findBy("bank_account_id", bankAccount.pl_id)
        .some((transaction) => transaction.label === entry.label && transaction.amount === entry.amount)
    )
      continue;
    const matched = entry.match_invoice
      ? ps.customerInvoices.findOneBy("invoice_number", entry.match_invoice)
      : undefined;
    const transaction = ps.transactions.insert({
      pl_id: pickId(ps, entry.id),
      bank_account_id: bankAccount.pl_id,
      label: entry.label,
      amount: entry.amount,
      currency: entry.currency ?? bankAccount.currency,
      currency_amount: entry.amount,
      date: entry.date ?? today(),
      fee: 0,
      archived: false,
      categories: seedCategories(ps, entry.categories),
      matched_customer_invoice_ids: matched ? [matched.pl_id] : [],
      matched_supplier_invoice_ids: [],
      external_reference: null,
    });
    if (matched)
      ps.customerInvoices.update(matched.id, { transaction_ids: [...matched.transaction_ids, transaction.pl_id] });
  }

  logEvent(ps, "seed.applied", "config", {
    customers: ps.customers.count(),
    customer_invoices: ps.customerInvoices.count(),
  });
}

export const pennylanePlugin: ServicePlugin = {
  name: "pennylane",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const ps = getPlStore(store);
    const fmt: Fmt = { ps, baseUrl };
    const rc: PlRouteContext = { app, ps, fmt, baseUrl };
    customerRoutes(rc);
    catalogRoutes(rc);
    customerInvoiceRoutes(rc);
    supplierInvoiceRoutes(rc);
    accountingRoutes(rc);
    miscRoutes(rc);
    inspectorRoutes(rc);
  },
  seed(store: Store, baseUrl: string): void {
    seedFromConfig(store, baseUrl, DEFAULT_SEED);
  },
};

export default pennylanePlugin;
