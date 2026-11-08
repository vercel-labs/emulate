---
name: stripe
description: Emulated Stripe API for local development and testing. Use when the user needs to process payments locally, test checkout flows, create customers, manage products and prices, handle payment intents, work with webhooks, or use the Stripe SDK without hitting real Stripe servers. Triggers include "Stripe API", "emulate Stripe", "test payments locally", "checkout flow", "payment intent", "Stripe webhook", "Stripe SDK", "STRIPE_API_KEY", or any task requiring a local Stripe API.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Stripe API Emulator

Fully stateful Stripe API emulation. Customers, products, prices, checkout sessions, payment intents, charges, and payment methods persist in memory. Webhooks fire on state changes. The hosted checkout UI lets you complete payments in the browser.

No real payments are processed. Every Stripe SDK call hits the emulator and produces realistic responses.

## Start

Local listeners bind to `127.0.0.1` by default. For access from containers or other machines, pass `--host 0.0.0.0` to the CLI or `hostname: '0.0.0.0'` to `createEmulator`. Configure `--base-url` or `baseUrl` for advertised URLs reachable by those clients.

```bash
# Stripe only
npx emulate --service stripe

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const stripe = await createEmulator({ service: 'stripe', port: 4000 })
// stripe.url === 'http://localhost:4000'
```

## Pointing Your App at the Emulator

### Stripe SDK

The Stripe Node.js SDK does not read an environment variable for the base URL. You must pass it when constructing the client:

```typescript
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-12-18.acacia',
  host: 'localhost',
  port: 4000,
  protocol: 'http',
})
```

### Embedded in Next.js (adapter-next)

When using `@emulators/adapter-next`, the emulator runs inside your Next.js app at `/emulate/stripe`. The SDK needs to point at `localhost` with a proxy route to forward `/v1/*` calls to `/emulate/stripe/v1/*`:

```typescript
// next.config.ts
import { withEmulate } from '@emulators/adapter-next'

export default withEmulate({
  env: {
    STRIPE_SECRET_KEY: 'sk_test_emulated',
  },
})
```

```typescript
// lib/stripe.ts
import Stripe from 'stripe'

const port = process.env.PORT ?? '3000'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-12-18.acacia',
  host: 'localhost',
  port: parseInt(port, 10),
  protocol: 'http',
})
```

```typescript
// app/emulate/[...path]/route.ts
import { createEmulateHandler } from '@emulators/adapter-next'
import * as stripe from '@emulators/stripe'

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: {
    stripe: {
      emulator: stripe,
      seed: {
        products: [
          { id: 'prod_widget', name: 'Widget', description: 'A useful widget' },
        ],
        prices: [
          { id: 'price_widget', product_name: 'Widget', currency: 'usd', unit_amount: 1000 },
        ],
        webhooks: [
          {
            url: `http://localhost:${process.env.PORT ?? '3000'}/api/webhooks/stripe`,
            events: ['*'],
            secret: process.env.STRIPE_WEBHOOK_SECRET,
          },
        ],
      },
    },
  },
})
```

```typescript
// app/v1/[...path]/route.ts  (proxy for Stripe SDK)
const STRIPE_URL = `http://localhost:${process.env.PORT ?? '3000'}/emulate/stripe`

async function handler(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params
  const url = new URL(req.url)
  const target = `${STRIPE_URL}/v1/${path.join('/')}${url.search}`

  const res = await fetch(target, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    duplex: 'half',
  } as any)

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE }
```

### Direct fetch

```bash
curl http://localhost:4000/v1/customers \
  -H "Authorization: Bearer sk_test_emulated"
```

## Seed Config

Seed data is optional. All entities support an optional `id` field for deterministic IDs that survive server restarts.

```yaml
stripe:
  api_version: 2026-10-28.endive   # optional, stamped on every event
  customers:
    - id: cus_demo
      email: demo@example.com
      name: Demo User
  products:
    - id: prod_tshirt
      name: T-Shirt
      description: A comfortable tee
  prices:
    - id: price_tshirt
      product_name: T-Shirt
      currency: usd
      unit_amount: 2500
  webhooks:
    - url: http://localhost:3000/api/webhooks/stripe
      events: ['*']
      secret: whsec_test
  webhook_chaos:          # optional, see "Delivery chaos" below
    seed: 42
    reorder: reverse
```

The `product_name` field in prices links to the product by name. Use `events: ['*']` to receive all webhook events, or specify individual event types. Seeded webhooks are also listed by `GET /v1/webhook_endpoints`.

## API Endpoints

Every `/v1` response includes a `Request-Id: req_...` header. Retrieve, create and list calls accept `expand` in any of the forms Stripe accepts: `expand[]=customer`, stripe-node's indexed `expand[0]=customer`, or an `expand` array in a POST body. Dotted paths work through objects and lists, up to four levels:

```typescript
const pi = await stripe.paymentIntents.retrieve('pi_xxx', { expand: ['customer'] })
const charges = await stripe.charges.list({ expand: ['data.payment_intent.customer'] })
```

### Events

```bash
# List events, newest first (type accepts a * wildcard)
curl "http://localhost:4000/v1/events?type=customer.*"

# Several types, a created range, or only events some endpoint has not accepted yet
curl "http://localhost:4000/v1/events?types[]=customer.created&types[]=charge.succeeded"
curl "http://localhost:4000/v1/events?created[gte]=1762560000"
curl "http://localhost:4000/v1/events?delivery_success=false"

# Retrieve one event
curl http://localhost:4000/v1/events/evt_xxx
```

### Webhook Endpoints

```bash
# Create an endpoint. The response is the only one that includes its secret (whsec_...)
curl -X POST http://localhost:4000/v1/webhook_endpoints \
  -d "url=http://localhost:3000/api/webhooks/stripe" \
  -d "enabled_events[]=customer.created" -d "enabled_events[]=charge.succeeded"

# Retrieve, update (url, enabled_events, description, metadata, disabled), delete, list
curl http://localhost:4000/v1/webhook_endpoints/we_xxx
curl -X POST http://localhost:4000/v1/webhook_endpoints/we_xxx -d "disabled=true"
curl -X DELETE http://localhost:4000/v1/webhook_endpoints/we_xxx
curl http://localhost:4000/v1/webhook_endpoints
```

```typescript
const endpoint = await stripe.webhookEndpoints.create({
  url: 'http://localhost:3000/api/webhooks/stripe',
  enabled_events: ['*'],
})
// endpoint.secret verifies the deliveries with stripe.webhooks.constructEvent
```

### Customers

```bash
# Create customer
curl -X POST http://localhost:4000/v1/customers \
  -d "email=user@example.com" -d "name=Jane Doe"

# Retrieve customer
curl http://localhost:4000/v1/customers/cus_xxx

# Update customer
curl -X POST http://localhost:4000/v1/customers/cus_xxx \
  -d "name=Updated Name"

# Delete customer
curl -X DELETE http://localhost:4000/v1/customers/cus_xxx

# List customers
curl http://localhost:4000/v1/customers
```

### Products

```bash
# Create product
curl -X POST http://localhost:4000/v1/products \
  -d "name=Widget" -d "description=A useful widget"

# Retrieve product
curl http://localhost:4000/v1/products/prod_xxx

# List products
curl "http://localhost:4000/v1/products?active=true"
```

### Prices

```bash
# Create price
curl -X POST http://localhost:4000/v1/prices \
  -d "product=prod_xxx" -d "currency=usd" -d "unit_amount=1000"

# Retrieve price
curl http://localhost:4000/v1/prices/price_xxx

# List prices
curl "http://localhost:4000/v1/prices?active=true"
```

### Checkout Sessions

```bash
# Create checkout session
curl -X POST http://localhost:4000/v1/checkout/sessions \
  -d "mode=payment" \
  -d "line_items[0][price]=price_xxx" \
  -d "line_items[0][quantity]=1" \
  -d "success_url=http://localhost:3000/success?session_id={CHECKOUT_SESSION_ID}" \
  -d "cancel_url=http://localhost:3000/cart"

# Retrieve session
curl http://localhost:4000/v1/checkout/sessions/cs_xxx

# List sessions
curl http://localhost:4000/v1/checkout/sessions

# Expire a session
curl -X POST http://localhost:4000/v1/checkout/sessions/cs_xxx/expire
```

The session's `url` field points to a hosted checkout page at `/checkout/cs_xxx`. Clicking "Pay" on that page completes the session, fires the `checkout.session.completed` webhook, and redirects to `success_url`. The `{CHECKOUT_SESSION_ID}` template in `success_url` is replaced with the actual session ID.

### Payment Intents

```bash
# Create payment intent
curl -X POST http://localhost:4000/v1/payment_intents \
  -d "amount=2000" -d "currency=usd"

# Retrieve
curl http://localhost:4000/v1/payment_intents/pi_xxx

# Update
curl -X POST http://localhost:4000/v1/payment_intents/pi_xxx \
  -d "amount=3000"

# Confirm (triggers payment_intent.succeeded + charge.succeeded webhooks)
curl -X POST http://localhost:4000/v1/payment_intents/pi_xxx/confirm

# Create and confirm off-session with a saved card in one call
curl -X POST http://localhost:4000/v1/payment_intents \
  -d "amount=2000" -d "currency=usd" -d "customer=cus_xxx" \
  -d "payment_method=pm_xxx" -d "confirm=true" -d "off_session=true"

# Cancel
curl -X POST http://localhost:4000/v1/payment_intents/pi_xxx/cancel \
  -d "cancellation_reason=requested_by_customer"

# List
curl http://localhost:4000/v1/payment_intents

# Emulator only: the customer completes (or fails) 3D Secure on an intent in requires_action
curl -X POST http://localhost:4000/_stripe/simulate/payment_intents/pi_xxx/authenticate \
  -H "Content-Type: application/json" -d '{"result": "succeed"}'
```

Confirming follows the test card's behaviour. `pm_card_visa` succeeds. A declining card (for example `pm_card_chargeDeclined`, or `pm_card_chargeCustomerFail` after attaching it) returns a 402 `card_error`, creates a failed charge, sets `last_payment_error` and returns the intent to `requires_payment_method`. `pm_card_authenticationRequired` returns `requires_action` with `next_action.type` `use_stripe_sdk` on-session, and a 402 `authentication_required` off-session. `pm_card_authenticationRequiredOnSetup` asks only on-session. Failing 3D Secure gives `last_payment_error.code` `payment_intent_authentication_failure`.

A `pm_card_*` id set on an intent is cloned into a new `pm_`. With `setup_future_usage` and a `customer`, a successful payment attaches that card to the customer. A card used without a customer cannot be used again. Confirming an intent that has no payment method still succeeds as if `pm_card_visa` were used (real Stripe returns a 400).

### Setup Intents

```bash
# Save a card to a customer without charging it (payment_method.attached + setup_intent.succeeded)
curl -X POST http://localhost:4000/v1/setup_intents \
  -d "customer=cus_xxx" -d "payment_method=pm_card_visa" -d "confirm=true"

# Or in two steps: create, then confirm with a card
curl -X POST http://localhost:4000/v1/setup_intents -d "customer=cus_xxx"
curl -X POST http://localhost:4000/v1/setup_intents/seti_xxx/confirm -d "payment_method=pm_card_visa"

# Retrieve, update (customer, payment_method, description, metadata), cancel, list (customer, payment_method)
curl http://localhost:4000/v1/setup_intents/seti_xxx
curl -X POST http://localhost:4000/v1/setup_intents/seti_xxx/cancel -d "cancellation_reason=abandoned"
curl "http://localhost:4000/v1/setup_intents?customer=cus_xxx"

# Emulator only: the customer completes (or fails) 3D Secure on a SetupIntent in requires_action
curl -X POST http://localhost:4000/_stripe/simulate/setup_intents/seti_xxx/authenticate \
  -H "Content-Type: application/json" -d '{"result": "succeed"}'
```

`usage` defaults to `off_session`. Issuer-decline cards such as `pm_card_chargeDeclined` return a 402 `card_error` carrying the `setup_intent`, set `last_setup_error` and send `setup_intent.setup_failed`. `pm_card_chargeCustomerFail` (0341) sets up fine and only fails when charged. `pm_card_authenticationRequired` and `pm_card_authenticationRequiredOnSetup` go to `requires_action`; once authenticated, a 3155 card is charged off-session without asking again. A failed authentication gives `last_setup_error.code` `setup_intent_authentication_failure`.

### Invoices

```bash
# A draft invoice, then an invoice item on it (pricing[price] or amount + currency)
curl -X POST http://localhost:4000/v1/invoices -d "customer=cus_xxx"
curl -X POST http://localhost:4000/v1/invoiceitems \
  -d "customer=cus_xxx" -d "invoice=in_xxx" -d "pricing[price]=price_xxx" -d "quantity=2"

# Or create pending items first and sweep them in
curl -X POST http://localhost:4000/v1/invoices \
  -d "customer=cus_xxx" -d "pending_invoice_items_behavior=include"

# Finalize (number, PaymentIntent, default InvoicePayment), then pay with the default card
curl -X POST http://localhost:4000/v1/invoices/in_xxx/finalize -d "expand[]=payments"
curl -X POST http://localhost:4000/v1/invoices/in_xxx/pay
curl -X POST http://localhost:4000/v1/invoices/in_xxx/pay -d "payment_method=pm_card_mastercard"
curl -X POST http://localhost:4000/v1/invoices/in_xxx/pay -d "paid_out_of_band=true"

# Void, mark uncollectible, delete a draft, list lines, list payments
curl -X POST http://localhost:4000/v1/invoices/in_xxx/void
curl -X POST http://localhost:4000/v1/invoices/in_xxx/mark_uncollectible
curl -X DELETE http://localhost:4000/v1/invoices/in_xxx
curl "http://localhost:4000/v1/invoices/in_xxx/lines?limit=10"
curl "http://localhost:4000/v1/invoice_payments?invoice=in_xxx"
```

Invoices use the current wire shape: there is no top-level `subscription`, `payment_intent`, `charge` or `paid`. Reach the PaymentIntent through `expand[]=payments.data.payment.payment_intent` or the client secret through `expand[]=confirmation_secret`. Lines carry `parent.invoice_item_details` and `pricing.price_details`. `pending_invoice_items_behavior` defaults to `exclude`, as on Stripe.

Paying charges, in order, the `payment_method` param, the invoice's `default_payment_method`, then the customer's `invoice_settings.default_payment_method`, off-session by default. A decline (`pm_card_chargeCustomerFail`) returns 402, leaves the invoice `open` with `attempt_count` 1 and sends `invoice.payment_failed`. `pm_card_authenticationRequired` returns 402 `invoice_payment_intent_requires_action`, leaves the PaymentIntent in `requires_action` and sends `invoice.payment_action_required` and `invoice.payment_failed`; completing it with `/_stripe/simulate/payment_intents/pi_xxx/authenticate` pays the invoice. A $0 invoice is paid when it is finalized and, like `paid_out_of_band`, sends `invoice.paid` without `invoice.payment_succeeded`. `mark_uncollectible` sets `status_details.uncollectible.reason` to `user_forgiven`; the invoice can still be paid. The hosted invoice page is not served yet, so `hosted_invoice_url` answers 404.

### Charges

```bash
# Retrieve charge
curl http://localhost:4000/v1/charges/ch_xxx

# List charges
curl http://localhost:4000/v1/charges
```

Charges are created automatically when a payment intent is confirmed. Failed charges have `status: failed`, `failure_code`, `failure_message` and `outcome.type: issuer_declined` with the decline code in `outcome.reason`. `payment_method_details.card` describes the card, including `three_d_secure` when the customer authenticated.

### Customer Sessions

```bash
# Create customer session
curl -X POST http://localhost:4000/v1/customer_sessions \
  -d "customer=cus_xxx"
```

### Payment Methods

```bash
# Save a test card to a customer. pm_card_visa clones into a new pm_ owned by the customer
curl -X POST http://localhost:4000/v1/payment_methods/pm_card_visa/attach -d "customer=cus_xxx"

# Create an unattached card from a test token or a test card number
curl -X POST http://localhost:4000/v1/payment_methods -d "type=card" -d "card[token]=tok_visa"
curl -X POST http://localhost:4000/v1/payment_methods -d "type=card" \
  -d "card[number]=4000000000000341" -d "card[exp_month]=12" -d "card[exp_year]=2030"

# Retrieve, update (metadata, billing_details, allow_redisplay) and detach (permanent)
curl http://localhost:4000/v1/payment_methods/pm_xxx
curl -X POST http://localhost:4000/v1/payment_methods/pm_xxx -d "metadata[nickname]=work"
curl -X POST http://localhost:4000/v1/payment_methods/pm_xxx/detach

# List, filtered by customer and type
curl "http://localhost:4000/v1/payment_methods?customer=cus_xxx&type=card"
curl http://localhost:4000/v1/customers/cus_xxx/payment_methods
```

```typescript
// Create a customer with a saved default card in one call
const customer = await stripe.customers.create({
  email: 'jenny@example.com',
  payment_method: 'pm_card_visa',
  invoice_settings: { default_payment_method: 'pm_card_visa' },
})
// customer.invoice_settings.default_payment_method is the new pm_ id

// Or set the default later, for a card already attached to the customer
await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } })
```

Test cards follow [Stripe's testing docs](https://docs.stripe.com/testing):

| Card | Behaviour |
|------|-----------|
| `pm_card_visa`, `pm_card_visa_debit`, `pm_card_mastercard`, `pm_card_amex` | Succeed |
| `pm_card_chargeDeclined`, `pm_card_visa_chargeDeclinedInsufficientFunds`, `pm_card_visa_chargeDeclinedLostCard`, `pm_card_visa_chargeDeclinedStolenCard`, `pm_card_chargeDeclinedExpiredCard`, `pm_card_chargeDeclinedIncorrectCvc`, `pm_card_chargeDeclinedProcessingError`, `pm_card_visa_chargeDeclinedVelocityLimitExceeded` | Issuer declines. Attaching returns a 402 `card_error` with `code` and `decline_code`, and stores nothing |
| `pm_card_chargeCustomerFail` (4000000000000341) | Attaches, later charges fail |
| `pm_card_authenticationRequired` (3184) | Needs 3D Secure on every charge |
| `pm_card_authenticationRequiredOnSetup` (3155) | Needs 3D Secure on setup and on-session charges |
| `pm_card_authenticationRequiredChargeDeclinedInsufficientFunds` (3178) | Needs 3D Secure, then declines |
| 4242424242424241 | Rejected at creation with `incorrect_number` |

Other card numbers are rejected. Setting a default payment method that is not attached to the customer returns a 400 with `param: "invoice_settings[default_payment_method]"`. Confirming a PaymentIntent does not apply card declines or 3D Secure yet.

## Webhooks

The emulator records a Stripe Event object for every state change and delivers it to each webhook endpoint subscribed to that type or to `*`. Register endpoints via seed config or `POST /v1/webhook_endpoints`. Delivery happens before the API call that caused it returns, and failed deliveries are not retried.

Endpoints configured with a `secret` include `Stripe-Signature: t=<timestamp>,v1=<signature>`, an HMAC SHA-256 over `<timestamp>.<raw body>`, so `stripe.webhooks.constructEvent` verifies them.

Each delivery is a full Event:

- `id` (`evt_...`), `object: "event"`, `api_version` (`2026-10-28.endive` unless the seed sets `api_version`), `created`, `livemode: false`, `type`.
- `data.object` is a snapshot of the object, and `*.updated` events add `data.previous_attributes` with the old value of each changed field. An update that changes nothing sends no event.
- `request.id` is the `Request-Id` of the API call that caused the event, and `request.idempotency_key` echoes its `Idempotency-Key` header. Both are `null` for events no API call caused, such as completing the hosted checkout page.
- `pending_webhooks` is the number of endpoints the event was sent to. `GET /v1/events/:id` shows how many have not answered 2xx yet.

### Delivery chaos

Delivery is inline, sequential and in order by default, with no automatic retries. To test idempotent and order-independent handlers, turn on chaos with the emulator-only control routes:

```bash
# Drop 20% of events, hold payment_intent.succeeded until flush, send charge.succeeded twice, shuffle batches
curl -X POST http://localhost:4000/_stripe/webhooks/chaos \
  -H "Content-Type: application/json" \
  -d '{"seed": 42, "drop": {"rate": 0.2}, "delay": {"types": ["payment_intent.succeeded"]}, "duplicate": {"types": ["charge.succeeded"]}, "reorder": "shuffle"}'

curl http://localhost:4000/_stripe/webhooks/chaos               # current settings
curl -X DELETE http://localhost:4000/_stripe/webhooks/chaos     # back to normal delivery

# Release held events (optionally only some, in held, reverse or shuffled order)
curl -X POST http://localhost:4000/_stripe/webhooks/flush \
  -H "Content-Type: application/json" -d '{"order": "reverse"}'

# Every attempt: succeeded, failed, dropped or held
curl "http://localhost:4000/_stripe/webhooks/deliveries?status=dropped"

# Send a stored event again (for example one that was dropped)
curl -X POST http://localhost:4000/_stripe/events/evt_xxx/redeliver
```

`rate` is a probability from 0 to 1 (default 1) and `types` accepts `*` wildcards (default every type). Duplicates reuse the same `evt_` id. The same `seed` makes the same decisions in every fresh emulator, and the generator state and held events survive a snapshot and restore.

### Events dispatched

| Event | Trigger |
|-------|---------|
| `customer.created` | Customer created |
| `customer.updated` | Customer updated |
| `customer.deleted` | Customer deleted |
| `payment_method.attached` | Payment method attached (also by `payment_method` on customer create) |
| `payment_method.detached` | Payment method detached |
| `payment_method.updated` | Payment method updated |
| `product.created` | Product created |
| `price.created` | Price created |
| `payment_intent.created` | Payment intent created |
| `payment_intent.requires_action` | Confirmation needs 3D Secure |
| `payment_intent.succeeded` | Payment intent confirmed and charged |
| `payment_intent.payment_failed` | Card declined, `authentication_required` off-session, or 3D Secure failed |
| `payment_intent.canceled` | Payment intent canceled |
| `setup_intent.created` | SetupIntent created |
| `setup_intent.requires_action` | Setup needs 3D Secure |
| `setup_intent.succeeded` | Card saved (after `payment_method.attached` when there is a customer) |
| `setup_intent.setup_failed` | Card declined at setup, or 3D Secure failed |
| `setup_intent.canceled` | SetupIntent canceled |
| `charge.succeeded` | Payment intent charged (charge auto-created) |
| `charge.failed` | Charge declined |
| `invoice.created` | Invoice created as a draft |
| `invoice.updated` | Invoice fields or lines changed, or a payment attempt succeeded or failed |
| `invoice.deleted` | Draft invoice deleted |
| `invoice.finalized` | Invoice finalized (after `payment_intent.created` when something is due) |
| `invoice.paid` | Invoice paid, including $0 invoices and `paid_out_of_band` |
| `invoice.payment_succeeded` | Invoice paid by its PaymentIntent |
| `invoice.payment_failed` | Payment attempt declined or waiting on 3D Secure |
| `invoice.payment_action_required` | Payment attempt needs 3D Secure |
| `invoice.voided` | Invoice voided |
| `invoice.marked_uncollectible` | Invoice marked uncollectible |
| `invoice_payment.paid` | The invoice's InvoicePayment was paid |
| `invoiceitem.created` | Invoice item created |
| `invoiceitem.deleted` | Invoice item deleted |
| `checkout.session.completed` | Checkout completed via hosted page |
| `checkout.session.expired` | Checkout session expired |

### Webhook handler example

```typescript
// app/api/webhooks/stripe/route.ts
import { NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe'

export async function POST(request: Request) {
  const body = await request.text()
  const signature = request.headers.get('stripe-signature')!
  const evt = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!)
  const event = evt.type
  const obj = evt.data.object as any

  switch (event) {
    case 'customer.created':
      console.log('Customer created:', obj.id, obj.email)
      break
    case 'checkout.session.completed':
      console.log('Checkout completed:', obj.id)
      break
    case 'payment_intent.succeeded':
      console.log('Payment succeeded:', obj.id)
      break
    case 'charge.succeeded':
      console.log('Charge succeeded:', obj.id)
      break
  }

  return NextResponse.json({ received: true })
}
```

## Common Patterns

### Checkout Flow (embedded Next.js)

```typescript
// Server action
const customer = await stripe.customers.create({
  email: 'shopper@example.com',
  name: 'Demo Shopper',
})

const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  customer: customer.id,
  line_items: [{ price: 'price_widget', quantity: 2 }],
  success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${origin}/cart`,
})

redirect(session.url!)
```

### Retrieve Session on Success Page

```typescript
const session = await stripe.checkout.sessions.retrieve(session_id)
const customer = await stripe.customers.retrieve(session.customer as string)

console.log(session.payment_status) // 'paid'
console.log(customer.name)          // 'Demo Shopper'
```

### Payment Intent Flow (no checkout UI)

```typescript
const pi = await stripe.paymentIntents.create({
  amount: 5000,
  currency: 'usd',
  customer: 'cus_xxx',
})

// Confirm triggers payment_intent.succeeded + charge.succeeded webhooks
const confirmed = await stripe.paymentIntents.confirm(pi.id)
console.log(confirmed.status) // 'succeeded'
```

## Custom emulators alongside built-ins

Use `npx emulate init --custom inventory` to scaffold a third-party API emulator and test. Register it in `emulate.config.ts` with `defineConfig` from `emulate`, alongside built-in entries such as `{ emulator: "stripe" }`. Run `npx emulate start --watch` to reload imports and inspect custom state at the printed `/_emulate` URL. Successful reloads reset the run to seed. Existing flat seed configs still work; `--config` selects an explicit file. For authoring and testing third-party API emulators, see https://emulate.dev/docs/custom-emulators.
