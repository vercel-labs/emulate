# @emulators/chargebee

Chargebee API emulation for Product Catalog 2.0 sites: customers, account hierarchy, item families, items, item prices, coupons, subscriptions, invoices, credit notes, transactions, payment sources, hosted pages, portal sessions, estimates, events, the delorean time machine, and webhooks. Includes hosted checkout and customer portal pages and an inspector.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/chargebee
```

## Defaults

```text
CHARGEBEE_SITE=emulate-test
CHARGEBEE_API_KEY=test_emulate_chargebee_api_key
```

The default seed includes item family `local-products`, plan `pro-plan` with item prices `pro-plan-USD-Monthly` and `pro-plan-USD-Yearly`, addon `extra-seats-USD-Monthly`, charge `setup-fee-USD`, coupon `WELCOME10`, customer `local-customer` with a test card, and active subscription `local-subscription`.

## Endpoints

All API routes live under `/api/v2` and use HTTP Basic auth with the API key as the username.

- Customers: `POST /customers`, `GET /customers`, `GET /customers/:id`, `POST /customers/:id`, `update_billing_info`, `update_payment_method`, `assign_payment_role`, promotional credits, `collect_payment`, `delete`, `clear_personal_data`, `relationships`, `delete_relationship`, `GET /customers/:id/hierarchy`
- Catalog: `item_families`, `items`, `item_prices` (create, retrieve, update, list, delete, `applicable_items`, `applicable_item_prices`)
- Coupons: `POST /coupons/create_for_items`, list, retrieve, `update_for_items`, `delete`, `unarchive`
- Subscriptions: `POST /customers/:id/subscription_for_items`, `POST /subscriptions/create_with_items`, `POST /customers/:id/import_for_items`, list, retrieve, `retrieve_with_scheduled_changes`, `update_for_items`, `change_term_end`, `cancel_for_items`, `remove_scheduled_cancellation`, `remove_scheduled_changes`, `reactivate`, `pause`, `resume`, `delete`
- Invoices: `create_for_charge_items_and_charges`, `charge`, list (also per customer and subscription), retrieve, `pdf`, `record_payment`, `collect_payment`, `void`, `write_off`, `delete`, `remove_payment`, `remove_credit_note`, `apply_credits`, `update_details`, `refund`, `record_refund`, `payments`
- Credit notes: create, list, retrieve, `pdf`, `void`, `delete`, `refund`, `record_refund`
- Transactions: list (also per customer and subscription), retrieve, `refund`
- Payment sources: `create_card`, `create_using_token`, `create_using_temp_token`, `create_using_permanent_token`, `create_using_payment_intent`, list, retrieve, `update_card`, `delete`
- Hosted pages: `checkout_new_for_items`, `checkout_existing_for_items`, `checkout_one_time_for_items`, `manage_payment_sources`, `update_payment_method`, `collect_now`, list, retrieve, `acknowledge`; the hosted UI lives at `/pages/v3/:id/`
- Portal sessions: create, retrieve, `activate`, `logout`; the portal UI lives at `/portal/v2/authenticate?token=...`
- Estimates: `create_subscription_for_items`, `update_subscription_for_items`, `renewal_estimate`, `cancel_subscription_for_items_estimate`, `create_invoice_for_items`
- Events: `GET /events`, `GET /events/:id`
- Time machine: `GET /time_machines/delorean`, `travel_forward`, `start_afresh`
- Inspector: `GET /`

## Webhooks

Events are delivered as Chargebee event payloads (`{ id, occurred_at, source, object: "event", api_version: "v2", content, event_type, webhook_status }`). Webhooks configured with `username` and `password` include an `Authorization: Basic` header.

## Seed Configuration

```yaml
chargebee:
  site: emulate-test
  api_keys:
    - key: test_emulate_chargebee_api_key
  item_families:
    - id: local-products
      name: Local Products
  items:
    - id: pro-plan
      name: Pro Plan
      type: plan
      item_family: local-products
  item_prices:
    - id: pro-plan-USD-Monthly
      item: pro-plan
      pricing_model: flat_fee
      price: 2000
      currency_code: USD
      period: 1
      period_unit: month
  customers:
    - id: local-customer
      email: test@example.com
      card:
        number: "4111111111111111"
  subscriptions:
    - id: local-subscription
      customer: local-customer
      items:
        - item_price: pro-plan-USD-Monthly
  webhooks:
    - url: http://localhost:3000/api/webhooks/chargebee
      username: chargebee
      password: webhook_secret
```

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
