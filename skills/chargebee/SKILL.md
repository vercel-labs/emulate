---
name: chargebee
description: Emulated Chargebee API (Product Catalog 2.0) for local development and testing. Use when the user needs to test subscription billing locally, create customers and subscriptions, manage items and item prices, generate invoices, drive hosted checkout or customer portal flows, test Chargebee webhooks, or use the Chargebee Node SDK without hitting a real Chargebee site. Triggers include "Chargebee API", "emulate Chargebee", "test billing locally", "subscription_for_items", "hosted page", "Chargebee webhook", "chargebee SDK", "CHARGEBEE_API_KEY", "CHARGEBEE_SITE", or any task requiring a local Chargebee API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Chargebee API Emulator

Fully stateful Chargebee API v2 emulation for Product Catalog 2.0 sites. Customers, catalog, subscriptions, invoices, credit notes, transactions, payment sources, hosted pages, portal sessions, and events persist in memory. Subscription changes generate invoices and collect payments with a simulated gateway, webhooks fire on every event, and the delorean time machine renews subscriptions when you travel forward.

No real charges are processed. Every Chargebee SDK call hits the emulator and produces Chargebee-shaped responses.

## Start

```bash
# Chargebee only
npx emulate --service chargebee

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const chargebee = await createEmulator({ service: 'chargebee', port: 4000 })
// chargebee.url === 'http://localhost:4000'
```

## Defaults

```text
CHARGEBEE_SITE=emulate-test
CHARGEBEE_API_KEY=test_emulate_chargebee_api_key
```

Seeded catalog and data:

| Kind | ID |
|------|----|
| Item family | `local-products` |
| Plan item | `pro-plan` with prices `pro-plan-USD-Monthly` (2000) and `pro-plan-USD-Yearly` (20000) |
| Addon item | `extra-seats` with price `extra-seats-USD-Monthly` (500 per unit) |
| Charge item | `setup-fee` with price `setup-fee-USD` (4900) |
| Coupon | `WELCOME10` (10%, one time) |
| Customer | `local-customer` with a valid test card |
| Subscription | `local-subscription` (active, monthly plan, paid invoice) |

Amounts are in minor currency units, like Chargebee.

## Pointing Your App at the Emulator

### Chargebee Node SDK (v3)

The SDK builds URLs from `site` and `hostSuffix`. Point it at the emulator by using `localhost` as the site with an empty suffix:

```typescript
import Chargebee from 'chargebee'

const chargebee = new Chargebee({
  site: 'localhost',
  apiKey: process.env.CHARGEBEE_API_KEY!,
  protocol: 'http',
  hostSuffix: '',
  port: 4000,
})

const { customer } = await chargebee.customer.create({ email: 'jane@example.com' })
const result = await chargebee.subscription.createWithItems(customer.id, {
  subscription_items: [{ item_price_id: 'pro-plan-USD-Monthly' }],
})
```

Behind a reverse proxy (`--base-url https://chargebee.myproxy.test`), set `site: 'chargebee'`, `hostSuffix: '.myproxy.test'`, `protocol: 'https'`, and `port: 443`.

### Direct fetch

Requests use HTTP Basic auth with the API key as the username and an empty password. Bodies are form encoded with Chargebee bracket syntax.

```bash
curl -u "$CHARGEBEE_API_KEY:" http://localhost:4000/api/v2/customers

curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/customers/local-customer/subscription_for_items \
  -d "subscription_items[item_price_id][0]=pro-plan-USD-Monthly" \
  -d "subscription_items[item_price_id][1]=extra-seats-USD-Monthly" \
  -d "subscription_items[quantity][1]=3"
```

## Seed Config

All entities accept an optional `id`. Custom fields use `cf_*` keys on customers, subscriptions, items, and item prices.

```yaml
chargebee:
  site: acme-test
  api_keys:
    - key: test_acme_key
  item_families:
    - id: security
      name: Security
  items:
    - id: edr
      name: EDR
      type: plan
      item_family: security
    - id: seats
      name: Seats
      type: addon
      item_family: security
  item_prices:
    - id: edr-EUR-Monthly
      item: edr
      pricing_model: flat_fee
      price: 9900
      currency_code: EUR
      period: 1
      period_unit: month
      trial_period: 14
      trial_period_unit: day
    - id: seats-EUR-Monthly
      item: seats
      pricing_model: per_unit
      price: 700
      currency_code: EUR
      period: 1
      period_unit: month
  coupons:
    - id: LAUNCH20
      name: Launch 20%
      discount_type: percentage
      discount_percentage: 20
      duration_type: limited_period
      duration_month: 3
  customers:
    - id: cust_acme
      company: Acme
      email: billing@acme.test
      auto_collection: "off"
      cf_company: cmp_123
    - id: cust_child
      email: child@acme.test
      parent_id: cust_acme
  subscriptions:
    - id: sub_acme
      customer: cust_acme
      items:
        - item_price: edr-EUR-Monthly
        - item_price: seats-EUR-Monthly
          quantity: 25
      coupons: [LAUNCH20]
  webhooks:
    - url: http://localhost:3000/api/webhooks/chargebee
      username: chargebee
      password: webhook_secret
      events: ["*"]
```

Seeded subscriptions on customers without a card are created with `auto_collection` off so their invoices stay in `payment_due`.

## API Endpoints

### Customers

```bash
# Create with a test card and custom field
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/customers \
  -d "first_name=Jane" -d "email=jane@example.com" -d "cf_company=cmp_1" \
  -d "card[number]=4111111111111111"

# Retrieve, update, list with filters
curl -u "$CHARGEBEE_API_KEY:" http://localhost:4000/api/v2/customers/cust_1
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/customers/cust_1 -d "company=Acme"
curl -u "$CHARGEBEE_API_KEY:" "http://localhost:4000/api/v2/customers?cf_company[is]=cmp_1&limit=10"

# Account hierarchy
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/customers/child/relationships \
  -d "parent_id=parent" -d "payment_owner_id=parent" -d "invoice_owner_id=parent"
curl -u "$CHARGEBEE_API_KEY:" http://localhost:4000/api/v2/customers/child/hierarchy
```

List endpoints support Chargebee filter operators (`is`, `is_not`, `in`, `not_in`, `starts_with`, `is_present`, `after`, `before`, `on`, `between`, `gt`, `lt`, `gte`, `lte`), `sort_by[asc|desc]`, `limit`, and `offset` with `next_offset` in responses.

### Catalog

```bash
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/item_families -d "id=widgets" -d "name=Widgets"
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/items \
  -d "id=widget" -d "name=Widget" -d "type=plan" -d "item_family_id=widgets"
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/item_prices \
  -d "item_id=widget" -d "pricing_model=per_unit" -d "price=1500" -d "currency_code=EUR" \
  -d "period=1" -d "period_unit=month"
# Generated id: widget-EUR-Monthly
curl -u "$CHARGEBEE_API_KEY:" "http://localhost:4000/api/v2/item_prices?item_type[is]=plan"
```

Pricing models: `flat_fee`, `per_unit` (with `free_quantity`), `tiered`, `volume`, `stairstep` (with `tiers[starting_unit][0]`, `tiers[ending_unit][0]`, `tiers[price][0]`).

### Subscriptions

```bash
# Create for an existing customer
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/customers/cust_1/subscription_for_items \
  -d "subscription_items[item_price_id][0]=pro-plan-USD-Monthly" \
  -d "coupon_ids[0]=WELCOME10"

# Create customer and subscription together
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/subscriptions/create_with_items \
  -d "customer[email]=new@example.com" -d "card[number]=4111111111111111" \
  -d "subscription_items[item_price_id][0]=pro-plan-USD-Monthly"

# Change items (prorated invoice), schedule for term end, cancel, reactivate
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/subscriptions/sub_1/update_for_items \
  -d "subscription_items[item_price_id][0]=extra-seats-USD-Monthly" -d "subscription_items[quantity][0]=5"
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/subscriptions/sub_1/cancel_for_items -d "end_of_term=true"
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/subscriptions/sub_1/remove_scheduled_cancellation
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/subscriptions/sub_1/cancel_for_items \
  -d "credit_option_for_current_term_charges=prorate"
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/subscriptions/sub_1/reactivate

# Import without invoicing
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/customers/cust_1/import_for_items \
  -d "id=legacy_1" -d "status=active" -d "subscription_items[item_price_id][0]=pro-plan-USD-Monthly"
```

Subscription lifecycle: `future` (start_date ahead), `in_trial` (plan trial or `trial_end`), `active`, `non_renewing` (cancel at term end), `paused`, `cancelled`. Active subscriptions generate a term invoice immediately. When the customer has `auto_collection` on, the invoice is charged to the primary payment source; without a payment source the create call fails with `payment_method_not_present`, like Chargebee. Customers with `auto_collection` off get `payment_due` invoices that you settle with `record_payment`.

### Invoices, Credit Notes, Transactions

```bash
curl -u "$CHARGEBEE_API_KEY:" "http://localhost:4000/api/v2/invoices?customer_id[is]=cust_1&status[is]=payment_due"
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/invoices/3/record_payment \
  -d "transaction[amount]=2000" -d "transaction[payment_method]=bank_transfer"
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/invoices/3/pdf
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/invoices/3/void
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/invoices/2/refund -d "refund_amount=500"
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/invoices/create_for_charge_items_and_charges \
  -d "customer_id=cust_1" -d "charges[amount][0]=1000" -d "charges[description][0]=Consulting"
curl -u "$CHARGEBEE_API_KEY:" http://localhost:4000/api/v2/customers/cust_1/credit_notes
curl -u "$CHARGEBEE_API_KEY:" "http://localhost:4000/api/v2/transactions?customer_id[is]=cust_1"
```

The `pdf` endpoints return a `download_url` served by the emulator with a minimal real PDF.

### Payment Sources

```bash
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/payment_sources/create_card \
  -d "customer_id=cust_1" -d "card[number]=4111111111111111" -d "card[expiry_month]=12" -d "card[expiry_year]=2030"
curl -u "$CHARGEBEE_API_KEY:" "http://localhost:4000/api/v2/payment_sources?customer_id[is]=cust_1"
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/payment_sources/pm_xxx/delete
```

Test cards: any number is accepted and `4111111111111111` always succeeds. `4000000000000002` is stored as a valid card but every charge fails, producing `payment_failed` events and `payment_due` invoices with `dunning_status` `in_progress`.

### Hosted Pages And Portal

```bash
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/hosted_pages/checkout_new_for_items \
  -d "subscription_items[item_price_id][0]=pro-plan-USD-Monthly" \
  -d "customer[email]=shopper@example.com" \
  -d "redirect_url=http://localhost:3000/thanks?hp={id}" -d "cancel_url=http://localhost:3000/cancel"
```

The response `url` points to a hosted checkout at `/pages/v3/<id>/`. Submitting the page creates the customer (with a test card), creates the subscription, fires the usual events, marks the hosted page `succeeded`, and redirects to `redirect_url` with `id` and `state=succeeded` appended. Retrieve the hosted page afterwards to read `content.customer`, `content.subscription`, and `content.invoice`. Other page types: `checkout_existing_for_items`, `checkout_one_time_for_items`, `manage_payment_sources`, `update_payment_method`, `collect_now`.

```bash
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/portal_sessions \
  -d "customer[id]=cust_1" -d "redirect_url=http://localhost:3000/account"
```

The `access_url` opens a local customer portal listing subscriptions and invoices.

### Estimates

```bash
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/estimates/create_subscription_for_items \
  -d "subscription_items[item_price_id][0]=pro-plan-USD-Monthly" -d "coupon_ids[0]=WELCOME10"
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/estimates/update_subscription_for_items \
  -d "subscription[id]=sub_1" -d "subscription_items[item_price_id][0]=extra-seats-USD-Monthly" -d "subscription_items[quantity][0]=5"
curl -u "$CHARGEBEE_API_KEY:" http://localhost:4000/api/v2/subscriptions/sub_1/renewal_estimate
```

### Time Machine

```bash
# Renew everything due before the destination
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/time_machines/delorean/travel_forward \
  -d "destination_time=$(( $(date +%s) + 35*86400 ))"
curl -u "$CHARGEBEE_API_KEY:" http://localhost:4000/api/v2/time_machines/delorean

# Wipe site data (keeps API keys)
curl -u "$CHARGEBEE_API_KEY:" -X POST http://localhost:4000/api/v2/time_machines/delorean/start_afresh
```

Travelling forward moves the emulator clock and processes trials ending, term renewals (`subscription_renewed`, `invoice_generated`, `payment_succeeded`), scheduled changes, scheduled cancellations, and scheduled pauses or resumptions. The SDK's `timeMachine.travelForward` and `waitForTimeTravelCompletion` helpers work because `time_travel_status` is `succeeded` immediately.

### Events

```bash
curl -u "$CHARGEBEE_API_KEY:" "http://localhost:4000/api/v2/events?event_type[is]=subscription_created"
```

## Webhooks

Configure webhooks in seed config. Every event is POSTed as JSON with the Chargebee event shape:

```json
{
  "id": "ev_...",
  "occurred_at": 1735689600,
  "source": "api",
  "object": "event",
  "api_version": "v2",
  "event_type": "subscription_created",
  "webhook_status": "scheduled",
  "content": { "subscription": {}, "customer": {}, "card": {} }
}
```

Webhooks with `username` and `password` include `Authorization: Basic base64(username:password)`, which matches Chargebee's webhook Basic auth setting and the SDK's `basicAuthValidator`.

### Events dispatched

| Event | Trigger |
|-------|---------|
| `customer_created`, `customer_changed`, `customer_deleted` | Customer lifecycle |
| `item_family_*`, `item_*`, `item_price_*`, `coupon_*` | Catalog changes |
| `subscription_created`, `subscription_started`, `subscription_activated` | Creation, future start, trial end |
| `subscription_changed`, `subscription_changes_scheduled`, `subscription_scheduled_changes_removed` | Item or field updates |
| `subscription_renewed` | Term renewal via the time machine |
| `subscription_cancellation_scheduled`, `subscription_scheduled_cancellation_removed`, `subscription_cancelled`, `subscription_reactivated` | Cancellation flow |
| `subscription_pause_scheduled`, `subscription_paused`, `subscription_resumption_scheduled`, `subscription_resumed` | Pause flow |
| `subscription_deleted` | Delete |
| `invoice_generated`, `invoice_updated`, `invoice_deleted` | Invoice lifecycle |
| `payment_succeeded`, `payment_failed`, `payment_refunded` | Collection, declines, refunds |
| `credit_note_created`, `credit_note_updated`, `credit_note_deleted` | Credit notes |
| `payment_source_added`, `payment_source_updated`, `payment_source_deleted`, `card_added`, `card_updated`, `card_deleted` | Payment sources |
| `promotional_credits_added`, `promotional_credits_deducted` | Promotional credits |

### Webhook handler example

```typescript
// app/api/webhooks/chargebee/route.ts
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const [scheme, encoded = ''] = (request.headers.get('authorization') ?? '').split(' ')
  const [username, password] = Buffer.from(encoded, 'base64').toString().split(':')
  if (scheme !== 'Basic' || username !== 'chargebee' || password !== 'webhook_secret') {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const event = await request.json()
  switch (event.event_type) {
    case 'subscription_created':
      console.log('Subscription created:', event.content.subscription.id)
      break
    case 'payment_succeeded':
      console.log('Paid invoice:', event.content.invoice.id)
      break
  }
  return NextResponse.json({ received: true })
}
```

## Inspector

Open `GET /` on the Chargebee emulator for customers, subscriptions, invoices and credit notes, catalog, transactions and payment sources, hosted pages and portal sessions, events, credentials, and webhook deliveries.

## Current Limits

Product Catalog 1.0 endpoints (`plans`, `addons`, `POST /subscriptions`) are not implemented. Taxes, multi-currency exchange rates, usage-based billing, quotes, orders, gifts, contract terms, dunning retries, advance invoices, unbilled charges beyond a counter, Chargebee.js tokenization, and the JS checkout drop-in are not implemented. Deleting a customer also deletes its subscriptions, invoices, transactions, credit notes, and payment sources.
