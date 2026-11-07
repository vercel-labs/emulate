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

### Customers
- `POST /v1/customers` — create customer
- `GET /v1/customers/:id` — retrieve customer
- `POST /v1/customers/:id` — update customer
- `DELETE /v1/customers/:id` — delete customer
- `GET /v1/customers` — list customers

### Payment Methods
- `GET /v1/payment_methods` — list payment methods

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

Events sent: `customer.created`, `customer.updated`, `customer.deleted`, `product.created`, `price.created`, `payment_intent.created`, `payment_intent.succeeded`, `payment_intent.canceled`, `charge.succeeded`, `checkout.session.completed` and `checkout.session.expired`.

## Seed Configuration

```yaml
stripe:
  api_version: 2026-10-28.endive
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

- Webhooks are delivered inline, one after another and in order, before the API response returns. Failed deliveries are not retried.
- All events use one `api_version`. There is no per-endpoint version pinning, no conversion between versions, and no thin or v2 events.
- `livemode` is always `false`, and events are kept for the life of the emulator rather than 30 days.
- `Idempotency-Key` is echoed into `event.request.idempotency_key`, but repeated requests are not replayed.
- Expand paths that do not name an expandable field are ignored instead of returning a 400.
- Charges report `balance_transaction`, `payment_method_details` and `receipt_url` as `null`, and `outcome` has no risk score.
- Confirming a PaymentIntent with no payment method succeeds as if `pm_card_visa` were used. Real Stripe returns a 400.
- Payment-mode Checkout Sessions may be created without `line_items`.

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
