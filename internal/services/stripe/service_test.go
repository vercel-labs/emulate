package stripe

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func TestStripeCustomersAndPagination(t *testing.T) {
	_, handler := newStripeTestService()

	create := stripeRequest(handler, http.MethodPost, "/v1/customers", `{"email":"user@test.com","name":"Jane Doe"}`)
	var customer struct {
		ID     string `json:"id"`
		Object string `json:"object"`
		Email  string `json:"email"`
	}
	mustDecodeStripeJSON(t, create.Body.Bytes(), &customer)
	if create.Code != http.StatusOK || !strings.HasPrefix(customer.ID, "cus_") || customer.Object != "customer" || customer.Email != "user@test.com" {
		t.Fatalf("unexpected customer: status=%d body=%#v", create.Code, customer)
	}

	get := stripeRequest(handler, http.MethodGet, "/v1/customers/"+customer.ID, "")
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), `"email":"user@test.com"`) {
		t.Fatalf("unexpected get body: %s", get.Body.String())
	}

	form := stripeRequest(handler, http.MethodPost, "/v1/customers", "email=form%40test.com&name=Form+User")
	if form.Code != http.StatusOK || !strings.Contains(form.Body.String(), `"email":"form@test.com"`) || !strings.Contains(form.Body.String(), `"name":"Form User"`) {
		t.Fatalf("unexpected form body: %s", form.Body.String())
	}

	missing := stripeRequest(handler, http.MethodGet, "/v1/customers/cus_nonexistent", "")
	if missing.Code != http.StatusNotFound || !strings.Contains(missing.Body.String(), `"code":"resource_missing"`) {
		t.Fatalf("unexpected missing body: status=%d body=%s", missing.Code, missing.Body.String())
	}

	page := stripeRequest(handler, http.MethodGet, "/v1/customers?limit=2", "")
	var list struct {
		Object  string           `json:"object"`
		HasMore bool             `json:"has_more"`
		Data    []map[string]any `json:"data"`
	}
	mustDecodeStripeJSON(t, page.Body.Bytes(), &list)
	if page.Code != http.StatusOK || list.Object != "list" || len(list.Data) != 2 || !list.HasMore {
		t.Fatalf("unexpected list: status=%d body=%#v", page.Code, list)
	}
}

func TestStripePaymentIntentConfirmCreatesChargeAndExpandsCustomer(t *testing.T) {
	_, handler := newStripeTestService()

	custRes := stripeRequest(handler, http.MethodPost, "/v1/customers", `{"email":"expand@test.com","name":"Expand Test"}`)
	var customer struct {
		ID string `json:"id"`
	}
	mustDecodeStripeJSON(t, custRes.Body.Bytes(), &customer)

	create := stripeRequest(handler, http.MethodPost, "/v1/payment_intents", `{"amount":5000,"currency":"usd","customer":"`+customer.ID+`","payment_method":"pm_card_visa"}`)
	var intent struct {
		ID       string `json:"id"`
		Status   string `json:"status"`
		Customer string `json:"customer"`
	}
	mustDecodeStripeJSON(t, create.Body.Bytes(), &intent)
	if create.Code != http.StatusOK || !strings.HasPrefix(intent.ID, "pi_") || intent.Status != "requires_confirmation" || intent.Customer != customer.ID {
		t.Fatalf("unexpected intent: status=%d body=%#v", create.Code, intent)
	}

	expanded := stripeRequest(handler, http.MethodGet, "/v1/payment_intents/"+intent.ID+"?expand[]=customer", "")
	if expanded.Code != http.StatusOK || !strings.Contains(expanded.Body.String(), `"customer":{"`) || !strings.Contains(expanded.Body.String(), `"email":"expand@test.com"`) {
		t.Fatalf("unexpected expanded intent: %s", expanded.Body.String())
	}

	confirmed := stripeRequest(handler, http.MethodPost, "/v1/payment_intents/"+intent.ID+"/confirm", `{}`)
	if confirmed.Code != http.StatusOK || !strings.Contains(confirmed.Body.String(), `"status":"succeeded"`) {
		t.Fatalf("unexpected confirmed body: %s", confirmed.Body.String())
	}

	charges := stripeRequest(handler, http.MethodGet, "/v1/charges?payment_intent="+intent.ID, "")
	if charges.Code != http.StatusOK || !strings.Contains(charges.Body.String(), `"amount":5000`) || !strings.Contains(charges.Body.String(), `"status":"succeeded"`) {
		t.Fatalf("unexpected charges body: %s", charges.Body.String())
	}

	secondConfirm := stripeRequest(handler, http.MethodPost, "/v1/payment_intents/"+intent.ID+"/confirm", `{}`)
	if secondConfirm.Code != http.StatusBadRequest || !strings.Contains(secondConfirm.Body.String(), `"code":"payment_intent_unexpected_state"`) {
		t.Fatalf("unexpected second confirm body: status=%d body=%s", secondConfirm.Code, secondConfirm.Body.String())
	}
}

func TestStripeCatalogCheckoutAndCustomerSession(t *testing.T) {
	_, handler := newStripeTestService()

	productRes := stripeRequest(handler, http.MethodPost, "/v1/products", `{"name":"T-Shirt"}`)
	var product struct {
		ID string `json:"id"`
	}
	mustDecodeStripeJSON(t, productRes.Body.Bytes(), &product)
	if productRes.Code != http.StatusOK || !strings.HasPrefix(product.ID, "prod_") {
		t.Fatalf("unexpected product: status=%d body=%#v", productRes.Code, product)
	}

	priceRes := stripeRequest(handler, http.MethodPost, "/v1/prices", `{"product":"`+product.ID+`","currency":"usd","unit_amount":2000}`)
	var price struct {
		ID      string `json:"id"`
		Product string `json:"product"`
	}
	mustDecodeStripeJSON(t, priceRes.Body.Bytes(), &price)
	if priceRes.Code != http.StatusOK || !strings.HasPrefix(price.ID, "price_") || price.Product != product.ID {
		t.Fatalf("unexpected price: status=%d body=%#v", priceRes.Code, price)
	}

	expandedPrice := stripeRequest(handler, http.MethodGet, "/v1/prices/"+price.ID+"?expand[]=product", "")
	if expandedPrice.Code != http.StatusOK || !strings.Contains(expandedPrice.Body.String(), `"product":{"`) || !strings.Contains(expandedPrice.Body.String(), `"name":"T-Shirt"`) {
		t.Fatalf("unexpected expanded price: %s", expandedPrice.Body.String())
	}

	sessionRes := stripeRequest(handler, http.MethodPost, "/v1/checkout/sessions", url.Values{
		"mode":                    {"payment"},
		"line_items[0][price]":    {price.ID},
		"line_items[0][quantity]": {"2"},
		"success_url":             {"https://example.com/success?session_id={CHECKOUT_SESSION_ID}"},
	}.Encode())
	var session struct {
		ID     string `json:"id"`
		Status string `json:"status"`
		URL    string `json:"url"`
	}
	mustDecodeStripeJSON(t, sessionRes.Body.Bytes(), &session)
	if sessionRes.Code != http.StatusOK || !strings.HasPrefix(session.ID, "cs_") || session.Status != "open" || session.URL == "" {
		t.Fatalf("unexpected session: status=%d body=%#v", sessionRes.Code, session)
	}

	page := stripeRequest(handler, http.MethodGet, "/checkout/"+session.ID, "")
	if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), "T-Shirt") || !strings.Contains(page.Body.String(), "Pay $40.00") {
		t.Fatalf("unexpected checkout page: status=%d body=%s", page.Code, page.Body.String())
	}

	complete := stripeRequest(handler, http.MethodPost, "/checkout/"+session.ID+"/complete", "")
	if complete.Code != http.StatusFound || !strings.Contains(complete.Header().Get("Location"), session.ID) {
		t.Fatalf("unexpected complete redirect: status=%d location=%s body=%s", complete.Code, complete.Header().Get("Location"), complete.Body.String())
	}

	customerRes := stripeRequest(handler, http.MethodPost, "/v1/customers", `{"email":"session@test.com"}`)
	var customer struct {
		ID string `json:"id"`
	}
	mustDecodeStripeJSON(t, customerRes.Body.Bytes(), &customer)
	customerSession := stripeRequest(handler, http.MethodPost, "/v1/customer_sessions", `{"customer":"`+customer.ID+`","components":{"payment_element":{"enabled":true}}}`)
	if customerSession.Code != http.StatusOK || !strings.Contains(customerSession.Body.String(), `"object":"customer_session"`) || !strings.Contains(customerSession.Body.String(), `"customer":"`+customer.ID+`"`) {
		t.Fatalf("unexpected customer session: status=%d body=%s", customerSession.Code, customerSession.Body.String())
	}
}

func TestStripePaymentMethodsAndSeedConfig(t *testing.T) {
	store := corestore.New()
	service := New(Options{
		Store:   store,
		BaseURL: "http://localhost:4020",
		Seed: &SeedConfig{
			Customers: []CustomerSeed{{Email: "seed@test.com", Name: "Seeded User"}},
			Products:  []ProductSeed{{Name: "Widget"}},
			Prices:    []PriceSeed{{ProductName: "Widget", Currency: "usd", UnitAmount: 999}},
		},
	})
	router := corehttp.NewRouter()
	service.RegisterRoutes(router)

	customers := service.store.Customers.FindBy("email", "seed@test.com")
	if len(customers) != 1 {
		t.Fatalf("seeded customers: %#v", customers)
	}
	product := firstRecord(service.store.Products.FindBy("stripe_id", stringField(firstRecord(service.store.Products.All()), "stripe_id")))
	if product == nil || stringField(product, "name") != "Widget" {
		t.Fatalf("seeded product: %#v", product)
	}
	prices := service.store.Prices.FindBy("product_id", stringField(product, "stripe_id"))
	if len(prices) != 1 || intField(prices[0], "unit_amount") != 999 {
		t.Fatalf("seeded prices: %#v", prices)
	}

	methods := stripeRequest(router, http.MethodGet, "/v1/payment_methods?customer="+stringField(customers[0], "stripe_id")+"&type=card", "")
	if methods.Code != http.StatusOK || !strings.Contains(methods.Body.String(), `"object":"list"`) || !strings.Contains(methods.Body.String(), `"data":[]`) {
		t.Fatalf("unexpected methods body: status=%d body=%s", methods.Code, methods.Body.String())
	}
	missing := stripeRequest(router, http.MethodGet, "/v1/payment_methods?customer=cus_nonexistent&type=card", "")
	if missing.Code != http.StatusBadRequest || !strings.Contains(missing.Body.String(), `"param":"customer"`) {
		t.Fatalf("unexpected missing methods body: status=%d body=%s", missing.Code, missing.Body.String())
	}
}

func newStripeTestService() (*Service, http.Handler) {
	service := New(Options{Store: corestore.New(), BaseURL: "http://localhost:4020"})
	router := corehttp.NewRouter()
	service.RegisterRoutes(router)
	return service, router
}

func stripeRequest(handler http.Handler, method string, path string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://localhost:4020"+path, strings.NewReader(body))
	if body != "" {
		if strings.Contains(body, "=") && !strings.HasPrefix(strings.TrimSpace(body), "{") {
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		} else {
			req.Header.Set("Content-Type", "application/json")
		}
	}
	req.Header.Set("Authorization", "Bearer sk_test_emulated")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func mustDecodeStripeJSON(t *testing.T, raw []byte, target any) {
	t.Helper()
	if err := json.Unmarshal(raw, target); err != nil {
		t.Fatalf("decode JSON: %v\n%s", err, string(raw))
	}
}
