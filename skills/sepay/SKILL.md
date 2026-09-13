---
name: sepay
description: Emulated SePay VietQR payment gateway APIs for local development and testing. Use when the user needs to test SePay transaction queries, bank-transfer webhooks, VietQR image generation, or SePay SDK integrations without hitting the real SePay service.
allowed-tools: Bash(npx emulate:*)
---

# SePay API Emulator

Stateful emulation of the SePay v1 transaction API (`my.sepay.vn/userapi`), inbound-to-merchant webhook delivery, VietQR PNG generation, and a local bank-transaction simulator.

## Start

```bash
npx emulate --service sepay
```

Default URL: `http://localhost:4014` when all services are started, or `http://localhost:4000` when SePay is the only service.

## Defaults

```text
SEPAY_API_KEY=sepay_test_api_key
SEPAY_WEBHOOK_API_KEY=sepay_test_webhook_key
```

A default bank account is seeded: bin `970436`, account number `0071000888888`.

## Auth

All `/userapi/*` routes require `Authorization: Bearer <API_KEY>` matching a seeded API key. Missing or invalid keys return 401. Webhook deliveries carry `Authorization: Bearer <webhook api key>` per target; validate that shared secret in your webhook handler.

## Core Routes

- `GET /userapi/transactions/list` - list transactions (newest first)
- `GET /userapi/transactions/details/{id}` - get transaction details
- `POST /userapi/simulate/transaction` - local-only helper to create a transaction and fire webhooks
- `GET /img?acc=&bank=&amount=&des=` - VietQR PNG (also at `/qr/img`)

## List Filters

`account_number`, `reference_number`, `since_id`, `amount_in`, `amount_out`, `limit` (max 5000), `offset`.

## Webhook Payload

```json
{
  "id": 100001,
  "gateway": "Vietcombank",
  "transactionDate": "2026-01-15 09:30:00",
  "accountNumber": "0071000888888",
  "subAccount": "",
  "amountIn": 250000,
  "amountOut": 0,
  "accumulated": 0,
  "code": "ORD1001",
  "transactionContent": "ORD1001 thanh toan don hang",
  "referenceNumber": "FT26011509300001",
  "body": "ORD1001 thanh toan don hang"
}
```

## Payment Flow Testing

1. Generate a checkout QR with `GET /img?acc=<account>&bank=<bin>&amount=<vnd>&des=<order code>`.
2. Simulate the customer paying: `POST /userapi/simulate/transaction` with JSON body `{ "accountNumber": "...", "amountIn": 250000, "code": "ORDER123", "content": "..." }`.
3. The emulator POSTs the webhook payload above to every seeded `webhook_targets[].url` with its per-target bearer key, then records each attempt in the store.
4. Poll `GET /userapi/transactions/list?reference_number=...` like production code to confirm reconciliation.

Seed config keys: `api_keys` (token + label), `webhook_targets` (url + api_key), `bank_accounts` (bin + account_number + name), `transactions` (camelCase fields). Omitted API keys are generated and reported through `generatedSecrets` when using `--generated-secrets-file`.

## Current Limits

No real bank connections, OAuth 2.0 API v2 endpoints, virtual accounts, bank account listing endpoints, transaction count endpoint, rate limiting, or webhook retry behavior is implemented.
