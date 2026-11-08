---
name: stripe
description: Emulated Stripe API for local development and testing, covering payments and Stripe Billing. Use when the user needs to process payments locally, test checkout flows, create customers, manage products and prices, handle payment or setup intents, run subscriptions (trials, renewals, cancellations, pausing), invoices, failed-payment retries and dunning, metered or usage-based billing with meters and meter events, the customer portal, test clocks, webhooks, or use the Stripe SDK without hitting real Stripe servers. Triggers include "Stripe API", "emulate Stripe", "test payments locally", "checkout flow", "payment intent", "Stripe subscription", "Stripe invoice", "free trial", "test clock", "subscription renewal", "metered billing", "usage-based billing", "billing meter", "dunning", "customer portal", "Stripe webhook", "Stripe SDK", "STRIPE_API_KEY", or any task requiring a local Stripe API.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Stripe API Emulator

Fully stateful Stripe API emulation for payments and Billing. Customers, payment methods (Stripe's test cards), payment intents, setup intents, charges, products, prices (recurring, tiered, metered), subscriptions, invoices, test clocks, billing meters, Checkout Sessions and customer portal sessions persist in memory. Every state change becomes a signed Stripe Event delivered to your webhook endpoints. Hosted checkout, invoice and portal pages let you complete flows in the browser or with a plain form POST.

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
  apiVersion: '2026-10-28.endive', // the shapes the emulator serves
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
  apiVersion: '2026-10-28.endive', // the shapes the emulator serves
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
  test_clocks:            # seeded before customers
    - id: clock_demo
      frozen_time: 1768478400
  customers:
    - id: cus_demo
      email: demo@example.com
      name: Demo User
      payment_method: pm_card_visa          # attached as a new pm_
      invoice_settings:
        default_payment_method: pm_card_visa # the card above becomes the invoice default
      test_clock: clock_demo                 # optional, by id or name
  meters:                 # seeded before prices; default_aggregation defaults to sum
    - id: mtr_test_api_calls
      display_name: API calls
      event_name: api_calls
  products:
    - id: prod_tshirt
      name: T-Shirt
      description: A comfortable tee
  prices:
    - id: price_tshirt
      product: T-Shirt          # product name or id
      currency: usd
      unit_amount: 2500
    - id: price_tshirt_club
      product: prod_tshirt
      currency: usd
      unit_amount: 900
      lookup_key: tshirt_club_monthly
      recurring:
        interval: month       # day, week, month or year
    - product: T-Shirt
      currency: usd
      recurring:
        interval: month
        usage_type: metered
        meter: api_calls      # a meter id or the event_name of an active meter
      tiers_mode: graduated   # tiers without billing_scheme make a tiered price
      tiers:
        - up_to: 1000
          unit_amount: 0
        - up_to: inf
          unit_amount: 2
  webhooks:
    - url: http://localhost:3000/api/webhooks/stripe
      events: ['*']
      secret: whsec_test
  webhook_chaos:          # optional, see "Delivery chaos" below
    seed: 42
    reorder: reverse
  billing:                # optional, also at /_stripe/billing/settings
    upcoming_renewal_days: 3   # 0 turns invoice.upcoming off
    retry_schedule_days: [3, 5, 7]   # days after the previous attempt, at most 3 retries
    after_retries:
      subscription: cancel   # cancel, unpaid, past_due or pause
      invoice: open          # open or uncollectible
```

The `product` field in prices links to a seeded product by name or id (the older `product_name` key still works). Seeded prices take the same params as `POST /v1/prices` and an invalid one stops the seed with an error. Use `events: ['*']` to receive all webhook events, or specify individual event types. Seeded webhooks are also listed by `GET /v1/webhook_endpoints`.

## API Endpoints

Every `/v1` response includes a `Request-Id: req_...` header. Retrieve, create and list calls accept `expand` in any of the forms Stripe accepts: `expand[]=customer`, stripe-node's indexed `expand[0]=customer`, or an `expand` array in a POST body. Dotted paths work through objects and lists, up to four levels:

```typescript
const pi = await stripe.paymentIntents.retrieve('pi_xxx', { expand: ['customer'] })
const charges = await stripe.charges.list({ expand: ['data.payment_intent.customer'] })
// Includable lists: a customer's current (not canceled) subscriptions, for an entitlement check
const customer = await stripe.customers.retrieve('cus_xxx', { expand: ['subscriptions'] })
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

# List customers (customers on a test clock only with test_clock=clock_xxx)
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
# Create a one-time price
curl -X POST http://localhost:4000/v1/prices \
  -d "product=prod_xxx" -d "currency=usd" -d "unit_amount=1000"

# A monthly price with a lookup key (transfer_lookup_key=true moves a key already in use)
curl -X POST http://localhost:4000/v1/prices \
  -d "product=prod_xxx" -d "currency=usd" -d "unit_amount=1000" \
  -d "recurring[interval]=month" -d "lookup_key=pro_monthly"

# A graduated tiered price; tiers are includable, so expand them to see them
curl -X POST http://localhost:4000/v1/prices \
  -d "product=prod_xxx" -d "currency=usd" -d "recurring[interval]=month" \
  -d "billing_scheme=tiered" -d "tiers_mode=graduated" \
  -d "tiers[0][up_to]=1000" -d "tiers[0][unit_amount]=0" \
  -d "tiers[1][up_to]=inf" -d "tiers[1][unit_amount]=2" -d "expand[]=tiers"

# Price and product in one call
curl -X POST http://localhost:4000/v1/prices \
  -d "currency=usd" -d "unit_amount=1000" -d "product_data[name]=Gold Plan"

# Retrieve price
curl "http://localhost:4000/v1/prices/price_xxx?expand[]=product"

# List prices (active, currency, product, type, lookup_keys[], recurring[interval])
curl "http://localhost:4000/v1/prices?active=true"
curl "http://localhost:4000/v1/prices?lookup_keys[]=pro_monthly&lookup_keys[]=pro_yearly"
curl "http://localhost:4000/v1/prices?type=recurring&recurring[interval]=month"
```

Prices use the current wire shape: `billing_scheme`, `recurring` (`interval`, `interval_count`, `meter`, `trial_period_days`, `usage_type`), `lookup_key`, `nickname`, `tax_behavior` (default `unspecified`), `tiers_mode`, `transform_quantity`, `unit_amount_decimal` and `custom_unit_amount` (`null`). A bad `recurring[interval]` answers 400 with that param. Metered prices (`recurring[usage_type]=metered`) need `recurring[meter]`, an active billing meter. Their subscription items and Checkout lines have `quantity: null`, and sending a quantity for one answers 400.

### Billing Meters and usage

```bash
# A meter (mtr_test_...). customer_mapping and value_settings default to stripe_customer_id and value
curl -X POST http://localhost:4000/v1/billing/meters \
  -d "display_name=API calls" -d "event_name=api_calls" -d "default_aggregation[formula]=sum"

# A metered graduated price on it
curl -X POST http://localhost:4000/v1/prices \
  -d "product=prod_xxx" -d "currency=usd" \
  -d "recurring[interval]=month" -d "recurring[usage_type]=metered" -d "recurring[meter]=mtr_test_xxx" \
  -d "billing_scheme=tiered" -d "tiers_mode=graduated" \
  -d "tiers[0][up_to]=1000" -d "tiers[0][unit_amount]=0" -d "tiers[1][up_to]=inf" -d "tiers[1][unit_amount]=2"

# Report usage (no id in the response; identifier is generated when absent, timestamp defaults to now)
curl -X POST http://localhost:4000/v1/billing/meter_events \
  -d "event_name=api_calls" -d "payload[value]=25" -d "payload[stripe_customer_id]=cus_xxx" -d "identifier=req_123"

# Cancel an event received in the last 24 hours
curl -X POST http://localhost:4000/v1/billing/meter_event_adjustments \
  -d "event_name=api_calls" -d "type=cancel" -d "cancel[identifier]=req_123"

# Aggregated usage for one customer (times aligned to the minute; hour or day buckets, newest first)
curl "http://localhost:4000/v1/billing/meters/mtr_test_xxx/event_summaries?customer=cus_xxx&start_time=1767225600&end_time=1767312000&value_grouping_window=hour"

# Rename, deactivate (rejects new events), reactivate, list by status
curl -X POST http://localhost:4000/v1/billing/meters/mtr_test_xxx -d "display_name=Calls"
curl -X POST http://localhost:4000/v1/billing/meters/mtr_test_xxx/deactivate
curl -X POST http://localhost:4000/v1/billing/meters/mtr_test_xxx/reactivate
curl "http://localhost:4000/v1/billing/meters?status=active"
```

Meter events are validated at once and a problem answers 400 with the code Stripe would put in its error report: `no_meter`, `archived_meter`, `meter_event_no_customer_defined`, `meter_event_customer_not_found`, `meter_event_value_not_found` (no value in the payload of a `sum` or `last` meter), `meter_event_invalid_value` (the value is not a number; decimals such as `2.5` and negatives are accepted), `timestamp_in_future` (over 5 minutes ahead), `timestamp_too_far_in_past` (over 35 days back) or `duplicate_meter_event` (identifier seen in the last 24 hours). Times are read on the customer's test clock. Each `subscription_cycle` invoice bills licensed items in advance and metered items in arrears for the period that ended, from the customer's usage with a timestamp inside it. Usage is summed when the invoice finalizes, an hour after the draft, so late events for the old period still count. Decimal totals show in the line's `quantity_decimal`, with `quantity` truncated. Negative totals bill 0, trial usage is never billed and the first invoice has no metered charge.

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

# A subscription with a 7 day trial (line_items needs at least one recurring price)
curl -X POST http://localhost:4000/v1/checkout/sessions \
  -d "mode=subscription" \
  -d "line_items[0][price]=price_monthly" \
  -d "line_items[0][quantity]=1" \
  -d "subscription_data[trial_period_days]=7" \
  -d "payment_method_collection=if_required" \
  -d "success_url=http://localhost:3000/welcome?session_id={CHECKOUT_SESSION_ID}"

# Line items are includable, or listed on their own
curl "http://localhost:4000/v1/checkout/sessions/cs_test_xxx?expand[]=line_items&expand[]=subscription"
curl http://localhost:4000/v1/checkout/sessions/cs_test_xxx/line_items

# Complete the hosted page without a browser: a test card id, or "none" for a trial without a card
curl -X POST http://localhost:4000/checkout/cs_test_xxx/complete \
  -d "payment_method=pm_card_visa" -d "email=buyer@example.com"
```

The session's `url` field points to a hosted checkout page at `/checkout/cs_test_xxx`, where a select picks the test card. Paying completes the session, fires the `checkout.session.completed` webhook last, and redirects to `success_url`. The `{CHECKOUT_SESSION_ID}` template in `success_url` is replaced with the actual session ID.

In `subscription` mode the page creates the customer and the subscription, with the card as the subscription's `default_payment_method` (the customer's invoice default stays unset). A trial saves the card through a SetupIntent and starts `trialing`; without a trial the first invoice is charged and the subscription turns `active`. The completed session has `customer`, `subscription` and `invoice` ids and `payment_status: "paid"`. In `payment` mode the page charges a PaymentIntent and sets `payment_intent`. A declined card (such as `pm_card_chargeDeclined`) re-renders the page with status 402 and keeps nothing, so no subscription exists. 3D Secure cards are approved on the page. `payment_method_types` is ignored.

### Customer Portal

```bash
# A portal session (bps_...) on the default configuration (bpc_...); its url is the portal page
curl -X POST http://localhost:4000/v1/billing_portal/sessions \
  -d "customer=cus_xxx" -d "return_url=http://localhost:3000/account"

# Deep link straight into one step, then go somewhere after it
curl -X POST http://localhost:4000/v1/billing_portal/sessions \
  -d "customer=cus_xxx" -d "flow_data[type]=payment_method_update"
curl -X POST http://localhost:4000/v1/billing_portal/sessions \
  -d "customer=cus_xxx" -d "flow_data[type]=subscription_cancel" \
  -d "flow_data[subscription_cancel][subscription]=sub_xxx" \
  -d "flow_data[after_completion][type]=redirect" \
  -d "flow_data[after_completion][redirect][return_url]=http://localhost:3000/bye"

# The configuration
curl http://localhost:4000/v1/billing_portal/configurations

# Drive the page without a browser: cancel at period end (with feedback), renew,
# save a new default card, pay an open invoice
curl -X POST http://localhost:4000/billing_portal/bps_xxx/subscriptions/sub_xxx/cancel -d "feedback=too_expensive"
curl -X POST http://localhost:4000/billing_portal/bps_xxx/subscriptions/sub_xxx/renew
curl -X POST http://localhost:4000/billing_portal/bps_xxx/payment_method -d "payment_method=pm_card_visa"
curl -X POST http://localhost:4000/billing_portal/bps_xxx/invoices/in_xxx/pay
```

The page lists the customer's current subscriptions, default card and invoices. Canceling sets `cancel_at_period_end` with `cancellation_details.reason` `cancellation_requested` and sends `customer.subscription.updated`; renewing undoes it and clears `cancellation_details`, as `cancel_at_period_end=false` does through the API. A new card is saved through a SetupIntent (`setup_intent.succeeded`, `payment_method.attached`) and becomes the customer's `invoice_settings.default_payment_method` (`customer.updated`). A subscription with a `default_payment_method` of its own (as Checkout creates) loses that override, which turns `null` so the subscription falls back to the new card (`customer.subscription.updated` with `previous_attributes.default_payment_method`). Paying the open invoice of a `past_due` subscription sends `invoice.paid` and makes it `active`. Portal events carry a `null` request. `flow_data[type]` may be `payment_method_update`, `subscription_cancel` or `subscription_update`; the session echoes it in `flow`, with `after_completion.type` defaulting to `portal_homepage`. `return_url` must be an absolute `http(s)` URL (otherwise 400 `Not a valid URL`). Session URLs never expire.

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

### Subscriptions

```bash
# Subscribe a customer whose default card is set; the first invoice is paid in the request
curl -X POST http://localhost:4000/v1/subscriptions \
  -d "customer=cus_xxx" -d "items[0][price]=price_xxx" -d "items[0][quantity]=1" \
  -d "expand[]=latest_invoice.confirmation_secret"

# A 7 day trial (no payment method needed), or collect payment client side first
curl -X POST http://localhost:4000/v1/subscriptions \
  -d "customer=cus_xxx" -d "items[0][price]=price_xxx" -d "trial_period_days=7"
curl -X POST http://localhost:4000/v1/subscriptions \
  -d "customer=cus_xxx" -d "items[0][price]=price_xxx" -d "payment_behavior=default_incomplete"

# Cancel at period end, end a trial now, change items, cancel at once
curl -X POST http://localhost:4000/v1/subscriptions/sub_xxx -d "cancel_at_period_end=true"
curl -X POST http://localhost:4000/v1/subscriptions/sub_xxx -d "trial_end=now"
curl -X POST http://localhost:4000/v1/subscriptions/sub_xxx \
  -d "items[0][id]=si_xxx" -d "items[0][quantity]=3" -d "items[1][price]=price_seat"
curl -X DELETE http://localhost:4000/v1/subscriptions/sub_xxx

# Pause (active or past_due only), then resume. The default payment_behavior finalizes a
# resumption invoice without charging it; resume_on_payment_success charges it at once
curl -X POST http://localhost:4000/v1/subscriptions/sub_xxx/pause
curl -X POST http://localhost:4000/v1/subscriptions/sub_xxx/resume -d "billing_cycle_anchor[type]=now"
curl -X POST http://localhost:4000/v1/subscriptions/sub_xxx/resume -d "payment_behavior=resume_on_payment_success"

# A cardless trial that pauses (or cancels) instead of invoicing when it ends without a card
curl -X POST http://localhost:4000/v1/subscriptions \
  -d "customer=cus_xxx" -d "items[0][price]=price_xxx" -d "trial_period_days=7" \
  -d "trial_settings[end_behavior][missing_payment_method]=pause"

# List (canceled ones only with status=canceled, ended or all) and manage items
curl "http://localhost:4000/v1/subscriptions?customer=cus_xxx&status=all"
curl -X POST http://localhost:4000/v1/subscription_items -d "subscription=sub_xxx" -d "price=price_seat"
curl "http://localhost:4000/v1/subscription_items?subscription=sub_xxx"
```

Subscriptions use the current wire shape: billing periods are `items.data[].current_period_start` and `current_period_end`, not top-level fields, and each item carries both `price` and the legacy `plan`. Creating one finalizes its first invoice (`billing_reason` `subscription_create`) and charges the subscription's `default_payment_method` or the customer's default card. A paid invoice makes it `active`; a decline (`pm_card_chargeCustomerFail`) or 3D Secure leaves it `incomplete` with the invoice `open`, and paying that invoice later activates it. `error_if_incomplete` answers 402 and stores nothing. A trial makes it `trialing` with a paid $0 invoice whose lines say "Free trial", and a trial under three days sends `customer.subscription.trial_will_end` at once. `send_invoice` subscriptions are `active` at once with an open invoice due after `days_until_due`. `DELETE` sets `canceled` with `cancellation_details.reason` `cancellation_requested` and sends only `customer.subscription.deleted`. Item and setting changes create no prorations. Swapping an item's price (`items[0][id]` with `items[0][price]`) keeps the period and bills the new price at renewal, but a change to another interval (monthly to yearly) restarts the cycle now and charges the full new period at once on a `subscription_update` invoice, with no credit for the old period. Billing time passes only for customers on a test clock: without one, trials and periods never roll over by themselves.

Pausing sets `status: "paused"` with `status_details.paused.subscription.type` `pause_requested`, ends the items' current period at the pause, and sends `customer.subscription.updated` and `customer.subscription.paused`. A paused subscription creates no invoices and can still be updated. `resume` answers 400 unless the subscription is paused. With `billing_cycle_anchor[type]=unchanged` it turns `active` at once with no invoice. With `now` (the default) it creates and finalizes a `subscription_update` resumption invoice for a new period starting now. Under `resume_on_payment_attempt` (the default) the subscription stays `paused`, with `pending_update.expires_at` 23 hours ahead, until you `/pay` that invoice: success makes it `active`, a failure `past_due`, and an unattempted invoice is voided on a test clock at `expires_at`, keeping it `paused`. Under `resume_on_payment_success` the invoice is charged in the call: success makes it `active`, a failure keeps it `paused` while the invoice is retried. Resuming sends `customer.subscription.updated` and `customer.subscription.resumed`. Usage recorded while paused is never billed.

### Test Clocks

```bash
# A clock frozen at a chosen time, and a customer on it with a default card
curl -X POST http://localhost:4000/v1/test_helpers/test_clocks \
  -d "frozen_time=1767225600" -d "name=Annual renewal"
curl -X POST http://localhost:4000/v1/customers \
  -d "test_clock=clock_xxx" -d "payment_method=pm_card_visa" \
  -d "invoice_settings[default_payment_method]=pm_card_visa"

# Advance (answers status=advancing with the old frozen_time; a GET right after shows ready)
curl -X POST http://localhost:4000/v1/test_helpers/test_clocks/clock_xxx/advance -d "frozen_time=1767830400"
curl http://localhost:4000/v1/test_helpers/test_clocks/clock_xxx

# Billing settings (emulator only): days before a renewal that invoice.upcoming is sent, 0 for never
curl http://localhost:4000/_stripe/billing/settings
curl -X POST http://localhost:4000/_stripe/billing/settings -d "upcoming_renewal_days=7"
# The retry schedule and what happens when the last retry fails
curl -X POST http://localhost:4000/_stripe/billing/settings \
  -d "retry_schedule_days[0]=1" -d "retry_schedule_days[1]=2" \
  -d "after_retries[subscription]=unpaid" -d "after_retries[invoice]=uncollectible"

# List the clock's objects, then delete the clock with its customers and their objects
curl "http://localhost:4000/v1/subscriptions?test_clock=clock_xxx"
curl -X DELETE http://localhost:4000/v1/test_helpers/test_clocks/clock_xxx
```

Everything created for a clock customer (subscriptions, invoices, payment methods, PaymentIntents) takes its times from the clock's `frozen_time`, so a subscription created with `trial_period_days=7` has `created`, `start_date` and `trial_start` equal to the frozen time. A clock holds at most 3 customers and each of them at most 3 subscriptions. One advance may move at most two intervals of the shortest subscription on the clock, or two years without subscriptions. Unfiltered `GET /v1/customers`, `/v1/subscriptions` and `/v1/invoices` leave clock objects out; pass `customer`, `subscription` (invoices) or `test_clock` to see them. Deleting a clock sends only `test_helpers.test_clock.deleted`.

Advancing runs Billing for the clock's customers, action by action in time order. Every event it raises has a `null` request and `created` set to the simulated time; `test_helpers.test_clock.ready` comes last. Webhook signatures stay on the wall clock, so `constructEvent` verifies them as usual.

| When | What happens |
|------|--------------|
| 3 days before `trial_end` | `customer.subscription.trial_will_end`; still `trialing` |
| `upcoming_renewal_days` (default 3) before a renewal | `invoice.upcoming` with an unsaved preview (no `id`, `billing_reason` `upcoming`). Not for `send_invoice` or a subscription ending then |
| `trial_end` | `active`, `billing_cycle_anchor` = `trial_end`, item periods roll; `customer.subscription.updated` (previous `status`, `items`, `latest_invoice`) and `invoice.created` for a `subscription_cycle` draft |
| `trial_end` with no default payment method | `trial_settings.end_behavior.missing_payment_method`: `create_invoice` (default) invoices as above, and the attempt an hour later fails (`invoice.payment_failed`, `past_due`); `cancel` sends `customer.subscription.deleted` and creates no invoice; `pause` sends `customer.subscription.updated` and `customer.subscription.paused` (`trial_end_without_payment_method`) and creates no invoice |
| `pending_update.expires_at` of a paused subscription | The unpaid resumption invoice is voided; the subscription stays `paused` |
| Each `current_period_end` | Item periods roll on the anchor's calendar; `customer.subscription.updated` and a new `subscription_cycle` draft |
| `cancel_at` (also `cancel_at_period_end`) | `customer.subscription.deleted`, `ended_at` = that time. With metered items, then a final `subscription_cycle` draft for the usage of the period that ended, collected an hour later; otherwise no invoice |
| 1 hour after a draft (`automatically_finalizes_at`) | Finalized and charged: `invoice.finalized`, `invoice.paid`, `invoice.payment_succeeded`. A decline leaves it `open` with `next_payment_attempt` set, the subscription `past_due` and the customer `delinquent` |
| `next_payment_attempt` | A retry with the payment method the invoice would use now. Each failure sends `invoice.payment_failed` with a higher `attempt_count` |
| After the last retry fails | `after_retries`: `cancel` (`customer.subscription.deleted`, reason `payment_failed`), `unpaid`, `past_due` or `pause` (`customer.subscription.paused`, `status_details.paused.subscription.type` `final_payment_failure`); the invoice stays `open` or turns `uncollectible` (reason `max_payment_attempts`) |
| 23 hours after an `incomplete` subscription was created | `incomplete_expired` and its first invoice voided. That invoice is never retried |

Hard declines (`lost_card`, `stolen_card`, `incorrect_number` and the others Stripe lists) keep the retries scheduled and counted, but they make no charge until the default payment method changes. A renewal that needs 3D Secure leaves the PaymentIntent `requires_action` and sends `invoice.payment_action_required` and `invoice.payment_failed`; `POST /_stripe/simulate/payment_intents/:id/authenticate` pays it. Paying, voiding or marking uncollectible the latest invoice makes a `past_due` or `unpaid` subscription `active` again.

```typescript
// Dunning: a renewal declined by 0341, retried on 3, 5 and 7 days, then canceled
const customer = await stripe.customers.create({ test_clock: clock.id, payment_method: 'pm_card_chargeCustomerFail',
  invoice_settings: { default_payment_method: 'pm_card_chargeCustomerFail' } })
await stripe.subscriptions.create({ customer: customer.id, items: [{ price }], trial_period_days: 7 })
await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: start + 7 * 86400 + 3600 })
// invoice.payment_failed (attempt_count 1), customer.subscription.updated (past_due), customer.updated (delinquent)
// Recover by attaching a working card, making it the default and paying the invoice:
const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id })
await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } })
await stripe.invoices.pay(invoiceId)
```

```typescript
// Walk a 7 day trial through its first renewal
const clock = await stripe.testHelpers.testClocks.create({ frozen_time: start })
const customer = await stripe.customers.create({ test_clock: clock.id, payment_method: 'pm_card_visa',
  invoice_settings: { default_payment_method: 'pm_card_visa' } })
await stripe.subscriptions.create({ customer: customer.id, items: [{ price }], trial_period_days: 7 })
await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: start + 7 * 86400 + 3600 })
// trial_will_end, customer.subscription.updated (active), invoice.created, then invoice.paid
```

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

Paying charges, in order, the `payment_method` param, the invoice's `default_payment_method`, the `default_payment_method` of the subscription that generated it, then the customer's `invoice_settings.default_payment_method`, off-session by default. A decline (`pm_card_chargeCustomerFail`) returns 402, leaves the invoice `open` with `attempt_count` 1 and sends `invoice.payment_failed`. Further manual `/pay` attempts leave `attempt_count` at 1, as on Stripe, where only automatic retries count after the first attempt. `pm_card_authenticationRequired` returns 402 `invoice_payment_intent_requires_action`, leaves the PaymentIntent in `requires_action` and sends `invoice.payment_action_required` and `invoice.payment_failed`; completing it with `/_stripe/simulate/payment_intents/pi_xxx/authenticate` pays the invoice. A $0 invoice is paid when it is finalized and, like `paid_out_of_band`, sends `invoice.paid` without `invoice.payment_succeeded`. `mark_uncollectible` sets `status_details.uncollectible.reason` to `user_forgiven`; the invoice can still be paid.

`hosted_invoice_url` (and `invoice_pdf`, which points at the same page) serves an HTML page with the invoice's lines and, while it is `open`, a test card select and a Pay button. Paying there charges the chosen card with the customer present (3D Secure is approved), does not save it to the customer, and redirects back to the page. Without a browser:

```bash
curl -X POST http://localhost:4000/invoice/in_xxx/pay -d "payment_method=pm_card_visa"
```

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
| `pm_card_authenticationRequiredSetupForOffSession` (0446) | Needs 3D Secure on setup and on-session charges, never off-session |
| `pm_card_threeDSecure2Required` (3220) | Needs 3D Secure 2 on every charge |
| `pm_card_threeDSecureOptional` (3055) | Supports 3D Secure but succeeds without it |
| `pm_card_authenticationRequiredChargeDeclinedInsufficientFunds` (3178) | Needs 3D Secure, then declines |
| 4242424242424241 | Rejected at creation with `incorrect_number` |

```bash
# Emulator only: make later charges on a saved card decline, need 3D Secure, or succeed again
curl -X POST http://localhost:4000/_stripe/simulate/payment_methods/pm_xxx \
  -d "behavior=decline" -d "decline_code=lost_card"
curl -X POST http://localhost:4000/_stripe/simulate/payment_methods/pm_xxx -d "behavior=require_authentication"
curl -X POST http://localhost:4000/_stripe/simulate/payment_methods/pm_xxx -d "behavior=succeed"
```

Other card numbers are rejected. Setting a default payment method that is not attached to the customer returns a 400 with `param: "invoice_settings[default_payment_method]"`.

## Webhooks

The emulator records a Stripe Event object for every state change and delivers it to each webhook endpoint subscribed to that type or to `*`. Register endpoints via seed config or `POST /v1/webhook_endpoints`. Delivery happens before the API call that caused it returns, and failed deliveries are not retried.

Endpoints configured with a `secret` include `Stripe-Signature: t=<timestamp>,v1=<signature>`, an HMAC SHA-256 over `<timestamp>.<raw body>`, so `stripe.webhooks.constructEvent` verifies them.

Each delivery is a full Event:

- `id` (`evt_...`), `object: "event"`, `api_version` (`2026-10-28.endive` unless the seed sets `api_version`), `created`, `livemode: false`, `type`.
- `data.object` is a snapshot of the object, and `*.updated` events add `data.previous_attributes` with the old value of each changed field. An update that changes nothing sends no event.
- `request.id` is the `Request-Id` of the API call that caused the event, and `request.idempotency_key` echoes its `Idempotency-Key` header. Both are `null` for events no API call caused, such as completing the hosted checkout page.
- `pending_webhooks` is the number of endpoints the event was sent to, fixed when it is created. `GET /v1/events/:id` shows how many of them have not answered 2xx yet. Endpoints created later never receive the event.

### Delivery chaos

Delivery is inline, sequential and in order by default, with no automatic retries. To test idempotent and order-independent handlers, turn on chaos with the emulator-only control routes:

```bash
# Drop 20% of events, hold payment_intent.succeeded until flush, send charge.succeeded twice, shuffle batches
curl -X POST http://localhost:4000/_stripe/webhooks/chaos \
  -H "Content-Type: application/json" \
  -d '{"seed": 42, "drop": {"rate": 0.2}, "delay": {"types": ["payment_intent.succeeded"]}, "duplicate": {"types": ["charge.succeeded"]}, "reorder": "shuffle"}'

curl http://localhost:4000/_stripe/webhooks/chaos               # current settings
curl -X DELETE http://localhost:4000/_stripe/webhooks/chaos     # back to normal delivery

# Release held events (optionally only some, in held, reverse or shuffled order; a shuffle takes a seed)
curl -X POST http://localhost:4000/_stripe/webhooks/flush \
  -H "Content-Type: application/json" -d '{"order": "shuffle", "seed": 7}'

# Every attempt: succeeded, failed, dropped or held
curl "http://localhost:4000/_stripe/webhooks/deliveries?status=dropped"

# Send a stored event again to its endpoints that have not answered 2xx (for example after a drop),
# or to one of its endpoints even after a 2xx
curl -X POST http://localhost:4000/_stripe/events/evt_xxx/redeliver
curl -X POST http://localhost:4000/_stripe/events/evt_xxx/redeliver -d "endpoint=we_xxx"
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
| `price.updated` | Price lost its lookup key to a new price created with `transfer_lookup_key` |
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
| `invoice.upcoming` | A test clock reached `upcoming_renewal_days` before a renewal |
| `invoice.voided` | Invoice voided |
| `invoice.marked_uncollectible` | Invoice marked uncollectible, through the API or because the last retry failed |
| `invoice_payment.paid` | The invoice's InvoicePayment was paid |
| `invoiceitem.created` | Invoice item created |
| `invoiceitem.deleted` | Invoice item deleted |
| `customer.subscription.created` | Subscription created (before its first invoice's events) |
| `customer.subscription.updated` | Subscription changed, payment moved it from `incomplete` to `active`, a test clock ended its trial or renewed it, or a failed payment made it `past_due`, `unpaid` or `incomplete_expired` |
| `customer.subscription.deleted` | Subscription canceled, its customer deleted, a test clock reached its `cancel_at`, or the last retry failed |
| `customer.subscription.paused` | Paused through the pause endpoint, at a trial end without a payment method, or after the last retry failed with `after_retries[subscription]` `pause` |
| `customer.subscription.resumed` | A paused subscription resumed: at once with an unchanged anchor, or when its resumption invoice was paid, marked uncollectible or (default `payment_behavior`) failed a payment attempt |
| `customer.subscription.trial_will_end` | Trial ends within three days (sent at once when created that close, else when a test clock reaches that point) |
| `checkout.session.completed` | Checkout completed via hosted page |
| `checkout.session.expired` | Checkout session expired |
| `billing_portal.session.created` | Customer portal session created |
| `billing.meter.created` | Billing meter created |
| `billing.meter.updated` | Billing meter renamed |
| `billing.meter.deactivated` | Billing meter deactivated |
| `billing.meter.reactivated` | Billing meter reactivated |
| `test_helpers.test_clock.created` | Test clock created |
| `test_helpers.test_clock.advancing` | Test clock advance started |
| `test_helpers.test_clock.ready` | Test clock reached its new `frozen_time` |
| `test_helpers.test_clock.internal_failure` | An advance ran more than 10,000 billing actions |
| `test_helpers.test_clock.deleted` | Test clock deleted with its customers |

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
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      console.log('Subscription', obj.id, 'is', obj.status) // trialing, active, past_due, canceled...
      break
    case 'invoice.paid':
    case 'invoice.payment_failed':
      console.log('Invoice', obj.id, obj.status, 'attempt', obj.attempt_count)
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

### Subscription Checkout with a Trial

```typescript
const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  line_items: [{ price: 'price_monthly', quantity: 1 }],
  subscription_data: { trial_period_days: 7, metadata: { plan: 'pro' } },
  success_url: `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
})

// After the customer pays on session.url:
const done = await stripe.checkout.sessions.retrieve(session.id, { expand: ['subscription'] })
const sub = done.subscription as Stripe.Subscription
console.log(sub.status)                 // 'trialing'
console.log(sub.default_payment_method) // 'pm_...', saved through a SetupIntent
```

### SaaS Subscription on a Test Clock

Billing time only moves on a test clock. Put the customer on one, run Checkout for that customer, then advance:

```typescript
const start = Math.floor(Date.UTC(2026, 0, 15, 12) / 1000)
const clock = await stripe.testHelpers.testClocks.create({ frozen_time: start })
const customer = await stripe.customers.create({ email: 'founder@saas.example', test_clock: clock.id })

const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  customer: customer.id,
  line_items: [{ price: 'price_pro_monthly', quantity: 1 }, { price: 'price_api_calls' }], // metered: no quantity
  subscription_data: { trial_period_days: 7 },
  success_url: `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
})
// Complete session.url in a browser, or post the form the page posts:
await fetch(`http://localhost:4000/checkout/${session.id}/complete`, {
  method: 'POST',
  body: new URLSearchParams({ payment_method: 'pm_card_visa' }),
})
// customer.subscription.created (trialing) ... checkout.session.completed (last)

await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: start + 4 * 86400 })
// customer.subscription.trial_will_end
await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: start + 7 * 86400 + 3600 })
// customer.subscription.updated (active), invoice.created, invoice.finalized, invoice.paid

await stripe.billing.meterEvents.create({
  event_name: 'api_calls',
  identifier: 'req-1', // a repeat within 24 hours answers 400 duplicate_meter_event
  payload: { stripe_customer_id: customer.id, value: '1500' },
})
// Billed in arrears on the renewal a month after the trial ended

const portal = await stripe.billingPortal.sessions.create({ customer: customer.id, return_url: `${origin}/account` })
// portal.url is the emulator's portal page: cancel at period end, renew, change card, pay invoices
```

Usage during the trial is never billed; each renewal bills the usage of the period that just ended, one line per tier reached. With `payment_method_collection: 'if_required'` and `payment_method: 'none'` on the form, the trial starts without a card and `subscription_data.trial_settings.end_behavior.missing_payment_method` (`cancel`, `pause` or `create_invoice`) decides what happens at `trial_end`.

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

## Differences from Real Stripe

The emulator matches Stripe's wire format but deliberately does less in places. The full list is in the package README (`packages/@emulators/stripe/README.md`). The ones that most often matter in tests:

- Only customers on a test clock move through billing time. Without a clock, trials never end, periods never renew and failed payments are never retried.
- A clock advance runs synchronously: the response says `advancing`, but a `GET` right after shows `ready`.
- Webhooks are delivered inline, in order, before the API response returns, with no automatic retries. Use the chaos controls to test duplicates, reordering, delays and drops.
- Retries follow a fixed custom schedule (`[3, 5, 7]` days by default), not Smart Retries.
- There are no prorations, schedules, coupons, discounts, taxes or credit notes.
- Meter event problems answer 400 at once instead of arriving later as error report events.
- Checkout, invoice and portal pages are emulator HTML with a select of test cards. Off-session 3D Secure is completed with `POST /_stripe/simulate/payment_intents/:id/authenticate`.

## Custom emulators alongside built-ins

Use `npx emulate init --custom inventory` to scaffold a third-party API emulator and test. Register it in `emulate.config.ts` with `defineConfig` from `emulate`, alongside built-in entries such as `{ emulator: "stripe" }`. Run `npx emulate start --watch` to reload imports and inspect custom state at the printed `/_emulate` URL. Successful reloads reset the run to seed. Existing flat seed configs still work; `--config` selects an explicit file. For authoring and testing third-party API emulators, see https://emulate.dev/docs/custom-emulators.
