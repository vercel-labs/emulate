package stripe

import corestore "github.com/vercel-labs/emulate/internal/core/store"

type Store struct {
	Customers        *corestore.Collection
	Products         *corestore.Collection
	Prices           *corestore.Collection
	PaymentIntents   *corestore.Collection
	Charges          *corestore.Collection
	CheckoutSessions *corestore.Collection
}

func NewStore(store *corestore.Store) Store {
	return Store{
		Customers:        store.MustCollection("stripe.customers", "stripe_id", "email"),
		Products:         store.MustCollection("stripe.products", "stripe_id"),
		Prices:           store.MustCollection("stripe.prices", "stripe_id", "product_id"),
		PaymentIntents:   store.MustCollection("stripe.payment_intents", "stripe_id", "customer_id"),
		Charges:          store.MustCollection("stripe.charges", "stripe_id", "customer_id", "payment_intent_id"),
		CheckoutSessions: store.MustCollection("stripe.checkout_sessions", "stripe_id", "customer_id"),
	}
}
