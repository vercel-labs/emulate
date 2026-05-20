package github

import (
	"net/http"
	"strconv"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerUserAndOrgRoutes(router *corehttp.Router) {
	router.Get("/user", s.handleCurrentUser)
	router.Patch("/user", s.handlePatchCurrentUser)
	router.Get("/user/repos", s.handleListCurrentUserRepos)
	router.Get("/user/orgs", s.handleListCurrentUserOrgs)
	router.Get("/users", s.handleListUsers)
	router.Get("/users/:username/repos", s.handleListUserRepos)
	router.Get("/users/:username/orgs", s.handleListUserOrgs)
	router.Get("/users/:username/followers", s.handleEmptyUserList)
	router.Get("/users/:username/following", s.handleEmptyUserList)
	router.Get("/users/:username/hovercard", s.handleHovercard)
	router.Get("/users/:username", s.handleGetUser)
	router.Get("/organizations", s.handleListOrganizations)
	router.Get("/orgs/:org/repos", s.handleListOrgRepos)
	router.Get("/orgs/:org", s.handleGetOrg)
}

func (s *Service) handleCurrentUser(c *corehttp.Context) {
	user, ok := s.currentUser(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, s.formatUserFull(user))
}

func (s *Service) handlePatchCurrentUser(c *corehttp.Context) {
	user, ok := s.currentUser(c)
	if !ok {
		return
	}
	body, err := parseJSONBody(c.Request)
	if err != nil {
		writeValidation(c, "Invalid JSON body")
		return
	}
	patch := corestore.Record{}
	for _, key := range []string{"name", "email", "company", "location", "bio", "twitter_username"} {
		if value, exists := body[key]; exists {
			if value == nil {
				patch[key] = nil
			} else if s, ok := value.(string); ok {
				patch[key] = s
			}
		}
	}
	if value, ok := body["blog"].(string); ok {
		patch["blog"] = value
	}
	if value, exists := body["hireable"]; exists {
		if value == nil {
			patch["hireable"] = nil
		} else if b, ok := value.(bool); ok {
			patch["hireable"] = b
		}
	}
	updated, _ := s.store.Users.Update(intField(user, "id"), patch)
	c.JSON(http.StatusOK, s.formatUserFull(updated))
}

func (s *Service) handleListCurrentUserRepos(c *corehttp.Context) {
	user, ok := s.currentUser(c)
	if !ok {
		return
	}
	listType, ok := repoListType(c, "all")
	if !ok {
		return
	}
	repos := s.reposForUser(user, listType)
	s.respondRepoList(c, s.filterReadableRepos(c, repos), intField(user, "id"))
}

func (s *Service) handleListUserRepos(c *corehttp.Context) {
	user := firstRecord(s.store.Users.FindBy("login", c.Param("username")))
	if user == nil {
		writeNotFound(c)
		return
	}
	listType, ok := repoListType(c, "owner")
	if !ok {
		return
	}
	repos := s.reposForUser(user, listType)
	s.respondRepoList(c, s.filterReadableRepos(c, repos), s.viewerID(c))
}

func (s *Service) handleListOrgRepos(c *corehttp.Context) {
	org := firstRecord(s.store.Orgs.FindBy("login", c.Param("org")))
	if org == nil {
		writeNotFound(c)
		return
	}
	repos := make([]corestore.Record, 0)
	for _, repo := range s.store.Repos.FindBy("owner_id", intField(org, "id")) {
		if stringField(repo, "owner_type") == "Organization" {
			repos = append(repos, repo)
		}
	}
	s.respondRepoList(c, s.filterReadableRepos(c, repos), s.viewerID(c))
}

func (s *Service) respondRepoList(c *corehttp.Context, repos []corestore.Record, viewerID int) {
	sortKey := strings.ToLower(defaultString(c.Query("sort"), "full_name"))
	if sortKey != "created" && sortKey != "updated" && sortKey != "pushed" && sortKey != "full_name" {
		writeValidation(c, "Invalid sort parameter")
		return
	}
	direction := strings.ToLower(c.Query("direction"))
	if direction == "" {
		if sortKey == "full_name" {
			direction = "asc"
		} else {
			direction = "desc"
		}
	}
	if direction != "asc" && direction != "desc" {
		writeValidation(c, "Invalid direction parameter")
		return
	}
	repos = sortedRepos(repos, sortKey, direction)
	page := paginateRecords(c, repos, parsePagination(c))
	out := make([]any, 0, len(page))
	for _, repo := range page {
		out = append(out, s.formatRepo(repo, viewerID))
	}
	c.JSON(http.StatusOK, out)
}

func (s *Service) reposForUser(user corestore.Record, listType string) []corestore.Record {
	if listType != "all" && listType != "owner" && listType != "member" {
		listType = "all"
	}
	owned := make([]corestore.Record, 0)
	for _, repo := range s.store.Repos.FindBy("owner_id", intField(user, "id")) {
		if stringField(repo, "owner_type") == "User" {
			owned = append(owned, repo)
		}
	}
	member := make([]corestore.Record, 0)
	for _, collab := range s.store.Collaborators.FindBy("user_id", intField(user, "id")) {
		if repo, ok := s.store.Repos.Get(intField(collab, "repo_id")); ok {
			if !(stringField(repo, "owner_type") == "User" && intField(repo, "owner_id") == intField(user, "id")) {
				member = append(member, repo)
			}
		}
	}
	if listType == "owner" {
		return owned
	}
	if listType == "member" {
		return member
	}
	byID := map[int]corestore.Record{}
	for _, repo := range owned {
		byID[intField(repo, "id")] = repo
	}
	for _, repo := range member {
		byID[intField(repo, "id")] = repo
	}
	out := make([]corestore.Record, 0, len(byID))
	for _, repo := range byID {
		out = append(out, repo)
	}
	return out
}

func (s *Service) handleListCurrentUserOrgs(c *corehttp.Context) {
	user, ok := s.currentUser(c)
	if !ok {
		return
	}
	s.respondOrgList(c, s.orgsForUser(intField(user, "id")))
}

func (s *Service) handleListUserOrgs(c *corehttp.Context) {
	user := firstRecord(s.store.Users.FindBy("login", c.Param("username")))
	if user == nil {
		writeNotFound(c)
		return
	}
	s.respondOrgList(c, s.orgsForUser(intField(user, "id")))
}

func (s *Service) respondOrgList(c *corehttp.Context, orgs []corestore.Record) {
	sortRecordsByString(orgs, "login", false)
	out := make([]any, 0, len(orgs))
	for _, org := range orgs {
		out = append(out, s.formatOrgBrief(org))
	}
	c.JSON(http.StatusOK, out)
}

func (s *Service) orgsForUser(userID int) []corestore.Record {
	byID := map[int]corestore.Record{}
	for _, member := range s.store.TeamMembers.FindBy("user_id", userID) {
		team, ok := s.store.Teams.Get(intField(member, "team_id"))
		if !ok {
			continue
		}
		if org, ok := s.store.Orgs.Get(intField(team, "org_id")); ok {
			byID[intField(org, "id")] = org
		}
	}
	out := make([]corestore.Record, 0, len(byID))
	for _, org := range byID {
		out = append(out, org)
	}
	return out
}

func (s *Service) handleListUsers(c *corehttp.Context) {
	since, _ := strconv.Atoi(c.Query("since"))
	perPage, _ := strconv.Atoi(c.Query("per_page"))
	if perPage < 1 {
		perPage = 30
	}
	if perPage > 100 {
		perPage = 100
	}
	users := make([]corestore.Record, 0)
	for _, user := range s.store.Users.All() {
		if intField(user, "id") > since {
			users = append(users, user)
		}
	}
	sortRecordsByInt(users, "id")
	if len(users) > perPage {
		users = users[:perPage]
	}
	out := make([]any, 0, len(users))
	for _, user := range users {
		out = append(out, s.formatUser(user))
	}
	c.JSON(http.StatusOK, out)
}

func (s *Service) handleGetUser(c *corehttp.Context) {
	user := firstRecord(s.store.Users.FindBy("login", c.Param("username")))
	if user == nil {
		writeNotFound(c)
		return
	}
	c.JSON(http.StatusOK, s.formatUserFull(user))
}

func (s *Service) handleEmptyUserList(c *corehttp.Context) {
	if firstRecord(s.store.Users.FindBy("login", c.Param("username"))) == nil {
		writeNotFound(c)
		return
	}
	c.JSON(http.StatusOK, []any{})
}

func (s *Service) handleHovercard(c *corehttp.Context) {
	if firstRecord(s.store.Users.FindBy("login", c.Param("username"))) == nil {
		writeNotFound(c)
		return
	}
	c.JSON(http.StatusOK, map[string]any{"contexts": []any{}})
}

func (s *Service) handleListOrganizations(c *corehttp.Context) {
	orgs := s.store.Orgs.All()
	sortRecordsByInt(orgs, "id")
	page := paginateRecords(c, orgs, parsePagination(c))
	out := make([]any, 0, len(page))
	for _, org := range page {
		out = append(out, s.formatOrgBrief(org))
	}
	c.JSON(http.StatusOK, out)
}

func (s *Service) handleGetOrg(c *corehttp.Context) {
	org := firstRecord(s.store.Orgs.FindBy("login", c.Param("org")))
	if org == nil {
		writeNotFound(c)
		return
	}
	c.JSON(http.StatusOK, s.formatOrgFull(org))
}

func defaultString(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func repoListType(c *corehttp.Context, fallback string) (string, bool) {
	listType := strings.ToLower(defaultString(c.Query("type"), fallback))
	if listType != "all" && listType != "owner" && listType != "member" {
		writeValidation(c, "Invalid type parameter")
		return "", false
	}
	return listType, true
}
