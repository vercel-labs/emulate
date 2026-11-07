# @emulators/stripe

Stripe API emulation with customers, payment methods, customer sessions, payment intents, charges, products, prices, and checkout sessions. Includes a hosted checkout page and webhook delivery.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/stripe
```

## Endpoints

Every `/v1` response carries a `Request-Id: req_...` header. Retrieve, create and list endpoints accept `expand`, sent as `expand[]=customer`, as the indexed `expand[0]=customer` that stripe-node uses, or as an `expand` array in a POST body. Paths can be dotted through objects and lists (`data.payment_intent.customer`), up to four levels.

### Events
- `GET /v1/events`: list events, newest first. Filters: `type` (accepts `*`, as in `customer.*`), `types[]`, `created` (exact or `gt`/`gte`/`lt`/`lte`), `delivery_success`, plus `limit`, `starting_after` and `ending_before`
- `GET /v1/events/:id`: retrieve an event

### Webhook Endpoints
- `POST /v1/webhook_endpoints`: create an endpoint (`url` and `enabled_events` required; `api_version`, `description`, `metadata` optional). Only this response includes `secret` (`whsec_...`)
- `GET /v1/webhook_endpoints/:id`: retrieve an endpoint
- `POST /v1/webhook_endpoints/:id`: update `url`, `enabled_events`, `description`, `metadata` or `disabled`
- `DELETE /v1/webhook_endpoints/:id`: delete an endpoint
- `GET /v1/webhook_endpoints`: list endpoints, including the ones from the seed config

### Emulator controls
These routes exist only in the emulator. See [Webhook delivery model and chaos](#webhook-delivery-model-and-chaos).
- `GET /_stripe/webhooks/chaos`, `POST /_stripe/webhooks/chaos`, `DELETE /_stripe/webhooks/chaos`: read, replace or clear the delivery chaos settings
- `POST /_stripe/webhooks/flush`: deliver held events. Body: `order` (`none`, `reverse` or `shuffle`) and `event_ids`
- `GET /_stripe/webhooks/deliveries`: the delivery log. Filters: `event_id`, `status`, `type`
- `POST /_stripe/events/:id/redeliver`: send a stored event again to every matching endpoint

### Customers
- `POST /v1/customers` — create customer
- `GET /v1/customers/:id` — retrieve customer
- `POST /v1/customers/:id` — update customer
- `DELETE /v1/customers/:id` — delete customer
- `GET /v1/customers` — list customers

Create accepts `payment_method`, which attaches that payment method (or a test card id such as `pm_card_visa`) in the same call, and `invoice_settings[default_payment_method]`, which may name the payment method being attached. Update accepts `invoice_settings[default_payment_method]` for a payment method already attached to the customer, or an empty string to clear it. Both accept `invoice_prefix` (3 to 12 uppercase letters or numbers). Customers always carry `address`, `balance` (0), `currency`, `default_source`, `delinquent` (false), `invoice_prefix` (8 characters when generated), `invoice_settings`, `next_invoice_sequence` (1), `phone`, `preferred_locales`, `shipping`, `tax_exempt` (`none`) and `test_clock` (null). Deleting a customer detaches its payment methods.

### Payment Methods
- `POST /v1/payment_methods`: create a card payment method from `card[token]` (a test token such as `tok_visa`) or `card[number]` with `card[exp_month]` and `card[exp_year]` (a test card number). Also accepts `billing_details`, `metadata` and `allow_redisplay`
- `GET /v1/payment_methods/:id`: retrieve a payment method. A test card id such as `pm_card_visa` returns a new unattached `pm_` each time
- `POST /v1/payment_methods/:id`: update `metadata`, `billing_details`, `allow_redisplay`, `card[exp_month]` or `card[exp_year]` of an attached payment method
- `POST /v1/payment_methods/:id/attach`: attach to `customer`. A test card id clones into a new `pm_`. Cards that simulate an issuer decline return a 402 `card_error` and store nothing
- `POST /v1/payment_methods/:id/detach`: detach from its customer. Detaching is permanent: the payment method cannot be attached again. If it was the customer's default, the default is cleared
- `GET /v1/payment_methods`: list payment methods, filtered by `customer` and `type`
- `GET /v1/customers/:id/payment_methods`: list a customer's payment methods, filtered by `type`
- `GET /v1/customers/:id/payment_methods/:payment_method`: retrieve one of a customer's payment methods

#### Test cards

Payment methods behave like the cards in [Stripe's testing docs](https://docs.stripe.com/testing). Each one can be used as a `pm_card_*` id, a `tok_*` token or its number:

| Card | Number | Behaviour |
|------|--------|-----------|
| `pm_card_visa` (`tok_visa`) | 4242424242424242 | Succeeds |
| `pm_card_visa_debit` | 4000056655665556 | Succeeds, debit funding |
| `pm_card_mastercard` | 5555555555554444 | Succeeds |
| `pm_card_amex` | 378282246310005 | Succeeds |
| `pm_card_visa_chargeDeclined` (also `pm_card_chargeDeclined`) | 4000000000000002 | Declined: `card_declined` / `generic_decline` |
| `pm_card_visa_chargeDeclinedInsufficientFunds` | 4000000000009995 | Declined: `insufficient_funds` |
| `pm_card_visa_chargeDeclinedLostCard` | 4000000000009987 | Declined: `lost_card` |
| `pm_card_visa_chargeDeclinedStolenCard` | 4000000000009979 | Declined: `stolen_card` |
| `pm_card_chargeDeclinedExpiredCard` | 4000000000000069 | Declined: `expired_card` |
| `pm_card_chargeDeclinedIncorrectCvc` | 4000000000000127 | Declined: `incorrect_cvc` |
| `pm_card_chargeDeclinedProcessingError` | 4000000000000119 | Declined: `processing_error` |
| `pm_card_visa_chargeDeclinedVelocityLimitExceeded` | 4000000000006975 | Declined: `card_velocity_exceeded` |
| `pm_card_chargeCustomerFail` | 4000000000000341 | Attaches, then charges are declined |
| `pm_card_authenticationRequired` | 4000002760003184 | Needs 3D Secure on every charge |
| `pm_card_authenticationRequiredOnSetup` | 4000002500003155 | Needs 3D Secure on setup and on-session charges, not off-session after setup |
| `pm_card_authenticationRequiredChargeDeclinedInsufficientFunds` | 4000008260003178 | Needs 3D Secure, then is declined with `insufficient_funds` |
| (number only) | 4242424242424241 | Rejected at creation: `incorrect_number` |

The declined cards cannot be attached to a customer, as on Stripe: attaching one returns the decline. Numbers outside the table are rejected, with `incorrect_number` when they fail the Luhn check and `test_mode_live_card` otherwise. Card errors carry `decline_code` and `doc_url` alongside `code`, `message` and `param`.

### Customer Sessions
- `POST /v1/customer_sessions` — create customer session

### Payment Intents
- `POST /v1/payment_intents` — create payment intent
- `GET /v1/payment_intents/:id` — retrieve payment intent
- `POST /v1/payment_intents/:id` — update payment intent
- `POST /v1/payment_intents/:id/confirm` — confirm payment intent
- `POST /v1/payment_intents/:id/cancel` — cancel payment intent
- `GET /v1/payment_intents` — list payment intents

### Charges
- `GET /v1/charges/:id` — retrieve charge
- `GET /v1/charges` — list charges

### Products
- `POST /v1/products` — create product
- `GET /v1/products/:id` — retrieve product
- `GET /v1/products` — list products

### Prices
- `POST /v1/prices` — create price
- `GET /v1/prices/:id` — retrieve price
- `GET /v1/prices` — list prices

### Checkout Sessions
- `POST /v1/checkout/sessions` — create checkout session
- `GET /v1/checkout/sessions/:id` — retrieve session
- `POST /v1/checkout/sessions/:id/expire` — expire session
- `GET /v1/checkout/sessions` — list sessions (filter by `customer`, `status`, `payment_status`)
- `GET /checkout/:id` — hosted checkout page (HTML)
- `POST /checkout/:id/complete` — complete payment flow

## Webhooks

Every state change is stored as a Stripe [Event](https://docs.stripe.com/api/events/object) and delivered to each webhook endpoint subscribed to its type (or to `*`). The body is the full Event object, so `stripe.webhooks.constructEvent` accepts it:

```json
{
  "id": "evt_...",
  "object": "event",
  "api_version": "2026-10-28.endive",
  "created": 1762560000,
  "data": { "object": { "id": "cus_...", "object": "customer" }, "previous_attributes": { "name": "Old" } },
  "livemode": false,
  "pending_webhooks": 1,
  "request": { "id": "req_...", "idempotency_key": "your-key" },
  "type": "customer.updated"
}
```

- Endpoints configured with a secret receive `Stripe-Signature: t=<timestamp>,v1=<signature>`, an HMAC SHA-256 over `<timestamp>.<raw body>`.
- `data.previous_attributes` appears on `*.updated` events and holds the old value of each changed field. Metadata is compared key by key, with `null` for keys that did not exist before. An update that changes nothing sends no event.
- `request.id` is the `Request-Id` of the API call that caused the event, and `request.idempotency_key` echoes its `Idempotency-Key` header. Events that no API call caused, such as completing the hosted checkout page, have both set to `null`.
- `pending_webhooks` is the number of endpoints the event was sent to. `GET /v1/events/:id` shows it dropping by one for each endpoint that answered with a 2xx status.
- `api_version` defaults to `2026-10-28.endive`. Set `api_version` in the seed config to stamp a different version.

Endpoints come from `POST /v1/webhook_endpoints` or from the seed config's `webhooks`. Both are stored in the `stripe.webhook_endpoints` collection, so they are listable and survive a snapshot. After a restore, each stored endpoint is matched to the dispatcher by url and secret and registered only if it is missing, so no endpoint receives an event twice.

Events sent: `customer.created`, `customer.updated`, `customer.deleted`, `payment_method.attached`, `payment_method.detached`, `payment_method.updated`, `product.created`, `price.created`, `payment_intent.created`, `payment_intent.succeeded`, `payment_intent.canceled`, `charge.succeeded`, `checkout.session.completed` and `checkout.session.expired`.

## Webhook delivery model and chaos

By default delivery is inline, sequential and in order: the events a request causes are sent one after another, in the order they happened, before the API response returns. A failed delivery is not retried automatically; it stays in the delivery log and keeps the event's `pending_webhooks` above zero until `POST /_stripe/events/:id/redeliver` succeeds.

To test how a handler copes with real-world delivery, turn on chaos. Settings apply to each batch of events a request causes:

```bash
curl -X POST http://localhost:4000/_stripe/webhooks/chaos \
  -H "Content-Type: application/json" \
  -d '{"seed": 42, "drop": {"rate": 0.2}, "duplicate": {"types": ["charge.succeeded"], "count": 1}, "delay": {"types": ["payment_intent.succeeded"]}, "reorder": "shuffle"}'
```

| Setting | Effect |
|---------|--------|
| `drop` `{rate, types}` | The event is stored but not sent. The delivery log shows one `dropped` record per endpoint. |
| `delay` `{rate, types}` | The event is held in an outbox until `POST /_stripe/webhooks/flush`. The log shows it as `held`. |
| `duplicate` `{rate, types, count}` | The event is sent `count` extra times (default 1) with the same `evt_` id and a freshly computed signature. |
| `reorder` | `none` (default), `reverse` or `shuffle` the events of a batch that are being sent now. |
| `seed` | Seed for the decisions. The same seed makes the same decisions in every fresh emulator. Omitted, a random seed is picked and returned. |

`rate` is a probability from 0 to 1 and defaults to 1. `types` lists event types (`*` wildcards allowed) and defaults to every type. Each event is checked for drop, then delay, then duplicate. The generator state and the outbox are kept in the store, so they survive a snapshot and restore. `DELETE /_stripe/webhooks/chaos` returns to normal delivery; held events stay held until flushed. Flushing and redelivering ignore the chaos settings.

`GET /_stripe/webhooks/deliveries` lists every attempt, oldest first, each with `event_id`, `type`, `status` (`succeeded`, `failed`, `dropped` or `held`), `status_code`, `url`, `delivery_id` and `created`. `POST /_stripe/webhooks/flush` returns `{flushed: [evt ids], remaining}`.

## Seed Configuration

```yaml
stripe:
  api_version: 2026-10-28.endive
  webhooks:
    - url: http://localhost:3000/api/webhooks/stripe
      events: ['*']
      secret: whsec_test
  webhook_chaos:
    seed: 42
    reorder: reverse
  customers:
    - name: Test Customer
      email: test@example.com
  products:
    - name: Pro Plan
  prices:
    - product: Pro Plan
      unit_amount: 2000
      currency: usd
      recurring:
        interval: month
```

## Differences from real Stripe

The emulator aims to match Stripe's wire format. These are the places where it deliberately does less:

- Webhooks are delivered inline, one after another and in order, before the API response returns. Failed deliveries are not retried, and redelivery happens only through `POST /_stripe/events/:id/redeliver`. Chaos (drop, duplicate, delay until flush, reorder) is opt-in and seeded.
- Webhook endpoints accept any `enabled_events` strings without checking them against Stripe's list of event types. `api_version` is stored and returned but events are not rendered in it, and `connect` endpoints are not modelled. Seed endpoints without a `secret` receive unsigned deliveries.
- All events use one `api_version`. There is no per-endpoint version pinning, no conversion between versions, and no thin or v2 events.
- `livemode` is always `false`, and events are kept for the life of the emulator rather than 30 days.
- `Idempotency-Key` is echoed into `event.request.idempotency_key`, but repeated requests are not replayed.
- Expand paths that do not name an expandable field are ignored instead of returning a 400.
- Charges report `balance_transaction`, `payment_method_details` and `receipt_url` as `null`, and `outcome` has no risk score.
- Confirming a PaymentIntent with no payment method succeeds as if `pm_card_visa` were used. Real Stripe returns a 400.
- Payment-mode Checkout Sessions may be created without `line_items`.
- Only card payment methods exist, and only the documented test cards. `card[number]` is accepted for those numbers without the raw card data setting real Stripe requires. Fingerprints are derived from the card number, `card.checks.cvc_check` turns `pass` when a `pm_card_*` id or a card created with `card[cvc]` is attached, and `regulated_status` is always `unregulated`.
- Card behaviour (declines after attaching, 3D Secure) is recorded on each card, but confirming a PaymentIntent does not apply it yet.
- `GET /v1/payment_methods` without `customer` lists every payment method.
- Detaching a customer's default payment method clears the default and sends `customer.updated`. Deleting a customer detaches its payment methods without sending `payment_method.detached`.
- Customer `balance`, `currency`, `address`, `shipping`, tax and discounts are not modelled and keep their empty defaults.

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
