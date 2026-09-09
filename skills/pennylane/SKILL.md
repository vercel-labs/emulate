---
name: pennylane
description: Emulated Pennylane external API v2 for local development and testing. Use when the user needs to look up Pennylane customer invoices by number or external reference, attach or list invoice appendices, create drafts and finalize invoices, import invoices, manage customers, suppliers, products, categories, transactions, or ledger entries, or simulate Pennylane's Chargebee integration without a real Pennylane account. Triggers include "Pennylane API", "emulate Pennylane", "customer_invoices", "appendices", "app.pennylane.com/api/external/v2", "PENNYLANE_API_KEY", "invoice_number eq", or any task requiring a local Pennylane API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Pennylane API Emulator

Fully stateful Pennylane external API v2 emulation. Customer invoices move from draft to finalized with sequential `F-YYYY-NNNN` numbers, imports keep their own numbers, payments and matched bank transactions settle them, cancellations produce `AV-` credit notes, and appendices accept PDF, XLSX, and image files. Suppliers, products, categories, bank transactions, journals, ledger accounts, and balanced ledger entries round out the ledger.

Nothing leaves the machine. Every Pennylane API call hits the emulator and produces Pennylane-shaped `{ items, has_more, next_cursor }` responses.

## Start

```bash
# Pennylane only
npx emulate --service pennylane

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const pennylane = await createEmulator({ service: 'pennylane', port: 4000 })
// pennylane.url === 'http://localhost:4000'
```

## Defaults

```text
PENNYLANE_URL=http://localhost:4000/api/external/v2
PENNYLANE_API_KEY=test_emulate_pennylane_api_key
```

Seeded data:

- Company "Emulate SAS" with journals VT, AC, BQ, OD and French ledger accounts (411000, 401000, 512000, 604000, 706000, 445710, 445660)
- Customers Acme SAS (`200001`, external reference `cb_acme`), Nimbus MSP (`200002`), individual Jeanne Martin; supplier Cloud Hosting Ltd
- Products for EDR endpoints, SOC monitoring, and training; categories Managed services, Training, Hosting
- Invoices `F-2026-0001` (paid, one PDF appendix), `F-2026-0002` (open), `INV-000123` (imported Chargebee-style invoice, `external_reference` also `INV-000123`), and a draft
- Bank account "Compte courant" with a matched credit and a hosting debit; supplier invoice `CH-88231`

## Authentication and Conventions

```bash
curl -H "Authorization: Bearer test_emulate_pennylane_api_key" http://localhost:4000/api/external/v2/me
```

Routes are served under `/api/external/v2`, `/v2`, and the bare path. Lists return `{ items, has_more, next_cursor }`; page with `limit` and `cursor`, sort with `sort=-date`. Filter with a JSON `filter` parameter:

```bash
curl -G -H "Authorization: Bearer test_emulate_pennylane_api_key" \
  http://localhost:4000/api/external/v2/customer_invoices \
  --data-urlencode 'filter=[{"field":"invoice_number","operator":"eq","value":"INV-000123"}]'
```

Operators: `eq not_eq gt gteq lt lteq in not_in contains starts_with is_null is_not_null`, restricted per field like the real API (`external_reference` accepts only `eq` and `in`). Unknown fields or operators return 400. Validation errors return 422 `{ message, errors: [{ field, message }] }`. Amounts are decimal strings, dates are `YYYY-MM-DD`, VAT rates are codes such as `FR_200`.

## Customer Invoices

```bash
# Draft, then finalize
curl -X POST -H "Authorization: Bearer test_emulate_pennylane_api_key" -H "Content-Type: application/json" \
  http://localhost:4000/api/external/v2/customer_invoices -d '{
    "customer_id": 200001, "date": "2026-09-05",
    "invoice_lines": [{ "label": "Managed EDR - per endpoint", "quantity": 10, "raw_currency_unit_price": 8, "vat_rate": "FR_200" }]
  }'
curl -X POST -H "Authorization: Bearer test_emulate_pennylane_api_key" \
  http://localhost:4000/api/external/v2/customer_invoices/{id}/finalize

# Import an already numbered invoice
curl -X POST -H "Authorization: Bearer test_emulate_pennylane_api_key" -H "Content-Type: application/json" \
  http://localhost:4000/api/external/v2/customer_invoices/import -d '{
    "customer_id": 200001, "invoice_number": "EXT-77", "external_reference": "cb_inv_77",
    "date": "2026-08-01", "currency_amount": 240, "file": "<base64 pdf>", "filename": "EXT-77.pdf"
  }'
```

Also: `GET /customer_invoices/{id}`, `PUT` (drafts fully editable, finalized invoices accept references and PDF texts), `DELETE` (drafts only), `POST .../mark_as_paid` (`amount` for partial), `POST .../send_by_email`, `POST .../cancel` (credit note), `GET .../invoice_lines`, `GET|PUT .../categories` (`{ categories: [{ id, weight }] }`), `GET|PUT .../matched_transactions` (`{ transaction_ids }`), `GET .../file`.

## Appendices

```bash
# List
curl -H "Authorization: Bearer test_emulate_pennylane_api_key" \
  http://localhost:4000/api/external/v2/customer_invoices/300001/appendices

# Upload (multipart)
curl -X POST -H "Authorization: Bearer test_emulate_pennylane_api_key" \
  http://localhost:4000/api/external/v2/customer_invoices/300002/appendices \
  -F "file=@detail.pdf;type=application/pdf"
```

Items look like `{ id, filename, content_type, size, url, created_at, updated_at }`. Accepted content types are PDF, XLSX (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and `application/vnd.ms-excel`), and PNG, JPEG, TIFF, BMP, and GIF images (422 otherwise). To change the list, seed `appendix_content_types` or call `POST /_pennylane/simulate/appendix-content-types` with `{ "content_types": [...] }`. `DELETE /customer_invoices/{id}/appendices/{appendixId}` removes one. Supplier invoices have the same routes.

## Contacts and Catalog

- `GET|POST|PUT|DELETE /customers`, `GET|POST|PUT /company_customers`, `GET|POST|PUT /individual_customers`; deleting a customer with invoices archives it
- `GET|POST /suppliers`, `GET|PUT|DELETE /suppliers/{id}`
- `GET|POST /products`, `GET|PUT|DELETE /products/{id}`; `GET|POST /category_groups`; `GET|POST /categories`, `GET|PUT|DELETE /categories/{id}`

## Supplier Invoices, Banking, Accounting

- `GET /supplier_invoices`, `POST /supplier_invoices/import`, `GET|PUT|DELETE /supplier_invoices/{id}`, `mark_as_paid`, `invoice_lines`, `categories`, `matched_transactions`, `appendices`, `file`
- `GET /bank_accounts`, `GET|POST /transactions`, `GET|PUT /transactions/{id}`, `GET|PUT .../categories`, `GET .../matched_invoices`; matching a transaction to an invoice marks it paid
- `GET|POST /journals`, `GET /journals/{id or code}`, `GET|POST /ledger_accounts`, `GET|PUT /ledger_accounts/{id}`, `GET /fiscal_years`, `GET|POST /ledger_entries` (debits must equal credits), `GET /ledger_entries/{id}/lines`, `GET /ledger_entry_lines`
- `GET /me`, `GET /company`

## Chargebee Sync Simulator

Pennylane's native Chargebee integration creates invoices whose `invoice_number` and `external_reference` are the Chargebee invoice id. Reproduce that locally:

```bash
curl -X POST -H "Content-Type: application/json" \
  http://localhost:4000/_pennylane/simulate/chargebee-invoice \
  -d '{ "invoice_number": "INV-000456", "customer_name": "Acme SAS", "amount": 600, "date": "2026-09-01" }'
```

Unknown customers are created (use `chargebee_customer_id` to set their external reference); `amount_cents` switches the amount to cents; duplicates return 409.

## Events and Inspector

- `GET /_pennylane/events?type=appendix.created` lists events (`customer_invoice.*`, `appendix.*`, `customer.*`, `supplier_invoice.*`, `transaction.*`, `ledger_entry.*`, `chargebee.synced`); `DELETE` clears them
- `GET /` inspector tabs: invoices, appendices, customers, suppliers, catalog, banking, accounting, events, auth

## Seed Configuration

```json
{
  "pennylane": {
    "api_keys": [{ "key": "test_emulate_pennylane_api_key" }],
    "company": { "name": "Emulate SAS", "invoice_number_prefix": "F-" },
    "appendix_content_types": ["application/pdf", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv"],
    "customers": [{ "name": "Acme SAS", "emails": ["billing@acme.example"], "external_reference": "cb_acme" }],
    "products": [{ "label": "Managed EDR - per endpoint", "price_before_tax": 8, "vat_rate": "FR_200", "unit": "endpoint" }],
    "customer_invoices": [
      { "customer": "Acme SAS", "invoice_number": "F-2026-0001", "date": "2026-01-15", "paid": true, "lines": [{ "label": "Managed EDR - per endpoint", "quantity": 25, "product": "Managed EDR - per endpoint" }], "appendices": [{ "filename": "detail.pdf" }] },
      { "customer": "Acme SAS", "invoice_number": "INV-000123", "external_reference": "INV-000123", "imported": true, "amount": 1200 }
    ],
    "transactions": [{ "label": "VIR ACME", "amount": 540, "match_invoice": "F-2026-0001" }]
  }
}
```

Tenants also accept `suppliers`, `supplier_invoices`, `category_groups`, `categories`, `journals`, `ledger_accounts`, `fiscal_years`, and `bank_accounts`. Entities accept explicit numeric `id` values; seeding is idempotent by id, name, or invoice number.

## Limits

Quotes, customer invoice templates, e-invoicing, recurring invoices, changelog endpoints, transaction attachments, and webhooks are not implemented.
