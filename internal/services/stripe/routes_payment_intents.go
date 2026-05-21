package stripe

import (
	"net/http"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerPaymentIntentRoutes(router *corehttp.Router) {
	router.Post("/v1/payment_intents", s.handleCreatePaymentIntent)
	router.Get("/v1/payment_intents", s.handleListPaymentIntents)
	router.Get("/v1/payment_intents/:id", s.handleGetPaymentIntent)
	router.Post("/v1/payment_intents/:id", s.handleUpdatePaymentIntent)
	router.Post("/v1/payment_intents/:id/confirm", s.handleConfirmPaymentIntent)
	router.Post("/v1/payment_intents/:id/cancel", s.handleCancelPaymentIntent)
}

func (s *Service) handleCreatePaymentIntent(c *corehttp.Context) {
	body := parseStripeBody(c.Request)
	if intValue(body["amount"]) == 0 || stringValue(body["currency"]) == "" {
		stripeError(c, http.StatusBadRequest, "invalid_request_error", "Missing required param: amount and currency are required.", "", "amount")
		return
	}
	customerID := stringValue(body["customer"])
	if customerID != "" && firstRecord(s.store.Customers.FindBy("stripe_id", customerID)) == nil {
		stripeError(c, http.StatusBadRequest, "invalid_request_error", "No such customer: '"+customerID+"'", "resource_missing", "customer")
		return
	}
	status := "requires_payment_method"
	paymentMethod := stringValue(body["payment_method"])
	if paymentMethod != "" {
		status = "requires_confirmation"
	}
	intent := s.store.PaymentIntents.Insert(corestore.Record{
		"stripe_id":      stripeID("pi"),
		"amount":         intValue(body["amount"]),
		"currency":       strings.ToLower(stringValue(body["currency"])),
		"status":         status,
		"customer_id":    nullableString(customerID),
		"description":    stringOrNil(body["description"]),
		"payment_method": nullableString(paymentMethod),
		"metadata":       metadataValue(body["metadata"]),
	})
	c.JSON(http.StatusOK, formatPaymentIntent(intent))
}

func (s *Service) handleGetPaymentIntent(c *corehttp.Context) {
	intent := firstRecord(s.store.PaymentIntents.FindBy("stripe_id", c.Param("id")))
	if intent == nil {
		stripeError(c, http.StatusNotFound, "invalid_request_error", "No such payment_intent: '"+c.Param("id")+"'", "resource_missing", "")
		return
	}
	c.JSON(http.StatusOK, s.formatPaymentIntentWithExpand(c, intent))
}

func (s *Service) handleUpdatePaymentIntent(c *corehttp.Context) {
	intent := firstRecord(s.store.PaymentIntents.FindBy("stripe_id", c.Param("id")))
	if intent == nil {
		stripeError(c, http.StatusNotFound, "invalid_request_error", "No such payment_intent: '"+c.Param("id")+"'", "resource_missing", "")
		return
	}
	body := parseStripeBody(c.Request)
	patch := corestore.Record{}
	if _, ok := body["amount"]; ok {
		patch["amount"] = intValue(body["amount"])
	}
	if _, ok := body["currency"]; ok {
		patch["currency"] = strings.ToLower(stringValue(body["currency"]))
	}
	if _, ok := body["description"]; ok {
		patch["description"] = stringOrNil(body["description"])
	}
	if _, ok := body["metadata"]; ok {
		patch["metadata"] = metadataValue(body["metadata"])
	}
	if _, ok := body["payment_method"]; ok {
		patch["payment_method"] = stringOrNil(body["payment_method"])
		if stringField(intent, "status") == "requires_payment_method" {
			patch["status"] = "requires_confirmation"
		}
	}
	updated, _ := s.store.PaymentIntents.Update(intField(intent, "id"), patch)
	c.JSON(http.StatusOK, formatPaymentIntent(updated))
}

func (s *Service) handleConfirmPaymentIntent(c *corehttp.Context) {
	intent := firstRecord(s.store.PaymentIntents.FindBy("stripe_id", c.Param("id")))
	if intent == nil {
		stripeError(c, http.StatusNotFound, "invalid_request_error", "No such payment_intent: '"+c.Param("id")+"'", "resource_missing", "")
		return
	}
	status := stringField(intent, "status")
	if status != "requires_confirmation" && status != "requires_payment_method" {
		stripeError(c, http.StatusBadRequest, "invalid_request_error", "This PaymentIntent's status is "+status+", which does not allow confirmation.", "payment_intent_unexpected_state", "")
		return
	}
	body := parseStripeBody(c.Request)
	patch := corestore.Record{"status": "succeeded"}
	if paymentMethod := stringValue(body["payment_method"]); paymentMethod != "" {
		patch["payment_method"] = paymentMethod
	}
	updated, _ := s.store.PaymentIntents.Update(intField(intent, "id"), patch)
	s.store.Charges.Insert(corestore.Record{
		"stripe_id":         stripeID("ch"),
		"amount":            intField(updated, "amount"),
		"currency":          stringField(updated, "currency"),
		"status":            "succeeded",
		"customer_id":       updated["customer_id"],
		"payment_intent_id": stringField(updated, "stripe_id"),
		"description":       updated["description"],
		"metadata":          mapValue(updated["metadata"]),
	})
	c.JSON(http.StatusOK, formatPaymentIntent(updated))
}

func (s *Service) handleCancelPaymentIntent(c *corehttp.Context) {
	intent := firstRecord(s.store.PaymentIntents.FindBy("stripe_id", c.Param("id")))
	if intent == nil {
		stripeError(c, http.StatusNotFound, "invalid_request_error", "No such payment_intent: '"+c.Param("id")+"'", "resource_missing", "")
		return
	}
	status := stringField(intent, "status")
	if status == "succeeded" || status == "canceled" {
		stripeError(c, http.StatusBadRequest, "invalid_request_error", "This PaymentIntent's status is "+status+", which does not allow cancellation.", "payment_intent_unexpected_state", "")
		return
	}
	updated, _ := s.store.PaymentIntents.Update(intField(intent, "id"), corestore.Record{"status": "canceled"})
	c.JSON(http.StatusOK, formatPaymentIntent(updated))
}

func (s *Service) handleListPaymentIntents(c *corehttp.Context) {
	intents := s.store.PaymentIntents.All()
	if customerID := c.Query("customer"); customerID != "" {
		filtered := []corestore.Record{}
		for _, intent := range intents {
			if stringField(intent, "customer_id") == customerID {
				filtered = append(filtered, intent)
			}
		}
		intents = filtered
	}
	if status := c.Query("status"); status != "" {
		filtered := []corestore.Record{}
		for _, intent := range intents {
			if stringField(intent, "status") == status {
				filtered = append(filtered, intent)
			}
		}
		intents = filtered
	}
	stripeList(c, intents, "/v1/payment_intents", formatPaymentIntent)
}

func (s *Service) formatPaymentIntentWithExpand(c *corehttp.Context, intent corestore.Record) map[string]any {
	out := formatPaymentIntent(intent)
	if expandRequested(c, "customer") {
		customerID := stringField(intent, "customer_id")
		if customer := firstRecord(s.store.Customers.FindBy("stripe_id", customerID)); customer != nil {
			out["customer"] = formatCustomer(customer)
		}
	}
	return out
}

func formatPaymentIntent(intent corestore.Record) map[string]any {
	return map[string]any{
		"id":             stringField(intent, "stripe_id"),
		"object":         "payment_intent",
		"amount":         intField(intent, "amount"),
		"currency":       stringField(intent, "currency"),
		"status":         stringField(intent, "status"),
		"customer":       intent["customer_id"],
		"description":    intent["description"],
		"payment_method": intent["payment_method"],
		"metadata":       mapValue(intent["metadata"]),
		"created":        createdUnix(stringField(intent, "created_at")),
		"livemode":       false,
	}
}
