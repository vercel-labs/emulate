package okta

import (
	"net/http"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerAppRoutes(router *corehttp.Router) {
	router.Get("/api/v1/apps", s.handleListApps)
	router.Post("/api/v1/apps", s.handleCreateApp)
	router.Get("/api/v1/apps/:appId/users", s.handleAppUsers)
	router.Put("/api/v1/apps/:appId/users/:userId", s.handleAssignAppUser)
	router.Delete("/api/v1/apps/:appId/users/:userId", s.handleUnassignAppUser)
	router.Post("/api/v1/apps/:appId/lifecycle/activate", s.handleActivateApp)
	router.Post("/api/v1/apps/:appId/lifecycle/deactivate", s.handleDeactivateApp)
	router.Get("/api/v1/apps/:appId", s.handleGetApp)
	router.Put("/api/v1/apps/:appId", s.handleUpdateApp)
	router.Delete("/api/v1/apps/:appId", s.handleDeleteApp)
}

func (s *Service) handleListApps(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	q := strings.ToLower(c.Query("q"))
	apps := s.store.Apps.All()
	filtered := make([]corestore.Record, 0, len(apps))
	for _, app := range apps {
		if q != "" && !strings.Contains(strings.ToLower(stringField(app, "name")+" "+stringField(app, "label")), q) {
			continue
		}
		filtered = append(filtered, app)
	}
	paginate(c, filtered, func(app corestore.Record) map[string]any {
		return appResponse(s.baseURL, app)
	})
}

func (s *Service) handleCreateApp(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	body := readJSONBody(c.Request)
	created := s.store.Apps.Insert(corestore.Record{
		"okta_id":      oktaID("0oa"),
		"name":         bodyStringDefault(body, "name", "oidc_client"),
		"label":        bodyStringDefault(body, "label", "Okta App"),
		"status":       normalizeActiveStatus(bodyString(body, "status"), "ACTIVE"),
		"sign_on_mode": bodyStringDefault(body, "signOnMode", "OPENID_CONNECT"),
		"settings":     mapValue(body["settings"]),
		"credentials":  mapValue(body["credentials"]),
	})
	c.JSON(http.StatusCreated, appResponse(s.baseURL, created))
}

func (s *Service) handleAppUsers(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	app := s.findApp(c.Param("appId"))
	if app == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: app")
		return
	}
	users := []map[string]any{}
	for _, assignment := range s.store.AppAssignments.FindBy("app_okta_id", stringField(app, "okta_id")) {
		user := firstRecord(s.store.Users.FindBy("okta_id", stringField(assignment, "user_okta_id")))
		if user == nil {
			continue
		}
		users = append(users, map[string]any{
			"id":          stringField(user, "okta_id"),
			"scope":       "USER",
			"credentials": map[string]any{"userName": stringField(user, "login")},
			"profile":     userResponse(s.baseURL, user)["profile"],
		})
	}
	c.JSON(http.StatusOK, users)
}

func (s *Service) handleAssignAppUser(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	app := s.findApp(c.Param("appId"))
	if app == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: app")
		return
	}
	user := s.findUser(c.Param("userId"))
	if user == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: user")
		return
	}
	s.ensureAppAssignment(stringField(app, "okta_id"), stringField(user, "okta_id"))
	writeNoContent(c)
}

func (s *Service) handleUnassignAppUser(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	app := s.findApp(c.Param("appId"))
	if app == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: app")
		return
	}
	user := s.findUser(c.Param("userId"))
	if user == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: user")
		return
	}
	for _, assignment := range s.store.AppAssignments.FindBy("app_okta_id", stringField(app, "okta_id")) {
		if stringField(assignment, "user_okta_id") == stringField(user, "okta_id") {
			s.store.AppAssignments.Delete(intField(assignment, "id"))
		}
	}
	writeNoContent(c)
}

func (s *Service) handleActivateApp(c *corehttp.Context) {
	s.handleAppLifecycle(c, "ACTIVE")
}

func (s *Service) handleDeactivateApp(c *corehttp.Context) {
	s.handleAppLifecycle(c, "INACTIVE")
}

func (s *Service) handleAppLifecycle(c *corehttp.Context, status string) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	app := s.findApp(c.Param("appId"))
	if app == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: app")
		return
	}
	updated, _ := s.store.Apps.Update(intField(app, "id"), corestore.Record{"status": status})
	c.JSON(http.StatusOK, appResponse(s.baseURL, updated))
}

func (s *Service) handleGetApp(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	app := s.findApp(c.Param("appId"))
	if app == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: app")
		return
	}
	c.JSON(http.StatusOK, appResponse(s.baseURL, app))
}

func (s *Service) handleUpdateApp(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	app := s.findApp(c.Param("appId"))
	if app == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: app")
		return
	}
	body := readJSONBody(c.Request)
	updated, _ := s.store.Apps.Update(intField(app, "id"), corestore.Record{
		"name":         firstNonEmpty(bodyString(body, "name"), stringField(app, "name")),
		"label":        firstNonEmpty(bodyString(body, "label"), stringField(app, "label")),
		"status":       normalizeActiveStatus(bodyString(body, "status"), stringField(app, "status")),
		"sign_on_mode": firstNonEmpty(bodyString(body, "signOnMode"), stringField(app, "sign_on_mode")),
		"settings":     firstMapOrExisting(body["settings"], mapValue(app["settings"])),
		"credentials":  firstMapOrExisting(body["credentials"], mapValue(app["credentials"])),
	})
	c.JSON(http.StatusOK, appResponse(s.baseURL, updated))
}

func (s *Service) handleDeleteApp(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	app := s.findApp(c.Param("appId"))
	if app == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: app")
		return
	}
	if stringField(app, "status") != "INACTIVE" {
		oktaError(c, http.StatusBadRequest, "E0000001", "App must be INACTIVE before deletion")
		return
	}
	for _, assignment := range s.store.AppAssignments.FindBy("app_okta_id", stringField(app, "okta_id")) {
		s.store.AppAssignments.Delete(intField(assignment, "id"))
	}
	s.store.Apps.Delete(intField(app, "id"))
	writeNoContent(c)
}

func firstMapOrExisting(value any, fallback map[string]any) map[string]any {
	if typed, ok := value.(map[string]any); ok {
		return typed
	}
	return fallback
}
