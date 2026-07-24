# @emulators/stripe

Stripe API emulation with customers, payment methods, customer sessions, payment intents, charges, products, prices, and checkout sessions. Includes a hosted checkout page and webhook delivery.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/stripe
```

## Endpoints

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

Events are delivered to configured webhook URLs:
- `checkout.session.completed` — when a checkout session is completed
- `checkout.session.expired` — when a checkout session expires

## Seed Configuration

```yaml
stripe:
  customers:
    - name: Test Customer
      email: test@example.com
  products:
    - name: Pro Plan
  prices:
    - product_name: Pro Plan # must match a `products[].name` above
      unit_amount: 2000
      currency: usd
  webhooks:
    - url: http://localhost:3000/api/stripe/webhook
      events: ["checkout.session.completed"]
```

Two rules the emulator enforces silently — seed config is not validated, so a
mistake produces an empty store rather than an error:

- **Prices are seeded through their product.** A `prices[]` entry is only created
  if its `product_name` matches the `name` of an entry in `products[]`. A `prices`
  block with no matching product — or with the key spelled `product` — is dropped,
  and `GET /v1/prices` returns `{"data":[]}`.
- **All seeded prices are one-time.** The emulator sets `type: "one_time"`;
  there is no `recurring` key. Create subscription-style prices through
  `POST /v1/prices` at runtime instead.

## Links

- [Full documentation](https://emulate.dev/docs/stripe)
- [GitHub](https://github.com/vercel-labs/emulate)
