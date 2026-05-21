package stripe

import (
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

const serviceLabel = "Stripe"

type Options struct {
	Store   *corestore.Store
	BaseURL string
	Seed    *SeedConfig
}

type SeedConfig struct {
	Port      int            `json:"port,omitempty"`
	Customers []CustomerSeed `json:"customers"`
	Products  []ProductSeed  `json:"products"`
	Prices    []PriceSeed    `json:"prices"`
	Webhooks  []WebhookSeed  `json:"webhooks"`
}

type CustomerSeed struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type ProductSeed struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type PriceSeed struct {
	ID          string `json:"id"`
	ProductName string `json:"product_name"`
	Currency    string `json:"currency"`
	UnitAmount  int    `json:"unit_amount"`
}

type WebhookSeed struct {
	URL    string   `json:"url"`
	Events []string `json:"events"`
	Secret string   `json:"secret"`
}

type Service struct {
	store   Store
	baseURL string
}

func Register(router *corehttp.Router, options Options) {
	service := New(options)
	service.RegisterRoutes(router)
}

func New(options Options) *Service {
	runtimeStore := options.Store
	if runtimeStore == nil {
		runtimeStore = corestore.New()
	}
	baseURL := strings.TrimRight(options.BaseURL, "/")
	if baseURL == "" {
		baseURL = "http://localhost:4000"
	}
	service := &Service{
		store:   NewStore(runtimeStore),
		baseURL: baseURL,
	}
	service.SeedDefaults()
	if options.Seed != nil {
		service.SeedFromConfig(*options.Seed)
	}
	return service
}

func SeedFromConfig(runtimeStore *corestore.Store, baseURL string, config SeedConfig) {
	New(Options{Store: runtimeStore, BaseURL: baseURL, Seed: &config})
}

func (s *Service) RegisterRoutes(router *corehttp.Router) {
	s.registerCustomerRoutes(router)
	s.registerPaymentMethodRoutes(router)
	s.registerPaymentIntentRoutes(router)
	s.registerChargeRoutes(router)
	s.registerProductRoutes(router)
	s.registerPriceRoutes(router)
	s.registerCheckoutSessionRoutes(router)
	s.registerCustomerSessionRoutes(router)
}

func (s *Service) SeedDefaults() {
	if s.store.Customers.Count() > 0 {
		return
	}
	s.store.Customers.Insert(corestore.Record{
		"stripe_id":   stripeID("cus"),
		"email":       "test@example.com",
		"name":        "Test Customer",
		"description": nil,
		"metadata":    map[string]any{},
	})
}

func (s *Service) SeedFromConfig(config SeedConfig) {
	for _, customer := range config.Customers {
		if customer.Email != "" && firstRecord(s.store.Customers.FindBy("email", customer.Email)) != nil {
			continue
		}
		id := customer.ID
		if id == "" {
			id = stripeID("cus")
		}
		s.store.Customers.Insert(corestore.Record{
			"stripe_id":   id,
			"email":       nullableString(customer.Email),
			"name":        nullableString(customer.Name),
			"description": nullableString(customer.Description),
			"metadata":    map[string]any{},
		})
	}

	for _, productSeed := range config.Products {
		if strings.TrimSpace(productSeed.Name) == "" {
			continue
		}
		id := productSeed.ID
		if id == "" {
			id = stripeID("prod")
		}
		product := s.store.Products.Insert(corestore.Record{
			"stripe_id":   id,
			"name":        productSeed.Name,
			"description": nullableString(productSeed.Description),
			"active":      true,
			"metadata":    map[string]any{},
		})
		for _, priceSeed := range config.Prices {
			if priceSeed.ProductName != productSeed.Name {
				continue
			}
			priceID := priceSeed.ID
			if priceID == "" {
				priceID = stripeID("price")
			}
			currency := strings.ToLower(priceSeed.Currency)
			if currency == "" {
				currency = "usd"
			}
			s.store.Prices.Insert(corestore.Record{
				"stripe_id":   priceID,
				"product_id":  stringField(product, "stripe_id"),
				"currency":    currency,
				"unit_amount": priceSeed.UnitAmount,
				"type":        "one_time",
				"active":      true,
				"metadata":    map[string]any{},
			})
		}
	}
}
