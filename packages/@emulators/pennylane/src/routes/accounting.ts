import type { PlLedgerEntryLine, PlTransaction } from "../entities.js";
import {
  formatBankAccount,
  formatCategoryWeights,
  formatCustomerInvoice,
  formatFiscalYear,
  formatJournal,
  formatLedgerAccount,
  formatLedgerEntry,
  formatLedgerEntryLine,
  formatSupplierInvoice,
  formatTransaction,
} from "../formatters.js";
import {
  api,
  bool,
  dateOnly,
  listResponse,
  notFound,
  num,
  obj,
  parseJsonBody,
  requireInt,
  route,
  str,
  strOrNull,
  today,
  unprocessable,
  type Json,
} from "../helpers.js";
import { logEvent, nextId } from "../store.js";
import { findTransaction, parseCategoryWeights, type PlRouteContext } from "../route-utils.js";

export function accountingRoutes(rc: PlRouteContext): void {
  const { app, ps, fmt } = rc;

  route(
    app,
    "get",
    "/journals",
    api(ps, (c) =>
      listResponse(c, [...ps.journals.all()].sort((a, b) => a.id - b.id).map(formatJournal), {
        filters: { id: true, code: true, label: true },
        sortable: ["id", "code", "label"],
      }),
    ),
  );

  route(
    app,
    "post",
    "/journals",
    api(ps, async (c) => {
      const body = await parseJsonBody(c);
      const code = str(body.code)?.trim().toUpperCase();
      const label = str(body.label)?.trim();
      if (!code) throw unprocessable("Validation failed", [{ field: "code", message: "can't be blank" }]);
      if (!label) throw unprocessable("Validation failed", [{ field: "label", message: "can't be blank" }]);
      if (ps.journals.findOneBy("code", code))
        throw unprocessable("Validation failed", [{ field: "code", message: "has already been taken" }]);
      const journal = ps.journals.insert({ pl_id: nextId(ps), code, label });
      return c.json(formatJournal(journal), 201);
    }),
  );

  route(
    app,
    "get",
    "/journals/:id",
    api(ps, (c) => {
      const raw = c.req.param("id");
      const journal = /^\d+$/.test(raw)
        ? ps.journals.findOneBy("pl_id", Number(raw))
        : ps.journals.findOneBy("code", raw.toUpperCase());
      if (!journal) throw notFound("Journal not found");
      return c.json(formatJournal(journal));
    }),
  );

  route(
    app,
    "get",
    "/ledger_accounts",
    api(ps, (c) =>
      listResponse(
        c,
        [...ps.ledgerAccounts.all()].sort((a, b) => a.number.localeCompare(b.number)).map(formatLedgerAccount),
        {
          filters: {
            id: true,
            number: { operators: ["eq", "in", "starts_with", "contains"] },
            label: true,
            enabled: true,
            vat_rate: true,
          },
          sortable: ["id", "number", "label"],
        },
      ),
    ),
  );

  route(
    app,
    "post",
    "/ledger_accounts",
    api(ps, async (c) => {
      const body = await parseJsonBody(c);
      const number = str(body.number)?.trim();
      const label = str(body.label)?.trim();
      if (!number || !/^\d{3,}$/.test(number))
        throw unprocessable("Validation failed", [{ field: "number", message: "must be a numeric account number" }]);
      if (!label) throw unprocessable("Validation failed", [{ field: "label", message: "can't be blank" }]);
      if (ps.ledgerAccounts.findOneBy("number", number))
        throw unprocessable("Validation failed", [{ field: "number", message: "has already been taken" }]);
      const account = ps.ledgerAccounts.insert({
        pl_id: nextId(ps),
        number,
        label,
        vat_rate: strOrNull(body.vat_rate),
        enabled: bool(body.enabled) ?? true,
      });
      logEvent(ps, "ledger_account.created", String(account.pl_id), { number, label });
      return c.json(formatLedgerAccount(account), 201);
    }),
  );

  route(
    app,
    "get",
    "/ledger_accounts/:id",
    api(ps, (c) => {
      const account = ps.ledgerAccounts.findOneBy("pl_id", requireInt(c.req.param("id"), "Ledger account"));
      if (!account) throw notFound("Ledger account not found");
      return c.json(formatLedgerAccount(account));
    }),
  );

  route(
    app,
    "put",
    "/ledger_accounts/:id",
    api(ps, async (c) => {
      const account = ps.ledgerAccounts.findOneBy("pl_id", requireInt(c.req.param("id"), "Ledger account"));
      if (!account) throw notFound("Ledger account not found");
      const body = await parseJsonBody(c);
      const updated = ps.ledgerAccounts.update(account.id, {
        label: str(body.label) ?? account.label,
        vat_rate: body.vat_rate !== undefined ? strOrNull(body.vat_rate) : account.vat_rate,
        enabled: bool(body.enabled) ?? account.enabled,
      })!;
      return c.json(formatLedgerAccount(updated));
    }),
  );

  route(
    app,
    "get",
    "/fiscal_years",
    api(ps, (c) =>
      listResponse(
        c,
        [...ps.fiscalYears.all()].sort((a, b) => a.start_date.localeCompare(b.start_date)).map(formatFiscalYear),
        { filters: { id: true, start_date: true, end_date: true, closed: true }, sortable: ["id", "start_date"] },
      ),
    ),
  );

  route(
    app,
    "get",
    "/ledger_entries",
    api(ps, (c) =>
      listResponse(
        c,
        [...ps.ledgerEntries.all()]
          .sort((a, b) => a.id - b.id)
          .map((entry) => ({ ...formatLedgerEntry(fmt, entry), journal_id: entry.journal_id })),
        {
          filters: {
            id: true,
            date: true,
            label: true,
            journal_id: true,
            external_reference: true,
            created_at: true,
            updated_at: true,
          },
          sortable: ["id", "date", "created_at"],
        },
      ),
    ),
  );

  route(
    app,
    "post",
    "/ledger_entries",
    api(ps, async (c) => {
      const body = await parseJsonBody(c);
      const date = dateOnly(body.date, "date", true) ?? today();
      const journalId = num(body.journal_id) ?? num((body.journal as Json | undefined)?.id);
      const journal =
        journalId !== undefined
          ? ps.journals.findOneBy("pl_id", journalId)
          : ps.journals.findOneBy("code", str(body.journal_code)?.toUpperCase() ?? "OD");
      if (!journal) throw unprocessable("Validation failed", [{ field: "journal_id", message: "journal not found" }]);
      const rawLines = Array.isArray(body.lines)
        ? body.lines
        : Array.isArray(body.ledger_entry_lines)
          ? body.ledger_entry_lines
          : [];
      if (rawLines.length < 2)
        throw unprocessable("Validation failed", [{ field: "lines", message: "must contain at least two lines" }]);
      const lines: PlLedgerEntryLine[] = rawLines.map((entry, index) => {
        const record = obj(entry) ?? {};
        const accountId = num(record.ledger_account_id) ?? num((record.ledger_account as Json | undefined)?.id);
        const account =
          accountId !== undefined
            ? ps.ledgerAccounts.findOneBy("pl_id", accountId)
            : ps.ledgerAccounts.findOneBy("number", str(record.ledger_account_number) ?? "");
        if (!account)
          throw unprocessable("Validation failed", [
            { field: `lines[${index}].ledger_account_id`, message: "ledger account not found" },
          ]);
        return {
          id: nextId(ps),
          ledger_account_id: account.pl_id,
          debit: num(record.debit) ?? 0,
          credit: num(record.credit) ?? 0,
          label: strOrNull(record.label),
          lettering: strOrNull(record.lettering),
        };
      });
      const debit = lines.reduce((sum, line) => sum + line.debit, 0);
      const credit = lines.reduce((sum, line) => sum + line.credit, 0);
      if (Math.abs(debit - credit) > 0.005)
        throw unprocessable("Validation failed", [
          { field: "lines", message: `debit (${debit.toFixed(2)}) and credit (${credit.toFixed(2)}) must balance` },
        ]);
      const entry = ps.ledgerEntries.insert({
        pl_id: nextId(ps),
        date,
        journal_id: journal.pl_id,
        label: str(body.label) ?? `Entry ${date}`,
        lines,
        external_reference: strOrNull(body.external_reference),
        source_type: null,
        source_id: null,
      });
      logEvent(ps, "ledger_entry.created", String(entry.pl_id), { journal: journal.code, debit, credit });
      return c.json(formatLedgerEntry(fmt, entry), 201);
    }),
  );

  route(
    app,
    "get",
    "/ledger_entries/:id",
    api(ps, (c) => {
      const entry = ps.ledgerEntries.findOneBy("pl_id", requireInt(c.req.param("id"), "Ledger entry"));
      if (!entry) throw notFound("Ledger entry not found");
      return c.json(formatLedgerEntry(fmt, entry));
    }),
  );

  route(
    app,
    "get",
    "/ledger_entries/:id/lines",
    api(ps, (c) => {
      const entry = ps.ledgerEntries.findOneBy("pl_id", requireInt(c.req.param("id"), "Ledger entry"));
      if (!entry) throw notFound("Ledger entry not found");
      return listResponse(
        c,
        entry.lines.map((line) => formatLedgerEntryLine(fmt, entry, line)),
        { filters: { id: true }, sortable: ["id"] },
      );
    }),
  );

  route(
    app,
    "get",
    "/ledger_entry_lines",
    api(ps, (c) =>
      listResponse(
        c,
        ps.ledgerEntries.all().flatMap((entry) =>
          entry.lines.map((line) => ({
            ...formatLedgerEntryLine(fmt, entry, line),
            ledger_account_id: line.ledger_account_id,
            ledger_entry_id: entry.pl_id,
            journal_id: entry.journal_id,
          })),
        ),
        {
          filters: {
            id: true,
            date: true,
            ledger_account_id: true,
            ledger_entry_id: true,
            journal_id: true,
            lettering: true,
            label: true,
          },
          sortable: ["id", "date"],
        },
      ),
    ),
  );

  route(
    app,
    "get",
    "/bank_accounts",
    api(ps, (c) =>
      listResponse(
        c,
        [...ps.bankAccounts.all()].sort((a, b) => a.id - b.id).map((account) => formatBankAccount(fmt, account)),
        { filters: { id: true, label: true, iban: true, currency: true }, sortable: ["id", "label"] },
      ),
    ),
  );

  route(
    app,
    "get",
    "/bank_accounts/:id",
    api(ps, (c) => {
      const account = ps.bankAccounts.findOneBy("pl_id", requireInt(c.req.param("id"), "Bank account"));
      if (!account) throw notFound("Bank account not found");
      return c.json(formatBankAccount(fmt, account));
    }),
  );

  const TRANSACTION_FILTERS = {
    id: true,
    label: { operators: ["eq", "contains", "starts_with"] },
    amount: true,
    date: true,
    currency: true,
    archived: true,
    external_reference: true,
    bank_account_id: { operators: ["eq", "in"], get: (row: Json) => (row.bank_account as { id: number }).id },
    created_at: true,
    updated_at: true,
  } as const;

  route(
    app,
    "get",
    "/transactions",
    api(ps, (c) =>
      listResponse(
        c,
        [...ps.transactions.all()]
          .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
          .map((transaction) => formatTransaction(fmt, transaction)),
        { filters: TRANSACTION_FILTERS, sortable: ["id", "date", "amount", "created_at"] },
      ),
    ),
  );

  route(
    app,
    "post",
    "/transactions",
    api(ps, async (c) => {
      const body = await parseJsonBody(c);
      const bankAccountId =
        num(body.bank_account_id) ??
        num((body.bank_account as Json | undefined)?.id) ??
        ps.bankAccounts.all()[0]?.pl_id;
      const bankAccount = bankAccountId !== undefined ? ps.bankAccounts.findOneBy("pl_id", bankAccountId) : undefined;
      if (!bankAccount)
        throw unprocessable("Validation failed", [{ field: "bank_account_id", message: "bank account not found" }]);
      const amount = num(body.amount) ?? num(body.currency_amount);
      if (amount === undefined)
        throw unprocessable("Validation failed", [{ field: "amount", message: "can't be blank" }]);
      const label = str(body.label)?.trim();
      if (!label) throw unprocessable("Validation failed", [{ field: "label", message: "can't be blank" }]);
      const transaction = ps.transactions.insert({
        pl_id: nextId(ps),
        bank_account_id: bankAccount.pl_id,
        label,
        amount,
        currency: str(body.currency) ?? bankAccount.currency,
        currency_amount: num(body.currency_amount) ?? amount,
        date: dateOnly(body.date, "date") ?? today(),
        fee: num(body.fee) ?? 0,
        archived: false,
        categories: Array.isArray(body.categories) ? parseCategoryWeights(ps, body) : [],
        matched_customer_invoice_ids: [],
        matched_supplier_invoice_ids: [],
        external_reference: strOrNull(body.external_reference),
      });
      logEvent(ps, "transaction.created", String(transaction.pl_id), { label, amount });
      return c.json(formatTransaction(fmt, transaction), 201);
    }),
  );

  route(
    app,
    "get",
    "/transactions/:id",
    api(ps, (c) => c.json(formatTransaction(fmt, findTransaction(ps, c.req.param("id"))))),
  );

  route(
    app,
    "put",
    "/transactions/:id",
    api(ps, async (c) => {
      const transaction = findTransaction(ps, c.req.param("id"));
      const body = await parseJsonBody(c);
      const updates: Partial<PlTransaction> = {
        label: str(body.label) ?? transaction.label,
        archived: bool(body.archived) ?? transaction.archived,
        external_reference:
          body.external_reference !== undefined ? strOrNull(body.external_reference) : transaction.external_reference,
      };
      return c.json(formatTransaction(fmt, ps.transactions.update(transaction.id, updates)!));
    }),
  );

  route(
    app,
    "get",
    "/transactions/:id/categories",
    api(ps, (c) =>
      listResponse(c, formatCategoryWeights(fmt, findTransaction(ps, c.req.param("id")).categories), {
        filters: { id: true },
        sortable: ["id"],
      }),
    ),
  );

  route(
    app,
    "put",
    "/transactions/:id/categories",
    api(ps, async (c) => {
      const transaction = findTransaction(ps, c.req.param("id"));
      const updated = ps.transactions.update(transaction.id, {
        categories: parseCategoryWeights(ps, await parseJsonBody(c)),
      })!;
      return c.json({ items: formatCategoryWeights(fmt, updated.categories), has_more: false, next_cursor: null });
    }),
  );

  route(
    app,
    "get",
    "/transactions/:id/matched_invoices",
    api(ps, (c) => {
      const transaction = findTransaction(ps, c.req.param("id"));
      const customerInvoices = transaction.matched_customer_invoice_ids
        .map((id) => ps.customerInvoices.findOneBy("pl_id", id))
        .filter((invoice): invoice is NonNullable<typeof invoice> => !!invoice);
      const supplierInvoices = transaction.matched_supplier_invoice_ids
        .map((id) => ps.supplierInvoices.findOneBy("pl_id", id))
        .filter((invoice): invoice is NonNullable<typeof invoice> => !!invoice);
      return c.json({
        items: [
          ...customerInvoices.map((invoice) => ({ type: "customer_invoice", ...formatCustomerInvoice(fmt, invoice) })),
          ...supplierInvoices.map((invoice) => ({ type: "supplier_invoice", ...formatSupplierInvoice(fmt, invoice) })),
        ],
        has_more: false,
        next_cursor: null,
      });
    }),
  );
}
