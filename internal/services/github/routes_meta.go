package github

import (
	"math/rand"
	"net/http"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
)

func (s *Service) registerMetaRoutes(router *corehttp.Router) {
	router.Get("/rate_limit", s.handleRateLimit)
	router.Get("/meta", s.handleMeta)
	router.Get("/emojis", s.handleEmojis)
	router.Get("/zen", s.handleZen)
	router.Get("/versions", s.handleVersions)
}

func (s *Service) handleRateLimit(c *corehttp.Context) {
	now := time.Now().Unix()
	reset := now + 3600
	core := map[string]any{"limit": 5000, "remaining": 4999, "reset": reset, "used": 1, "resource": "core"}
	c.JSON(http.StatusOK, map[string]any{
		"resources": map[string]any{
			"core":                 core,
			"search":               map[string]any{"limit": 30, "remaining": 29, "reset": reset, "used": 1, "resource": "search"},
			"graphql":              map[string]any{"limit": 5000, "remaining": 4999, "reset": reset, "used": 1, "resource": "graphql"},
			"integration_manifest": map[string]any{"limit": 5000, "remaining": 4999, "reset": reset, "used": 1, "resource": "integration_manifest"},
			"source_import":        map[string]any{"limit": 100, "remaining": 99, "reset": reset, "used": 1, "resource": "source_import"},
			"code_scanning_upload": map[string]any{"limit": 500, "remaining": 499, "reset": reset, "used": 1, "resource": "code_scanning_upload"},
		},
		"rate": core,
	})
}

func (s *Service) handleMeta(c *corehttp.Context) {
	c.JSON(http.StatusOK, map[string]any{
		"verifiable_password_authentication": true,
		"ssh_key_fingerprints": map[string]any{
			"SHA256_RSA":     "placeholder",
			"SHA256_DSA":     "placeholder",
			"SHA256_ECDSA":   "placeholder",
			"SHA256_ED25519": "placeholder",
		},
		"ssh_keys":                   []string{"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaceholder"},
		"hooks":                      []string{"127.0.0.1/32"},
		"web":                        []string{"127.0.0.1/32"},
		"api":                        []string{"127.0.0.1/32"},
		"git":                        []string{"127.0.0.1/32"},
		"github_enterprise_importer": []string{"127.0.0.1/32"},
		"packages":                   []string{"127.0.0.1/32"},
		"pages":                      []string{"127.0.0.1/32"},
		"importer":                   []string{"127.0.0.1/32"},
		"actions":                    []string{"127.0.0.1/32"},
		"actions_macos":              []string{"127.0.0.1/32"},
		"dependabot":                 []string{"127.0.0.1/32"},
		"copilot":                    []string{"127.0.0.1/32"},
		"domains": map[string]any{
			"website":               []string{"localhost"},
			"codespaces":            []string{"localhost"},
			"copilot":               []string{"localhost"},
			"packages":              []string{"localhost"},
			"actions":               []string{"localhost"},
			"artifact_attestations": map[string]any{"trust_domain": "localhost"},
		},
	})
}

func (s *Service) handleEmojis(c *corehttp.Context) {
	c.JSON(http.StatusOK, map[string]any{
		"+1":         s.baseURL + "/emojis/+1.png",
		"-1":         s.baseURL + "/emojis/-1.png",
		"100":        s.baseURL + "/emojis/100.png",
		"tada":       s.baseURL + "/emojis/tada.png",
		"rocket":     s.baseURL + "/emojis/rocket.png",
		"heart":      s.baseURL + "/emojis/heart.png",
		"eyes":       s.baseURL + "/emojis/eyes.png",
		"thinking":   s.baseURL + "/emojis/thinking.png",
		"thumbsup":   s.baseURL + "/emojis/thumbsup.png",
		"thumbsdown": s.baseURL + "/emojis/thumbsdown.png",
	})
}

func (s *Service) handleZen(c *corehttp.Context) {
	phrases := []string{
		"Non-blocking is better than blocking.",
		"Design for failure.",
		"Half measures are as bad as nothing at all.",
		"Encourage flow.",
		"Anything added dilutes everything else.",
		"Approachable is better than simple.",
		"Mind your words, they are important.",
		"Speak like a human.",
		"It is not fully shipped until it is fast.",
		"Responsive is better than fast.",
		"Keep it logically awesome.",
		"Favor focus over features.",
		"Avoid administrative distraction.",
	}
	c.Text(http.StatusOK, phrases[rand.Intn(len(phrases))])
}

func (s *Service) handleVersions(c *corehttp.Context) {
	c.JSON(http.StatusOK, []string{"2022-11-28", "2022-08-09"})
}
