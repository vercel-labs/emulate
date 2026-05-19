package runtime

import (
	"net/http"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	"github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/core/ui"
	"github.com/vercel-labs/emulate/internal/services/aws"
)

const HealthPath = "/_emulate/health"

type ServerOptions struct {
	Version  string
	BaseURL  string
	Services []string
	Store    *store.Store
}

type Server struct {
	Handler  http.Handler
	Store    *store.Store
	Version  string
	BaseURL  string
	Services []string
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
		})
	}
	router.NotFound(func(c *corehttp.Context) {
		c.JSON(http.StatusNotFound, map[string]any{"message": "Not Found"})
	})

	return &Server{
		Handler:  router,
		Store:    runtimeStore,
		Version:  version,
		BaseURL:  options.BaseURL,
		Services: services,
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
