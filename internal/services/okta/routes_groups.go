package okta

import (
	"net/http"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerGroupRoutes(router *corehttp.Router) {
	router.Get("/api/v1/groups", s.handleListGroups)
	router.Post("/api/v1/groups", s.handleCreateGroup)
	router.Get("/api/v1/groups/:groupId/users", s.handleGroupUsers)
	router.Put("/api/v1/groups/:groupId/users/:userId", s.handleAddGroupUser)
	router.Delete("/api/v1/groups/:groupId/users/:userId", s.handleRemoveGroupUser)
	router.Get("/api/v1/groups/:groupId", s.handleGetGroup)
	router.Put("/api/v1/groups/:groupId", s.handleUpdateGroup)
	router.Delete("/api/v1/groups/:groupId", s.handleDeleteGroup)
}

func (s *Service) handleListGroups(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	q := strings.ToLower(c.Query("q"))
	groups := s.store.Groups.All()
	filtered := make([]corestore.Record, 0, len(groups))
	for _, group := range groups {
		if q != "" && !strings.Contains(strings.ToLower(stringField(group, "name")+" "+stringField(group, "description")), q) {
			continue
		}
		filtered = append(filtered, group)
	}
	paginate(c, filtered, func(group corestore.Record) map[string]any {
		return groupResponse(s.baseURL, group)
	})
}

func (s *Service) handleCreateGroup(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	body := readJSONBody(c.Request)
	profile := bodyMap(body, "profile")
	name := bodyString(profile, "name")
	if name == "" {
		oktaError(c, http.StatusBadRequest, "E0000001", "profile.name is required")
		return
	}
	if firstRecord(s.store.Groups.FindBy("name", name)) != nil {
		oktaError(c, http.StatusBadRequest, "E0000001", "A group with the same name already exists")
		return
	}
	created := s.store.Groups.Insert(corestore.Record{
		"okta_id":     oktaID("00g"),
		"type":        normalizeGroupType(bodyString(body, "type"), "OKTA_GROUP"),
		"name":        name,
		"description": stringOrNil(bodyString(profile, "description")),
	})
	c.JSON(http.StatusCreated, groupResponse(s.baseURL, created))
}

func (s *Service) handleGroupUsers(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	group := s.findGroup(c.Param("groupId"))
	if group == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: group")
		return
	}
	users := []map[string]any{}
	for _, membership := range s.store.GroupMemberships.FindBy("group_okta_id", stringField(group, "okta_id")) {
		user := firstRecord(s.store.Users.FindBy("okta_id", stringField(membership, "user_okta_id")))
		if user != nil {
			users = append(users, userResponse(s.baseURL, user))
		}
	}
	c.JSON(http.StatusOK, users)
}

func (s *Service) handleAddGroupUser(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	group := s.findGroup(c.Param("groupId"))
	if group == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: group")
		return
	}
	user := s.findUser(c.Param("userId"))
	if user == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: user")
		return
	}
	s.ensureMembership(stringField(group, "okta_id"), stringField(user, "okta_id"))
	writeNoContent(c)
}

func (s *Service) handleRemoveGroupUser(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	group := s.findGroup(c.Param("groupId"))
	if group == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: group")
		return
	}
	user := s.findUser(c.Param("userId"))
	if user == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: user")
		return
	}
	for _, membership := range s.store.GroupMemberships.FindBy("group_okta_id", stringField(group, "okta_id")) {
		if stringField(membership, "user_okta_id") == stringField(user, "okta_id") {
			s.store.GroupMemberships.Delete(intField(membership, "id"))
		}
	}
	writeNoContent(c)
}

func (s *Service) handleGetGroup(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	group := s.findGroup(c.Param("groupId"))
	if group == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: group")
		return
	}
	c.JSON(http.StatusOK, groupResponse(s.baseURL, group))
}

func (s *Service) handleUpdateGroup(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	group := s.findGroup(c.Param("groupId"))
	if group == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: group")
		return
	}
	body := readJSONBody(c.Request)
	profile := bodyMap(body, "profile")
	nextName := firstNonEmpty(bodyString(profile, "name"), stringField(group, "name"))
	if nextName != stringField(group, "name") {
		existing := firstRecord(s.store.Groups.FindBy("name", nextName))
		if existing != nil && stringField(existing, "okta_id") != stringField(group, "okta_id") {
			oktaError(c, http.StatusBadRequest, "E0000001", "A group with the same name already exists")
			return
		}
	}
	updated, _ := s.store.Groups.Update(intField(group, "id"), corestore.Record{
		"name":        nextName,
		"description": firstNonEmpty(bodyString(profile, "description"), stringField(group, "description")),
		"type":        normalizeGroupType(bodyString(body, "type"), stringField(group, "type")),
	})
	c.JSON(http.StatusOK, groupResponse(s.baseURL, updated))
}

func (s *Service) handleDeleteGroup(c *corehttp.Context) {
	if _, ok := s.requireManagementAuth(c); !ok {
		return
	}
	group := s.findGroup(c.Param("groupId"))
	if group == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: group")
		return
	}
	for _, membership := range s.store.GroupMemberships.FindBy("group_okta_id", stringField(group, "okta_id")) {
		s.store.GroupMemberships.Delete(intField(membership, "id"))
	}
	s.store.Groups.Delete(intField(group, "id"))
	writeNoContent(c)
}
