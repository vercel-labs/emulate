---
name: stripe
description: Emulated Stripe API for local development and testing. Use when the user needs to process payments locally, test checkout flows, manage customers/products/prices, create payment intents, handle webhooks, or work with the Stripe API without hitting the real Stripe API. Triggers include "Stripe API", "emulate Stripe", "mock Stripe", "test payments", "checkout flow", "payment intent", "STRIPE_API_BASE", or any task requiring a local payments API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Stripe API Emulator

Fully stateful Stripe API emulation with customers, products, prices, payment intents, charges, checkout sessions, and webhooks. State changes dispatch webhook events to configured URLs.

Request bodies can be JSON or form-urlencoded (the Stripe SDK default). All responses match the Stripe API object format with `livemode: false`.

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

## Auth

Pass any `sk_test_*` or `sk_live_*` token as `Authorization: Bearer <token>`. The emulator accepts all tokens without validation.

```bash
curl http://localhost:4000/v1/customers \
  -H "Authorization: Bearer sk_test_emulate"
```

## Pointing Your App at the Emulator

### Stripe Node.js SDK

The Stripe SDK accepts a custom `apiBase` in the constructor config:

```typescript
import Stripe from 'stripe'

const stripe = new Stripe('sk_test_emulate', {
  apiVersion: '2024-12-18.acacia',
  httpClient: Stripe.createFetchHttpClient(),
  host: 'localhost',
  port: 4000,
  protocol: 'http',
})
```

### Environment Variable

Set `STRIPE_API_BASE` if your SDK wrapper reads it:

```bash
STRIPE_API_BASE=http://localhost:4000
```

### Embedded in Next.js (adapter-next)

```typescript
// next.config.ts
import { withEmulate } from '@emulators/adapter-next'

export default withEmulate({
  env: {
    STRIPE_API_BASE: `http://localhost:${process.env.PORT ?? '3000'}/emulate/stripe`,
  },
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
        customers: [{ email: 'test@example.com', name: 'Test User' }],
        products: [{ name: 'Pro Plan', description: 'Monthly subscription' }],
        prices: [{ product_name: 'Pro Plan', currency: 'usd', unit_amount: 2000 }],
      },
    },
  },
})
```

### Direct fetch

```typescript
await fetch('http://localhost:4000/v1/customers', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': 'Bearer sk_test_emulate',
  },
  body: new URLSearchParams({ email: 'user@example.com', name: 'Jane' }),
})
```

## Seed Config

```yaml
stripe:
  customers:
    - email: test@example.com
      name: Test Customer
    - email: premium@example.com
      name: Premium User
  products:
    - name: Starter
      description: Free tier
    - name: Pro Plan
      description: Monthly subscription
  prices:
    - product_name: Pro Plan
      currency: usd
      unit_amount: 2000
```

Without seed config, the emulator creates one default customer (test@example.com).

## API Endpoints

### Customers

```bash
TOKEN="sk_test_emulate"
BASE="http://localhost:4000"

# Create customer
curl -X POST $BASE/v1/customers \
  -H "Authorization: Bearer $TOKEN" \
  -d "email=user@example.com" -d "name=Jane Doe"

# Get customer
curl $BASE/v1/customers/<id> \
  -H "Authorization: Bearer $TOKEN"

# Update customer
curl -X POST $BASE/v1/customers/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -d "name=Updated Name"

# Delete customer
curl -X DELETE $BASE/v1/customers/<id> \
  -H "Authorization: Bearer $TOKEN"

# List customers
curl $BASE/v1/customers \
  -H "Authorization: Bearer $TOKEN"
```

### Products

```bash
# Create product
curl -X POST $BASE/v1/products \
  -H "Authorization: Bearer $TOKEN" \
  -d "name=Pro Plan" -d "description=Monthly subscription"

# Get product
curl $BASE/v1/products/<id> \
  -H "Authorization: Bearer $TOKEN"

# List products
curl $BASE/v1/products \
  -H "Authorization: Bearer $TOKEN"
```

### Prices

```bash
# Create price (must reference an existing product)
curl -X POST $BASE/v1/prices \
  -H "Authorization: Bearer $TOKEN" \
  -d "product=prod_xxx" -d "currency=usd" -d "unit_amount=2000"

# Get price
curl $BASE/v1/prices/<id> \
  -H "Authorization: Bearer $TOKEN"

# List prices
curl $BASE/v1/prices \
  -H "Authorization: Bearer $TOKEN"
```

### Payment Intents

```bash
# Create payment intent
curl -X POST $BASE/v1/payment_intents \
  -H "Authorization: Bearer $TOKEN" \
  -d "amount=2000" -d "currency=usd"

# Get payment intent (supports ?expand[]=customer)
curl "$BASE/v1/payment_intents/<id>?expand[]=customer" \
  -H "Authorization: Bearer $TOKEN"

# Update payment intent
curl -X POST $BASE/v1/payment_intents/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -d "amount=3000"

# Confirm payment intent
curl -X POST $BASE/v1/payment_intents/<id>/confirm \
  -H "Authorization: Bearer $TOKEN" \
  -d "payment_method=pm_card_visa"

# Cancel payment intent
curl -X POST $BASE/v1/payment_intents/<id>/cancel \
  -H "Authorization: Bearer $TOKEN"

# List payment intents
curl $BASE/v1/payment_intents \
  -H "Authorization: Bearer $TOKEN"
```

Payment intent states: `requires_payment_method` -> `requires_confirmation` -> `succeeded` (after confirm with payment_method). Confirming creates a charge automatically.

### Charges

```bash
# Get charge (supports ?expand[]=customer,payment_intent)
curl "$BASE/v1/charges/<id>?expand[]=customer" \
  -H "Authorization: Bearer $TOKEN"

# List charges
curl $BASE/v1/charges \
  -H "Authorization: Bearer $TOKEN"
```

Charges are created automatically when a payment intent is confirmed. They cannot be created directly.

### Checkout Sessions

```bash
# Create checkout session
curl -X POST $BASE/v1/checkout/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -d "mode=payment" \
  -d "success_url=http://localhost:3000/success" \
  -d "cancel_url=http://localhost:3000/cancel" \
  -d "line_items[0][price]=price_xxx" \
  -d "line_items[0][quantity]=1"

# Get checkout session
curl $BASE/v1/checkout/sessions/<id> \
  -H "Authorization: Bearer $TOKEN"

# List checkout sessions
curl $BASE/v1/checkout/sessions \
  -H "Authorization: Bearer $TOKEN"

# Expire a checkout session
curl -X POST $BASE/v1/checkout/sessions/<id>/expire \
  -H "Authorization: Bearer $TOKEN"
```

Checkout modes: `payment`, `setup`, `subscription`.

### Checkout UI

Open sessions have a browser-viewable checkout page:

```
http://localhost:4000/checkout/<session_id>
```

Completing checkout through the UI transitions the session to `complete` with `payment_status: paid` and dispatches `checkout.session.completed`.

### Customer Sessions

```bash
# Create customer session (requires existing customer)
curl -X POST $BASE/v1/customer_sessions \
  -H "Authorization: Bearer $TOKEN" \
  -d "customer=cus_xxx"
```

### Payment Methods

```bash
# List payment methods (optionally filter by customer)
curl "$BASE/v1/payment_methods?customer=cus_xxx" \
  -H "Authorization: Bearer $TOKEN"
```

## Webhooks

The emulator dispatches webhook events when state changes:

- `customer.created`, `customer.updated`, `customer.deleted`
- `product.created`
- `price.created`
- `payment_intent.created`, `payment_intent.succeeded`, `payment_intent.canceled`
- `charge.succeeded`
- `checkout.session.completed`, `checkout.session.expired`

## Common Patterns

### Full Checkout Flow

```bash
TOKEN="sk_test_emulate"
BASE="http://localhost:4000"

# 1. Create a product and price
PRODUCT=$(curl -s -X POST $BASE/v1/products \
  -H "Authorization: Bearer $TOKEN" \
  -d "name=Widget" | jq -r '.id')

PRICE=$(curl -s -X POST $BASE/v1/prices \
  -H "Authorization: Bearer $TOKEN" \
  -d "product=$PRODUCT" -d "currency=usd" -d "unit_amount=999" | jq -r '.id')

# 2. Create checkout session
SESSION=$(curl -s -X POST $BASE/v1/checkout/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -d "mode=payment" \
  -d "success_url=http://localhost:3000/success" \
  -d "cancel_url=http://localhost:3000/cancel" \
  -d "line_items[0][price]=$PRICE" \
  -d "line_items[0][quantity]=1" | jq -r '.id')

# 3. Complete via UI or API
curl -s -X POST $BASE/checkout/$SESSION/complete \
  -H "Authorization: Bearer $TOKEN"
```

### Payment Intent with Confirmation

```typescript
import { createEmulator } from 'emulate'
import Stripe from 'stripe'

const emu = await createEmulator({ service: 'stripe', port: 4000 })

const stripe = new Stripe('sk_test_emulate', {
  httpClient: Stripe.createFetchHttpClient(),
  host: 'localhost',
  port: 4000,
  protocol: 'http',
})

const pi = await stripe.paymentIntents.create({
  amount: 2000,
  currency: 'usd',
})
// pi.status === 'requires_payment_method'

const confirmed = await stripe.paymentIntents.confirm(pi.id, {
  payment_method: 'pm_card_visa',
})
// confirmed.status === 'succeeded'
```
