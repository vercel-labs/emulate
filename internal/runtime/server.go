package runtime

import (
	"net/http"

	coreassets "github.com/vercel-labs/emulate/internal/core/assets"
	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	"github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/core/ui"
	"github.com/vercel-labs/emulate/internal/services/apple"
	"github.com/vercel-labs/emulate/internal/services/aws"
	"github.com/vercel-labs/emulate/internal/services/github"
	"github.com/vercel-labs/emulate/internal/services/microsoft"
	"github.com/vercel-labs/emulate/internal/services/resend"
	"github.com/vercel-labs/emulate/internal/services/vercel"
)

const HealthPath = "/_emulate/health"

type ServerOptions struct {
	Version       string
	BaseURL       string
	Services      []string
	Store         *store.Store
	AssetStore    *coreassets.Store
	AppleSeed     *apple.SeedConfig
	GitHubSeed    *github.SeedConfig
	MicrosoftSeed *microsoft.SeedConfig
	ResendSeed    *resend.SeedConfig
	VercelSeed    *vercel.SeedConfig
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
	if serviceEnabled(services, "aws") {
		aws.Register(router, aws.Options{
			Store:          runtimeStore,
			S3PathFallback: len(services) == 1,
			AssetStore:     assetStore,
			BaseURL:        options.BaseURL,
		})
	}
	if serviceEnabled(services, "resend") {
		resend.Register(router, resend.Options{
			Store: runtimeStore,
			Seed:  options.ResendSeed,
		})
	}
	if serviceEnabled(services, "vercel") {
		vercel.Register(router, vercel.Options{
			Store:   runtimeStore,
			BaseURL: options.BaseURL,
			Seed:    options.VercelSeed,
		})
	}
	if serviceEnabled(services, "github") {
		github.Register(router, github.Options{
			Store:   runtimeStore,
			BaseURL: options.BaseURL,
			Seed:    options.GitHubSeed,
		})
	}
	if serviceEnabled(services, "apple") {
		apple.Register(router, apple.Options{
			Store:   runtimeStore,
			BaseURL: options.BaseURL,
			Seed:    options.AppleSeed,
		})
	}
	if serviceEnabled(services, "microsoft") {
		microsoft.Register(router, microsoft.Options{
			Store:   runtimeStore,
			BaseURL: options.BaseURL,
			Seed:    options.MicrosoftSeed,
		})
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
