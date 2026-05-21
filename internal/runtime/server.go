package runtime

import (
	"net/http"
	"strings"

	coreassets "github.com/vercel-labs/emulate/internal/core/assets"
	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	"github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/core/ui"
	"github.com/vercel-labs/emulate/internal/services/apple"
	"github.com/vercel-labs/emulate/internal/services/aws"
	"github.com/vercel-labs/emulate/internal/services/clerk"
	"github.com/vercel-labs/emulate/internal/services/github"
	"github.com/vercel-labs/emulate/internal/services/google"
	"github.com/vercel-labs/emulate/internal/services/microsoft"
	"github.com/vercel-labs/emulate/internal/services/mongoatlas"
	"github.com/vercel-labs/emulate/internal/services/okta"
	"github.com/vercel-labs/emulate/internal/services/resend"
	"github.com/vercel-labs/emulate/internal/services/slack"
	"github.com/vercel-labs/emulate/internal/services/stripe"
	"github.com/vercel-labs/emulate/internal/services/vercel"
)

const HealthPath = "/_emulate/health"

type ServerOptions struct {
	Version        string
	BaseURL        string
	Services       []string
	Store          *store.Store
	AssetStore     *coreassets.Store
	AppleSeed      *apple.SeedConfig
	AWSSeed        *aws.SeedConfig
	ClerkSeed      *clerk.SeedConfig
	GitHubSeed     *github.SeedConfig
	GoogleSeed     *google.SeedConfig
	MicrosoftSeed  *microsoft.SeedConfig
	MongoAtlasSeed *mongoatlas.SeedConfig
	OktaSeed       *okta.SeedConfig
	ResendSeed     *resend.SeedConfig
	SlackSeed      *slack.SeedConfig
	StripeSeed     *stripe.SeedConfig
	VercelSeed     *vercel.SeedConfig
}

type Server struct {
	Handler    http.Handler
	Store      *store.Store
	AssetStore *coreassets.Store
	Version    string
	BaseURL    string
	Services   []string
}

func NewHandler(options ServerOptions) http.Handler {
	return NewServer(options).Handler
}

func NewServer(options ServerOptions) *Server {
	version := options.Version
	if version == "" {
		version = "dev"
	}
	services := append([]string(nil), options.Services...)
	if len(services) == 0 {
		services = ServiceNames()
	}

	runtimeStore := options.Store
	if runtimeStore == nil {
		runtimeStore = store.New()
	}
	assetStore := options.AssetStore
	if assetStore == nil {
		assetStore = coreassets.New()
	}

	router := corehttp.NewRouter()
	ui.RegisterAssetRoutes(router)
	router.Get(HealthPath, func(c *corehttp.Context) {
		c.JSON(http.StatusOK, map[string]any{
			"ok":       true,
			"runtime":  "go",
			"version":  version,
			"base_url": options.BaseURL,
			"services": services,
		})
	})
	router.Get("/health", func(c *corehttp.Context) {
		c.JSON(http.StatusOK, map[string]any{
			"ok":      true,
			"runtime": "go",
		})
	})
	ambiguousOIDCServices := enabledRootOIDCServices(services)
	clerkNeedsOAuthPrefix := serviceEnabled(services, "clerk") && serviceEnabled(services, "vercel")
	if len(ambiguousOIDCServices) > 1 || clerkNeedsOAuthPrefix {
		router.Get("/.well-known/openid-configuration", func(c *corehttp.Context) {
			paths := oidcDiscoveryPaths(ambiguousOIDCServices)
			if clerkNeedsOAuthPrefix {
				paths["clerk"] = "/clerk/.well-known/openid-configuration"
			}
			c.JSON(http.StatusBadRequest, map[string]any{
				"message":  "Root OIDC discovery is ambiguous for the enabled services. Use a service specific discovery path.",
				"services": ambiguousOIDCServices,
				"paths":    paths,
			})
		})
	}
	if serviceEnabled(services, "aws") {
		aws.Register(router, aws.Options{
			Store:          runtimeStore,
			S3PathFallback: len(services) == 1,
			AssetStore:     assetStore,
			BaseURL:        options.BaseURL,
			Seed:           options.AWSSeed,
		})
	}
	if serviceEnabled(services, "resend") {
		resend.Register(router, resend.Options{
			Store: runtimeStore,
			Seed:  options.ResendSeed,
		})
	}
	if serviceEnabled(services, "slack") {
		slack.Register(router, slack.Options{
			Store:         runtimeStore,
			BaseURL:       options.BaseURL,
			Seed:          options.SlackSeed,
			RootInspector: len(services) == 1,
		})
	}
	if serviceEnabled(services, "stripe") {
		stripe.Register(router, stripe.Options{
			Store:   runtimeStore,
			BaseURL: options.BaseURL,
			Seed:    options.StripeSeed,
		})
	}
	if serviceEnabled(services, "vercel") {
		vercel.Register(router, vercel.Options{
			Store:   runtimeStore,
			BaseURL: options.BaseURL,
			Seed:    options.VercelSeed,
		})
	}
	if serviceEnabled(services, "mongoatlas") {
		mongoatlas.Register(router, mongoatlas.Options{
			Store: runtimeStore,
			Seed:  options.MongoAtlasSeed,
		})
	}
	if serviceEnabled(services, "github") {
		github.Register(router, github.Options{
			Store:   runtimeStore,
			BaseURL: options.BaseURL,
			Seed:    options.GitHubSeed,
		})
	}
	if serviceEnabled(services, "google") {
		google.Register(router, google.Options{
			Store:   runtimeStore,
			BaseURL: options.BaseURL,
			Seed:    options.GoogleSeed,
		})
		if len(ambiguousOIDCServices) > 1 {
			prefixed := corehttp.NewRouter()
			google.Register(prefixed, google.Options{
				Store:   runtimeStore,
				BaseURL: servicePrefixedBaseURL(options.BaseURL, "google"),
			})
			router.Mount("/google", prefixed)
		}
	}
	if serviceEnabled(services, "apple") {
		apple.Register(router, apple.Options{
			Store:   runtimeStore,
			BaseURL: options.BaseURL,
			Seed:    options.AppleSeed,
		})
		if len(ambiguousOIDCServices) > 1 {
			prefixed := corehttp.NewRouter()
			apple.Register(prefixed, apple.Options{
				Store:   runtimeStore,
				BaseURL: servicePrefixedBaseURL(options.BaseURL, "apple"),
			})
			router.Mount("/apple", prefixed)
		}
	}
	if serviceEnabled(services, "microsoft") {
		microsoft.Register(router, microsoft.Options{
			Store:   runtimeStore,
			BaseURL: options.BaseURL,
			Seed:    options.MicrosoftSeed,
		})
		if len(ambiguousOIDCServices) > 1 {
			prefixed := corehttp.NewRouter()
			microsoft.Register(prefixed, microsoft.Options{
				Store:   runtimeStore,
				BaseURL: servicePrefixedBaseURL(options.BaseURL, "microsoft"),
			})
			router.Mount("/microsoft", prefixed)
		}
	}
	if serviceEnabled(services, "okta") {
		okta.Register(router, okta.Options{
			Store:   runtimeStore,
			BaseURL: options.BaseURL,
			Seed:    options.OktaSeed,
		})
		if len(ambiguousOIDCServices) > 1 {
			prefixed := corehttp.NewRouter()
			okta.Register(prefixed, okta.Options{
				Store:   runtimeStore,
				BaseURL: servicePrefixedBaseURL(options.BaseURL, "okta"),
			})
			router.Mount("/okta", prefixed)
		}
	}
	if serviceEnabled(services, "clerk") {
		clerk.Register(router, clerk.Options{
			Store:   runtimeStore,
			BaseURL: options.BaseURL,
			Seed:    options.ClerkSeed,
		})
		if len(ambiguousOIDCServices) > 1 || clerkNeedsOAuthPrefix {
			prefixed := corehttp.NewRouter()
			clerk.Register(prefixed, clerk.Options{
				Store:   runtimeStore,
				BaseURL: servicePrefixedBaseURL(options.BaseURL, "clerk"),
			})
			router.Mount("/clerk", prefixed)
		}
	}
	router.NotFound(func(c *corehttp.Context) {
		c.JSON(http.StatusNotFound, map[string]any{"message": "Not Found"})
	})

	return &Server{
		Handler:    router,
		Store:      runtimeStore,
		AssetStore: assetStore,
		Version:    version,
		BaseURL:    options.BaseURL,
		Services:   services,
	}
}

func serviceEnabled(services []string, name string) bool {
	for _, service := range services {
		if service == name {
			return true
		}
	}
	return false
}

func enabledRootOIDCServices(services []string) []string {
	names := []string{}
	for _, name := range []string{"apple", "google", "microsoft", "okta", "clerk"} {
		if serviceEnabled(services, name) {
			names = append(names, name)
		}
	}
	return names
}

func servicePrefixedBaseURL(baseURL string, service string) string {
	trimmed := strings.TrimRight(baseURL, "/")
	if trimmed == "" {
		trimmed = "http://localhost:4000"
	}
	return trimmed + "/" + service
}

func oidcDiscoveryPaths(services []string) map[string]string {
	paths := map[string]string{}
	for _, service := range services {
		paths[service] = "/" + service + "/.well-known/openid-configuration"
	}
	return paths
}
