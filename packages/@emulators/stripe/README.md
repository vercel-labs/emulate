# @emulators/stripe

Stripe API emulation with customers, payment methods, customer sessions, payment intents, setup intents, charges, subscriptions, invoices, invoice items, products, prices, and checkout sessions (payment and subscription mode). Includes a hosted checkout page and webhook delivery.

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
- `POST /_stripe/simulate/payment_intents/:id/authenticate`: complete or fail 3D Secure for an intent in `requires_action`. See [Payment Intents](#payment-intents)
- `POST /_stripe/simulate/setup_intents/:id/authenticate`: complete or fail 3D Secure for a SetupIntent in `requires_action`. See [Setup Intents](#setup-intents)

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
- `GET /v1/invoices`: list invoices, filtered by `customer`, `status`, `collection_method` and `subscription`

Invoices use the wire shape of API versions from basil on. There is no top-level `subscription`, `payment_intent`, `charge` or `paid`; `parent` is `null` for invoices created through the API. `lines` is a list with `total_count` and `url`. `payments`, `confirmation_secret` and `amount_paid_off_stripe` are includable, so they appear only with `expand[]`. `status_details` appears only while the invoice is `uncollectible`.

| Action | Allowed from | Result |
|--------|--------------|--------|
| finalize | `draft` | `open`, `number` `<invoice_prefix>-0001` (the customer's `next_invoice_sequence` moves on), `finalized_at`, `effective_at`, `hosted_invoice_url` and `invoice_pdf`. Something due creates a `pi_` PaymentIntent and a default `inpay_` InvoicePayment. Nothing due pays the invoice at once |
| pay | `draft`, `open`, `uncollectible` | Charges the `payment_method` param, else the invoice's `default_payment_method`, else the `default_payment_method` of the subscription that generated it, else the customer's `invoice_settings.default_payment_method`. A test card id such as `pm_card_visa` is attached to the customer first. Sets `attempted`. The first attempt raises `attempt_count` to 1; later manual attempts leave it there, since only automatic retries count after the first, as on Stripe |
| void | `open`, `uncollectible` | `void`, with the PaymentIntent canceled (`void_invoice`) and the InvoicePayment `canceled` |
| mark_uncollectible | `open` | `uncollectible` with `status_details.uncollectible.reason` `user_forgiven`. It can still be paid or voided |
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
- `DELETE /v1/subscriptions/:id`: cancel at once, with optional `cancellation_details`
- `GET /v1/subscriptions`: list subscriptions, filtered by `customer`, `price`, `collection_method`, `test_clock` and `status`. Without `status`, canceled subscriptions are left out; `status=all` lists every one and `status=ended` the canceled and expired ones

### Subscription Items
- `POST /v1/subscription_items`: add an item to `subscription` from `price`, with `quantity` (default 1) and `metadata`. It joins the current period
- `GET /v1/subscription_items/:id`: retrieve an item
- `POST /v1/subscription_items/:id`: update `price`, `quantity` or `metadata`
- `DELETE /v1/subscription_items/:id`: delete an item. The last item of a subscription cannot be deleted
- `GET /v1/subscription_items`: list the items of `subscription` (required)

Subscriptions use the wire shape of API versions from basil on: billing periods are `current_period_start` and `current_period_end` on each item, and there is no top-level `current_period_*`, `plan` or `quantity`. Each item still carries the legacy `plan` object next to the full `price`. `billing_mode` is `{type: "flexible", flexible: {proration_discounts: "included"}}`, the default since clover. `latest_invoice`, `customer`, `default_payment_method` and `items.data.price.product` are expandable.

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
| `cancel_at_period_end=true` | `cancel_at` is the item period end and `canceled_at` the time of the request. `false` clears both |
| `cancel_at` | Scheduled cancellation at that time, with `canceled_at` set to now |
| `trial_end` while `trialing` | A later timestamp moves the trial end, the anchor and the period end. `now` ends the trial: a new period starts, the subscription turns `active` and the period is invoiced with `billing_reason` `subscription_update`; a failed payment leaves it `past_due` |
| `DELETE` | `canceled`, `canceled_at` and `ended_at` now, `cancellation_details.reason` `cancellation_requested`. Open invoices of the subscription get `auto_advance` false. Sends `customer.subscription.deleted` only. A second `DELETE` answers 400 |
| Deleting the customer | Cancels each of its subscriptions the same way, before `customer.deleted` |

A canceled subscription accepts only `metadata` and `cancellation_details`; an `incomplete` one only `metadata` and `default_payment_method`. Other updates answer 400. Every change sends `customer.subscription.updated` with `previous_attributes`, including the old `items` list when items change.

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
- `GET /v1/charges/:id` — retrieve charge
- `GET /v1/charges` — list charges

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
| Metered | `recurring[usage_type]=metered` needs `recurring[meter]`. Billing meters are not modelled yet, so every metered price is rejected with 400: `parameter_missing` without a meter, `resource_missing` with one |
| Per unit | `unit_amount` (integer) or `unit_amount_decimal` (up to 12 decimal places), not both. `unit_amount` is `null` when the decimal has a fractional part |
| Tiered | `billing_scheme=tiered` needs `tiers` and `tiers_mode` (`graduated` or `volume`). Each tier has `up_to` and at least one of `unit_amount`/`unit_amount_decimal` and `flat_amount`/`flat_amount_decimal`. `up_to` values must increase and only the last tier, which must be `inf`, may be unbounded. `unit_amount`, `unit_amount_decimal` and `transform_quantity` are not allowed alongside. `unit_amount` and `unit_amount_decimal` are `null` |
| Package | `transform_quantity` `{divide_by, round}` divides the quantity and rounds `up` or `down` before multiplying by the unit amount |
| Lookup key | Up to 200 characters and unique across all prices. Reusing one answers 400 `lookup_key_already_used` unless `transfer_lookup_key=true`, which moves it and sends `price.updated` for the old price |

`tiers` and `currency_options` are includable. `expand[]=tiers` shows the tiers with the final `inf` tier as `up_to: null`, and `null` for a per-unit price. `expand[]=currency_options` holds only the price's own currency. `recurring.trial_period_days` (legacy) is always `null`, and `tax_behavior` defaults to `unspecified`.

Amounts follow Stripe's tiered pricing rules: graduated tiers charge each tier for the units in it plus the flat fee of every tier reached, volume tiers charge every unit at the tier the whole quantity falls in, and a quantity of 0 still bills the first tier's flat fee.

### Checkout Sessions
- `POST /v1/checkout/sessions`: create a session in `payment`, `subscription` or `setup` mode. Accepts `line_items` (`{price, quantity}`), `customer` or `customer_email`, `customer_creation` (`payment` and `setup` mode only), `client_reference_id`, `success_url`, `cancel_url`, `expires_at` (30 minutes to 24 hours ahead, default 24 hours), `metadata`, and in `subscription` mode `payment_method_collection` (`always` or `if_required`) and `subscription_data` (`trial_period_days`, `trial_end`, `trial_settings[end_behavior][missing_payment_method]`, `description`, `metadata`). `payment_method_types` is ignored, since endive removed it from the request
- `GET /v1/checkout/sessions/:id`: retrieve a session. `line_items` is includable, and `customer`, `invoice`, `subscription` and `payment_intent` are expandable
- `GET /v1/checkout/sessions/:id/line_items`: list the line items (`li_`, `object: "item"`)
- `POST /v1/checkout/sessions/:id/expire`: expire an open session
- `GET /v1/checkout/sessions`: list sessions, filtered by `customer`, `status`, `payment_status`, `subscription` and `payment_intent`
- `GET /checkout/:id`: the hosted checkout page (HTML), with a select of test cards
- `POST /checkout/:id/complete`: what the page posts. Form fields `payment_method` (a test card id, default `pm_card_visa`, or `none` to start a free trial without a card) and `email`

Session ids start with `cs_test_`. `amount_subtotal` and `amount_total` are what is due when the session completes, so a trial session shows 0. `subscription` mode needs at least one recurring price, and `payment` mode accepts only one-time prices; both return 400 with `param: "line_items"` otherwise.

Completing the page in `subscription` mode creates the customer (unless the session has one), then the subscription through the same path as `POST /v1/subscriptions`, with the collected card as the subscription's `default_payment_method`. The customer's `invoice_settings.default_payment_method` is left alone. With a trial the card is saved through a `seti_` SetupIntent and the $0 invoice is paid at once; without one the card is attached and the first invoice charged with the customer present. The session ends `complete` and `paid` with `customer`, `subscription` and `invoice` set:

| Session | Events, in order, ending with `checkout.session.completed` |
|---------|-------------------------------------------------------------|
| Trial, card | `customer.created`, `setup_intent.created`, `payment_method.attached`, `setup_intent.succeeded`, `customer.subscription.created` (`trialing`), the invoice events up to `invoice.paid` |
| No trial | `customer.created`, `payment_method.attached`, `customer.subscription.created` (`incomplete`), the invoice, PaymentIntent and charge events, `invoice.paid`, `customer.subscription.updated` (`active`) |
| Trial, `payment_method_collection=if_required`, no card | `customer.created`, `customer.subscription.created` (`trialing`, no `default_payment_method`), the invoice events |

A declined card re-renders the page with status 402 and the decline message. Nothing the attempt created is kept (no customer, subscription, invoice or payment method) and no event is sent, so the customer can try another card. Choosing no card when the session needs one returns the page with status 400. In `payment` mode the page charges a `pi_` PaymentIntent (`payment_intent.created`, `payment_intent.succeeded`, `charge.succeeded`) and sets `payment_intent`; a customer is created only with `customer_creation=always`. Every event the page causes carries a `null` request.

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

Events sent: `customer.created`, `customer.updated`, `customer.deleted`, `payment_method.attached`, `payment_method.detached`, `payment_method.updated`, `product.created`, `price.created`, `price.updated`, `payment_intent.created`, `payment_intent.requires_action`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `setup_intent.created`, `setup_intent.requires_action`, `setup_intent.succeeded`, `setup_intent.setup_failed`, `setup_intent.canceled`, `charge.succeeded`, `charge.failed`, `invoice.created`, `invoice.updated`, `invoice.deleted`, `invoice.finalized`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.voided`, `invoice.marked_uncollectible`, `invoice_payment.paid`, `invoiceitem.created`, `invoiceitem.deleted`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.trial_will_end`, `checkout.session.completed` and `checkout.session.expired`. Events raised by the customer completing 3D Secure carry a `null` request, like the hosted checkout page.

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
      lookup_key: pro_monthly
      recurring:
        interval: month
    - product: Pro Plan
      currency: usd
      recurring:
        interval: month
      tiers_mode: graduated
      tiers:
        - up_to: 1000
          unit_amount: 0
        - up_to: inf
          unit_amount: 2
```

A price's `product` names a seeded product by name or id; the older `product_name` key still works. Seeded prices take the same params as `POST /v1/prices` and are validated the same way, so an invalid one stops the seed with an error. `tiers` without `billing_scheme` makes a tiered price, and a seeded `lookup_key` moves from any price that already holds it.

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
- 3D Secure is completed through `POST /_stripe/simulate/payment_intents/:id/authenticate`. `next_action` is always `use_stripe_sdk` (never `redirect_to_url`), and its `stripe_js` points at that emulator route. Card behaviour comes only from the test card table: there are no Radar rules, no exemptions and no `request_three_d_secure` handling.
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
- Invoices are never finalized or charged on their own: `auto_advance` is stored and `automatically_finalizes_at` and `next_payment_attempt` are reported, but nothing acts on them without a test clock. `webhooks_delivered_at` is set when the invoice is created, because delivery is inline.
- `hosted_invoice_url` and `invoice_pdf` point at the same emulator URL, which is not served yet and answers 404.
- Invoice items created from a bare `amount` render `pricing` as `null` instead of an inline price. `price_data`, `quantity_decimal`, `tax_rates` and `discounts` params are ignored, and lines are listed oldest first.
- `/pay` ignores `forgive`, `mandate` and `source`: card payments either cover the whole amount or fail. A customer with no payment method gets a 400 and the attempt is not counted.
- Subscriptions have no prorations, `subscription_update` invoices for item changes, schedules, quotes, Trial Offers, `pause_collection`, pause or resume, `billing_cycle_anchor` params, `billing_cycle_anchor_config`, tax, discounts, coupons, pending invoice items, thresholds or Connect: those fields keep their empty or `null` defaults. `billing_mode` is always `flexible`, with `updated_at` equal to `created`. `current_trial` on items is always `null`, because only legacy trials exist, and `trial_from_plan` never starts a trial, because plans have no `trial_period_days`.
- Every item of a subscription must share one currency and one billing interval. Real Stripe allows mixed intervals under flexible billing mode.
- Billing time does not pass on its own: trials never end by themselves, periods never renew and `incomplete` subscriptions never expire after 23 hours. `trial_end` can be changed only while the subscription is `trialing`.
- The first payment of a subscription counts as an automatic collection attempt, so a decline makes the customer `delinquent`. `error_if_incomplete` rolls back everything the attempt created, including the declined charge.
- Invoice line descriptions for subscription items (`1 × Pro Plan (at $20.00 / month)`, `Free trial for 1 × Pro Plan`, tier lines) and the error messages for subscription updates are the emulator's wording. The pending invoice items of a customer are not pulled into subscription invoices.
- InvoicePayments are only of type `payment_intent`, and there is no attach-payment or detach-payment API.
- Error messages for invoice state changes (finalizing twice, voiding a paid invoice, deleting a finalized one) are the emulator's wording.
- A per-unit price may be created without `unit_amount`, `unit_amount_decimal` or `custom_unit_amount` and then charges 0. Real Stripe requires one of them.
- Prices have no update, search or delete API yet. `custom_unit_amount` is always `null`, `currency_options` holds only the price's own currency, and the `currency_options` and `custom_unit_amount` params are ignored. Currencies are checked only for being three letters.
- Metered prices are rejected until billing meters exist. Validation messages for prices and tiers are the emulator's wording.
- `GET /v1/prices` without `active` lists inactive prices too.
- Products have no update or delete API yet, so `updated` equals `created`. `default_price_data`, `marketing_features`, `package_dimensions` and `tax_code` are not modelled.

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
