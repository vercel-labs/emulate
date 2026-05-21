package stripe

import (
	"net/http"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerProductRoutes(router *corehttp.Router) {
	router.Post("/v1/products", s.handleCreateProduct)
	router.Get("/v1/products", s.handleListProducts)
	router.Get("/v1/products/:id", s.handleGetProduct)
}

func (s *Service) registerPriceRoutes(router *corehttp.Router) {
	router.Post("/v1/prices", s.handleCreatePrice)
	router.Get("/v1/prices", s.handleListPrices)
	router.Get("/v1/prices/:id", s.handleGetPrice)
}

func (s *Service) handleCreateProduct(c *corehttp.Context) {
	body := parseStripeBody(c.Request)
	name := stringValue(body["name"])
	if name == "" {
		stripeError(c, http.StatusBadRequest, "invalid_request_error", "Missing required param: name.", "", "name")
		return
	}
	active := true
	if _, ok := body["active"]; ok {
		active = boolValue(body["active"])
	}
	product := s.store.Products.Insert(corestore.Record{
		"stripe_id":   stripeID("prod"),
		"name":        name,
		"description": stringOrNil(body["description"]),
		"active":      active,
		"metadata":    metadataValue(body["metadata"]),
	})
	c.JSON(http.StatusOK, formatProduct(product))
}

func (s *Service) handleGetProduct(c *corehttp.Context) {
	product := firstRecord(s.store.Products.FindBy("stripe_id", c.Param("id")))
	if product == nil {
		stripeError(c, http.StatusNotFound, "invalid_request_error", "No such product: '"+c.Param("id")+"'", "resource_missing", "")
		return
	}
	c.JSON(http.StatusOK, formatProduct(product))
}

func (s *Service) handleListProducts(c *corehttp.Context) {
	products := s.store.Products.All()
	if active := c.Query("active"); active != "" {
		want := active == "true"
		filtered := []corestore.Record{}
		for _, product := range products {
			if boolField(product, "active") == want {
				filtered = append(filtered, product)
			}
		}
		products = filtered
	}
	stripeList(c, products, "/v1/products", formatProduct)
}

func (s *Service) handleCreatePrice(c *corehttp.Context) {
	body := parseStripeBody(c.Request)
	currency := stringValue(body["currency"])
	productID := stringValue(body["product"])
	if currency == "" || productID == "" {
		stripeError(c, http.StatusBadRequest, "invalid_request_error", "Missing required param: currency and product are required.", "", "currency")
		return
	}
	if firstRecord(s.store.Products.FindBy("stripe_id", productID)) == nil {
		stripeError(c, http.StatusBadRequest, "invalid_request_error", "No such product: '"+productID+"'", "resource_missing", "product")
		return
	}
	active := true
	if _, ok := body["active"]; ok {
		active = boolValue(body["active"])
	}
	priceType := "one_time"
	if _, ok := body["recurring"]; ok {
		priceType = "recurring"
	}
	price := s.store.Prices.Insert(corestore.Record{
		"stripe_id":   stripeID("price"),
		"product_id":  productID,
		"currency":    strings.ToLower(currency),
		"unit_amount": intValue(body["unit_amount"]),
		"type":        priceType,
		"active":      active,
		"metadata":    metadataValue(body["metadata"]),
	})
	c.JSON(http.StatusOK, formatPrice(price))
}

func (s *Service) handleGetPrice(c *corehttp.Context) {
	price := firstRecord(s.store.Prices.FindBy("stripe_id", c.Param("id")))
	if price == nil {
		stripeError(c, http.StatusNotFound, "invalid_request_error", "No such price: '"+c.Param("id")+"'", "resource_missing", "")
		return
	}
	c.JSON(http.StatusOK, s.formatPriceWithExpand(c, price))
}

func (s *Service) handleListPrices(c *corehttp.Context) {
	prices := s.store.Prices.All()
	if productID := c.Query("product"); productID != "" {
		filtered := []corestore.Record{}
		for _, price := range prices {
			if stringField(price, "product_id") == productID {
				filtered = append(filtered, price)
			}
		}
		prices = filtered
	}
	if active := c.Query("active"); active != "" {
		want := active == "true"
		filtered := []corestore.Record{}
		for _, price := range prices {
			if boolField(price, "active") == want {
				filtered = append(filtered, price)
			}
		}
		prices = filtered
	}
	stripeList(c, prices, "/v1/prices", formatPrice)
}

func formatProduct(product corestore.Record) map[string]any {
	return map[string]any{
		"id":          stringField(product, "stripe_id"),
		"object":      "product",
		"name":        stringField(product, "name"),
		"description": product["description"],
		"active":      boolField(product, "active"),
		"metadata":    mapValue(product["metadata"]),
		"created":     createdUnix(stringField(product, "created_at")),
		"livemode":    false,
	}
}

func formatProductForPrice(product corestore.Record) map[string]any {
	return map[string]any{
		"id":       stringField(product, "stripe_id"),
		"object":   "product",
		"name":     stringField(product, "name"),
		"active":   boolField(product, "active"),
		"created":  createdUnix(stringField(product, "created_at")),
		"livemode": false,
	}
}

func (s *Service) formatPriceWithExpand(c *corehttp.Context, price corestore.Record) map[string]any {
	out := formatPrice(price)
	if expandRequested(c, "product") {
		productID := stringField(price, "product_id")
		if product := firstRecord(s.store.Products.FindBy("stripe_id", productID)); product != nil {
			out["product"] = formatProductForPrice(product)
		}
	}
	return out
}

func formatPrice(price corestore.Record) map[string]any {
	return map[string]any{
		"id":          stringField(price, "stripe_id"),
		"object":      "price",
		"product":     stringField(price, "product_id"),
		"currency":    stringField(price, "currency"),
		"unit_amount": intField(price, "unit_amount"),
		"type":        stringField(price, "type"),
		"active":      boolField(price, "active"),
		"metadata":    mapValue(price["metadata"]),
		"created":     createdUnix(stringField(price, "created_at")),
		"livemode":    false,
	}
}
