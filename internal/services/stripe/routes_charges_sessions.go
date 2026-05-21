package stripe

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/core/ui"
)

func (s *Service) registerChargeRoutes(router *corehttp.Router) {
	router.Get("/v1/charges", s.handleListCharges)
	router.Get("/v1/charges/:id", s.handleGetCharge)
}

func (s *Service) registerPaymentMethodRoutes(router *corehttp.Router) {
	router.Get("/v1/payment_methods", s.handleListPaymentMethods)
}

func (s *Service) registerCustomerSessionRoutes(router *corehttp.Router) {
	router.Post("/v1/customer_sessions", s.handleCreateCustomerSession)
}

func (s *Service) registerCheckoutSessionRoutes(router *corehttp.Router) {
	router.Post("/v1/checkout/sessions", s.handleCreateCheckoutSession)
	router.Get("/v1/checkout/sessions", s.handleListCheckoutSessions)
	router.Get("/v1/checkout/sessions/:id", s.handleGetCheckoutSession)
	router.Post("/v1/checkout/sessions/:id/expire", s.handleExpireCheckoutSession)
	router.Get("/checkout/:id", s.handleCheckoutPage)
	router.Post("/checkout/:id/complete", s.handleCompleteCheckoutSession)
}

func (s *Service) handleGetCharge(c *corehttp.Context) {
	charge := firstRecord(s.store.Charges.FindBy("stripe_id", c.Param("id")))
	if charge == nil {
		stripeError(c, http.StatusNotFound, "invalid_request_error", "No such charge: '"+c.Param("id")+"'", "resource_missing", "")
		return
	}
	c.JSON(http.StatusOK, s.formatChargeWithExpand(c, charge))
}

func (s *Service) handleListCharges(c *corehttp.Context) {
	charges := s.store.Charges.All()
	if customerID := c.Query("customer"); customerID != "" {
		filtered := []corestore.Record{}
		for _, charge := range charges {
			if stringField(charge, "customer_id") == customerID {
				filtered = append(filtered, charge)
			}
		}
		charges = filtered
	}
	if intentID := c.Query("payment_intent"); intentID != "" {
		filtered := []corestore.Record{}
		for _, charge := range charges {
			if stringField(charge, "payment_intent_id") == intentID {
				filtered = append(filtered, charge)
			}
		}
		charges = filtered
	}
	stripeList(c, charges, "/v1/charges", formatCharge)
}

func (s *Service) handleListPaymentMethods(c *corehttp.Context) {
	customerID := c.Query("customer")
	if customerID != "" && firstRecord(s.store.Customers.FindBy("stripe_id", customerID)) == nil {
		stripeError(c, http.StatusBadRequest, "invalid_request_error", "No such customer: '"+customerID+"'", "resource_missing", "customer")
		return
	}
	c.JSON(http.StatusOK, map[string]any{
		"object":   "list",
		"url":      "/v1/payment_methods",
		"has_more": false,
		"data":     []any{},
	})
}

func (s *Service) handleCreateCustomerSession(c *corehttp.Context) {
	body := parseStripeBody(c.Request)
	customerID := stringValue(body["customer"])
	if customerID == "" {
		stripeError(c, http.StatusBadRequest, "invalid_request_error", "Missing required param: customer.", "", "customer")
		return
	}
	customer := firstRecord(s.store.Customers.FindBy("stripe_id", customerID))
	if customer == nil {
		stripeError(c, http.StatusBadRequest, "invalid_request_error", "No such customer: '"+customerID+"'", "resource_missing", "customer")
		return
	}
	now := time.Now().Unix()
	c.JSON(http.StatusOK, map[string]any{
		"object":        "customer_session",
		"client_secret": stripeID("cuss_secret"),
		"components":    mapValue(body["components"]),
		"created":       now,
		"customer":      stringField(customer, "stripe_id"),
		"expires_at":    now + 1800,
		"livemode":      false,
	})
}

func (s *Service) handleCreateCheckoutSession(c *corehttp.Context) {
	body := parseStripeBody(c.Request)
	mode := stringValue(body["mode"])
	if mode == "" {
		stripeError(c, http.StatusBadRequest, "invalid_request_error", "Missing required param: mode.", "", "mode")
		return
	}
	customerID := stringValue(body["customer"])
	if customerID != "" && firstRecord(s.store.Customers.FindBy("stripe_id", customerID)) == nil {
		stripeError(c, http.StatusBadRequest, "invalid_request_error", "No such customer: '"+customerID+"'", "resource_missing", "customer")
		return
	}
	lineItems, ok := s.parseLineItems(c, body["line_items"])
	if !ok {
		return
	}
	session := s.store.CheckoutSessions.Insert(corestore.Record{
		"stripe_id":      stripeID("cs"),
		"mode":           mode,
		"status":         "open",
		"payment_status": "unpaid",
		"customer_id":    nullableString(customerID),
		"success_url":    stringOrNil(body["success_url"]),
		"cancel_url":     stringOrNil(body["cancel_url"]),
		"line_items":     lineItems,
		"metadata":       metadataValue(body["metadata"]),
	})
	c.JSON(http.StatusOK, s.formatCheckoutSession(session))
}

func (s *Service) parseLineItems(c *corehttp.Context, value any) ([]map[string]any, bool) {
	if value == nil {
		return []map[string]any{}, true
	}
	rawItems, ok := value.([]any)
	if !ok {
		stripeError(c, http.StatusBadRequest, "invalid_request_error", "line_items must be an array.", "", "line_items")
		return nil, false
	}
	lineItems := make([]map[string]any, 0, len(rawItems))
	for index, raw := range rawItems {
		item, ok := raw.(map[string]any)
		if !ok {
			stripeError(c, http.StatusBadRequest, "invalid_request_error", "Invalid line_items["+strconv.Itoa(index)+"]: must be an object.", "", "line_items["+strconv.Itoa(index)+"]")
			return nil, false
		}
		priceID := stringValue(item["price"])
		if priceID == "" {
			param := "line_items[" + strconv.Itoa(index) + "][price]"
			stripeError(c, http.StatusBadRequest, "invalid_request_error", "Missing required param: "+param+".", "", param)
			return nil, false
		}
		if firstRecord(s.store.Prices.FindBy("stripe_id", priceID)) == nil {
			param := "line_items[" + strconv.Itoa(index) + "][price]"
			stripeError(c, http.StatusBadRequest, "invalid_request_error", "No such price: '"+priceID+"'", "resource_missing", param)
			return nil, false
		}
		quantity := intValue(item["quantity"])
		if quantity < 1 {
			param := "line_items[" + strconv.Itoa(index) + "][quantity]"
			stripeError(c, http.StatusBadRequest, "invalid_request_error", "Invalid "+param+": must be a positive integer.", "", param)
			return nil, false
		}
		lineItems = append(lineItems, map[string]any{"price": priceID, "quantity": quantity})
	}
	return lineItems, true
}

func (s *Service) handleGetCheckoutSession(c *corehttp.Context) {
	session := firstRecord(s.store.CheckoutSessions.FindBy("stripe_id", c.Param("id")))
	if session == nil {
		stripeError(c, http.StatusNotFound, "invalid_request_error", "No such checkout session: '"+c.Param("id")+"'", "resource_missing", "")
		return
	}
	c.JSON(http.StatusOK, s.formatCheckoutSession(session))
}

func (s *Service) handleExpireCheckoutSession(c *corehttp.Context) {
	session := firstRecord(s.store.CheckoutSessions.FindBy("stripe_id", c.Param("id")))
	if session == nil {
		stripeError(c, http.StatusNotFound, "invalid_request_error", "No such checkout session: '"+c.Param("id")+"'", "resource_missing", "")
		return
	}
	if stringField(session, "status") != "open" {
		stripeError(c, http.StatusBadRequest, "invalid_request_error", "Only open sessions can be expired.", "checkout_session_not_open", "")
		return
	}
	updated, _ := s.store.CheckoutSessions.Update(intField(session, "id"), corestore.Record{"status": "expired"})
	c.JSON(http.StatusOK, s.formatCheckoutSession(updated))
}

func (s *Service) handleListCheckoutSessions(c *corehttp.Context) {
	sessions := s.store.CheckoutSessions.All()
	if customerID := c.Query("customer"); customerID != "" {
		filtered := []corestore.Record{}
		for _, session := range sessions {
			if stringField(session, "customer_id") == customerID {
				filtered = append(filtered, session)
			}
		}
		sessions = filtered
	}
	if status := c.Query("status"); status != "" {
		filtered := []corestore.Record{}
		for _, session := range sessions {
			if stringField(session, "status") == status {
				filtered = append(filtered, session)
			}
		}
		sessions = filtered
	}
	if paymentStatus := c.Query("payment_status"); paymentStatus != "" {
		filtered := []corestore.Record{}
		for _, session := range sessions {
			if stringField(session, "payment_status") == paymentStatus {
				filtered = append(filtered, session)
			}
		}
		sessions = filtered
	}
	stripeList(c, sessions, "/v1/checkout/sessions", s.formatCheckoutSession)
}

func (s *Service) handleCheckoutPage(c *corehttp.Context) {
	session := firstRecord(s.store.CheckoutSessions.FindBy("stripe_id", c.Param("id")))
	if session == nil {
		c.HTML(http.StatusNotFound, ui.RenderCardPage("Session Not Found", "This checkout session does not exist.", `<p class="empty">The session ID is invalid or has been removed.</p>`, ui.PageOptions{Service: serviceLabel}))
		return
	}
	if stringField(session, "status") != "open" {
		c.HTML(http.StatusOK, ui.RenderCardPage("Session Expired", "This checkout session is no longer available.", `<p class="empty">Status: `+ui.EscapeHTML(stringField(session, "status"))+`</p>`, ui.PageOptions{Service: serviceLabel}))
		return
	}
	lineItems := []ui.CheckoutLineItem{}
	for _, item := range recordSliceValue(session["line_items"]) {
		price := firstRecord(s.store.Prices.FindBy("stripe_id", stringValue(item["price"])))
		var product corestore.Record
		if price != nil {
			product = firstRecord(s.store.Products.FindBy("stripe_id", stringField(price, "product_id")))
		}
		quantity := intValue(item["quantity"])
		unitPrice := intField(price, "unit_amount")
		name := stringValue(item["price"])
		if product != nil {
			name = stringField(product, "name")
		}
		currency := "usd"
		if price != nil && stringField(price, "currency") != "" {
			currency = stringField(price, "currency")
		}
		lineItems = append(lineItems, ui.CheckoutLineItem{
			Name:       name,
			Quantity:   quantity,
			UnitPrice:  unitPrice,
			TotalPrice: unitPrice * quantity,
			Currency:   currency,
		})
	}
	subtotal := 0
	currency := "usd"
	for index, item := range lineItems {
		subtotal += item.TotalPrice
		if index == 0 && item.Currency != "" {
			currency = item.Currency
		}
	}
	c.HTML(http.StatusOK, ui.RenderCheckoutPage(ui.CheckoutPageOptions{
		LineItems: lineItems,
		Subtotal:  subtotal,
		Total:     subtotal,
		Currency:  currency,
		SessionID: stringField(session, "stripe_id"),
		CancelURL: stringField(session, "cancel_url"),
	}, ui.PageOptions{Service: serviceLabel}))
}

func (s *Service) handleCompleteCheckoutSession(c *corehttp.Context) {
	session := firstRecord(s.store.CheckoutSessions.FindBy("stripe_id", c.Param("id")))
	if session == nil || stringField(session, "status") != "open" {
		c.Redirect(http.StatusFound, "/checkout/"+c.Param("id"))
		return
	}
	updated, _ := s.store.CheckoutSessions.Update(intField(session, "id"), corestore.Record{"status": "complete", "payment_status": "paid"})
	if successURL := stringField(session, "success_url"); successURL != "" {
		c.Redirect(http.StatusFound, strings.ReplaceAll(successURL, "{CHECKOUT_SESSION_ID}", stringField(updated, "stripe_id")))
		return
	}
	c.HTML(http.StatusOK, ui.RenderCardPage("Payment Complete", "Your payment was successful.", `<p class="empty check">Payment received</p>`, ui.PageOptions{Service: serviceLabel}))
}

func (s *Service) formatChargeWithExpand(c *corehttp.Context, charge corestore.Record) map[string]any {
	out := formatCharge(charge)
	if expandRequested(c, "customer") {
		if customer := firstRecord(s.store.Customers.FindBy("stripe_id", stringField(charge, "customer_id"))); customer != nil {
			out["customer"] = formatCustomer(customer)
		}
	}
	if expandRequested(c, "payment_intent") {
		if intent := firstRecord(s.store.PaymentIntents.FindBy("stripe_id", stringField(charge, "payment_intent_id"))); intent != nil {
			out["payment_intent"] = formatPaymentIntent(intent)
		}
	}
	return out
}

func formatCharge(charge corestore.Record) map[string]any {
	return map[string]any{
		"id":             stringField(charge, "stripe_id"),
		"object":         "charge",
		"amount":         intField(charge, "amount"),
		"currency":       stringField(charge, "currency"),
		"status":         stringField(charge, "status"),
		"customer":       charge["customer_id"],
		"payment_intent": charge["payment_intent_id"],
		"description":    charge["description"],
		"metadata":       mapValue(charge["metadata"]),
		"created":        createdUnix(stringField(charge, "created_at")),
		"livemode":       false,
	}
}

func (s *Service) formatCheckoutSession(session corestore.Record) map[string]any {
	var sessionURL any
	if stringField(session, "status") == "open" {
		sessionURL = s.baseURL + "/checkout/" + stringField(session, "stripe_id")
	}
	return map[string]any{
		"id":             stringField(session, "stripe_id"),
		"object":         "checkout.session",
		"mode":           stringField(session, "mode"),
		"status":         stringField(session, "status"),
		"payment_status": stringField(session, "payment_status"),
		"customer":       session["customer_id"],
		"success_url":    session["success_url"],
		"cancel_url":     session["cancel_url"],
		"metadata":       mapValue(session["metadata"]),
		"created":        createdUnix(stringField(session, "created_at")),
		"livemode":       false,
		"url":            sessionURL,
	}
}
