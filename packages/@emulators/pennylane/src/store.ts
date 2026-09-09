import { Store, type Collection } from "@emulators/core";
import type {
  PlApiKey,
  PlAppendix,
  PlBankAccount,
  PlCategory,
  PlCategoryGroup,
  PlCustomer,
  PlCustomerInvoice,
  PlEventLog,
  PlFiscalYear,
  PlJournal,
  PlLedgerAccount,
  PlLedgerEntry,
  PlProduct,
  PlSupplier,
  PlSupplierInvoice,
  PlTransaction,
} from "./entities.js";

export interface PlStore {
  raw: Store;
  apiKeys: Collection<PlApiKey>;
  customers: Collection<PlCustomer>;
  suppliers: Collection<PlSupplier>;
  products: Collection<PlProduct>;
  categoryGroups: Collection<PlCategoryGroup>;
  categories: Collection<PlCategory>;
  journals: Collection<PlJournal>;
  ledgerAccounts: Collection<PlLedgerAccount>;
  fiscalYears: Collection<PlFiscalYear>;
  customerInvoices: Collection<PlCustomerInvoice>;
  supplierInvoices: Collection<PlSupplierInvoice>;
  appendices: Collection<PlAppendix>;
  bankAccounts: Collection<PlBankAccount>;
  transactions: Collection<PlTransaction>;
  ledgerEntries: Collection<PlLedgerEntry>;
  events: Collection<PlEventLog>;
}

export function getPlStore(store: Store): PlStore {
  return {
    raw: store,
    apiKeys: store.collection<PlApiKey>("pennylane.api_keys", ["key"]),
    customers: store.collection<PlCustomer>("pennylane.customers", ["pl_id", "external_reference"]),
    suppliers: store.collection<PlSupplier>("pennylane.suppliers", ["pl_id", "external_reference"]),
    products: store.collection<PlProduct>("pennylane.products", ["pl_id", "external_reference"]),
    categoryGroups: store.collection<PlCategoryGroup>("pennylane.category_groups", ["pl_id"]),
    categories: store.collection<PlCategory>("pennylane.categories", ["pl_id", "category_group_id"]),
    journals: store.collection<PlJournal>("pennylane.journals", ["pl_id", "code"]),
    ledgerAccounts: store.collection<PlLedgerAccount>("pennylane.ledger_accounts", ["pl_id", "number"]),
    fiscalYears: store.collection<PlFiscalYear>("pennylane.fiscal_years", ["pl_id"]),
    customerInvoices: store.collection<PlCustomerInvoice>("pennylane.customer_invoices", [
      "pl_id",
      "invoice_number",
      "customer_id",
      "external_reference",
    ]),
    supplierInvoices: store.collection<PlSupplierInvoice>("pennylane.supplier_invoices", [
      "pl_id",
      "supplier_id",
      "external_reference",
    ]),
    appendices: store.collection<PlAppendix>("pennylane.appendices", ["pl_id", "target_id"]),
    bankAccounts: store.collection<PlBankAccount>("pennylane.bank_accounts", ["pl_id"]),
    transactions: store.collection<PlTransaction>("pennylane.transactions", ["pl_id", "bank_account_id"]),
    ledgerEntries: store.collection<PlLedgerEntry>("pennylane.ledger_entries", ["pl_id", "journal_id"]),
    events: store.collection<PlEventLog>("pennylane.events", ["type"]),
  };
}

export interface PlCompany {
  id: number;
  name: string;
  reg_no: string;
  vat_number: string;
  address: string;
  postal_code: string;
  city: string;
  country_alpha2: string;
  currency: string;
  invoice_number_prefix: string;
}

const COMPANY_KEY = "pennylane.company";
const NEXT_ID_KEY = "pennylane.next_id";
const APPENDIX_TYPES_KEY = "pennylane.appendix_content_types";

export const DEFAULT_COMPANY: PlCompany = {
  id: 1,
  name: "Emulate SAS",
  reg_no: "123456789",
  vat_number: "FR12345678901",
  address: "1 rue de la Paix",
  postal_code: "75002",
  city: "Paris",
  country_alpha2: "FR",
  currency: "EUR",
  invoice_number_prefix: "F-",
};

export const DEFAULT_APPENDIX_CONTENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/bmp",
  "image/gif",
];

export function company(ps: PlStore): PlCompany {
  return ps.raw.getData<PlCompany>(COMPANY_KEY) ?? DEFAULT_COMPANY;
}

export function setCompany(ps: PlStore, value: Partial<PlCompany>): void {
  ps.raw.setData(COMPANY_KEY, { ...company(ps), ...value });
}

export function nextId(ps: PlStore): number {
  const current = ps.raw.getData<number>(NEXT_ID_KEY) ?? 100000;
  ps.raw.setData(NEXT_ID_KEY, current + 1);
  return current;
}

export function claimId(ps: PlStore, id: number): number {
  const current = ps.raw.getData<number>(NEXT_ID_KEY) ?? 100000;
  if (id >= current) ps.raw.setData(NEXT_ID_KEY, id + 1);
  return id;
}

export function appendixContentTypes(ps: PlStore): string[] {
  return ps.raw.getData<string[]>(APPENDIX_TYPES_KEY) ?? DEFAULT_APPENDIX_CONTENT_TYPES;
}

export function setAppendixContentTypes(ps: PlStore, types: string[]): void {
  ps.raw.setData(APPENDIX_TYPES_KEY, types);
}

export function logEvent(ps: PlStore, type: string, subject: string, detail: Record<string, unknown>): void {
  ps.events.insert({ type, subject, detail });
  const all = ps.events.all();
  if (all.length > 1000) for (const stale of all.slice(0, all.length - 1000)) ps.events.delete(stale.id);
}
