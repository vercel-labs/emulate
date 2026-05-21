package okta

import (
	"net/http"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerAuthorizationServerRoutes(router *corehttp.Router) {
	router.Get("/api/v1/authorizationServers", s.handleListAuthorizationServers)
	router.Post("/api/v1/authorizationServers", s.handleCreateAuthorizationServer)
	router.Post("/api/v1/authorizationServers/:authServerId/lifecycle/activate", s.handleActivateAuthorizationServer)
	router.Post("/api/v1/authorizationServers/:authServerId/lifecycle/deactivate", s.handleDeactivateAuthorizationServer)
	router.Get("/api/v1/authorizationServers/:authServerId", s.handleGetAuthorizationServer)
	router.Put("/api/v1/authorizationServers/:authServerId", s.handleUpdateAuthorizationServer)
	router.Delete("/api/v1/authorizationServers/:authServerId", s.handleDeleteAuthorizationServer)
}

func (s *Service) handleListAuthorizationServers(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	paginate(c, s.store.AuthorizationServers.All(), func(server corestore.Record) map[string]any {
		return authorizationServerResponse(s.baseURL, server)
	})
}

func (s *Service) handleCreateAuthorizationServer(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	body := readJSONBody(c.Request)
	name := bodyString(body, "name")
	if name == "" {
		oktaError(c, http.StatusBadRequest, "E0000001", "name is required")
		return
	}
	serverID := firstNonEmpty(bodyString(body, "id"), normalizeServerID(name))
	if firstRecord(s.store.AuthorizationServers.FindBy("server_id", serverID)) != nil {
		oktaError(c, http.StatusBadRequest, "E0000001", "Authorization server '"+serverID+"' already exists")
		return
	}
	created := s.store.AuthorizationServers.Insert(corestore.Record{
		"server_id":   serverID,
		"name":        name,
		"description": bodyString(body, "description"),
		"audiences":   bodyStringSlice(body, "audiences", []string{defaultAudience}),
		"status":      normalizeActiveStatus(bodyString(body, "status"), "ACTIVE"),
	})
	c.JSON(http.StatusCreated, authorizationServerResponse(s.baseURL, created))
}

func (s *Service) handleActivateAuthorizationServer(c *corehttp.Context) {
	s.handleAuthorizationServerLifecycle(c, "ACTIVE")
}

func (s *Service) handleDeactivateAuthorizationServer(c *corehttp.Context) {
	s.handleAuthorizationServerLifecycle(c, "INACTIVE")
}

func (s *Service) handleAuthorizationServerLifecycle(c *corehttp.Context, status string) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	server := s.findAuthorizationServer(c.Param("authServerId"))
	if server == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: authorization server")
		return
	}
	updated, _ := s.store.AuthorizationServers.Update(intField(server, "id"), corestore.Record{"status": status})
	c.JSON(http.StatusOK, authorizationServerResponse(s.baseURL, updated))
}

func (s *Service) handleGetAuthorizationServer(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	server := s.findAuthorizationServer(c.Param("authServerId"))
	if server == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: authorization server")
		return
	}
	c.JSON(http.StatusOK, authorizationServerResponse(s.baseURL, server))
}

func (s *Service) handleUpdateAuthorizationServer(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	server := s.findAuthorizationServer(c.Param("authServerId"))
	if server == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: authorization server")
		return
	}
	body := readJSONBody(c.Request)
	updated, _ := s.store.AuthorizationServers.Update(intField(server, "id"), corestore.Record{
		"name":        firstNonEmpty(bodyString(body, "name"), stringField(server, "name")),
		"description": firstNonEmpty(bodyString(body, "description"), stringField(server, "description")),
		"audiences":   bodyStringSlice(body, "audiences", stringSliceValue(server["audiences"])),
		"status":      normalizeActiveStatus(bodyString(body, "status"), stringField(server, "status")),
	})
	c.JSON(http.StatusOK, authorizationServerResponse(s.baseURL, updated))
}

func (s *Service) handleDeleteAuthorizationServer(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	server := s.findAuthorizationServer(c.Param("authServerId"))
	if server == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: authorization server")
		return
	}
	for _, client := range s.store.OAuthClients.FindBy("auth_server_id", stringField(server, "server_id")) {
		s.store.OAuthClients.Delete(intField(client, "id"))
	}
	s.store.AuthorizationServers.Delete(intField(server, "id"))
	writeNoContent(c)
}

func normalizeServerID(name string) string {
	name = strings.TrimSpace(strings.ToLower(name))
	var b strings.Builder
	lastDash := false
	for _, r := range name {
		valid := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-'
		if valid {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return oktaID("as")
	}
	return out
}
