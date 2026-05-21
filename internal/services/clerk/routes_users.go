package clerk

import (
	"net/http"
	"sort"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerUserRoutes(router *corehttp.Router) {
	router.Get("/v1/users", s.handleListUsers)
	router.Get("/v1/users/count", s.handleCountUsers)
	router.Get("/v1/users/:userId", s.handleGetUser)
	router.Post("/v1/users", s.handleCreateUser)
	router.Patch("/v1/users/:userId", s.handlePatchUser)
	router.Delete("/v1/users/:userId", s.handleDeleteUser)
	router.Post("/v1/users/:userId/ban", s.handleBanUser)
	router.Post("/v1/users/:userId/unban", s.handleUnbanUser)
	router.Post("/v1/users/:userId/lock", s.handleLockUser)
	router.Post("/v1/users/:userId/unlock", s.handleUnlockUser)
	router.Patch("/v1/users/:userId/metadata", s.handlePatchUserMetadata)
	router.Post("/v1/users/:userId/verify_password", s.handleVerifyPassword)
}

func (s *Service) handleListUsers(c *corehttp.Context) {
	if !requireSecretKey(c) {
		return
	}
	limit, offset := parsePagination(c)
	orderBy := firstNonEmpty(c.Query("order_by"), "-created_at")
	filtered := s.filteredUsers(c)
	desc := strings.HasPrefix(orderBy, "-")
	field := strings.TrimPrefix(orderBy, "-")
	sort.SliceStable(filtered, func(i int, j int) bool {
		left := int64Field(filtered[i], "updated_at_unix")
		right := int64Field(filtered[j], "updated_at_unix")
		if field == "created_at" {
			left = int64Field(filtered[i], "created_at_unix")
			right = int64Field(filtered[j], "created_at_unix")
		}
		if desc {
			return left > right
		}
		return left < right
	})
	paged := sliceRecords(filtered, limit, offset)
	data := make([]map[string]any, 0, len(paged))
	for _, user := range paged {
		emails := s.store.EmailAddresses.FindBy("user_id", stringField(user, "clerk_id"))
		data = append(data, userResponse(user, emails))
	}
	c.JSON(http.StatusOK, paginatedResponse(data, len(filtered), limit, offset))
}

func (s *Service) handleCountUsers(c *corehttp.Context) {
	if !requireSecretKey(c) {
		return
	}
	c.JSON(http.StatusOK, map[string]any{"object": "total_count", "total_count": len(s.filteredUsers(c))})
}

func (s *Service) handleGetUser(c *corehttp.Context) {
	if !requireSecretKey(c) {
		return
	}
	user := firstRecord(s.store.Users.FindBy("clerk_id", c.Param("userId")))
	if user == nil {
		clerkError(c, http.StatusNotFound, "RESOURCE_NOT_FOUND", "User not found")
		return
	}
	emails := s.store.EmailAddresses.FindBy("user_id", stringField(user, "clerk_id"))
	c.JSON(http.StatusOK, userResponse(user, emails))
}

func (s *Service) handleCreateUser(c *corehttp.Context) {
	if !requireSecretKey(c) {
		return
	}
	body := readJSONBody(c.Request)
	now := nowUnix()
	userID := clerkID("user_")
	user := s.store.Users.Insert(corestore.Record{
		"clerk_id":                 userID,
		"username":                 nilStringValue(stringValue(body["username"])),
		"first_name":               nilStringValue(stringValue(body["first_name"])),
		"last_name":                nilStringValue(stringValue(body["last_name"])),
		"image_url":                nil,
		"profile_image_url":        nil,
		"external_id":              nilStringValue(stringValue(body["external_id"])),
		"primary_email_address_id": nil,
		"primary_phone_number_id":  nil,
		"password_enabled":         stringValue(body["password"]) != "",
		"password_hash":            nilStringValue(stringValue(body["password"])),
		"totp_enabled":             false,
		"backup_code_enabled":      false,
		"two_factor_enabled":       false,
		"banned":                   false,
		"locked":                   false,
		"public_metadata":          mapValue(body["public_metadata"]),
		"private_metadata":         mapValue(body["private_metadata"]),
		"unsafe_metadata":          mapValue(body["unsafe_metadata"]),
		"last_active_at":           nil,
		"last_sign_in_at":          nil,
		"created_at_unix":          now,
		"updated_at_unix":          now,
	})
	emailList := stringSliceValue(body["email_address"])
	primaryEmailID := ""
	for index, value := range emailList {
		email := s.store.EmailAddresses.Insert(corestore.Record{
			"email_id":              clerkID("idn_"),
			"email_address":         value,
			"user_id":               userID,
			"verification_status":   "verified",
			"verification_strategy": "email_code",
			"is_primary":            index == 0,
			"reserved":              false,
			"created_at_unix":       now,
			"updated_at_unix":       now,
		})
		if index == 0 {
			primaryEmailID = stringField(email, "email_id")
		}
	}
	if primaryEmailID != "" {
		s.store.Users.Update(intField(user, "id"), corestore.Record{"primary_email_address_id": primaryEmailID})
	}
	created := firstRecord(s.store.Users.FindBy("clerk_id", userID))
	emails := s.store.EmailAddresses.FindBy("user_id", userID)
	c.JSON(http.StatusOK, userResponse(created, emails))
}

func (s *Service) handlePatchUser(c *corehttp.Context) {
	if !requireSecretKey(c) {
		return
	}
	userID := c.Param("userId")
	user := firstRecord(s.store.Users.FindBy("clerk_id", userID))
	if user == nil {
		clerkError(c, http.StatusNotFound, "RESOURCE_NOT_FOUND", "User not found")
		return
	}
	body := readJSONBody(c.Request)
	patch := corestore.Record{"updated_at_unix": nowUnix()}
	assignStringPatch(patch, body, "first_name")
	assignStringPatch(patch, body, "last_name")
	assignStringPatch(patch, body, "username")
	assignStringPatch(patch, body, "external_id")
	assignStringPatch(patch, body, "primary_email_address_id")
	assignStringPatch(patch, body, "primary_phone_number_id")
	if body["public_metadata"] != nil {
		patch["public_metadata"] = mapValue(body["public_metadata"])
	}
	if body["private_metadata"] != nil {
		patch["private_metadata"] = mapValue(body["private_metadata"])
	}
	if body["unsafe_metadata"] != nil {
		patch["unsafe_metadata"] = mapValue(body["unsafe_metadata"])
	}
	if password, ok := body["password"].(string); ok {
		patch["password_enabled"] = password != ""
		patch["password_hash"] = nilStringValue(password)
	}
	s.store.Users.Update(intField(user, "id"), patch)
	updated := firstRecord(s.store.Users.FindBy("clerk_id", userID))
	emails := s.store.EmailAddresses.FindBy("user_id", userID)
	c.JSON(http.StatusOK, userResponse(updated, emails))
}

func (s *Service) handleDeleteUser(c *corehttp.Context) {
	if !requireSecretKey(c) {
		return
	}
	userID := c.Param("userId")
	user := firstRecord(s.store.Users.FindBy("clerk_id", userID))
	if user == nil {
		clerkError(c, http.StatusNotFound, "RESOURCE_NOT_FOUND", "User not found")
		return
	}
	for _, email := range s.store.EmailAddresses.FindBy("user_id", userID) {
		s.store.EmailAddresses.Delete(intField(email, "id"))
	}
	for _, membership := range s.store.Memberships.FindBy("user_id", userID) {
		s.store.Memberships.Delete(intField(membership, "id"))
		org := firstRecord(s.store.Organizations.FindBy("clerk_id", stringField(membership, "org_id")))
		if org != nil {
			s.store.Organizations.Update(intField(org, "id"), corestore.Record{"members_count": max(0, intField(org, "members_count")-1)})
		}
	}
	for _, session := range s.store.Sessions.FindBy("user_id", userID) {
		s.store.Sessions.Delete(intField(session, "id"))
	}
	s.store.Users.Delete(intField(user, "id"))
	c.JSON(http.StatusOK, deletedResponse(userID))
}

func (s *Service) handleBanUser(c *corehttp.Context) {
	s.setUserFlag(c, "banned", true)
}

func (s *Service) handleUnbanUser(c *corehttp.Context) {
	s.setUserFlag(c, "banned", false)
}

func (s *Service) handleLockUser(c *corehttp.Context) {
	s.setUserFlag(c, "locked", true)
}

func (s *Service) handleUnlockUser(c *corehttp.Context) {
	s.setUserFlag(c, "locked", false)
}

func (s *Service) setUserFlag(c *corehttp.Context, field string, value bool) {
	if !requireSecretKey(c) {
		return
	}
	userID := c.Param("userId")
	user := firstRecord(s.store.Users.FindBy("clerk_id", userID))
	if user == nil {
		clerkError(c, http.StatusNotFound, "RESOURCE_NOT_FOUND", "User not found")
		return
	}
	s.store.Users.Update(intField(user, "id"), corestore.Record{field: value, "updated_at_unix": nowUnix()})
	updated := firstRecord(s.store.Users.FindBy("clerk_id", userID))
	emails := s.store.EmailAddresses.FindBy("user_id", userID)
	c.JSON(http.StatusOK, userResponse(updated, emails))
}

func (s *Service) handlePatchUserMetadata(c *corehttp.Context) {
	if !requireSecretKey(c) {
		return
	}
	userID := c.Param("userId")
	user := firstRecord(s.store.Users.FindBy("clerk_id", userID))
	if user == nil {
		clerkError(c, http.StatusNotFound, "RESOURCE_NOT_FOUND", "User not found")
		return
	}
	body := readJSONBody(c.Request)
	patch := corestore.Record{"updated_at_unix": nowUnix()}
	if body["public_metadata"] != nil {
		patch["public_metadata"] = mergeMaps(mapValue(user["public_metadata"]), mapValue(body["public_metadata"]))
	}
	if body["private_metadata"] != nil {
		patch["private_metadata"] = mergeMaps(mapValue(user["private_metadata"]), mapValue(body["private_metadata"]))
	}
	if body["unsafe_metadata"] != nil {
		patch["unsafe_metadata"] = mergeMaps(mapValue(user["unsafe_metadata"]), mapValue(body["unsafe_metadata"]))
	}
	s.store.Users.Update(intField(user, "id"), patch)
	updated := firstRecord(s.store.Users.FindBy("clerk_id", userID))
	emails := s.store.EmailAddresses.FindBy("user_id", userID)
	c.JSON(http.StatusOK, userResponse(updated, emails))
}

func (s *Service) handleVerifyPassword(c *corehttp.Context) {
	if !requireSecretKey(c) {
		return
	}
	user := firstRecord(s.store.Users.FindBy("clerk_id", c.Param("userId")))
	if user == nil {
		clerkError(c, http.StatusNotFound, "RESOURCE_NOT_FOUND", "User not found")
		return
	}
	body := readJSONBody(c.Request)
	c.JSON(http.StatusOK, map[string]any{"object": "verification", "verified": stringField(user, "password_hash") == stringValue(body["password"])})
}

func userMatchesQuery(user corestore.Record, emails []corestore.Record, query string) bool {
	if strings.Contains(strings.ToLower(stringField(user, "first_name")), query) ||
		strings.Contains(strings.ToLower(stringField(user, "last_name")), query) ||
		strings.Contains(strings.ToLower(stringField(user, "username")), query) ||
		strings.Contains(strings.ToLower(stringField(user, "clerk_id")), query) ||
		strings.Contains(strings.ToLower(stringField(user, "external_id")), query) {
		return true
	}
	for _, email := range emails {
		if strings.Contains(strings.ToLower(stringField(email, "email_address")), query) {
			return true
		}
	}
	return false
}

func (s *Service) filteredUsers(c *corehttp.Context) []corestore.Record {
	query := strings.ToLower(c.Query("query"))
	emailFilters := c.Request.URL.Query()["email_address"]
	emailSet := map[string]bool{}
	for _, email := range emailFilters {
		emailSet[strings.ToLower(email)] = true
	}
	users := s.store.Users.All()
	filtered := make([]corestore.Record, 0, len(users))
	for _, user := range users {
		emails := s.store.EmailAddresses.FindBy("user_id", stringField(user, "clerk_id"))
		if query != "" && !userMatchesQuery(user, emails, query) {
			continue
		}
		if len(emailSet) > 0 && !userHasEmail(emails, emailSet) {
			continue
		}
		filtered = append(filtered, user)
	}
	return filtered
}

func userHasEmail(emails []corestore.Record, emailSet map[string]bool) bool {
	for _, email := range emails {
		if emailSet[strings.ToLower(stringField(email, "email_address"))] {
			return true
		}
	}
	return false
}

func assignStringPatch(patch corestore.Record, body map[string]any, field string) {
	if value, ok := body[field]; ok {
		if value == nil {
			patch[field] = nil
			return
		}
		patch[field] = stringValue(value)
	}
}

func mergeMaps(left map[string]any, right map[string]any) map[string]any {
	out := make(map[string]any, len(left)+len(right))
	for key, value := range left {
		out[key] = value
	}
	for key, value := range right {
		out[key] = value
	}
	return out
}
