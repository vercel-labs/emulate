package github

import (
	"net/http"
	"sort"
	"strconv"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerPullRoutes(router *corehttp.Router) {
	router.Get("/repos/:owner/:repo/pulls", s.handleListPulls)
	router.Post("/repos/:owner/:repo/pulls", s.handleCreatePull)
	router.Get("/repos/:owner/:repo/pulls/:pull_number", s.handleGetPull)
	router.Patch("/repos/:owner/:repo/pulls/:pull_number", s.handlePatchPull)
	router.Put("/repos/:owner/:repo/pulls/:pull_number/merge", s.handleMergePull)
	router.Get("/repos/:owner/:repo/pulls/:pull_number/commits", s.handlePullCommits)
	router.Get("/repos/:owner/:repo/pulls/:pull_number/files", s.handlePullFiles)
}

func (s *Service) handleListPulls(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	state := c.Query("state")
	if state == "" {
		state = "open"
	}
	pulls := make([]corestore.Record, 0)
	for _, pr := range s.store.PullRequests.FindBy("repo_id", intField(repo, "id")) {
		if state == "open" || state == "closed" {
			if stringField(pr, "state") != state {
				continue
			}
		}
		if base := strings.TrimSpace(c.Query("base")); base != "" && stringField(pr, "base_ref") != base {
			continue
		}
		if head := strings.TrimSpace(c.Query("head")); head != "" && stringField(pr, "head_ref") != strings.TrimPrefix(head, s.ownerLogin(repo)+":") {
			continue
		}
		pulls = append(pulls, pr)
	}
	sort.SliceStable(pulls, func(i, j int) bool {
		return stringField(pulls[i], "created_at") > stringField(pulls[j], "created_at")
	})
	page := paginateRecords(c, pulls, parsePagination(c))
	out := make([]any, 0, len(page))
	for _, pr := range page {
		out = append(out, s.formatPull(pr))
	}
	c.JSON(http.StatusOK, out)
}

func (s *Service) handleCreatePull(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	actor, ok := s.assertRepoWrite(c, repo)
	if !ok {
		return
	}
	body, err := parseJSONBody(c.Request)
	if err != nil {
		writeValidation(c, "Invalid JSON body")
		return
	}
	title := strings.TrimSpace(stringValue(body["title"]))
	head := strings.TrimSpace(stringValue(body["head"]))
	base := strings.TrimSpace(stringValue(body["base"]))
	if title == "" || head == "" || base == "" {
		writeValidation(c, "Validation failed")
		return
	}
	headRepo := repo
	headRef := head
	if strings.Contains(head, ":") {
		parts := strings.SplitN(head, ":", 2)
		headRef = parts[1]
		if other := s.lookupRepo(parts[0], stringField(repo, "name")); other != nil {
			headRepo = other
		}
	}
	if headRef == base && intField(headRepo, "id") == intField(repo, "id") {
		writeValidation(c, "Validation failed")
		return
	}
	headBranch := s.getOrCreateBranch(headRepo, headRef)
	baseBranch := s.getOrCreateBranch(repo, base)
	if headBranch == nil || baseBranch == nil {
		writeValidation(c, "The repository is empty.")
		return
	}
	number := s.nextIssueNumber(intField(repo, "id"))
	prBody := nullableIssueBody(body["body"])
	issue := s.store.Issues.Insert(corestore.Record{
		"node_id":            "",
		"number":             number,
		"repo_id":            intField(repo, "id"),
		"title":              title,
		"body":               prBody,
		"state":              "open",
		"state_reason":       nil,
		"locked":             false,
		"active_lock_reason": nil,
		"user_id":            intField(actor, "id"),
		"assignee_ids":       []int{},
		"label_ids":          []int{},
		"milestone_id":       nil,
		"comments":           0,
		"closed_at":          nil,
		"closed_by_id":       nil,
		"is_pull_request":    true,
	})
	s.store.Issues.Update(intField(issue, "id"), corestore.Record{"node_id": generateNodeID("Issue", intField(issue, "id"))})
	row := s.store.PullRequests.Insert(corestore.Record{
		"node_id":                "",
		"number":                 number,
		"repo_id":                intField(repo, "id"),
		"title":                  title,
		"body":                   prBody,
		"state":                  "open",
		"locked":                 false,
		"user_id":                intField(actor, "id"),
		"assignee_ids":           []int{},
		"label_ids":              []int{},
		"milestone_id":           nil,
		"head_ref":               headRef,
		"head_sha":               stringField(headBranch, "sha"),
		"head_repo_id":           intField(headRepo, "id"),
		"base_ref":               base,
		"base_sha":               stringField(baseBranch, "sha"),
		"base_repo_id":           intField(repo, "id"),
		"merged":                 false,
		"merged_at":              nil,
		"merged_by_id":           nil,
		"merge_commit_sha":       nil,
		"mergeable":              true,
		"mergeable_state":        "clean",
		"comments":               0,
		"review_comments":        0,
		"commits":                1,
		"additions":              0,
		"deletions":              0,
		"changed_files":          0,
		"draft":                  boolField(corestore.Record{"draft": body["draft"]}, "draft"),
		"requested_reviewer_ids": []int{},
		"requested_team_ids":     []int{},
		"closed_at":              nil,
		"auto_merge":             nil,
	})
	pr, _ := s.store.PullRequests.Update(intField(row, "id"), corestore.Record{"node_id": generateNodeID("PullRequest", intField(row, "id"))})
	s.adjustOpenIssues(intField(repo, "id"), 1)
	c.JSON(http.StatusCreated, s.formatPull(pr))
}

func (s *Service) handleGetPull(c *corehttp.Context) {
	repo, pr, ok := s.pullFromRequest(c)
	if !ok {
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	c.JSON(http.StatusOK, s.formatPull(pr))
}

func (s *Service) handlePatchPull(c *corehttp.Context) {
	repo, pr, ok := s.pullFromRequest(c)
	if !ok {
		return
	}
	actor, ok := s.assertRepoWrite(c, repo)
	if !ok {
		return
	}
	body, err := parseJSONBody(c.Request)
	if err != nil {
		writeValidation(c, "Invalid JSON body")
		return
	}
	patch := corestore.Record{}
	issuePatch := corestore.Record{}
	if title, ok := body["title"].(string); ok {
		patch["title"] = title
		issuePatch["title"] = title
	}
	if value, exists := body["body"]; exists {
		patch["body"] = nullableIssueBody(value)
		issuePatch["body"] = nullableIssueBody(value)
	}
	if state := stringValue(body["state"]); state == "open" || state == "closed" {
		patch["state"] = state
		issuePatch["state"] = state
		if state == "closed" && stringField(pr, "state") == "open" {
			now := nowISO()
			patch["closed_at"] = now
			issuePatch["closed_at"] = now
			issuePatch["closed_by_id"] = intField(actor, "id")
			s.adjustOpenIssues(intField(repo, "id"), -1)
		}
		if state == "open" && stringField(pr, "state") == "closed" {
			patch["closed_at"] = nil
			issuePatch["closed_at"] = nil
			issuePatch["closed_by_id"] = nil
			s.adjustOpenIssues(intField(repo, "id"), 1)
		}
	}
	if draft, ok := body["draft"].(bool); ok {
		patch["draft"] = draft
	}
	if base := strings.TrimSpace(stringValue(body["base"])); base != "" {
		branch := s.getOrCreateBranch(repo, base)
		if branch == nil {
			writeValidation(c, "The repository is empty.")
			return
		}
		patch["base_ref"] = base
		patch["base_sha"] = stringField(branch, "sha")
	}
	updated, _ := s.store.PullRequests.Update(intField(pr, "id"), patch)
	if issue := s.findPullIssue(intField(repo, "id"), intField(pr, "number")); issue != nil {
		s.store.Issues.Update(intField(issue, "id"), issuePatch)
	}
	c.JSON(http.StatusOK, s.formatPull(updated))
}

func (s *Service) handleMergePull(c *corehttp.Context) {
	repo, pr, ok := s.pullFromRequest(c)
	if !ok {
		return
	}
	actor, ok := s.assertRepoWrite(c, repo)
	if !ok {
		return
	}
	if boolField(pr, "merged") || stringField(pr, "state") == "closed" {
		writeValidation(c, "Pull Request is not mergeable")
		return
	}
	baseRepo, ok := s.store.Repos.Get(intField(pr, "base_repo_id"))
	if !ok {
		writeValidation(c, "Base repository not found")
		return
	}
	headRepo, ok := s.store.Repos.Get(intField(pr, "head_repo_id"))
	if !ok {
		writeValidation(c, "Head repository not found")
		return
	}
	baseCommit := s.findCommitExact(baseRepo, stringField(pr, "base_sha"))
	headCommit := s.findCommitExact(headRepo, stringField(pr, "head_sha"))
	if baseCommit == nil || headCommit == nil {
		writeValidation(c, "Could not resolve commits to merge.")
		return
	}
	mergeCommit := s.insertCommit(baseRepo, stringField(headCommit, "tree_sha"), []string{stringField(baseCommit, "sha"), stringField(headCommit, "sha")}, mergeCommitMessage(pr), actor)
	mergeSha := stringField(mergeCommit, "sha")
	now := nowISO()
	s.store.PullRequests.Update(intField(pr, "id"), corestore.Record{
		"merged":           true,
		"merged_at":        now,
		"merged_by_id":     intField(actor, "id"),
		"merge_commit_sha": mergeSha,
		"state":            "closed",
		"closed_at":        now,
		"mergeable":        false,
		"mergeable_state":  "unknown",
	})
	if issue := s.findPullIssue(intField(repo, "id"), intField(pr, "number")); issue != nil {
		s.store.Issues.Update(intField(issue, "id"), corestore.Record{
			"state":        "closed",
			"closed_at":    now,
			"closed_by_id": intField(actor, "id"),
		})
	}
	s.updateBranchSha(repo, stringField(pr, "base_ref"), mergeSha)
	s.adjustOpenIssues(intField(repo, "id"), -1)
	c.JSON(http.StatusOK, map[string]any{
		"sha":     mergeSha,
		"merged":  true,
		"message": "Pull Request successfully merged",
	})
}

func (s *Service) handlePullCommits(c *corehttp.Context) {
	repo, pr, ok := s.pullFromRequest(c)
	if !ok {
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	headRepo, ok := s.store.Repos.Get(intField(pr, "head_repo_id"))
	if !ok {
		writeNotFound(c)
		return
	}
	commits := make([]corestore.Record, 0)
	for _, commit := range s.store.Commits.FindBy("repo_id", intField(headRepo, "id")) {
		if stringField(commit, "sha") == stringField(pr, "head_sha") {
			commits = append(commits, commit)
			break
		}
	}
	out := make([]any, 0, len(commits))
	for _, commit := range commits {
		out = append(out, s.formatCommit(headRepo, commit))
	}
	c.JSON(http.StatusOK, out)
}

func (s *Service) handlePullFiles(c *corehttp.Context) {
	repo, _, ok := s.pullFromRequest(c)
	if !ok {
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	c.JSON(http.StatusOK, []any{})
}

func (s *Service) pullFromRequest(c *corehttp.Context) (corestore.Record, corestore.Record, bool) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return nil, nil, false
	}
	number, err := strconv.Atoi(c.Param("pull_number"))
	if err != nil {
		writeNotFound(c)
		return nil, nil, false
	}
	for _, pr := range s.store.PullRequests.FindBy("repo_id", intField(repo, "id")) {
		if intField(pr, "number") == number {
			return repo, pr, true
		}
	}
	writeNotFound(c)
	return nil, nil, false
}

func (s *Service) findPullIssue(repoID int, number int) corestore.Record {
	for _, issue := range s.store.Issues.FindBy("repo_id", repoID) {
		if intField(issue, "number") == number && boolField(issue, "is_pull_request") {
			return issue
		}
	}
	return nil
}

func (s *Service) insertCommit(repo corestore.Record, treeSha string, parentShas []string, message string, actor corestore.Record) corestore.Record {
	authorName := stringField(actor, "name")
	if authorName == "" {
		authorName = stringField(actor, "login")
	}
	authorEmail := stringField(actor, "email")
	if authorEmail == "" {
		authorEmail = stringField(actor, "login") + "@localhost"
	}
	now := nowISO()
	row := s.store.Commits.Insert(corestore.Record{
		"repo_id":         intField(repo, "id"),
		"sha":             generateSha(),
		"node_id":         "",
		"message":         message,
		"author_name":     authorName,
		"author_email":    authorEmail,
		"author_date":     now,
		"committer_name":  authorName,
		"committer_email": authorEmail,
		"committer_date":  now,
		"tree_sha":        treeSha,
		"parent_shas":     parentShas,
		"user_id":         intField(actor, "id"),
	})
	commit, _ := s.store.Commits.Update(intField(row, "id"), corestore.Record{"node_id": generateNodeID("Commit", intField(row, "id"))})
	return commit
}

func mergeCommitMessage(pr corestore.Record) string {
	return "Merge pull request #" + strconv.Itoa(intField(pr, "number")) + " from " + stringField(pr, "head_ref")
}
