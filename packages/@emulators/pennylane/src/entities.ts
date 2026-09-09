import type { Entity } from "@emulators/core";

export interface PlApiKey extends Entity {
  key: string;
  description: string;
}

export interface PlAddress {
  address: string;
  postal_code: string;
  city: string;
  country_alpha2: string;
}

export type CustomerType = "company" | "individual";

export interface PlCustomer extends Entity {
  pl_id: number;
  customer_type: CustomerType;
  name: string;
  first_name: string | null;
  last_name: string | null;
  gender: string | null;
  reg_no: string | null;
  vat_number: string | null;
  emails: string[];
  billing_iban: string | null;
  billing_address: PlAddress | null;
  delivery_address: PlAddress | null;
  recipient: string | null;
  reference: string | null;
  notes: string | null;
  payment_conditions: string;
  external_reference: string | null;
  phone: string | null;
  billing_language: string;
  archived: boolean;
}

export interface PlSupplier extends Entity {
  pl_id: number;
  name: string;
  reg_no: string | null;
  vat_number: string | null;
  iban: string | null;
  emails: string[];
  billing_address: PlAddress | null;
  payment_conditions: string;
  external_reference: string | null;
  recipient: string | null;
  notes: string | null;
  ledger_account_id: number | null;
  archived: boolean;
}

export interface PlProduct extends Entity {
  pl_id: number;
  label: string;
  description: string | null;
  price_before_tax: number;
  vat_rate: string;
  unit: string;
  currency: string;
  reference: string | null;
  external_reference: string | null;
  ledger_account_id: number | null;
}

export type CategoryDirection = "expense" | "revenue" | "both";

export interface PlCategoryGroup extends Entity {
  pl_id: number;
  label: string;
  direction: CategoryDirection;
  external_reference: string | null;
}

export interface PlCategory extends Entity {
  pl_id: number;
  label: string;
  color: string;
  direction: CategoryDirection;
  external_reference: string | null;
  category_group_id: number | null;
}

export interface PlJournal extends Entity {
  pl_id: number;
  code: string;
  label: string;
}

export interface PlLedgerAccount extends Entity {
  pl_id: number;
  number: string;
  label: string;
  vat_rate: string | null;
  enabled: boolean;
}

export interface PlFiscalYear extends Entity {
  pl_id: number;
  start_date: string;
  end_date: string;
  closed: boolean;
}

export interface PlInvoiceLine {
  id: number;
  label: string;
  description: string | null;
  quantity: number;
  unit: string;
  raw_currency_unit_price: number;
  vat_rate: string;
  discount: { type: "relative" | "absolute"; value: number } | null;
  product_id: number | null;
  ledger_account_id: number | null;
}

export type InvoiceStatus = "draft" | "upcoming" | "late" | "paid" | "cancelled" | "partially_cancelled" | "incomplete";

export interface PlCategoryWeight {
  category_id: number;
  weight: number;
}

export interface PlCustomerInvoice extends Entity {
  pl_id: number;
  label: string;
  invoice_number: string | null;
  customer_id: number | null;
  currency: string;
  exchange_rate: number;
  date: string;
  deadline: string;
  external_reference: string | null;
  pdf_invoice_free_text: string | null;
  pdf_invoice_subject: string | null;
  special_mention: string | null;
  language: string;
  draft: boolean;
  imported: boolean;
  paid: boolean;
  paid_amount: number;
  cancelled_at: string | null;
  archived_at: string | null;
  filename: string | null;
  file_content: string | null;
  file_content_type: string | null;
  invoice_lines: PlInvoiceLine[];
  categories: PlCategoryWeight[];
  transaction_ids: number[];
  transaction_reference: string | null;
  discount: { type: "relative" | "absolute"; value: number } | null;
  credit_note_of_id: number | null;
  sent_at: string | null;
}

export interface PlSupplierInvoice extends Entity {
  pl_id: number;
  label: string;
  invoice_number: string | null;
  supplier_id: number | null;
  currency: string;
  exchange_rate: number;
  date: string;
  deadline: string;
  external_reference: string | null;
  paid: boolean;
  paid_amount: number;
  amount: number;
  amount_before_tax: number;
  archived_at: string | null;
  filename: string | null;
  file_content: string | null;
  file_content_type: string | null;
  invoice_lines: PlInvoiceLine[];
  categories: PlCategoryWeight[];
  transaction_ids: number[];
  ledger_account_id: number | null;
}

export type AppendixTarget = "customer_invoice" | "supplier_invoice";

export interface PlAppendix extends Entity {
  pl_id: number;
  target_type: AppendixTarget;
  target_id: number;
  filename: string;
  content_type: string;
  size: number;
  content: string;
}

export interface PlBankAccount extends Entity {
  pl_id: number;
  label: string;
  bank_name: string;
  iban: string;
  bic: string;
  currency: string;
  balance: number;
  ledger_account_id: number | null;
}

export interface PlTransaction extends Entity {
  pl_id: number;
  bank_account_id: number;
  label: string;
  amount: number;
  currency: string;
  currency_amount: number;
  date: string;
  fee: number;
  archived: boolean;
  categories: PlCategoryWeight[];
  matched_customer_invoice_ids: number[];
  matched_supplier_invoice_ids: number[];
  external_reference: string | null;
}

export interface PlLedgerEntryLine {
  id: number;
  ledger_account_id: number;
  debit: number;
  credit: number;
  label: string | null;
  lettering: string | null;
}

export interface PlLedgerEntry extends Entity {
  pl_id: number;
  date: string;
  journal_id: number;
  label: string;
  lines: PlLedgerEntryLine[];
  external_reference: string | null;
  source_type: string | null;
  source_id: number | null;
}

export interface PlEventLog extends Entity {
  type: string;
  subject: string;
  detail: Record<string, unknown>;
}
