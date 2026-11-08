# @emulators/stripe

Stripe API emulation for payments and Billing: customers, payment methods with Stripe's test cards, customer sessions, payment intents, setup intents, charges, products, prices (recurring, tiered and metered), subscriptions with trials, pausing and dunning, invoices, invoice items, invoice payments, test clocks, billing meters and meter events, Checkout Sessions (payment and subscription mode) and the customer portal. Includes hosted checkout, invoice and portal pages, and webhook delivery of signed Event objects with optional delivery chaos.

Part of [emulate](https://github.com/vercel-labs/emulate), local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/stripe
```

## Usage

Point the official SDK at the emulator. stripe-node has no base URL environment variable, so pass `host`, `port` and `protocol`:

```typescript
import Stripe from 'stripe'

const stripe = new Stripe('sk_test_emulated', {
  host: 'localhost',
  port: 4000, // 4009 when emulate runs every service
  protocol: 'http',
})
```

Responses use the wire shape of API version `2026-10-28.endive`, the version stripe-node 23 pins. Register a webhook endpoint with a secret, in the [seed config](#seed-configuration) or with `POST /v1/webhook_endpoints`, and verify deliveries with `stripe.webhooks.constructEvent` as you would in production.

### Testing a subscription integration

A typical SaaS setup (a 7 day trial with a card on file, a flat monthly plan and a metered overage price whose first 1000 units are free) runs end to end against the emulator. Billing time only moves on a [test clock](#test-clocks), so put the customer on one:

1. Create a clock with `POST /v1/test_helpers/test_clocks` and a customer with `test_clock` set.
2. Create a subscription-mode Checkout Session for that `customer` with `subscription_data[trial_period_days]=7`, and complete the hosted page at its `url` (or `POST /checkout/:id/complete` with `payment_method=pm_card_visa`). The subscription starts `trialing` with the card as its `default_payment_method`, and `checkout.session.completed` comes last.
3. Advance the clock. Three days before the trial ends you get `customer.subscription.trial_will_end`. At `trial_end` the subscription turns `active` and an hour later the first invoice is finalized and charged (`invoice.paid`).
4. Report usage with `POST /v1/billing/meter_events`. The next renewal bills it in arrears on the cycle invoice, one line per tier reached.
5. Make payments fail with `pm_card_chargeCustomerFail`, or later with `POST /_stripe/simulate/payment_methods/:id`, to walk `past_due`, the retry schedule and the final `cancel`, `unpaid`, `past_due` or `pause` policy. Recover by setting a new default card and paying the open invoice.
6. Send customers to a portal session's `url` to cancel at period end, renew, change their card or pay an invoice.

`src/__tests__/scenarios.test.ts` drives each of these steps through stripe-node and verifies every webhook with `constructEvent`.

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
- `POST /_stripe/webhooks/flush`: deliver held events. Body: `order` (`none`, `reverse` or `shuffle`), `event_ids` and `seed` (for `shuffle`)
- `GET /_stripe/webhooks/deliveries`: the delivery log. Filters: `event_id`, `status`, `type`
- `POST /_stripe/events/:id/redeliver`: send a stored event again to the endpoints it was sent to that have not answered with a 2xx yet. Body: `endpoint` (a `we_` id the event was sent to) resends to that endpoint alone, even after a 2xx
- `POST /_stripe/simulate/payment_intents/:id/authenticate`: complete or fail 3D Secure for an intent in `requires_action`. See [Payment Intents](#payment-intents)
- `POST /_stripe/simulate/setup_intents/:id/authenticate`: complete or fail 3D Secure for a SetupIntent in `requires_action`. See [Setup Intents](#setup-intents)
- `POST /_stripe/simulate/payment_methods/:id`: change how later charges on a saved card behave. See [Test cards](#test-cards)
- `GET /_stripe/billing/settings`, `POST /_stripe/billing/settings`: read or change the Billing settings that live in the Stripe Dashboard. See [Test Clocks](#test-clocks) and [Failed payments and retries](#failed-payments-and-retries)
  - `upcoming_renewal_days` (default 3, from 0 to 45; 0 turns `invoice.upcoming` off): how many days before a renewal `invoice.upcoming` is sent
  - `retry_schedule_days` (default `[3, 5, 7]`): the custom retry schedule, at most 3 retries, each the number of days (1 to 60) after the previous attempt. `""` or `[]` turns retries off
  - `after_retries[subscription]`: what happens to the subscription when the last retry fails. `cancel` (the default), `unpaid`, `past_due` or `pause`
  - `after_retries[invoice]`: what happens to the invoice then. `open` (the default) or `uncollectible`

### Customers
- `POST /v1/customers`: create customer
- `GET /v1/customers/:id`: retrieve customer
- `POST /v1/customers/:id`: update customer
- `DELETE /v1/customers/:id`: delete customer
- `GET /v1/customers`: list customers, filtered by `email` and `test_clock`. Customers on a test clock are listed only with `test_clock`

Create accepts `payment_method`, which attaches that payment method (or a test card id such as `pm_card_visa`) in the same call, and `invoice_settings[default_payment_method]`, which may name the payment method being attached. Update accepts `invoice_settings[default_payment_method]` for a payment method already attached to the customer, or an empty string to clear it. Both accept `invoice_prefix` (3 to 12 uppercase letters or numbers). Create also accepts `test_clock`, which puts the customer on that [test clock](#test-clocks). Customers always carry `address`, `balance` (0), `currency`, `default_source`, `delinquent` (false), `invoice_prefix` (8 characters when generated), `invoice_settings`, `next_invoice_sequence` (1), `phone`, `preferred_locales`, `shipping`, `tax_exempt` (`none`) and `test_clock` (null unless the customer is on a clock). Deleting a customer detaches its payment methods.

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

`POST /_stripe/simulate/payment_methods/:id` (emulator only) changes how later charges on a stored payment method behave, which Stripe's test cards cannot do. It answers with the PaymentMethod. Attaching and setting up the card still follow its test card.

| `behavior` | Later charges |
|------------|---------------|
| `succeed` | Succeed without 3D Secure |
| `decline` | Are declined with `decline_code` (default `generic_decline`; any code from [Stripe's decline codes](https://docs.stripe.com/declines/codes)). `expired_card`, `incorrect_cvc`, `incorrect_number` and `processing_error` are reported as the error `code`, the others as `card_declined` with that `decline_code` |
| `require_authentication` | Ask for 3D Secure on every charge, as 3184 does |

### Customer Sessions
- `POST /v1/customer_sessions`: create a customer session

### Payment Intents
- `POST /v1/payment_intents`: create a payment intent
- `GET /v1/payment_intents/:id`: retrieve a payment intent
- `POST /v1/payment_intents/:id`: update a payment intent
- `POST /v1/payment_intents/:id/confirm`: confirm a payment intent
- `POST /v1/payment_intents/:id/cancel`: cancel a payment intent
- `GET /v1/payment_intents`: list payment intents
- `POST /_stripe/simulate/payment_intents/:id/authenticate`: emulator only. Completes (`{"result": "succeed"}`, the default) or fails (`{"result": "fail"}`) the 3D Secure step of an intent in `requires_action`, as the customer would

Create accepts `payment_method`, `confirm`, `off_session` (`true`, `one_off` or `recurring`), `setup_future_usage` (`off_session` or `on_session`), `confirmation_method` (`automatic` or `manual`), `capture_method` (`automatic_async`, the default, or `automatic`), `customer`, `description` and `metadata`. Confirm accepts `payment_method`, `off_session` and `setup_future_usage`. A test card id such as `pm_card_visa` is cloned into a new unattached `pm_` when it is set on an intent. A payment method attached to a customer can only be used with that customer, and one used without a customer cannot be used again.

Confirming charges the card according to the [test card table](#test-cards):

| Card behaviour | On-session confirm | Off-session confirm (`off_session=true`) |
|----------------|--------------------|------------------------------------------|
| Succeeds | `succeeded`, with a `ch_` charge in `latest_charge` | `succeeded` |
| Declines (for example 0002, 9995, or 0341 after attaching) | 402 `card_error`, failed charge, intent back to `requires_payment_method` | Same |
| 3D Secure always (3184) | `requires_action` with `next_action.type` `use_stripe_sdk` | 402 `authentication_required`, failed charge, intent `requires_payment_method` |
| 3D Secure on setup (3155) | `requires_action` | `succeeded` |
| 3D Secure, then declined (3178) | `requires_action`, then declined with `insufficient_funds` after authenticating | Declined with `insufficient_funds` |

A failed attempt sets `last_payment_error` (with `code`, `decline_code`, `doc_url`, `message`, `charge` and the `payment_method` object) and clears `payment_method`. The 402 error body carries the same fields plus the `payment_intent` object. Failing 3D Secure returns the intent to `requires_payment_method` with `last_payment_error.code` `payment_intent_authentication_failure` and creates no charge. With `confirmation_method=manual`, authenticating returns the intent to `requires_confirmation` and the next confirm charges it. With `setup_future_usage` and a `customer`, a successful payment attaches the payment method to the customer. Cancel accepts `cancellation_reason` and sets `canceled_at`.

### Setup Intents
- `POST /v1/setup_intents`: create a SetupIntent. Accepts `customer`, `payment_method`, `confirm`, `usage` (`off_session`, the default, or `on_session`), `description` and `metadata`
- `GET /v1/setup_intents/:id`: retrieve a SetupIntent
- `POST /v1/setup_intents/:id`: update `customer`, `payment_method`, `description` or `metadata`. Setting `payment_method` moves the intent to `requires_confirmation`
- `POST /v1/setup_intents/:id/confirm`: confirm, optionally with `payment_method`
- `POST /v1/setup_intents/:id/cancel`: cancel, with an optional `cancellation_reason` (`abandoned`, `duplicate` or `requested_by_customer`)
- `GET /v1/setup_intents`: list SetupIntents, filtered by `customer` and `payment_method`
- `POST /_stripe/simulate/setup_intents/:id/authenticate`: emulator only. Completes (`{"result": "succeed"}`, the default) or fails (`{"result": "fail"}`) the 3D Secure step of a SetupIntent in `requires_action`

A SetupIntent saves a card for later payments without charging it. A test card id such as `pm_card_visa` is cloned into a new `pm_`. Confirming follows the [test card table](#test-cards), with the customer present:

| Card behaviour | Confirm |
|----------------|---------|
| Succeeds, or declines only when charged (0341) | `succeeded`. The card is attached to `customer` (`payment_method.attached`, then `setup_intent.succeeded`) |
| Issuer decline (for example 0002 or 9995) | 402 `card_error` with the `setup_intent` and `payment_method` objects, intent back to `requires_payment_method` with `last_setup_error`, `setup_intent.setup_failed`. Nothing is attached |
| 3D Secure (3184, 3155, 3178) | `requires_action` with `next_action.type` `use_stripe_sdk` and `setup_intent.requires_action`. Authenticating saves the card as above; failing returns the intent to `requires_payment_method` with `last_setup_error.code` `setup_intent_authentication_failure` and sends `setup_intent.setup_failed` |

Without a `customer`, a successful setup leaves the card unattached, and it can be attached later. A card set up with 3155 is then charged off-session without asking for authentication again. Every event is `setup_intent.created`, `setup_intent.requires_action`, `setup_intent.succeeded`, `setup_intent.setup_failed` or `setup_intent.canceled`; there is no `setup_intent.updated`, as on Stripe.

### Invoices
- `POST /v1/invoices`: create a draft. Accepts `customer` (required), `currency` (default `usd`), `collection_method`, `auto_advance` (default `false`), `default_payment_method`, `days_until_due`, `due_date`, `description`, `footer`, `metadata` and `pending_invoice_items_behavior` (`exclude`, the default, or `include`)
- `GET /v1/invoices/:id`: retrieve an invoice
- `POST /v1/invoices/:id`: update `description`, `footer`, `metadata`, `auto_advance` and `default_payment_method`, and on a draft also `collection_method`, `days_until_due` and `due_date`
- `DELETE /v1/invoices/:id`: delete a draft, with its lines and invoice items
- `GET /v1/invoices/:id/lines`: list the lines, oldest first
- `POST /v1/invoices/:id/finalize`: finalize a draft
- `POST /v1/invoices/:id/pay`: pay, finalizing a draft first. Accepts `payment_method`, `off_session` (default `true`), `paid_out_of_band` and `forgive`
- `POST /v1/invoices/:id/void`: void an `open` or `uncollectible` invoice
- `POST /v1/invoices/:id/mark_uncollectible`: mark an `open` invoice uncollectible
- `GET /v1/invoices`: list invoices, filtered by `customer`, `status`, `collection_method`, `subscription` and `test_clock`. Invoices of a test clock customer are listed only when `customer`, `subscription` or `test_clock` is given

Invoices use the wire shape of API versions from basil on. There is no top-level `subscription`, `payment_intent`, `charge` or `paid`; `parent` is `null` for invoices created through the API. `lines` is a list with `total_count` and `url`. `payments`, `confirmation_secret` and `amount_paid_off_stripe` are includable, so they appear only with `expand[]`. `status_details` appears only while the invoice is `uncollectible`.

| Action | Allowed from | Result |
|--------|--------------|--------|
| finalize | `draft` | `open`, `number` `<invoice_prefix>-0001` (the customer's `next_invoice_sequence` moves on), `finalized_at`, `effective_at`, `hosted_invoice_url` and `invoice_pdf`. Something due creates a `pi_` PaymentIntent and a default `inpay_` InvoicePayment. Nothing due pays the invoice at once |
| pay | `draft`, `open`, `uncollectible` | Charges the `payment_method` param, else the invoice's `default_payment_method`, else the `default_payment_method` of the subscription that generated it, else the customer's `invoice_settings.default_payment_method`. A test card id such as `pm_card_visa` is attached to the customer first. Sets `attempted`. The first attempt raises `attempt_count` to 1; later manual attempts leave it there, since only automatic retries count after the first, as on Stripe |
| void | `open`, `uncollectible` | `void`, with the PaymentIntent canceled (`void_invoice`) and the InvoicePayment `canceled`. The latest invoice of a `past_due` or `unpaid` subscription makes it `active` again, unless an earlier invoice is still `open` |
| mark_uncollectible | `open` | `uncollectible` with `status_details.uncollectible.reason` `user_forgiven`. It can still be paid or voided. The latest invoice of a `past_due` or `unpaid` subscription makes it `active` again |
| delete | `draft` | Gone, with its lines and invoice items |

Payment outcomes follow the [test card table](#test-cards), with Billing as the initiator:

| Card behaviour | `/pay` response | Invoice | Events, after the PaymentIntent and charge events |
|----------------|-----------------|---------|---------------------------------------------------|
| Succeeds | 200 | `paid`, `amount_paid` equal to the total, `auto_advance` false | `invoice.updated`, `invoice.paid`, `invoice.payment_succeeded`, `invoice_payment.paid` |
| Declines (for example 0341) | 402 `card_error` | `open`, `attempt_count` 1 | `invoice.updated`, `invoice.payment_failed` |
| 3D Secure always (3184) | 402 `invoice_payment_intent_requires_action` | `open`, PaymentIntent `requires_action` | `invoice.updated`, `invoice.payment_action_required`, `invoice.payment_failed` |

Completing 3D Secure with `POST /_stripe/simulate/payment_intents/:id/authenticate`, or confirming the invoice's PaymentIntent directly, pays the invoice with the same events and a `null` request. The PaymentIntent of an invoice cannot be canceled through `/v1/payment_intents/:id/cancel`. A $0 invoice and a `paid_out_of_band` payment send `invoice.paid` without `invoice.payment_succeeded`, as the [invoice lifecycle docs](https://docs.stripe.com/invoicing/overview#paid) describe. Paying and `mark_uncollectible` set the customer's `delinquent` to `false`, with `customer.updated` when it changes. A failed automatic collection attempt sets it to `true`; a failed manual `/pay` leaves it alone.

### Subscriptions
- `POST /v1/subscriptions`: create a subscription for `customer` from `items` (1 to 20 `{price, quantity, metadata}`, recurring prices only, one currency and one interval). Also accepts `default_payment_method`, `collection_method` with `days_until_due` (required for `send_invoice`), `trial_end` (a timestamp or `now`), `trial_period_days`, `trial_from_plan`, `trial_settings[end_behavior][missing_payment_method]`, `cancel_at` (a timestamp, `max_period_end` or `min_period_end`), `cancel_at_period_end`, `payment_behavior`, `payment_settings[save_default_payment_method]`, `off_session` (default `false`), `description` and `metadata`
- `GET /v1/subscriptions/:id`: retrieve a subscription
- `POST /v1/subscriptions/:id`: update `items` (`items[i][id]` with `price`, `quantity`, `metadata` or `deleted`; an entry without `id` adds an item), `cancel_at_period_end`, `cancel_at` (`""` clears it), `cancellation_details` (`comment`, `feedback`), `default_payment_method`, `description`, `metadata`, `trial_end` and `trial_settings`. Changes create no prorations or invoices
- `DELETE /v1/subscriptions/:id`: cancel at once, with optional `cancellation_details`. With `invoice_now=true`, an `active`, `past_due` or `unpaid` subscription with metered items gets a final `subscription_update` invoice for the usage of its current period so far, created after `customer.subscription.deleted`, finalized and charged in the same call (an `unpaid` one's stays a draft). Without it the usage is dropped. `prorate` is accepted but creates no prorations
- `POST /v1/subscriptions/:id/pause`: pause an `active` or `past_due` subscription that collects automatically. Accepts `type` (`subscription`, the default), `invoicing_behavior` and `bill_for`
- `POST /v1/subscriptions/:id/resume`: resume a paused subscription. Accepts `billing_cycle_anchor[type]` (`now`, the default, or `unchanged`), `payment_behavior` (`resume_on_payment_attempt`, the default, or `resume_on_payment_success`), `proration_behavior` and `proration_date`
- `GET /v1/subscriptions`: list subscriptions, filtered by `customer`, `price`, `collection_method`, `test_clock` and `status`. Subscriptions of a test clock customer are listed only when `customer` or `test_clock` is given. Without `status`, canceled subscriptions are left out; `status=all` lists every one and `status=ended` the canceled and expired ones

### Subscription Items
- `POST /v1/subscription_items`: add an item to `subscription` from `price`, with `quantity` (default 1, not allowed for a metered price) and `metadata`. It joins the current period
- `GET /v1/subscription_items/:id`: retrieve an item
- `POST /v1/subscription_items/:id`: update `price`, `quantity` or `metadata`
- `DELETE /v1/subscription_items/:id`: delete an item. The last item of a subscription cannot be deleted
- `GET /v1/subscription_items`: list the items of `subscription` (required)

Subscriptions use the wire shape of API versions from basil on: billing periods are `current_period_start` and `current_period_end` on each item, and there is no top-level `current_period_*`, `plan` or `quantity`. Each item still carries the legacy `plan` object next to the full `price`. Items of a metered price have `quantity: null`, and passing `quantity` for one answers 400. `billing_mode` is `{type: "flexible", flexible: {proration_discounts: "included"}}`, the default since clover. `latest_invoice`, `customer`, `default_payment_method` and `items.data.price.product` are expandable.

Periods follow the UTC calendar from `billing_cycle_anchor`. A monthly anchor on the 31st bills on the last day of shorter months and returns to the 31st (Jan 31, Feb 28, Mar 31); a yearly anchor on Feb 29 bills on Feb 28 in other years.

Creating a subscription creates its first invoice (`billing_reason` `subscription_create`, `parent.subscription_details.subscription` set to the `sub_` id), finalizes it and, for `charge_automatically`, pays it in the same request with the subscription's `default_payment_method`, else the customer's `invoice_settings.default_payment_method`. Each item gives one line, such as `1 × Pro Plan (at $20.00 / month)`; a tiered price gives one line per tier reached and one per flat fee.

| Case | Status | First invoice |
|------|--------|---------------|
| Payment succeeds (`allow_incomplete`, the default) | `active` | `paid` |
| Payment fails or needs 3D Secure | `incomplete` | `open`, `attempt_count` 1. Paying it later makes the subscription `active` |
| `default_incomplete` | `incomplete` | `open`, `auto_advance` false, no payment attempted |
| `error_if_incomplete` and the payment fails | 402 error, nothing is stored and no event is sent | |
| Trial (`trial_period_days` or a future `trial_end`) | `trialing`, `billing_cycle_anchor` and the item period end at `trial_end` | $0, `paid`, lines say "Free trial" |
| `send_invoice` | `active` | `open`, `due_date` `days_until_due` days after creation |
| No payment method, no trial, something due | 400, nothing is stored | |

Events: `customer.subscription.created` first, already pointing at `latest_invoice`, then the invoice and PaymentIntent events, then `customer.subscription.updated` when payment moves the subscription from `incomplete` to `active`. A trial ending within three days also sends `customer.subscription.trial_will_end` at once.

| Change | Result |
|--------|--------|
| `cancel_at_period_end=true` | `cancel_at` is the item period end, `canceled_at` the time of the request and `cancellation_details.reason` `cancellation_requested`. `false` clears all three |
| `cancel_at` | Scheduled cancellation at that time, with `canceled_at` set to now and `cancellation_details.reason` `cancellation_requested` |
| `trial_end` while `trialing` | A timestamp moves the trial end, the anchor and the period end; one less than three days away also sends `customer.subscription.trial_will_end` in the same request, after `customer.subscription.updated`. `now` ends the trial: a new period starts, the subscription turns `active` and the period is invoiced with `billing_reason` `subscription_update`. The events are one `customer.subscription.updated` for the whole request, then `customer.subscription.trial_will_end` (unless that trial was already warned about), then the invoice events. A failed payment, including one with no payment method to charge, leaves it `past_due` with the attempt counted and retries scheduled. With no payment method and `trial_settings[end_behavior][missing_payment_method]` `cancel` or `pause`, the subscription is canceled or paused instead, with no invoice and no `trial_will_end` |
| `DELETE` | `canceled`, `canceled_at` and `ended_at` now, `cancellation_details.reason` `cancellation_requested`. Open invoices of the subscription get `auto_advance` false. Sends `customer.subscription.deleted` only. A second `DELETE` answers 400 |
| Deleting the customer | Cancels each of its subscriptions the same way, before `customer.deleted` |

A canceled subscription accepts only `metadata` and `cancellation_details`; an `incomplete` one only `metadata` and `default_payment_method`. Other updates answer 400. Every change sends `customer.subscription.updated` with `previous_attributes`, including the old `items` list when items change.

#### Pausing and resuming

A paused subscription has `status` `paused` and `status_details.paused` `{subscription: {type}, transitioned_at, type: "subscription"}`, where `type` is `pause_requested` (the pause endpoint), `trial_end_without_payment_method` or `final_payment_failure`. It neither renews nor creates invoices, and its invoices that are already open keep advancing without changing its status. It can still be updated, without prorations. Pausing sends `customer.subscription.updated` and then `customer.subscription.paused`; the pause endpoint also ends the items' current period at the pause. Pausing a `trialing`, `unpaid`, `incomplete`, ended or already paused subscription, or one that uses `send_invoice`, answers 400.

Resuming a subscription that is not paused, or that already waits on a resumption invoice, answers 400. Otherwise:

| `billing_cycle_anchor[type]` and `payment_behavior` | Result |
|------|--------|
| `unchanged` | `active` at once, no invoice. The anchor is kept and the items' period runs from now to its next boundary |
| `now`, `resume_on_payment_attempt` (default) | A resumption invoice (`billing_reason` `subscription_update`, `auto_advance` false) for a new period starting now is created and finalized, but not attempted. The subscription stays `paused`, its `latest_invoice` is that invoice and `pending_update` holds the new `billing_cycle_anchor` and an `expires_at` 23 hours ahead. Paying it, or marking it uncollectible, makes it `active`; a failed `/pay` makes it `past_due`, with no retries. If no attempt is made by `expires_at`, the invoice is voided on a test clock and the subscription stays `paused` |
| `now`, `resume_on_payment_success` | The resumption invoice is attempted at once, off-session. Success makes the subscription `active` in the same call. A failure leaves it `paused` with `pending_update` expiring in a year, while the invoice is retried on the retry schedule; a later successful retry or `/pay` makes it `active`. With something due and no default payment method, the call answers 400 and creates nothing |

Voiding the resumption invoice drops `pending_update` and keeps the subscription `paused`. Resuming sets `billing_cycle_anchor` to the new anchor, moves every item to the new period, clears `status_details` and `pending_update`, and sends `customer.subscription.updated` and then `customer.subscription.resumed`, after the invoice events. A $0 resumption invoice is paid on finalization, so the subscription turns `active` at once.

### Test Clocks
- `POST /v1/test_helpers/test_clocks`: create a clock frozen at `frozen_time` (required), with an optional `name`. `customer` puts an existing customer, with its subscriptions and invoices, on the new clock; its `frozen_time` cannot be in the past
- `GET /v1/test_helpers/test_clocks/:id`: retrieve a clock
- `POST /v1/test_helpers/test_clocks/:id/advance`: move `frozen_time` forward
- `DELETE /v1/test_helpers/test_clocks/:id`: delete a clock and everything on it
- `GET /v1/test_helpers/test_clocks`: list clocks, newest first

A clock (`clock_...`, object `test_helpers.test_clock`) is created `ready` with `status_details` `{}` and `deletes_after` 30 days after `created`. Pass `test_clock` when creating a customer to put the customer on it. From then on, everything created for that customer (payment methods, subscriptions and their items, invoices, invoice items, PaymentIntents, charges, SetupIntents, Checkout Sessions) takes its `created`, `start_date`, `trial_start` and similar times from the clock's `frozen_time` instead of the wall clock. Subscriptions, invoices and invoice items of the customer carry `test_clock`, which is expandable, as it is on the customer.

| Rule | Result |
|------|--------|
| More than 3 customers on a clock | 400, `param` `test_clock` |
| More than 3 live subscriptions for a clock customer | 400, `param` `customer` |
| `frozen_time` not after the current one | 400, `param` `frozen_time` |
| Advancing past two intervals of the shortest live subscription on the clock, counted on the calendar from the current `frozen_time` (two years when the clock has none) | 400, `param` `frozen_time` |

`advance` answers with the clock as Stripe does while it works: `status` `advancing`, the old `frozen_time` and `status_details.advancing.target_frozen_time`. The emulator finishes the advance before responding, so a `GET` right after shows `ready` at the target time. It sends `test_helpers.test_clock.advancing` (with the request's id) and then `test_helpers.test_clock.ready` (with a `null` request), last.

While it advances, the clock runs Billing for its customers. It repeatedly takes the earliest scheduled action at or before the target, moves `frozen_time` to that moment and runs it. Each action's events have a `null` request and a `created` equal to the simulated time of the action.

| Action | When | Result and events |
|--------|------|-------------------|
| Trial warning | 3 days before `trial_end` | `customer.subscription.trial_will_end`, once per trial end. The subscription stays `trialing` |
| Upcoming renewal | `upcoming_renewal_days` before a trial end or period end (default 3) | `invoice.upcoming` with a preview of the renewal invoice: `status` `draft`, `billing_reason` `upcoming`, the next period's lines and no `id`, as Stripe documents. Nothing is stored. Not sent for `send_invoice`, for a subscription that ends at that renewal, or when the setting is 0 |
| Trial end | `trial_end` | `active`, `billing_cycle_anchor` moves to `trial_end` and the item periods roll to the first paid period. A `subscription_cycle` draft is created with `auto_advance` true and `automatically_finalizes_at` one hour later. `customer.subscription.updated` (with `previous_attributes` `status`, `items` and `latest_invoice`), then `invoice.created`. See [Trial end without a payment method](#trial-end-without-a-payment-method) |
| Renewal | the items' `current_period_end` | Each item's period rolls to the next boundary of `billing_cycle_anchor`, and a `subscription_cycle` draft bills the new period. Its `period_start` and `period_end` look back on the period that just ended; the lines carry the new one. `customer.subscription.updated` (with the old `items` and `latest_invoice`), then `invoice.created` |
| Scheduled cancellation | `cancel_at`, when it falls on or before the next trial end or period end (so also `cancel_at_period_end`) | `canceled` with `ended_at` at that time and `canceled_at` kept from the request that scheduled it, `cancellation_details.reason` `cancellation_requested`. `customer.subscription.deleted`. A subscription with metered items then gets a final `subscription_cycle` draft for the usage of the period that ended, billed in arrears like a renewal and collected an hour later; licensed items were billed in advance and get no line. Without metered items there is no invoice |
| Draft collection | `automatically_finalizes_at`, one hour after an auto-advancing draft was created | The draft is finalized and, for `charge_automatically`, paid off-session as an automatic attempt, with the same events as `/pay`. A failed payment leaves the invoice `open`, an `active` subscription `past_due` and schedules the first retry. See [Failed payments and retries](#failed-payments-and-retries) |
| Retry | `next_payment_attempt` of an open subscription invoice | Another automatic attempt. See [Failed payments and retries](#failed-payments-and-retries) |
| Overdue invoice | `due_date` of an open `send_invoice` subscription invoice | When it is the subscription's latest invoice, an `active` subscription turns `past_due` (`customer.subscription.updated`). Paying the invoice makes it `active` again |
| Incomplete expiry | 23 hours after an `incomplete` subscription was created | `incomplete_expired` with `ended_at`, `customer.subscription.updated`, and its open first invoice is voided (`invoice.voided`) |
| Resumption expiry | `pending_update.expires_at` of a paused subscription | The unpaid resumption invoice is voided (`invoice.voided`) and the subscription stays `paused` (`customer.subscription.updated` without `pending_update`) |

One advance that spans several periods runs every renewal in it, so advancing a monthly subscription two months gives two cycle invoices.

#### Trial end without a payment method

At `trial_end`, a `charge_automatically` subscription with no default payment method (on the subscription or the customer's `invoice_settings`) follows `trial_settings.end_behavior.missing_payment_method`:

| Setting | Result |
|---------|--------|
| `create_invoice` (default) | As any trial end: the `subscription_cycle` draft is created and the subscription turns `active`. An hour later the automatic attempt fails for lack of a payment method: the invoice stays `open` with `attempt_count` 1 and a retry scheduled, `invoice.updated` and `invoice.payment_failed` are sent, the subscription turns `past_due` and the customer `delinquent`. Retries then follow [Failed payments and retries](#failed-payments-and-retries) |
| `cancel` | `canceled` at `trial_end` with `cancellation_details.reason` `cancellation_requested`. `customer.subscription.deleted` only, and no invoice |
| `pause` | `paused` with `status_details.paused.subscription.type` `trial_end_without_payment_method`. `customer.subscription.updated`, then `customer.subscription.paused`, and no invoice. It stays paused until [resumed](#pausing-and-resuming) |

Trials that will cancel or pause this way get no `invoice.upcoming`. Adding a default payment method before `trial_end` makes the trial end as usual.

#### Failed payments and retries

When Billing's automatic attempt on a subscription invoice fails (at a trial end, a renewal, or `trial_end=now`), the invoice stays `open` with `attempt_count` 1 and `next_payment_attempt` set to the first entry of `retry_schedule_days` after the attempt (3 days by default). An `active` subscription turns `past_due` (`customer.subscription.updated`) and the customer turns `delinquent` (`customer.updated`). Each retry charges the payment method the invoice would use at that moment, so a new subscription or customer default takes effect on the next retry. Every failed retry raises `attempt_count`, moves `next_payment_attempt` on by the next entry of the schedule and sends `invoice.updated` and `invoice.payment_failed`.

After the last retry fails, `next_payment_attempt` is `null` and the `after_retries` settings apply:

| Setting | Result |
|---------|--------|
| `subscription: cancel` | `canceled` with `cancellation_details.reason` `payment_failed`. Its open invoices keep their status with `auto_advance` false. `customer.subscription.deleted` |
| `subscription: unpaid` | `unpaid` (`customer.subscription.updated`). Later renewals create drafts with `auto_advance` false that are never finalized |
| `subscription: past_due` | Stays `past_due`. Later renewals are invoiced and collected as usual |
| `subscription: pause` | `paused`, with `status_details.paused` `{subscription: {type: "final_payment_failure"}, transitioned_at, type: "subscription"}`. `customer.subscription.updated`, then `customer.subscription.paused`. The invoice stays `open` and no new invoices are created |
| `invoice: uncollectible` | The invoice is marked `uncollectible` with `status_details.uncollectible.reason` `max_payment_attempts` (`invoice.marked_uncollectible`). The customer stays `delinquent` |

Other failures:

| Case | Result |
|------|--------|
| Hard decline (`incorrect_number`, `lost_card`, `pickup_card`, `stolen_card`, `revocation_of_authorization`, `revocation_of_all_authorizations`, `authentication_required`, `highest_risk_level`, `transaction_not_allowed`) | Retries stay scheduled and are counted, as [Stripe documents](https://docs.stripe.com/billing/revenue-recovery/smart-retries#non-retryable-decline-codes), but while the invoice would still be charged with the declined payment method (or with none) a retry makes no charge: it sends `invoice.updated` and `invoice.payment_failed` only. Once the default payment method changes, the next scheduled retry charges the new one |
| First invoice of an `incomplete` subscription | Never retried: `next_payment_attempt` stays `null`. On a clock the subscription turns `incomplete_expired` 23 hours after it was created |
| Renewal that needs 3D Secure (3184) | The PaymentIntent stays `requires_action`, `invoice.payment_action_required` and `invoice.payment_failed` are sent and the subscription turns `past_due`. Retries are scheduled as for a decline and ask for authentication again. `POST /_stripe/simulate/payment_intents/:id/authenticate` with `succeed` pays the invoice |

Paying the latest invoice of a `past_due` or `unpaid` subscription (with `/pay`, or by completing 3D Secure) makes it `active`, clears `delinquent` and stops the retries. Marking it uncollectible through the API or voiding it makes the subscription `active` too. A failed manual `/pay` keeps the retry Billing scheduled.

`DELETE` answers `{id, object: "test_helpers.test_clock", deleted: true}` and removes the clock's customers with their payment methods, subscriptions, invoices, invoice items, PaymentIntents, charges, SetupIntents and Checkout Sessions. Subscriptions, invoices and invoice items that carry the clock's `test_clock` are removed too, with their items, lines, invoice payments and PaymentIntents, even when their customer was deleted earlier. Only `test_helpers.test_clock.deleted` is sent; the removed objects send no events of their own.

### Invoice Items
- `POST /v1/invoiceitems`: create an item for `customer` (required), from `pricing[price]` (amount is `unit_amount` times `quantity`), `amount` with `currency`, or `unit_amount_decimal`. With `invoice` it goes on that draft; without, it stays pending. Also accepts `quantity`, `description` (defaults to the product name), `discountable`, `period` and `metadata`
- `GET /v1/invoiceitems/:id`: retrieve an item
- `POST /v1/invoiceitems/:id`: update `pricing[price]`, `quantity`, `amount`, `description`, `discountable`, `period` or `metadata`. The draft's line follows
- `DELETE /v1/invoiceitems/:id`: delete an item that is pending or on a draft
- `GET /v1/invoiceitems`: list items, filtered by `customer`, `invoice` and `pending`

Items on a finalized invoice answer 400 `invoice_not_editable`. Changing the lines of a draft sends `invoice.updated`.

### Invoice Payments
- `GET /v1/invoice_payments/:id`: retrieve an InvoicePayment
- `GET /v1/invoice_payments`: list them, filtered by `invoice`, `status` and `payment[type]` with `payment[payment_intent]`

### Charges
- `GET /v1/charges/:id`: retrieve a charge
- `GET /v1/charges`: list charges

Charges are created by confirming a payment intent. They carry `outcome` (`authorized`, or `issuer_declined` with the decline code in `reason`), `failure_code`, `failure_message`, `paid`, `billing_details` copied from the payment method, and `payment_method_details.card` (brand, last4, checks, `network`, `three_d_secure` when the customer authenticated).

### Products
- `POST /v1/products`: create a product. Accepts `name` (required), `description`, `active`, `metadata`, `images`, `shippable`, `statement_descriptor`, `unit_label` and `url`
- `GET /v1/products/:id`: retrieve a product
- `GET /v1/products`: list products, filtered by `active`

Products have the full shape of the API reference. `default_price`, `package_dimensions` and `tax_code` are `null` and `marketing_features` is empty. `expand[]=product` on a price returns the same object as `GET /v1/products/:id`.

### Prices
- `POST /v1/prices`: create a price for `product`, or for a new product from `product_data` (`product.created` is sent first). Accepts `currency` (required), `unit_amount` or `unit_amount_decimal`, `recurring` (`interval`, `interval_count`, `usage_type`), `billing_scheme`, `tiers`, `tiers_mode`, `transform_quantity`, `lookup_key` with `transfer_lookup_key`, `nickname`, `tax_behavior`, `active` and `metadata`
- `GET /v1/prices/:id`: retrieve a price
- `GET /v1/prices`: list prices, filtered by `active`, `currency`, `product`, `type`, `lookup_keys[]` (up to 10) and `recurring[interval]`, `recurring[usage_type]` or `recurring[meter]`

| Price | Rules |
|-------|-------|
| Recurring | `recurring[interval]` is `day`, `week`, `month` or `year`, otherwise 400 with param `recurring[interval]`. `interval_count` defaults to 1 and may span at most three years (3 years, 36 months, 156 weeks or 1095 days). `type` is `recurring`; without `recurring` it is `one_time` and `recurring` is `null` |
| Metered | `recurring[usage_type]=metered` needs `recurring[meter]`, an active [billing meter](#billing-meters). Without one the answer is 400 `parameter_missing`; an unknown meter gives `resource_missing` and an inactive one a 400 on `recurring[meter]`. Metered items bill their usage in arrears, so their `quantity` is `null` and sending one answers 400 |
| Per unit | `unit_amount` (integer) or `unit_amount_decimal` (up to 12 decimal places), not both. `unit_amount` is `null` when the decimal has a fractional part |
| Tiered | `billing_scheme=tiered` needs `tiers` and `tiers_mode` (`graduated` or `volume`). Each tier has `up_to` and at least one of `unit_amount`/`unit_amount_decimal` and `flat_amount`/`flat_amount_decimal`. `up_to` values must increase and only the last tier, which must be `inf`, may be unbounded. `unit_amount`, `unit_amount_decimal` and `transform_quantity` are not allowed alongside. `unit_amount` and `unit_amount_decimal` are `null` |
| Package | `transform_quantity` `{divide_by, round}` divides the quantity and rounds `up` or `down` before multiplying by the unit amount |
| Lookup key | Up to 200 characters and unique across all prices. Reusing one answers 400 `lookup_key_already_used` unless `transfer_lookup_key=true`, which moves it and sends `price.updated` for the old price |

`tiers` and `currency_options` are includable. `expand[]=tiers` shows the tiers with the final `inf` tier as `up_to: null`, and `null` for a per-unit price. `expand[]=currency_options` holds only the price's own currency. `recurring.trial_period_days` (legacy) is always `null`, and `tax_behavior` defaults to `unspecified`.

Amounts follow Stripe's tiered pricing rules: graduated tiers charge each tier for the units in it plus the flat fee of every tier reached, volume tiers charge every unit at the tier the whole quantity falls in, and a quantity of 0 still bills the first tier's flat fee.

### Billing Meters
- `POST /v1/billing/meters`: create a meter (`mtr_test_...`) from `display_name`, `event_name` and `default_aggregation[formula]` (`sum`, `count` or `last`), all required. `customer_mapping` defaults to `{type: "by_id", event_payload_key: "stripe_customer_id"}` and `value_settings` to `{event_payload_key: "value"}`. `event_time_window` (`day` or `hour`) is stored and shown. `event_name` must be unique among active meters, else 400 on `event_name`
- `GET /v1/billing/meters/:id`: retrieve a meter
- `POST /v1/billing/meters/:id`: update `display_name`, the only field that can change
- `POST /v1/billing/meters/:id/deactivate`: stop accepting events. `status` turns `inactive` and `status_transitions.deactivated_at` is set. An inactive meter frees its `event_name` and cannot back a new price
- `POST /v1/billing/meters/:id/reactivate`: accept events again. Answers 400 while another active meter holds the `event_name`
- `GET /v1/billing/meters`: list meters, filtered by `status`
- `GET /v1/billing/meters/:id/event_summaries`: aggregate a meter's events for `customer` (required) between `start_time` (inclusive) and `end_time` (exclusive), both required and aligned to the minute. Without `value_grouping_window` the answer is one summary for the whole range; with `hour` or `day` (times aligned to the hour or the UTC day) it is one summary per bucket that has events, newest first. Summaries (`mtrusg_test_...`, `object: "billing.meter_event_summary"`) have deterministic ids, so `starting_after` and `ending_before` work

Events: `billing.meter.created`, `billing.meter.updated` (with `previous_attributes`), `billing.meter.deactivated` and `billing.meter.reactivated`. Meters belong to the account, not to a test clock, so `created` and `updated` are on the wall clock.

### Meter Events
- `POST /v1/billing/meter_events`: record usage. `event_name` (an active meter's) and `payload` are required. The payload holds the customer id under the meter's customer key and a number, which may be negative or decimal (`25`, `-3`, `2.5`), under its value key; every payload value is kept as a string. `identifier` is generated (a UUID) when absent. `timestamp` defaults to now on the customer's clock and must lie within the past 35 days and at most 5 minutes ahead. The response is the `billing.meter_event` object, which has no `id`
- `POST /v1/billing/meter_event_adjustments`: `type=cancel` with `event_name` and `cancel[identifier]` removes one event from every aggregation. Only events received in the last 24 hours on the customer's clock can be canceled. The response is `{object: "billing.meter_event_adjustment", status: "pending", ...}` as on Stripe, but the cancellation applies at once

| Rejected event | Code |
|----------------|------|
| No meter has the `event_name` | `no_meter` |
| The meter is inactive | `archived_meter` |
| No customer id in the payload | `meter_event_no_customer_defined` |
| The customer does not exist | `meter_event_customer_not_found` |
| No value in the payload (`sum` and `last`) | `meter_event_value_not_found` |
| The value is not a number | `meter_event_invalid_value` |
| `timestamp` more than 5 minutes ahead | `timestamp_in_future` |
| `timestamp` more than 35 days back | `timestamp_too_far_in_past` |
| The `identifier` was received in the last 24 hours | `duplicate_meter_event` |

`count` meters count events and need no value, `last` takes the value of the event with the latest `timestamp`, and `sum` adds the values.

Usage is billed through metered prices. A subscription's first invoice (`subscription_create`) has no metered charge. Each `subscription_cycle` invoice bills licensed items in advance for the new period and metered items in arrears for the period that just ended: the usage of the subscription's customer on the price's meter with a `timestamp` in `[period start, period end)`. The quantity is computed when the invoice finalizes, an hour after the draft, so usage that arrives in that window with a timestamp inside the period counts. A negative total bills 0, and usage during a trial is never billed. Decimal usage bills as on Stripe: the line's `quantity_decimal` holds the full total (`2.75`) and `quantity` the truncated integer (`2`). Graduated tiers give one line per tier reached plus one per flat fee, so 1500 units on `[{up_to: 1000, unit_amount: 0}, {up_to: inf, unit_amount: 2}]` bill `1000 × ... (Tier 1 at $0.00 / month)` and `500 × ... (Tier 2 at $0.02 / month)`, 1000 in all. `invoice.upcoming` previews the usage of the current period so far.

### Checkout Sessions
- `POST /v1/checkout/sessions`: create a session in `payment`, `subscription` or `setup` mode. Accepts `line_items` (`{price, quantity}`), `customer` or `customer_email`, `customer_creation` (`payment` and `setup` mode only), `client_reference_id`, `success_url`, `cancel_url`, `expires_at` (30 minutes to 24 hours ahead, default 24 hours), `metadata`, and in `subscription` mode `payment_method_collection` (`always` or `if_required`) and `subscription_data` (`trial_period_days`, `trial_end`, `trial_settings[end_behavior][missing_payment_method]`, `description`, `metadata`). `payment_method_types` is ignored, since endive removed it from the request
- `GET /v1/checkout/sessions/:id`: retrieve a session. `line_items` is includable, and `customer`, `invoice`, `subscription` and `payment_intent` are expandable
- `GET /v1/checkout/sessions/:id/line_items`: list the line items (`li_`, `object: "item"`)
- `POST /v1/checkout/sessions/:id/expire`: expire an open session
- `GET /v1/checkout/sessions`: list sessions, filtered by `customer`, `status`, `payment_status`, `subscription` and `payment_intent`
- `GET /checkout/:id`: the hosted checkout page (HTML), with a select of test cards
- `POST /checkout/:id/complete`: what the page posts. Form fields `payment_method` (a test card id, default `pm_card_visa`, or `none` to start a free trial without a card) and `email`

Session ids start with `cs_test_`. A line for a metered price takes no `quantity` (400 on `line_items[i][quantity]` otherwise), shows `quantity: null` and adds nothing to the amount due. `amount_subtotal` and `amount_total` are what is due when the session completes, so a trial session shows 0. `subscription` mode needs at least one recurring price, and `payment` mode accepts only one-time prices; both return 400 with `param: "line_items"` otherwise.

Completing the page in `subscription` mode creates the customer (unless the session has one), then the subscription through the same path as `POST /v1/subscriptions`, with the collected card as the subscription's `default_payment_method`. The customer's `invoice_settings.default_payment_method` is left alone. A session for a `customer` that is on a [test clock](#test-clocks) creates everything at the clock's `frozen_time`, so advancing that clock runs the trial and the renewals. With a trial the card is saved through a `seti_` SetupIntent and the $0 invoice is paid at once; without one the card is attached and the first invoice charged with the customer present. The session ends `complete` and `paid` with `customer`, `subscription` and `invoice` set:

| Session | Events, in order, ending with `checkout.session.completed` |
|---------|-------------------------------------------------------------|
| Trial, card | `customer.created`, `setup_intent.created`, `payment_method.attached`, `setup_intent.succeeded`, `customer.subscription.created` (`trialing`), the invoice events up to `invoice.paid` |
| No trial | `customer.created`, `payment_method.attached`, `customer.subscription.created` (`incomplete`), the invoice, PaymentIntent and charge events, `invoice.paid`, `customer.subscription.updated` (`active`) |
| Trial, `payment_method_collection=if_required`, no card | `customer.created`, `customer.subscription.created` (`trialing`, no `default_payment_method`), the invoice events |

A declined card re-renders the page with status 402 and the decline message. Nothing the attempt created is kept (no customer, subscription, invoice or payment method) and no event is sent, so the customer can try another card. Choosing no card when the session needs one returns the page with status 400. In `payment` mode the page charges a `pi_` PaymentIntent (`payment_intent.created`, `payment_intent.succeeded`, `charge.succeeded`) and sets `payment_intent`; a customer is created only with `customer_creation=always`. Every event the page causes carries a `null` request.

### Customer Portal
- `POST /v1/billing_portal/sessions`: create a `bps_` session. Accepts `customer` (required), `return_url`, `configuration`, `locale`, `on_behalf_of`, `after_expiration` and `flow_data`. Sends `billing_portal.session.created`
- `GET /v1/billing_portal/configurations`: list configurations (filters `is_default`, `active`). There is one, the default `bpc_` configuration, created the first time it is needed
- `GET /v1/billing_portal/configurations/:id`: retrieve a configuration. A session's `configuration` is expandable
- `GET /billing_portal/:id`: the portal page (HTML) at the session's `url`
- `POST /billing_portal/:id/subscriptions/:sub/cancel`: what the page posts to cancel at period end. Form fields `feedback` (a `cancellation_details.feedback` value) and `comment`
- `POST /billing_portal/:id/subscriptions/:sub/renew`: undo a scheduled cancellation
- `POST /billing_portal/:id/payment_method`: save a new card. Form field `payment_method` (a test card id, default `pm_card_visa`)
- `POST /billing_portal/:id/invoices/:invoice/pay`: pay an open or uncollectible invoice with the customer's usual payment method

A session has `object: "billing_portal.session"`, `url` `<baseUrl>/billing_portal/bps_...`, and `flow`, `locale`, `on_behalf_of`, `customer_account` and `after_expiration` `null` unless given. A missing or unknown `customer` is a 400 with `param: "customer"`. The default configuration enables invoice history, payment method updates, cancellation at period end with every cancellation reason, and subscription updates; customer details and pausing are off.

`flow_data[type]` may be `payment_method_update`, `subscription_cancel` (with `flow_data[subscription_cancel][subscription]`, one of the customer's subscriptions that is not ended or already scheduled to cancel) or `subscription_update` (with `flow_data[subscription_update][subscription]`). `customer_update` and `subscription_pause` are refused because the configuration turns those features off, and `subscription_update_confirm` is not supported. `flow_data[after_completion][type]` defaults to `portal_homepage`; `redirect` needs `redirect[return_url]` and `hosted_confirmation` takes a `custom_message` of up to 500 characters. `return_url` and `redirect[return_url]` must be absolute `http` or `https` URLs, or the request answers 400 `Not a valid URL` with that param. The session echoes the flow with every other flow key `null`.

The page lists the customer's subscriptions that have not ended, the default card and the finalized invoices. A session with a flow shows only that step until the customer completes it, then follows `after_completion`. Every portal action sends its events with a `null` request:

| Action | Result | Events |
|--------|--------|--------|
| Cancel (`active`, `trialing` or `past_due`) | `cancel_at_period_end` true, `cancel_at` the current period end, `canceled_at` now, `cancellation_details` with reason `cancellation_requested` and the feedback and comment given | `customer.subscription.updated` |
| Renew | `cancel_at_period_end` false, `cancel_at`, `canceled_at` and `cancellation_details` cleared | `customer.subscription.updated` |
| Update payment method | The card is saved through an `off_session` `seti_` SetupIntent (3D Secure is approved on the page) and becomes the customer's `invoice_settings.default_payment_method`. A subscription's own `default_payment_method` overrides that default, so the portal removes the override (`null`) and the subscription falls back to the new card | `setup_intent.created`, `payment_method.attached`, `setup_intent.succeeded`, `customer.updated`, and `customer.subscription.updated` (with `previous_attributes.default_payment_method`) for each subscription that had an override |
| Pay an invoice | Charged as `POST /v1/invoices/:id/pay` with the customer present. Paying the latest invoice of a `past_due` subscription makes it `active` | The invoice events up to `invoice.paid` |

A declined card or payment re-renders the page with status 402 and the decline message; the failed SetupIntent or invoice attempt is kept, with its events.

### Hosted invoice page
- `GET /invoice/:id`: the page at a finalized invoice's `hosted_invoice_url` (and `invoice_pdf`), with its lines, amounts and, while it is `open` or `uncollectible`, a select of test cards and a Pay button. Drafts and unknown invoices answer 404
- `POST /invoice/:id/pay`: what the page posts. Form field `payment_method` (a test card id, default `pm_card_visa`)

The chosen card is charged as a new payment method that is not saved to the customer, with the customer present, so 3D Secure is approved on the page. Success redirects back to the page, which then shows the invoice as paid. A decline re-renders the page with status 402; the attempt counts and sends `invoice.payment_failed`, as a failed `/pay` does. Events carry a `null` request.

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
- `request.id` is the `Request-Id` of the API call that caused the event, and `request.idempotency_key` echoes its `Idempotency-Key` header. Events that no API call caused, such as completing the hosted checkout page or a renewal during a test clock advance, have both set to `null`.
- `pending_webhooks` is the number of endpoints the event was sent to, fixed when the event is created, as on Stripe. `GET /v1/events/:id` shows it dropping by one for each of those endpoints that answered with a 2xx status. An endpoint created later never receives the event, even on redelivery.
- `api_version` defaults to `2026-10-28.endive`. Set `api_version` in the seed config to stamp a different version.

Endpoints come from `POST /v1/webhook_endpoints` or from the seed config's `webhooks`. Both are stored in the `stripe.webhook_endpoints` collection, so they are listable and survive a snapshot. After a restore, each stored endpoint is matched to the dispatcher by url and secret and registered only if it is missing, so no endpoint receives an event twice.

Events sent: `customer.created`, `customer.updated`, `customer.deleted`, `payment_method.attached`, `payment_method.detached`, `payment_method.updated`, `product.created`, `price.created`, `price.updated`, `payment_intent.created`, `payment_intent.requires_action`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `setup_intent.created`, `setup_intent.requires_action`, `setup_intent.succeeded`, `setup_intent.setup_failed`, `setup_intent.canceled`, `charge.succeeded`, `charge.failed`, `invoice.created`, `invoice.updated`, `invoice.deleted`, `invoice.finalized`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.upcoming`, `invoice.voided`, `invoice.marked_uncollectible`, `invoice_payment.paid`, `invoiceitem.created`, `invoiceitem.deleted`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.trial_will_end`, `customer.subscription.paused`, `customer.subscription.resumed`, `checkout.session.completed`, `checkout.session.expired`, `billing_portal.session.created`, `billing.meter.created`, `billing.meter.updated`, `billing.meter.deactivated`, `billing.meter.reactivated`, `test_helpers.test_clock.created`, `test_helpers.test_clock.advancing`, `test_helpers.test_clock.ready`, `test_helpers.test_clock.internal_failure` and `test_helpers.test_clock.deleted`. Events raised by the customer completing 3D Secure, or by Billing while a test clock advances, carry a `null` request, like the hosted checkout, invoice and portal pages.

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

`rate` is a probability from 0 to 1 and defaults to 1. `types` lists event types (`*` wildcards allowed) and defaults to every type. Each event is checked for drop, then delay, then duplicate. The generator state and the outbox are kept in the store, so they survive a snapshot and restore. `DELETE /_stripe/webhooks/chaos` returns to normal delivery; held events stay held until flushed. Flushing and redelivering ignore the chaos settings. A flush with `order` `shuffle` draws from its own generator, seeded by the flush's `seed` (by default the chaos seed, or 0 without chaos settings), so it is repeatable and does not change later chaos decisions.

`GET /_stripe/webhooks/deliveries` lists every attempt in the order it happened, oldest first (a dropped or held event in the place it was emitted), each with `event_id`, `type`, `status` (`succeeded`, `failed`, `dropped` or `held`), `status_code`, `url`, `delivery_id` and `created`. `POST /_stripe/webhooks/flush` returns `{flushed: [evt ids], remaining}`.

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
  billing:
    upcoming_renewal_days: 3
    retry_schedule_days: [3, 5, 7]
    after_retries:
      subscription: cancel
      invoice: open
  test_clocks:
    - id: clock_renewals
      frozen_time: 1768478400
      name: Renewals
  customers:
    - name: Test Customer
      email: test@example.com
    - id: cus_with_card
      email: card@example.com
      test_clock: clock_renewals
      payment_method: pm_card_visa
      invoice_settings:
        default_payment_method: pm_card_visa
  meters:
    - display_name: API calls
      event_name: api_calls
      default_aggregation:
        formula: sum
  products:
    - name: Pro Plan
  prices:
    - product: Pro Plan
      unit_amount: 2000
      currency: usd
      lookup_key: pro_monthly
      recurring:
        interval: month
    - product: Pro Plan
      currency: usd
      recurring:
        interval: month
        usage_type: metered
        meter: api_calls
      tiers_mode: graduated
      tiers:
        - up_to: 1000
          unit_amount: 0
        - up_to: inf
          unit_amount: 2
```

Every key is optional. Seeded objects are created in this order: test clocks, customers, meters, products with their prices, then webhook endpoints.

| Key | Contents |
|-----|----------|
| `api_version` | The version stamped on every event. Defaults to `2026-10-28.endive` |
| `webhooks` | Endpoints: `url`, `events` (`['*']` for every type), optional `secret` (deliveries are signed only with one) and `id`. Listed by `GET /v1/webhook_endpoints` |
| `webhook_chaos` | Delivery faults applied from the start, with the body of `POST /_stripe/webhooks/chaos`. See [Webhook delivery model and chaos](#webhook-delivery-model-and-chaos) |
| `billing` | `upcoming_renewal_days`, `retry_schedule_days` and `after_retries` (`subscription`, `invoice`), as in `POST /_stripe/billing/settings` |
| `test_clocks` | `frozen_time` (required), `name` and an optional `id`. Created `ready`, as by `POST /v1/test_helpers/test_clocks` |
| `customers` | `email`, `name`, `description`, `metadata` and an optional `id`, plus `payment_method`, `invoice_settings.default_payment_method` and `test_clock` as described below |
| `products` | `name`, `description` and an optional `id` |
| `meters` | The params of `POST /v1/billing/meters` (`display_name`, `event_name`, `customer_mapping`, `value_settings`, `event_time_window`) with an optional `id`. `default_aggregation` defaults to `{formula: sum}` |
| `prices` | The params of `POST /v1/prices`: `currency`, `unit_amount` or `unit_amount_decimal`, `recurring` (`interval`, `interval_count`, `usage_type`, `meter`), `billing_scheme`, `tiers`, `tiers_mode`, `transform_quantity`, `lookup_key`, `nickname`, `tax_behavior` and `metadata`, with an optional `id` |

A seeded customer takes `payment_method` and `invoice_settings.default_payment_method` as `POST /v1/customers` does: `payment_method` is a test card id such as `pm_card_visa`, attached as a new `pm_` (listed by `GET /v1/payment_methods?customer=...`), and `default_payment_method` may name that same card, which then becomes the customer's `invoice_settings.default_payment_method`, so subscriptions charge it with no further setup. Any other default, or a card that declines on attach, stops the seed with an error. `test_clock` names a seeded clock by id or name; the customer and its card are then created at the clock's `frozen_time`, and at most three customers fit on one clock. Seeding emits no events. A customer whose `id` or `email` already exists is skipped, card included, so seeding the same config twice adds nothing.

A price's `product` names a seeded product by name or id; the older `product_name` key still works. Seeded prices are validated like `POST /v1/prices`, so an invalid one stops the seed with an error. `tiers` without `billing_scheme` makes a tiered price, a tier's `up_to` takes `inf` for the last tier, and a seeded `lookup_key` moves from any price that already holds it. Meters are seeded before prices, so a metered price's `recurring.meter` can name a meter by id or by `event_name`. Optional `id` fields give deterministic ids that survive a restart.

## Differences from real Stripe

The emulator aims to match Stripe's wire format. These are the places where it deliberately does less:

- Webhooks are delivered inline, one after another and in order, before the API response returns. Failed deliveries are not retried, and redelivery happens only through `POST /_stripe/events/:id/redeliver`. Chaos (drop, duplicate, delay until flush, reorder) is opt-in and seeded.
- Webhook endpoints accept any `enabled_events` strings without checking them against Stripe's list of event types. `api_version` is stored and returned but events are not rendered in it, and `connect` endpoints are not modelled. Seed endpoints without a `secret` receive unsigned deliveries.
- All events use one `api_version`. There is no per-endpoint version pinning, no conversion between versions, and no thin or v2 events.
- `livemode` is always `false`, and events are kept for the life of the emulator rather than 30 days.
- `Idempotency-Key` is echoed into `event.request.idempotency_key`, but repeated requests are not replayed.
- Expand paths that do not name an expandable field are ignored instead of returning a 400.
- Charges report `balance_transaction` and `receipt_url` as `null`, and `outcome` has no risk score. Charges are captured at once: `capture_method=manual`, refunds and disputes are not modelled.
- Confirming a PaymentIntent with no payment method succeeds as if `pm_card_visa` were used. Real Stripe returns a 400.
- PaymentIntents accept only cards. `payment_method_types` is always `["card"]`, `automatic_payment_methods` is always enabled, `return_url` is never required, and `payment_method_configuration_details` is `null`.
- 3D Secure is completed through `POST /_stripe/simulate/payment_intents/:id/authenticate`. `next_action` is always `use_stripe_sdk` (never `redirect_to_url`), and its `stripe_js` points at that emulator route. Card behaviour comes only from the test card table and `POST /_stripe/simulate/payment_methods/:id`: there are no Radar rules, no exemptions and no `request_three_d_secure` handling.
- A test card with authentication `on_setup` (3155, 3178) never asks for authentication off-session, whether or not it was set up first.
- SetupIntents accept only cards. SetupAttempts and mandates are not modelled, so `latest_attempt`, `mandate` and `single_use_mandate` are always `null`, and `automatic_payment_methods` is `null` with `payment_method_types` always `["card"]`. `return_url`, `payment_method_data` and `payment_method_options` params are ignored. Confirmation always runs with the customer present, so every 3D Secure card asks for authentication at setup.
- The messages for using a payment method that belongs to another customer are the emulator's wording.
- Payment-mode Checkout Sessions may be created without `line_items`. Such a session has `null` amounts and `currency`, and completing it charges nothing and creates no PaymentIntent.
- Checkout pages are emulator HTML that offer a select of test cards in place of card fields. 3D Secure is approved on the page, because the customer is present. A declined attempt keeps nothing it created, including the customer and the failed charge.
- Checkout Sessions never expire on their own at `expires_at`; only `POST /v1/checkout/sessions/:id/expire` expires them. Setup mode only marks the session complete and creates no SetupIntent.
- Subscription-mode Checkout Sessions reject one-time prices, which Stripe would put on the first invoice. `subscription_data` params other than `trial_period_days`, `trial_end`, `trial_settings`, `description` and `metadata` are ignored, as are `invoice_creation`, `discounts`, `allow_promotion_codes`, tax, shipping, consent and custom field options, which keep their empty defaults. `customer_details` holds only `email` and `name`, and `setup_intent` is always `null`.
- Subscription-mode sessions without a `customer` report `customer_creation: "always"`, and the line items of a trial session report amounts of 0. Both are the emulator's reading of the docs. Validation messages for Checkout Session params are partly the emulator's wording.
- Only card payment methods exist, and only the documented test cards. `card[number]` is accepted for those numbers without the raw card data setting real Stripe requires. Fingerprints are derived from the card number, `card.checks.cvc_check` turns `pass` when a `pm_card_*` id or a card created with `card[cvc]` is attached, and `regulated_status` is always `unregulated`.
- `GET /v1/payment_methods` without `customer` lists every payment method.
- Detaching a customer's default payment method clears the default and sends `customer.updated`. Deleting a customer detaches its payment methods without sending `payment_method.detached`.
- Customer `balance`, `currency`, `address`, `shipping`, tax and discounts are not modelled and keep their empty defaults.
- Invoices model no taxes, discounts, credit notes, customer balance, shipping or Connect: `total` is the sum of the lines, `amount_due` never goes below 0, `starting_balance` is 0 and `ending_balance` is 0 once finalized. `account_country` and `account_name` are `null`, and `customer_account`, `customer_address`, `customer_phone` and `customer_shipping` are always `null` (there are no Accounts v2 customer accounts).
- Invoices of customers without a test clock are never finalized or charged on their own: `auto_advance` is stored and `automatically_finalizes_at` and `next_payment_attempt` are reported, but nothing acts on them. On a test clock an auto-advancing draft is finalized and charged one hour after it was created, without the delay of up to 72 hours Stripe adds when `invoice.created` was not answered with a 2xx. `webhooks_delivered_at` is set when the invoice is created, because delivery is inline.
- `hosted_invoice_url` and `invoice_pdf` point at the same emulator HTML page; there is no PDF. The page pays with a test card select, approves 3D Secure, and never saves the card to the customer.
- The customer portal is emulator HTML at `<baseUrl>/billing_portal/bps_...`; session URLs never expire and carry no secret, `after_expiration` is stored but never acts. There is one configuration, the default, and no configuration create or update API. The page cannot change plans, quantities or customer details, so a `subscription_update` flow only shows the subscription. Canceling always happens at period end, without prorations or retention offers (coupons are not modelled). `customer_account` is refused and `on_behalf_of` is echoed without checking the account.
- Updating the card in the portal always removes the `default_payment_method` override of the customer's subscriptions, as the [portal integration guide](https://docs.stripe.com/customer-management/integrate-customer-portal) describes; there is no setting to keep it. Undoing a scheduled cancellation, from the portal or with `cancel_at_period_end=false` or `cancel_at=""`, clears `cancellation_details` (details sent in the same request are kept), which is the emulator's reading of the docs. Portal and hosted invoice payments of an invoice whose PaymentIntent needs 3D Secure are approved on the page, as Checkout does. Error messages for portal flows are the emulator's wording.
- Invoice items created from a bare `amount` render `pricing` as `null` instead of an inline price. `price_data`, `quantity_decimal`, `tax_rates` and `discounts` params are ignored, and lines are listed oldest first.
- The PaymentIntent of a subscription invoice, and its charge, has `description` `Subscription creation` for the first invoice and `Subscription update` for later ones, which is the emulator's reading of what Billing shows; the PaymentIntents of one-off invoices have a `null` description.
- `/pay` ignores `forgive`, `mandate` and `source`: card payments either cover the whole amount or fail. A customer with no payment method gets a 400 and the attempt is not counted.
- Subscriptions have no prorations, `subscription_update` invoices for item changes, schedules, quotes, Trial Offers, `pause_collection`, `billing_cycle_anchor` params outside of resume, `billing_cycle_anchor_config`, tax, discounts, coupons, pending invoice items, thresholds or Connect: those fields keep their empty or `null` defaults. `billing_mode` is always `flexible`, with `updated_at` equal to `created`. `current_trial` on items is always `null`, because only legacy trials exist, and `trial_from_plan` never starts a trial, because plans have no `trial_period_days`.
- Every item of a subscription must share one currency and one billing interval. Real Stripe allows mixed intervals under flexible billing mode.
- Only customers on a test clock move through billing time. Without a clock there are no background timers, so trials never end by themselves, periods never renew, failed payments are never retried and `incomplete` subscriptions never expire after 23 hours. `trial_end` can be changed only while the subscription is `trialing`.
- A trial counts as missing a payment method when neither the subscription's `default_payment_method` nor the customer's `invoice_settings.default_payment_method` is set; payment sources (`default_source`) are not modelled. A trial canceled for a missing payment method records `cancellation_details.reason` `cancellation_requested`, and such trials (and the ones that pause) get no `invoice.upcoming`; both are the emulator's reading of the docs. An `unpaid` subscription keeps renewing with drafts that are never finalized.
- `POST /v1/subscriptions/:id/pause` accepts `bill_for` and `invoicing_behavior` but creates no credit for unused time and no charge for outstanding usage. Classic billing mode, schedules and billing schedules do not exist, so those pause restrictions never apply. A scheduled `cancel_at` still cancels a paused subscription when it falls due.
- `POST /v1/subscriptions/:id/resume` accepts `proration_behavior` and `proration_date` but creates no prorations. With `billing_cycle_anchor[type]=unchanged` the subscription therefore turns `active` at once with no invoice, and its items' period runs from the resume time (not the last boundary) to the anchor's next boundary, so usage recorded while paused is never billed. The resumption invoice has `billing_reason` `subscription_update`, and `pending_update` sets only `billing_cycle_anchor` and `expires_at`, with every other key (`cancel_at_period_end`, `discount`, `discounts`, `metadata`, `subscription_items`, `trial_end`, `trial_from_plan`) `null`; a second resume while one is pending answers 400. These choices and the pause and resume error messages are the emulator's reading of the docs.
- Retries follow a deterministic custom schedule (`retry_schedule_days`, default `[3, 5, 7]` days after the previous attempt). Smart Retries, automations, retries of one-off invoices and pausing after the first renewal failure are not modelled. A subscription paused after its final retry does not resume when that invoice is paid; only the resume endpoint resumes it. Every hard decline code suspends execution the same way, and a retry that is counted without a charge still sends `invoice.payment_failed`, which is the emulator's reading of the docs. A retry that needs 3D Secure asks for it again rather than being suspended.
- Subscription status always follows the most recent invoice that is not void. The Dashboard option that looks at all of a subscription's invoices is not modelled. `incomplete_expired` sets `ended_at` and sends `customer.subscription.updated`, and an `incomplete` subscription whose first invoice is voided through the API stays `incomplete`.
- A `send_invoice` subscription turns `past_due` when its invoice is unpaid at the due date, and nothing more happens after that: the account's overdue-invoice settings that later cancel the subscription or mark it `unpaid`, and the `invoice.overdue` automation, are not modelled.
- Billing settings such as the retry schedule are global to the emulator, as they are to a Stripe account, and changing them affects retries scheduled afterwards only.
- `invoice.upcoming` is skipped when the configured number of days reaches back past the start of the current period, such as 3 days on a daily price. Its preview's `lines.url` and its line ids (`il_tmp_...`) are the emulator's choice, and its `created` is the renewal time. A scheduled `cancel_at` inside a period ends the subscription without a proration.
- Test clock advances run synchronously inside the request. The response says `advancing`, with `status_details.advancing.target_frozen_time`, but the stored clock is already `ready` when it returns. Clocks are never deleted on their own at `deletes_after`. A clock turns `internal_failure`, with `test_helpers.test_clock.internal_failure`, only if one advance runs more than 10,000 billing actions.
- Deleting a test clock removes its customers and their objects without sending `customer.deleted`, `customer.subscription.deleted` or other per-object events. Removing a customer from a clock is not possible, as on Stripe.
- Events that Billing raises during an advance carry the simulated time as `created`. The `test_helpers.test_clock.*` events and the events of API calls made for clock customers carry a wall clock `created`. Stripe-Signature timestamps always stay on the wall clock, so `constructEvent` with its 300 second tolerance accepts deliveries from any simulated time. Clock customers are hidden from `GET /v1/customers` and their subscriptions and invoices from the unfiltered lists, but other lists (PaymentIntents, charges, payment methods, invoice items) still show their objects. A subscription counts towards the limit of three while it is not `canceled` or `incomplete_expired`. The error messages for test clock limits are the emulator's wording.
- The first payment of a subscription counts as an automatic collection attempt, so a decline makes the customer `delinquent`. `error_if_incomplete` rolls back everything the attempt created, including the declined charge.
- Invoice line descriptions for subscription items (`1 × Pro Plan (at $20.00 / month)`, `Free trial for 1 × Pro Plan`, tier lines) and the error messages for subscription updates are the emulator's wording. The pending invoice items of a customer are not pulled into subscription invoices.
- InvoicePayments are only of type `payment_intent`, and there is no attach-payment or detach-payment API.
- Error messages for invoice state changes (finalizing twice, voiding a paid invoice, deleting a finalized one) are the emulator's wording.
- A per-unit price may be created without `unit_amount`, `unit_amount_decimal` or `custom_unit_amount` and then charges 0. Real Stripe requires one of them.
- Prices have no update, search or delete API yet. `custom_unit_amount` is always `null`, `currency_options` holds only the price's own currency, and the `currency_options` and `custom_unit_amount` params are ignored. Currencies are checked only for being three letters.
- Validation messages for prices and tiers are the emulator's wording.
- Meter events are validated and aggregated synchronously. Stripe accepts them and reports problems later through `v1.billing.meter.error_report_triggered`; the emulator answers 400 with the error report's code instead, and never sends that event. The error messages, the 400 for a duplicate meter `event_name` and the 404 for an unknown meter are the emulator's wording. Deactivating an inactive meter, or reactivating an active one, returns it unchanged without an event.
- Identifier uniqueness covers the whole account for exactly 24 hours after receipt, measured on the clock of the customer that sent the earlier event. Decimal usage is summed to 12 decimal places; a metered line's amount is its decimal quantity times the unit price, rounded half up to the smallest currency unit on each line; Stripe's own rounding of fractional amounts may differ. `event_time_window` is stored but does not change how events are aggregated, and the v2 meter event streams and sessions are not modelled.
- Event summaries with a `value_grouping_window` list only buckets that have events. Summary ids are the emulator's deterministic hash of meter, customer and time range.
- Metered usage is summed per customer and meter when the invoice finalizes, so two items on one subscription with the same meter would bill it twice. A subscription that ends with metered items bills their usage on a final invoice only at a scheduled cancellation or with `invoice_now`; that invoice comes after `customer.subscription.deleted`, and its `billing_reason` (`subscription_cycle` at a period end, `subscription_update` for `invoice_now`) and timing are the emulator's reading of the [cancellation docs](https://docs.stripe.com/billing/subscriptions/cancel). Usage during a paused period is never billed, because a paused subscription does not renew and a resumed one starts its period at the resume time.
- `GET /v1/prices` without `active` lists inactive prices too.
- Products have no update or delete API yet, so `updated` equals `created`. `default_price_data`, `marketing_features`, `package_dimensions` and `tax_code` are not modelled.

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
