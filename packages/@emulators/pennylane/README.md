# @emulators/pennylane

Stateful Pennylane external API v2 emulator plugin for [emulate](https://github.com/vercel-labs/emulate).

## Features

- Bearer API keys, routes under `/api/external/v2` (also `/v2` and bare), `{ items, has_more, next_cursor }` lists with cursor paging, sorting, and the JSON `filter` parameter with per-field operator restrictions
- Customer invoices: drafts, finalization with sequential numbers, imports, partial and full payments, email sending, cancellation with credit notes, invoice lines, categories, matched transactions, files
- Appendices on customer and supplier invoices with Pennylane's accepted content types (PDF and images), configurable for local runs
- Company and individual customers, suppliers, products, categories and category groups
- Supplier invoices, bank accounts, transactions with matching and categorization
- Journals, ledger accounts, fiscal years, balanced ledger entries and lines
- Chargebee sync simulator, event log, and a tabbed inspector

## Usage

```typescript
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { pennylanePlugin, seedFromConfig } from "@emulators/pennylane";

const app = new Hono();
const store = new Store();
const baseUrl = "http://localhost:4019";

pennylanePlugin.register(app, store, new WebhookDispatcher(), baseUrl);
pennylanePlugin.seed?.(store, baseUrl);
seedFromConfig(store, baseUrl, {
  customers: [{ name: "Acme SAS", external_reference: "cb_acme" }],
  customer_invoices: [{ customer: "Acme SAS", invoice_number: "INV-000123", external_reference: "INV-000123", imported: true, amount: 1200 }],
});
```

Authenticate with `Authorization: Bearer test_emulate_pennylane_api_key` and call `GET /api/external/v2/customer_invoices?filter=[{"field":"invoice_number","operator":"eq","value":"INV-000123"}]`.

## Defaults

The default seed creates company "Emulate SAS", three customers, one supplier, three products, categories, journals and ledger accounts, two fiscal years, a bank account with two transactions, four customer invoices (paid with an appendix, open, imported Chargebee-style, draft), and one supplier invoice.

See the [Pennylane skill](../../../skills/pennylane/SKILL.md) for the complete route list and seed schema.
