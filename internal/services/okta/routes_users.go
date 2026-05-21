package okta

import (
	"net/http"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerUserRoutes(router *corehttp.Router) {
	router.Get("/api/v1/users", s.handleListUsers)
	router.Post("/api/v1/users", s.handleCreateUser)
	router.Get("/api/v1/users/me", s.handleCurrentUser)
	router.Get("/api/v1/users/:userId/groups", s.handleUserGroups)
	router.Post("/api/v1/users/:userId/lifecycle/activate", s.handleActivateUser)
	router.Post("/api/v1/users/:userId/lifecycle/deactivate", s.handleDeactivateUser)
	router.Post("/api/v1/users/:userId/lifecycle/suspend", s.handleSuspendUser)
	router.Post("/api/v1/users/:userId/lifecycle/unsuspend", s.handleUnsuspendUser)
	router.Post("/api/v1/users/:userId/lifecycle/reactivate", s.handleReactivateUser)
	router.Get("/api/v1/users/:userId", s.handleGetUser)
	router.Put("/api/v1/users/:userId", s.handlePutUser)
	router.Post("/api/v1/users/:userId", s.handlePostUser)
	router.Delete("/api/v1/users/:userId", s.handleDeleteUser)
}

func (s *Service) handleListUsers(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	q := strings.ToLower(c.Query("q"))
	search := strings.ToLower(c.Query("search"))
	filter := c.Query("filter")
	users := s.store.Users.All()
	filtered := make([]corestore.Record, 0, len(users))
	for _, user := range users {
		searchText := strings.ToLower(strings.Join([]string{
			stringField(user, "login"),
			stringField(user, "email"),
			stringField(user, "first_name"),
			stringField(user, "last_name"),
			userDisplayName(user),
		}, " "))
		if q != "" && !strings.Contains(searchText, q) {
			continue
		}
		if search != "" && !strings.Contains(searchText, search) {
			continue
		}
		if status := statusFilterValue(filter); status != "" && stringField(user, "status") != status {
			continue
		}
		filtered = append(filtered, user)
	}
	paginate(c, filtered, func(user corestore.Record) map[string]any {
		return userResponse(s.baseURL, user)
	})
}

func (s *Service) handleCreateUser(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	body := readJSONBody(c.Request)
	profile := bodyMap(body, "profile")
	login := bodyString(profile, "login")
	email := bodyString(profile, "email")
	if email == "" {
		email = login
	}
	if login == "" || email == "" {
		oktaError(c, http.StatusBadRequest, "E0000001", "profile.login and profile.email are required")
		return
	}
	if firstRecord(s.store.Users.FindBy("login", login)) != nil || firstRecord(s.store.Users.FindBy("email", email)) != nil {
		oktaError(c, http.StatusBadRequest, "E0000001", "A user with the same login or email already exists")
		return
	}
	now := nowISO()
	activate := boolFromQuery(c.Query("activate"), true)
	status := "STAGED"
	var activatedAt any
	if activate {
		status = "ACTIVE"
		activatedAt = now
	}
	firstName := bodyStringDefault(profile, "firstName", "Test")
	lastName := bodyStringDefault(profile, "lastName", "User")
	displayName := bodyString(profile, "displayName")
	if displayName == "" {
		displayName = strings.TrimSpace(firstName + " " + lastName)
	}
	if displayName == "" {
		displayName = login
	}
	created := s.store.Users.Insert(corestore.Record{
		"okta_id":                 oktaID("00u"),
		"status":                  status,
		"activated_at":            activatedAt,
		"status_changed_at":       now,
		"last_login_at":           nil,
		"password_changed_at":     nil,
		"transitioning_to_status": nil,
		"login":                   login,
		"email":                   email,
		"first_name":              firstName,
		"last_name":               lastName,
		"display_name":            displayName,
		"locale":                  bodyStringDefault(profile, "locale", "en-US"),
		"time_zone":               bodyStringDefault(profile, "timeZone", "UTC"),
	})
	if group := firstRecord(s.store.Groups.FindBy("okta_id", defaultEveryoneGroupID)); group != nil {
		s.ensureMembership(stringField(group, "okta_id"), stringField(created, "okta_id"))
	}
	c.JSON(http.StatusCreated, userResponse(s.baseURL, created))
}

func (s *Service) handleCurrentUser(c *corehttp.Context) {
	login, ok := s.requireManagementAuth(c)
	if !ok {
		return
	}
	user := firstRecord(s.store.Users.FindBy("login", login))
	if user == nil {
		user = firstRecord(s.store.Users.All())
	}
	if user == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: user")
		return
	}
	response := userResponse(s.baseURL, user)
	profile := mapValue(response["profile"])
	profile["displayName"] = userDisplayName(user)
	response["profile"] = profile
	c.JSON(http.StatusOK, response)
}

func (s *Service) handleUserGroups(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	user := s.findUser(c.Param("userId"))
	if user == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: user")
		return
	}
	groups := []map[string]any{}
	for _, membership := range s.store.GroupMemberships.FindBy("user_okta_id", stringField(user, "okta_id")) {
		group := firstRecord(s.store.Groups.FindBy("okta_id", stringField(membership, "group_okta_id")))
		if group == nil {
			continue
		}
		groups = append(groups, map[string]any{
			"id": stringField(group, "okta_id"),
			"profile": map[string]any{
				"name":        stringField(group, "name"),
				"description": group["description"],
			},
			"type": stringField(group, "type"),
		})
	}
	c.JSON(http.StatusOK, groups)
}

func (s *Service) handleActivateUser(c *corehttp.Context) {
	s.handleUserLifecycle(c, "ACTIVE")
}

func (s *Service) handleDeactivateUser(c *corehttp.Context) {
	s.handleUserLifecycle(c, "DEPROVISIONED")
}

func (s *Service) handleSuspendUser(c *corehttp.Context) {
	s.handleUserLifecycle(c, "SUSPENDED")
}

func (s *Service) handleUnsuspendUser(c *corehttp.Context) {
	s.handleUserLifecycle(c, "ACTIVE")
}

func (s *Service) handleReactivateUser(c *corehttp.Context) {
	s.handleUserLifecycle(c, "PROVISIONED")
}

func (s *Service) handleUserLifecycle(c *corehttp.Context, status string) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	user := s.findUser(c.Param("userId"))
	if user == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: user")
		return
	}
	updated := s.updateUserLifecycle(user, status)
	c.JSON(http.StatusOK, userResponse(s.baseURL, updated))
}

func (s *Service) handleGetUser(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	user := s.findUser(c.Param("userId"))
	if user == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: user")
		return
	}
	c.JSON(http.StatusOK, userResponse(s.baseURL, user))
}

func (s *Service) handlePutUser(c *corehttp.Context) {
	s.handleUpdateUser(c, true)
}

func (s *Service) handlePostUser(c *corehttp.Context) {
	s.handleUpdateUser(c, false)
}

func (s *Service) handleUpdateUser(c *corehttp.Context, checkDuplicates bool) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	user := s.findUser(c.Param("userId"))
	if user == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: user")
		return
	}
	body := readJSONBody(c.Request)
	updates := updateUserProfile(user, bodyMap(body, "profile"))
	if checkDuplicates {
		if login := stringValue(updates["login"]); login != "" && login != stringField(user, "login") && firstRecord(s.store.Users.FindBy("login", login)) != nil {
			oktaError(c, http.StatusBadRequest, "E0000001", "A user with the same login or email already exists")
			return
		}
		if email := stringValue(updates["email"]); email != "" && email != stringField(user, "email") && firstRecord(s.store.Users.FindBy("email", email)) != nil {
			oktaError(c, http.StatusBadRequest, "E0000001", "A user with the same login or email already exists")
			return
		}
	}
	updated, _ := s.store.Users.Update(intField(user, "id"), updates)
	c.JSON(http.StatusOK, userResponse(s.baseURL, updated))
}

func (s *Service) handleDeleteUser(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	user := s.findUser(c.Param("userId"))
	if user == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: user")
		return
	}
	if stringField(user, "status") != "DEPROVISIONED" {
		s.updateUserLifecycle(user, "DEPROVISIONED")
		writeNoContent(c)
		return
	}
	for _, membership := range s.store.GroupMemberships.FindBy("user_okta_id", stringField(user, "okta_id")) {
		s.store.GroupMemberships.Delete(intField(membership, "id"))
	}
	for _, assignment := range s.store.AppAssignments.FindBy("user_okta_id", stringField(user, "okta_id")) {
		s.store.AppAssignments.Delete(intField(assignment, "id"))
	}
	s.store.Users.Delete(intField(user, "id"))
	writeNoContent(c)
}

func updateUserProfile(user corestore.Record, profile map[string]any) corestore.Record {
	firstName := firstNonEmpty(bodyString(profile, "firstName"), stringField(user, "first_name"))
	lastName := firstNonEmpty(bodyString(profile, "lastName"), stringField(user, "last_name"))
	displayName := firstNonEmpty(bodyString(profile, "displayName"), bodyString(profile, "nickName"), stringField(user, "display_name"))
	if displayName == "" {
		displayName = strings.TrimSpace(firstName + " " + lastName)
	}
	return corestore.Record{
		"login":        firstNonEmpty(bodyString(profile, "login"), stringField(user, "login")),
		"email":        firstNonEmpty(bodyString(profile, "email"), stringField(user, "email")),
		"first_name":   firstName,
		"last_name":    lastName,
		"display_name": displayName,
		"locale":       firstNonEmpty(bodyString(profile, "locale"), stringField(user, "locale")),
		"time_zone":    firstNonEmpty(bodyString(profile, "timeZone"), stringField(user, "time_zone")),
	}
}

func (s *Service) updateUserLifecycle(user corestore.Record, target string) corestore.Record {
	now := nowISO()
	activatedAt := user["activated_at"]
	if target == "ACTIVE" && activatedAt == nil {
		activatedAt = now
	}
	updated, ok := s.store.Users.Update(intField(user, "id"), corestore.Record{
		"status":                  target,
		"transitioning_to_status": nil,
		"status_changed_at":       now,
		"activated_at":            activatedAt,
	})
	if !ok {
		return user
	}
	return updated
}

func statusFilterValue(filter string) string {
	filter = strings.TrimSpace(filter)
	lower := strings.ToLower(filter)
	marker := "status eq "
	index := strings.Index(lower, marker)
	if index < 0 {
		return ""
	}
	value := strings.TrimSpace(filter[index+len(marker):])
	value = strings.Trim(value, `" '`)
	return strings.ToUpper(value)
}
