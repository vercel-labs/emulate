package stripe

import (
	"net/http"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerCustomerRoutes(router *corehttp.Router) {
	router.Post("/v1/customers", s.handleCreateCustomer)
	router.Get("/v1/customers", s.handleListCustomers)
	router.Get("/v1/customers/:id", s.handleGetCustomer)
	router.Post("/v1/customers/:id", s.handleUpdateCustomer)
	router.Delete("/v1/customers/:id", s.handleDeleteCustomer)
}

func (s *Service) handleCreateCustomer(c *corehttp.Context) {
	body := parseStripeBody(c.Request)
	customer := s.store.Customers.Insert(corestore.Record{
		"stripe_id":   stripeID("cus"),
		"email":       stringOrNil(body["email"]),
		"name":        stringOrNil(body["name"]),
		"description": stringOrNil(body["description"]),
		"metadata":    metadataValue(body["metadata"]),
	})
	c.JSON(http.StatusOK, formatCustomer(customer))
}

func (s *Service) handleGetCustomer(c *corehttp.Context) {
	customer := firstRecord(s.store.Customers.FindBy("stripe_id", c.Param("id")))
	if customer == nil {
		stripeError(c, http.StatusNotFound, "invalid_request_error", "No such customer: '"+c.Param("id")+"'", "resource_missing", "")
		return
	}
	c.JSON(http.StatusOK, formatCustomer(customer))
}

func (s *Service) handleUpdateCustomer(c *corehttp.Context) {
	customer := firstRecord(s.store.Customers.FindBy("stripe_id", c.Param("id")))
	if customer == nil {
		stripeError(c, http.StatusNotFound, "invalid_request_error", "No such customer: '"+c.Param("id")+"'", "resource_missing", "")
		return
	}
	body := parseStripeBody(c.Request)
	patch := corestore.Record{}
	if _, ok := body["email"]; ok {
		patch["email"] = stringOrNil(body["email"])
	}
	if _, ok := body["name"]; ok {
		patch["name"] = stringOrNil(body["name"])
	}
	if _, ok := body["description"]; ok {
		patch["description"] = stringOrNil(body["description"])
	}
	if _, ok := body["metadata"]; ok {
		patch["metadata"] = metadataValue(body["metadata"])
	}
	updated, _ := s.store.Customers.Update(intField(customer, "id"), patch)
	c.JSON(http.StatusOK, formatCustomer(updated))
}

func (s *Service) handleDeleteCustomer(c *corehttp.Context) {
	customer := firstRecord(s.store.Customers.FindBy("stripe_id", c.Param("id")))
	if customer == nil {
		stripeError(c, http.StatusNotFound, "invalid_request_error", "No such customer: '"+c.Param("id")+"'", "resource_missing", "")
		return
	}
	customerID := stringField(customer, "stripe_id")
	for _, intent := range s.store.PaymentIntents.FindBy("customer_id", customerID) {
		s.store.PaymentIntents.Update(intField(intent, "id"), corestore.Record{"customer_id": nil})
	}
	for _, charge := range s.store.Charges.FindBy("customer_id", customerID) {
		s.store.Charges.Update(intField(charge, "id"), corestore.Record{"customer_id": nil})
	}
	for _, session := range s.store.CheckoutSessions.FindBy("customer_id", customerID) {
		s.store.CheckoutSessions.Update(intField(session, "id"), corestore.Record{"customer_id": nil})
	}
	s.store.Customers.Delete(intField(customer, "id"))
	c.JSON(http.StatusOK, map[string]any{"id": customerID, "object": "customer", "deleted": true})
}

func (s *Service) handleListCustomers(c *corehttp.Context) {
	customers := s.store.Customers.All()
	if email := c.Query("email"); email != "" {
		filtered := []corestore.Record{}
		for _, customer := range customers {
			if stringField(customer, "email") == email {
				filtered = append(filtered, customer)
			}
		}
		customers = filtered
	}
	stripeList(c, customers, "/v1/customers", formatCustomer)
}

func formatCustomer(customer corestore.Record) map[string]any {
	return map[string]any{
		"id":          stringField(customer, "stripe_id"),
		"object":      "customer",
		"email":       customer["email"],
		"name":        customer["name"],
		"description": customer["description"],
		"metadata":    mapValue(customer["metadata"]),
		"created":     createdUnix(stringField(customer, "created_at")),
		"livemode":    false,
	}
}
