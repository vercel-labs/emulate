import type { InspectorTab } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { customerInvoiceStatus, invoiceTotals } from "../formatters.js";
import { money } from "../helpers.js";
import { appendixContentTypes, company } from "../store.js";
import type { PlRouteContext } from "../route-utils.js";

const SERVICE_LABEL = "Pennylane";
const TABS: InspectorTab[] = [
  { id: "invoices", label: "Customer Invoices", href: "/?tab=invoices" },
  { id: "appendices", label: "Appendices", href: "/?tab=appendices" },
  { id: "customers", label: "Customers", href: "/?tab=customers" },
  { id: "suppliers", label: "Suppliers", href: "/?tab=suppliers" },
  { id: "catalog", label: "Catalog", href: "/?tab=catalog" },
  { id: "banking", label: "Banking", href: "/?tab=banking" },
  { id: "accounting", label: "Accounting", href: "/?tab=accounting" },
  { id: "events", label: "Events", href: "/?tab=events" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
];

type TabId = (typeof TABS)[number]["id"];

function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function inspectorRoutes(rc: PlRouteContext): void {
  const { app, ps, baseUrl } = rc;

  app.get("/", (c) => {
    const requested = c.req.query("tab") ?? "invoices";
    const active = TABS.some((tab) => tab.id === requested) ? (requested as TabId) : "invoices";
    const views: Record<TabId, () => string> = {
      invoices: invoicesView,
      appendices: appendicesView,
      customers: customersView,
      suppliers: suppliersView,
      catalog: catalogView,
      banking: bankingView,
      accounting: accountingView,
      events: eventsView,
      auth: authView,
    };
    return c.html(renderInspectorPage("Pennylane Inspector", TABS, active, views[active](), SERVICE_LABEL));
  });

  const customerName = (id: number | null) => (id ? (ps.customers.findOneBy("pl_id", id)?.name ?? String(id)) : "");

  function invoicesView(): string {
    const rows = [...ps.customerInvoices.all()]
      .sort((a, b) => b.id - a.id)
      .map((invoice) => {
        const totals = invoiceTotals(invoice);
        return [
          escapeHtml(invoice.invoice_number ?? "(draft)"),
          code(String(invoice.pl_id)),
          escapeHtml(customerName(invoice.customer_id)),
          escapeHtml(invoice.external_reference ?? ""),
          escapeHtml(invoice.date),
          escapeHtml(invoice.deadline),
          escapeHtml(`${money(totals.total)} ${invoice.currency}`),
          badge(customerInvoiceStatus(invoice)),
          invoice.imported ? badge("imported") : "",
          escapeHtml(
            String(
              ps.appendices
                .findBy("target_id", invoice.pl_id)
                .filter((appendix) => appendix.target_type === "customer_invoice").length,
            ),
          ),
        ];
      });
    const supplierRows = [...ps.supplierInvoices.all()]
      .sort((a, b) => b.id - a.id)
      .map((invoice) => [
        escapeHtml(invoice.invoice_number ?? ""),
        code(String(invoice.pl_id)),
        escapeHtml(invoice.supplier_id ? (ps.suppliers.findOneBy("pl_id", invoice.supplier_id)?.name ?? "") : ""),
        escapeHtml(invoice.date),
        escapeHtml(`${money(invoice.amount)} ${invoice.currency}`),
        badge(invoice.paid ? "paid" : "upcoming"),
      ]);
    return (
      section(
        "Customer invoices",
        `<p>Simulate the Chargebee integration with <code>POST /_pennylane/simulate/chargebee-invoice</code>.</p>` +
          table(
            ["Number", "Id", "Customer", "External ref", "Date", "Deadline", "Total", "Status", "", "Appendices"],
            rows,
            "No customer invoices.",
          ),
      ) +
      section(
        "Supplier invoices",
        table(["Number", "Id", "Supplier", "Date", "Total", "Status"], supplierRows, "No supplier invoices."),
      )
    );
  }

  function appendicesView(): string {
    const rows = [...ps.appendices.all()]
      .sort((a, b) => b.id - a.id)
      .map((appendix) => {
        const invoice =
          appendix.target_type === "customer_invoice"
            ? ps.customerInvoices.findOneBy("pl_id", appendix.target_id)
            : ps.supplierInvoices.findOneBy("pl_id", appendix.target_id);
        return [
          `<a href="${escapeHtml(`${baseUrl}/_pennylane/appendices/${appendix.pl_id}/${encodeURIComponent(appendix.filename)}`)}">${escapeHtml(appendix.filename)}</a>`,
          code(String(appendix.pl_id)),
          badge(appendix.target_type),
          escapeHtml(invoice?.invoice_number ?? String(appendix.target_id)),
          escapeHtml(appendix.content_type),
          escapeHtml(`${appendix.size} B`),
          escapeHtml(appendix.created_at),
        ];
      });
    return section(
      "Appendices",
      `<p>Accepted content types: <code>${escapeHtml(appendixContentTypes(ps).join(", "))}</code>. Change them with <code>POST /_pennylane/simulate/appendix-content-types</code>.</p>` +
        table(["File", "Id", "Target", "Invoice", "Content type", "Size", "Created"], rows, "No appendices."),
    );
  }

  function customersView(): string {
    const rows = [...ps.customers.all()]
      .sort((a, b) => a.id - b.id)
      .map((customer) => [
        escapeHtml(customer.name),
        code(String(customer.pl_id)),
        badge(customer.customer_type),
        escapeHtml(customer.external_reference ?? ""),
        escapeHtml(customer.emails.join(", ")),
        escapeHtml(customer.vat_number ?? ""),
        escapeHtml(String(ps.customerInvoices.findBy("customer_id", customer.pl_id).length)),
        customer.archived ? badge("archived") : "",
      ]);
    return section(
      "Customers",
      table(["Name", "Id", "Type", "External ref", "Emails", "VAT", "Invoices", ""], rows, "No customers."),
    );
  }

  function suppliersView(): string {
    const rows = [...ps.suppliers.all()]
      .sort((a, b) => a.id - b.id)
      .map((supplier) => [
        escapeHtml(supplier.name),
        code(String(supplier.pl_id)),
        escapeHtml(supplier.external_reference ?? ""),
        escapeHtml(supplier.emails.join(", ")),
        escapeHtml(supplier.iban ?? ""),
        escapeHtml(String(ps.supplierInvoices.findBy("supplier_id", supplier.pl_id).length)),
      ]);
    return section(
      "Suppliers",
      table(["Name", "Id", "External ref", "Emails", "IBAN", "Invoices"], rows, "No suppliers."),
    );
  }

  function catalogView(): string {
    const products = [...ps.products.all()].map((product) => [
      escapeHtml(product.label),
      code(String(product.pl_id)),
      escapeHtml(`${money(product.price_before_tax)} ${product.currency}`),
      escapeHtml(product.vat_rate),
      escapeHtml(product.unit),
      escapeHtml(product.reference ?? ""),
    ]);
    const categories = [...ps.categories.all()].map((category) => [
      escapeHtml(category.label),
      code(String(category.pl_id)),
      badge(category.direction),
      `<span style="display:inline-block;width:12px;height:12px;background:${escapeHtml(category.color)}"></span>`,
      escapeHtml(
        category.category_group_id
          ? (ps.categoryGroups.findOneBy("pl_id", category.category_group_id)?.label ?? "")
          : "",
      ),
    ]);
    return (
      section(
        "Products",
        table(["Label", "Id", "Price before tax", "VAT", "Unit", "Reference"], products, "No products."),
      ) + section("Categories", table(["Label", "Id", "Direction", "Color", "Group"], categories, "No categories."))
    );
  }

  function bankingView(): string {
    const accounts = [...ps.bankAccounts.all()].map((account) => [
      escapeHtml(account.label),
      code(String(account.pl_id)),
      escapeHtml(account.bank_name),
      escapeHtml(account.iban),
      escapeHtml(account.currency),
      escapeHtml(String(ps.transactions.findBy("bank_account_id", account.pl_id).length)),
    ]);
    const transactions = [...ps.transactions.all()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 200)
      .map((transaction) => [
        escapeHtml(transaction.date),
        code(String(transaction.pl_id)),
        escapeHtml(transaction.label),
        escapeHtml(`${money(transaction.amount)} ${transaction.currency}`),
        escapeHtml(
          transaction.matched_customer_invoice_ids.concat(transaction.matched_supplier_invoice_ids).join(", "),
        ),
        escapeHtml(
          transaction.categories
            .map((entry) => ps.categories.findOneBy("pl_id", entry.category_id)?.label ?? String(entry.category_id))
            .join(", "),
        ),
      ]);
    return (
      section(
        "Bank accounts",
        table(["Label", "Id", "Bank", "IBAN", "Currency", "Transactions"], accounts, "No bank accounts."),
      ) +
      section(
        "Transactions",
        table(["Date", "Id", "Label", "Amount", "Matched invoices", "Categories"], transactions, "No transactions."),
      )
    );
  }

  function accountingView(): string {
    const journals = [...ps.journals.all()].map((journal) => [
      escapeHtml(journal.code),
      code(String(journal.pl_id)),
      escapeHtml(journal.label),
      escapeHtml(String(ps.ledgerEntries.findBy("journal_id", journal.pl_id).length)),
    ]);
    const accounts = [...ps.ledgerAccounts.all()]
      .sort((a, b) => a.number.localeCompare(b.number))
      .map((account) => [
        escapeHtml(account.number),
        code(String(account.pl_id)),
        escapeHtml(account.label),
        escapeHtml(account.vat_rate ?? ""),
        badge(account.enabled ? "enabled" : "disabled"),
      ]);
    const years = [...ps.fiscalYears.all()].map((year) => [
      escapeHtml(year.start_date),
      escapeHtml(year.end_date),
      badge(year.closed ? "closed" : "open"),
    ]);
    const entries = [...ps.ledgerEntries.all()]
      .sort((a, b) => b.id - a.id)
      .slice(0, 100)
      .map((entry) => [
        escapeHtml(entry.date),
        code(String(entry.pl_id)),
        escapeHtml(ps.journals.findOneBy("pl_id", entry.journal_id)?.code ?? ""),
        escapeHtml(entry.label),
        escapeHtml(money(entry.lines.reduce((sum, line) => sum + line.debit, 0))),
        escapeHtml(String(entry.lines.length)),
      ]);
    return (
      section(`Company: ${escapeHtml(company(ps).name)}`, table(["Start", "End", "State"], years, "No fiscal years.")) +
      section("Journals", table(["Code", "Id", "Label", "Entries"], journals, "No journals.")) +
      section("Ledger accounts", table(["Number", "Id", "Label", "VAT", "State"], accounts, "No ledger accounts.")) +
      section(
        "Ledger entries",
        table(["Date", "Id", "Journal", "Label", "Debit", "Lines"], entries, "No ledger entries."),
      )
    );
  }

  function eventsView(): string {
    const rows = [...ps.events.all()]
      .sort((a, b) => b.id - a.id)
      .slice(0, 300)
      .map((event) => [
        badge(event.type),
        code(event.subject),
        `<code>${escapeHtml(JSON.stringify(event.detail))}</code>`,
        escapeHtml(event.created_at),
      ]);
    return section(
      "Events",
      `<p>Also available as JSON at <code>${escapeHtml(baseUrl)}/_pennylane/events</code>.</p>` +
        table(["Type", "Subject", "Detail", "Created"], rows, "No events yet."),
    );
  }

  function authView(): string {
    const rows = ps.apiKeys
      .all()
      .map((key) => [
        `<code>${escapeHtml(maskSecret(key.key))}</code>`,
        escapeHtml(key.description),
        escapeHtml(key.created_at),
      ]);
    return section(
      "API tokens",
      `<p>Send <code>Authorization: Bearer &lt;token&gt;</code>. Routes are served under <code>${escapeHtml(baseUrl)}/api/external/v2</code>, <code>${escapeHtml(baseUrl)}/v2</code>, and <code>${escapeHtml(baseUrl)}</code>.</p>` +
        table(["Token", "Description", "Created"], rows, "No API tokens configured."),
    );
  }
}

function code(value: string): string {
  return `<code>${escapeHtml(value)}</code>`;
}

function badge(value: string): string {
  return `<span class="badge">${escapeHtml(value)}</span>`;
}

function section(title: string, body: string): string {
  return `<section class="inspector-section">
  <h2>${title}</h2>
  ${body}
</section>`;
}

function table(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return `<p class="inspector-empty">${escapeHtml(empty)}</p>`;
  const headerHtml = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const rowHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("\n");
  return `<table class="inspector-table">
  <thead><tr>${headerHtml}</tr></thead>
  <tbody>
${rowHtml}
  </tbody>
</table>`;
}
