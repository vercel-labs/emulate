---
name: stripe
description: Emulated Stripe API for local development and testing. Use when the user needs to process payments locally, test checkout flows, create customers, manage products and prices, handle payment intents, work with webhooks, or use the Stripe SDK without hitting real Stripe servers. Triggers include "Stripe API", "emulate Stripe", "test payments locally", "checkout flow", "payment intent", "Stripe webhook", "Stripe SDK", "STRIPE_API_KEY", or any task requiring a local Stripe API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Stripe API Emulator

Fully stateful Stripe API emulation. Customers, products, prices, checkout sessions, payment intents, charges, and payment methods persist in memory. Webhooks fire on state changes. The hosted checkout UI lets you complete payments in the browser.

No real payments are processed. Every Stripe SDK call hits the emulator and produces realistic responses.

## Start

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
```

The `product_name` field in prices links to the product by name. Use `events: ['*']` to receive all webhook events, or specify individual event types.

## API Endpoints

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

# Cancel
curl -X POST http://localhost:4000/v1/payment_intents/pi_xxx/cancel

# List
curl http://localhost:4000/v1/payment_intents
```

### Charges

```bash
# Retrieve charge
curl http://localhost:4000/v1/charges/ch_xxx

# List charges
curl http://localhost:4000/v1/charges
```

Charges are created automatically when a payment intent is confirmed.

### Customer Sessions

```bash
# Create customer session
curl -X POST http://localhost:4000/v1/customer_sessions \
  -d "customer=cus_xxx"
```

### Payment Methods

```bash
# List payment methods
curl http://localhost:4000/v1/payment_methods
```

## Webhooks

The emulator dispatches webhook events when state changes. Register webhooks via seed config or programmatically.

### Events dispatched

| Event | Trigger |
|-------|---------|
| `customer.created` | Customer created |
| `customer.updated` | Customer updated |
| `customer.deleted` | Customer deleted |
| `product.created` | Product created |
| `price.created` | Price created |
| `payment_intent.created` | Payment intent created |
| `payment_intent.succeeded` | Payment intent confirmed |
| `payment_intent.canceled` | Payment intent canceled |
| `charge.succeeded` | Payment intent confirmed (charge auto-created) |
| `checkout.session.completed` | Checkout completed via hosted page |
| `checkout.session.expired` | Checkout session expired |

### Webhook handler example

```typescript
// app/api/webhooks/stripe/route.ts
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const body = await request.json()
  const event = body.type as string
  const obj = body.data?.object

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
