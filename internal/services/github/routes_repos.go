package github

import (
	"net/http"
	"sort"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

type createRepoOptions struct {
	Name          string
	Description   any
	Private       bool
	Homepage      any
	OwnerID       int
	OwnerType     string
	OwnerLogin    string
	DefaultBranch string
	Language      any
	Topics        []string
}

func (s *Service) registerRepoRoutes(router *corehttp.Router) {
	router.Get("/repos/:owner/:repo", s.handleGetRepo)
	router.Post("/user/repos", s.handleCreateUserRepo)
	router.Post("/orgs/:org/repos", s.handleCreateOrgRepo)
	router.Patch("/repos/:owner/:repo", s.handlePatchRepo)
	router.Delete("/repos/:owner/:repo", s.handleDeleteRepo)
	router.Get("/repos/:owner/:repo/topics", s.handleGetRepoTopics)
	router.Put("/repos/:owner/:repo/topics", s.handlePutRepoTopics)
	router.Get("/repos/:owner/:repo/languages", s.handleGetRepoLanguages)
	router.Get("/repos/:owner/:repo/contributors", s.handleListContributors)
	router.Get("/repos/:owner/:repo/tags", s.handleListTags)
}

func (s *Service) handleGetRepo(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	viewerID := 0
	if auth, ok := s.authUser(c); ok {
		viewerID = auth.ID
	}
	c.JSON(http.StatusOK, s.formatRepo(repo, viewerID))
}

func (s *Service) handleCreateUserRepo(c *corehttp.Context) {
	user, ok := s.currentUser(c)
	if !ok {
		return
	}
	body, err := parseJSONBody(c.Request)
	if err != nil {
		writeValidation(c, "Invalid JSON body")
		return
	}
	repo, ok := s.createRepoFromBody(c, body, user, "User")
	if !ok {
		return
	}
	c.JSON(http.StatusCreated, s.formatRepo(repo, intField(user, "id")))
}

func (s *Service) handleCreateOrgRepo(c *corehttp.Context) {
	user, ok := s.currentUser(c)
	if !ok {
		return
	}
	org := firstRecord(s.store.Orgs.FindBy("login", c.Param("org")))
	if org == nil {
		writeNotFound(c)
		return
	}
	if !boolField(user, "site_admin") && !s.isOrgMember(intField(user, "id"), intField(org, "id")) {
		writeForbidden(c)
		return
	}
	body, err := parseJSONBody(c.Request)
	if err != nil {
		writeValidation(c, "Invalid JSON body")
		return
	}
	repo, ok := s.createRepoFromBody(c, body, org, "Organization")
	if !ok {
		return
	}
	c.JSON(http.StatusCreated, s.formatRepo(repo, intField(user, "id")))
}

func (s *Service) createRepoFromBody(c *corehttp.Context, body map[string]any, owner corestore.Record, ownerKind string) (corestore.Record, bool) {
	name := strings.TrimSpace(stringValue(body["name"]))
	if !validateRepoName(name) {
		writeValidation(c, "Invalid repository name")
		return nil, false
	}
	defaultBranch := "main"
	if v := strings.TrimSpace(stringValue(body["default_branch"])); v != "" {
		defaultBranch = v
	}
	options := createRepoOptions{
		Name:          name,
		Description:   nil,
		Private:       false,
		Homepage:      nil,
		OwnerID:       intField(owner, "id"),
		OwnerType:     ownerKind,
		OwnerLogin:    stringField(owner, "login"),
		DefaultBranch: defaultBranch,
		Topics:        nil,
	}
	if value, ok := body["description"].(string); ok {
		options.Description = value
	}
	if value, ok := body["private"].(bool); ok {
		options.Private = value
	}
	if value, ok := body["homepage"].(string); ok {
		options.Homepage = value
	}
	if names, ok := body["topics"].([]any); ok {
		for _, item := range names {
			if topic, ok := item.(string); ok {
				options.Topics = append(options.Topics, topic)
			}
		}
	}
	repo := s.createRepoRecord(options)
	if repo == nil {
		writeValidation(c, "Repository already exists")
		return nil, false
	}
	if autoInit, ok := body["auto_init"].(bool); ok && autoInit {
		s.seedInitialGit(repo, owner)
		repo, _ = s.store.Repos.Get(intField(repo, "id"))
	}
	return repo, true
}

func (s *Service) createRepoRecord(options createRepoOptions) corestore.Record {
	name := strings.TrimSpace(options.Name)
	fullName := options.OwnerLogin + "/" + name
	if firstRecord(s.store.Repos.FindBy("full_name", fullName)) != nil {
		return nil
	}
	visibility := "public"
	if options.Private {
		visibility = "private"
	}
	if options.DefaultBranch == "" {
		options.DefaultBranch = "main"
	}
	languages := map[string]int{}
	if language, ok := options.Language.(string); ok && language != "" {
		languages[language] = 10000
	}
	repo := s.store.Repos.Insert(corestore.Record{
		"node_id":                "",
		"name":                   name,
		"full_name":              fullName,
		"owner_id":               options.OwnerID,
		"owner_type":             options.OwnerType,
		"private":                options.Private,
		"description":            options.Description,
		"fork":                   false,
		"forked_from_id":         nil,
		"homepage":               options.Homepage,
		"language":               options.Language,
		"languages":              languages,
		"forks_count":            0,
		"stargazers_count":       0,
		"watchers_count":         0,
		"size":                   0,
		"default_branch":         options.DefaultBranch,
		"open_issues_count":      0,
		"topics":                 options.Topics,
		"has_issues":             true,
		"has_projects":           true,
		"has_wiki":               true,
		"has_pages":              false,
		"has_downloads":          true,
		"has_discussions":        false,
		"archived":               false,
		"disabled":               false,
		"visibility":             visibility,
		"pushed_at":              nil,
		"allow_rebase_merge":     true,
		"allow_squash_merge":     true,
		"allow_merge_commit":     true,
		"allow_auto_merge":       false,
		"delete_branch_on_merge": false,
		"allow_forking":          true,
		"is_template":            false,
		"license":                nil,
	})
	repo, _ = s.store.Repos.Update(intField(repo, "id"), corestore.Record{"node_id": generateNodeID("Repository", intField(repo, "id"))})
	if !options.Private {
		s.bumpPublicRepos(options.OwnerID, options.OwnerType, 1)
	}
	return repo
}

func (s *Service) seedInitialGit(repo corestore.Record, actor corestore.Record) {
	readme := "# " + stringField(repo, "name") + "\n"
	blob := s.store.Blobs.Insert(corestore.Record{
		"repo_id":  intField(repo, "id"),
		"sha":      generateSha(),
		"node_id":  "",
		"content":  readme,
		"encoding": "utf-8",
		"size":     len([]byte(readme)),
	})
	s.store.Blobs.Update(intField(blob, "id"), corestore.Record{"node_id": generateNodeID("Blob", intField(blob, "id"))})
	tree := s.store.Trees.Insert(corestore.Record{
		"repo_id": intField(repo, "id"),
		"sha":     generateSha(),
		"node_id": "",
		"tree": []any{
			map[string]any{"path": "README.md", "mode": "100644", "type": "blob", "sha": stringField(blob, "sha"), "size": len([]byte(readme))},
		},
		"truncated": false,
	})
	s.store.Trees.Update(intField(tree, "id"), corestore.Record{"node_id": generateNodeID("Tree", intField(tree, "id"))})
	authorName := stringField(actor, "name")
	if authorName == "" {
		authorName = stringField(actor, "login")
	}
	authorEmail := stringField(actor, "email")
	if authorEmail == "" {
		authorEmail = stringField(actor, "login") + "@localhost"
	}
	now := nowISO()
	commit := s.store.Commits.Insert(corestore.Record{
		"repo_id":         intField(repo, "id"),
		"sha":             generateSha(),
		"node_id":         "",
		"message":         "Initial commit",
		"author_name":     authorName,
		"author_email":    authorEmail,
		"author_date":     now,
		"committer_name":  authorName,
		"committer_email": authorEmail,
		"committer_date":  now,
		"tree_sha":        stringField(tree, "sha"),
		"parent_shas":     []string{},
		"user_id":         intField(actor, "id"),
	})
	s.store.Commits.Update(intField(commit, "id"), corestore.Record{"node_id": generateNodeID("Commit", intField(commit, "id"))})
	s.store.Branches.Insert(corestore.Record{
		"repo_id":   intField(repo, "id"),
		"name":      stringField(repo, "default_branch"),
		"sha":       stringField(commit, "sha"),
		"protected": false,
	})
	ref := s.store.Refs.Insert(corestore.Record{
		"repo_id": intField(repo, "id"),
		"ref":     "refs/heads/" + stringField(repo, "default_branch"),
		"sha":     stringField(commit, "sha"),
		"node_id": "",
	})
	s.store.Refs.Update(intField(ref, "id"), corestore.Record{"node_id": generateNodeID("Ref", intField(ref, "id"))})
	s.store.Repos.Update(intField(repo, "id"), corestore.Record{
		"size":      len([]byte(readme)),
		"pushed_at": now,
		"language":  "Markdown",
		"languages": map[string]int{"Markdown": len([]byte(readme))},
	})
}

func (s *Service) handlePatchRepo(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if _, ok := s.assertRepoAdmin(c, repo); !ok {
		return
	}
	body, err := parseJSONBody(c.Request)
	if err != nil {
		writeValidation(c, "Invalid JSON body")
		return
	}
	patch := corestore.Record{}
	if name := strings.TrimSpace(stringValue(body["name"])); name != "" {
		if !validateRepoName(name) {
			writeValidation(c, "Invalid repository name")
			return
		}
		newFullName := s.ownerLogin(repo) + "/" + name
		if existing := firstRecord(s.store.Repos.FindBy("full_name", newFullName)); existing != nil && intField(existing, "id") != intField(repo, "id") {
			writeValidation(c, "Repository already exists")
			return
		}
		patch["name"] = name
		patch["full_name"] = newFullName
	}
	for _, key := range []string{"description", "homepage"} {
		if value, exists := body[key]; exists {
			if value == nil {
				patch[key] = nil
			} else if s, ok := value.(string); ok {
				patch[key] = s
			}
		}
	}
	if value, ok := body["private"].(bool); ok {
		patch["private"] = value
		if value {
			patch["visibility"] = "private"
		} else {
			patch["visibility"] = "public"
		}
	}
	for _, key := range []string{"has_issues", "has_projects", "has_wiki", "has_pages", "has_downloads", "has_discussions", "archived", "disabled", "allow_rebase_merge", "allow_squash_merge", "allow_merge_commit", "allow_auto_merge", "delete_branch_on_merge", "allow_forking", "is_template"} {
		if value, ok := body[key].(bool); ok {
			patch[key] = value
		}
	}
	if value, ok := body["visibility"].(string); ok && (value == "public" || value == "private" || value == "internal") {
		patch["visibility"] = value
		patch["private"] = value != "public"
	}
	if value, ok := body["default_branch"].(string); ok && value != "" {
		patch["default_branch"] = value
	}
	if raw, ok := body["topics"].([]any); ok {
		topics := make([]string, 0, len(raw))
		for _, item := range raw {
			if topic, ok := item.(string); ok {
				topics = append(topics, topic)
			}
		}
		patch["topics"] = topics
	}
	oldPrivate := boolField(repo, "private")
	updated, _ := s.store.Repos.Update(intField(repo, "id"), patch)
	if newPrivate := boolField(updated, "private"); newPrivate != oldPrivate {
		if newPrivate {
			s.bumpPublicRepos(intField(updated, "owner_id"), stringField(updated, "owner_type"), -1)
		} else {
			s.bumpPublicRepos(intField(updated, "owner_id"), stringField(updated, "owner_type"), 1)
		}
	}
	viewerID := 0
	if auth, ok := s.authUser(c); ok {
		viewerID = auth.ID
	}
	c.JSON(http.StatusOK, s.formatRepo(updated, viewerID))
}

func (s *Service) handleDeleteRepo(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if _, ok := s.assertRepoAdmin(c, repo); !ok {
		return
	}
	repoID := intField(repo, "id")
	for _, collection := range []*corestore.Collection{s.store.Collaborators, s.store.Issues, s.store.PullRequests, s.store.Labels, s.store.Milestones, s.store.Comments, s.store.Branches, s.store.Refs, s.store.Commits, s.store.Trees, s.store.Blobs, s.store.Webhooks} {
		for _, row := range collection.FindBy("repo_id", repoID) {
			collection.Delete(intField(row, "id"))
		}
	}
	s.store.Repos.Delete(repoID)
	if !boolField(repo, "private") {
		s.bumpPublicRepos(intField(repo, "owner_id"), stringField(repo, "owner_type"), -1)
	}
	c.Writer.WriteHeader(http.StatusNoContent)
}

func (s *Service) handleGetRepoTopics(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	c.JSON(http.StatusOK, map[string]any{"names": stringSliceValue(repo["topics"])})
}

func (s *Service) handlePutRepoTopics(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if _, ok := s.assertRepoAdmin(c, repo); !ok {
		return
	}
	body, err := parseJSONBody(c.Request)
	if err != nil {
		writeValidation(c, "Invalid JSON body")
		return
	}
	topics := stringSliceValue(body["names"])
	updated, _ := s.store.Repos.Update(intField(repo, "id"), corestore.Record{"topics": topics})
	c.JSON(http.StatusOK, map[string]any{"names": stringSliceValue(updated["topics"])})
}

func (s *Service) handleGetRepoLanguages(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	c.JSON(http.StatusOK, jsonStringMap(mapStringIntValue(repo["languages"])))
}

func (s *Service) handleListContributors(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	byID := map[int]corestore.Record{}
	if stringField(repo, "owner_type") == "User" {
		if owner, ok := s.store.Users.Get(intField(repo, "owner_id")); ok {
			byID[intField(owner, "id")] = owner
		}
	}
	for _, collab := range s.store.Collaborators.FindBy("repo_id", intField(repo, "id")) {
		if user, ok := s.store.Users.Get(intField(collab, "user_id")); ok {
			byID[intField(user, "id")] = user
		}
	}
	users := make([]corestore.Record, 0, len(byID))
	for _, user := range byID {
		users = append(users, user)
	}
	sortRecordsByString(users, "login", false)
	page := paginateRecords(c, users, parsePagination(c))
	out := make([]any, 0, len(page))
	for _, user := range page {
		row := s.formatUser(user)
		row["contributions"] = 1
		out = append(out, row)
	}
	c.JSON(http.StatusOK, out)
}

func (s *Service) handleListTags(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	c.JSON(http.StatusOK, []any{})
}

func (s *Service) bumpPublicRepos(ownerID int, ownerKind string, delta int) {
	if delta == 0 {
		return
	}
	collection := s.store.Users
	if ownerKind == "Organization" {
		collection = s.store.Orgs
	}
	owner, ok := collection.Get(ownerID)
	if !ok {
		return
	}
	next := intField(owner, "public_repos") + delta
	if next < 0 {
		next = 0
	}
	collection.Update(ownerID, corestore.Record{"public_repos": next})
}

func sortedRepos(repos []corestore.Record, sortKey string, direction string) []corestore.Record {
	out := append([]corestore.Record(nil), repos...)
	desc := direction == "desc"
	switch sortKey {
	case "created":
		sortRecordsByString(out, "created_at", desc)
	case "updated":
		sortRecordsByString(out, "updated_at", desc)
	case "pushed":
		sortRecordsByString(out, "pushed_at", desc)
	default:
		sort.SliceStable(out, func(i, j int) bool {
			if desc {
				return stringField(out[i], "full_name") > stringField(out[j], "full_name")
			}
			return stringField(out[i], "full_name") < stringField(out[j], "full_name")
		})
	}
	return out
}
