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
		if head := strings.TrimSpace(c.Query("head")); head != "" && !s.matchesPullHeadFilter(pr, head) {
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
	actor, auth, ok := s.currentAuthUser(c)
	if !ok {
		return
	}
	if !s.assertPullBaseAccess(c, auth, repo) {
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
	headRepo, headRef, ok := s.resolvePullHead(repo, head)
	if !ok {
		writeValidation(c, "Validation failed")
		return
	}
	if !s.assertPullHeadAccess(c, auth, headRepo) {
		return
	}
	if headRef == base && intField(headRepo, "id") == intField(repo, "id") {
		writeValidation(c, "Validation failed")
		return
	}
	headBranch := s.findBranch(headRepo, headRef)
	baseBranch := s.findBranch(repo, base)
	if headBranch == nil || baseBranch == nil {
		writeValidation(c, "Validation failed")
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
	openIssuesDelta := 0
	if title, ok := body["title"].(string); ok {
		patch["title"] = title
		issuePatch["title"] = title
	}
	if value, exists := body["body"]; exists {
		patch["body"] = nullableIssueBody(value)
		issuePatch["body"] = nullableIssueBody(value)
	}
	if state := stringValue(body["state"]); state == "open" || state == "closed" {
		if state == "open" && boolField(pr, "merged") {
			writeValidation(c, "Validation failed")
			return
		}
		patch["state"] = state
		issuePatch["state"] = state
		if state == "closed" && stringField(pr, "state") == "open" {
			now := nowISO()
			patch["closed_at"] = now
			issuePatch["closed_at"] = now
			issuePatch["closed_by_id"] = intField(actor, "id")
			openIssuesDelta = -1
		}
		if state == "open" && stringField(pr, "state") == "closed" {
			patch["closed_at"] = nil
			issuePatch["closed_at"] = nil
			issuePatch["closed_by_id"] = nil
			openIssuesDelta = 1
		}
	}
	if draft, ok := body["draft"].(bool); ok {
		patch["draft"] = draft
	}
	if base := strings.TrimSpace(stringValue(body["base"])); base != "" {
		branch := s.findBranch(repo, base)
		if branch == nil {
			writeValidation(c, "Validation failed")
			return
		}
		patch["base_ref"] = base
		patch["base_sha"] = stringField(branch, "sha")
	}
	updated, _ := s.store.PullRequests.Update(intField(pr, "id"), patch)
	if issue := s.findPullIssue(intField(repo, "id"), intField(pr, "number")); issue != nil {
		s.store.Issues.Update(intField(issue, "id"), issuePatch)
	}
	if openIssuesDelta != 0 {
		s.adjustOpenIssues(intField(repo, "id"), openIssuesDelta)
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
	body, err := parseJSONBody(c.Request)
	if err != nil {
		writeValidation(c, "Invalid JSON body")
		return
	}
	if boolField(pr, "draft") {
		writeValidation(c, "Draft pull requests cannot be merged.")
		return
	}
	if sha := strings.TrimSpace(stringValue(body["sha"])); sha != "" && sha != stringField(pr, "head_sha") {
		writeValidation(c, "Head sha is out of date")
		return
	}
	mergeMethod := "merge"
	if value, ok := body["merge_method"].(string); ok && (value == "squash" || value == "rebase") {
		mergeMethod = value
	}
	if mergeMethod == "merge" && !boolField(repo, "allow_merge_commit") {
		writeValidation(c, "Merge commits are not allowed on this repository.")
		return
	}
	if mergeMethod == "squash" && !boolField(repo, "allow_squash_merge") {
		writeValidation(c, "Squash merges are not allowed on this repository.")
		return
	}
	if mergeMethod == "rebase" && !boolField(repo, "allow_rebase_merge") {
		writeValidation(c, "Rebase merges are not allowed on this repository.")
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
	if intField(baseRepo, "id") != intField(headRepo, "id") {
		s.materializeCommitGraph(baseRepo, headRepo, stringField(headCommit, "sha"), map[string]bool{}, map[string]bool{})
	}
	parentShas := []string{stringField(baseCommit, "sha"), stringField(headCommit, "sha")}
	if mergeMethod != "merge" {
		parentShas = []string{stringField(baseCommit, "sha")}
	}
	mergeCommit := s.insertCommit(baseRepo, stringField(headCommit, "tree_sha"), parentShas, s.mergeCommitMessage(pr, body), actor)
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
	s.updateBranchSha(baseRepo, stringField(pr, "base_ref"), mergeSha)
	if boolField(repo, "delete_branch_on_merge") && stringField(pr, "head_ref") != stringField(pr, "base_ref") {
		s.deleteBranchByName(headRepo, stringField(pr, "head_ref"))
	}
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

func (s *Service) findPullByNumber(repoID int, number int) corestore.Record {
	for _, pr := range s.store.PullRequests.FindBy("repo_id", repoID) {
		if intField(pr, "number") == number {
			return pr
		}
	}
	return nil
}

func (s *Service) resolvePullHead(baseRepo corestore.Record, head string) (corestore.Record, string, bool) {
	if !strings.Contains(head, ":") {
		return baseRepo, head, true
	}
	parts := strings.SplitN(head, ":", 2)
	owner := strings.TrimSpace(parts[0])
	ref := strings.TrimSpace(parts[1])
	if owner == "" || ref == "" {
		return nil, "", false
	}
	headRepo := s.lookupRepo(owner, stringField(baseRepo, "name"))
	if headRepo == nil {
		return nil, "", false
	}
	return headRepo, ref, true
}

func (s *Service) matchesPullHeadFilter(pr corestore.Record, head string) bool {
	head = strings.TrimSpace(head)
	if head == "" {
		return true
	}
	if !strings.Contains(head, ":") {
		return stringField(pr, "head_ref") == head
	}
	headRepo, ok := s.store.Repos.Get(intField(pr, "head_repo_id"))
	if !ok {
		return false
	}
	return s.ownerLogin(headRepo)+":"+stringField(pr, "head_ref") == head
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

func (s *Service) materializeCommitGraph(targetRepo corestore.Record, sourceRepo corestore.Record, sha string, seenCommits map[string]bool, seenTrees map[string]bool) {
	if sha == "" || seenCommits[sha] || s.findCommitExact(targetRepo, sha) != nil {
		return
	}
	seenCommits[sha] = true
	source := s.findCommitExact(sourceRepo, sha)
	if source == nil {
		return
	}
	for _, parent := range stringSliceValue(source["parent_shas"]) {
		s.materializeCommitGraph(targetRepo, sourceRepo, parent, seenCommits, seenTrees)
	}
	s.materializeTree(targetRepo, sourceRepo, stringField(source, "tree_sha"), seenTrees)
	row := s.store.Commits.Insert(corestore.Record{
		"repo_id":         intField(targetRepo, "id"),
		"sha":             stringField(source, "sha"),
		"node_id":         "",
		"message":         stringField(source, "message"),
		"author_name":     stringField(source, "author_name"),
		"author_email":    stringField(source, "author_email"),
		"author_date":     stringField(source, "author_date"),
		"committer_name":  stringField(source, "committer_name"),
		"committer_email": stringField(source, "committer_email"),
		"committer_date":  stringField(source, "committer_date"),
		"tree_sha":        stringField(source, "tree_sha"),
		"parent_shas":     stringSliceValue(source["parent_shas"]),
		"user_id":         source["user_id"],
	})
	s.store.Commits.Update(intField(row, "id"), corestore.Record{"node_id": generateNodeID("Commit", intField(row, "id"))})
}

func (s *Service) materializeTree(targetRepo corestore.Record, sourceRepo corestore.Record, sha string, seen map[string]bool) {
	if sha == "" || seen[sha] || s.findTreeExact(targetRepo, sha) != nil {
		return
	}
	seen[sha] = true
	source := s.findTreeExact(sourceRepo, sha)
	if source == nil {
		return
	}
	for _, item := range treeEntries(source["tree"]) {
		itemSha := stringValue(item["sha"])
		switch stringValue(item["type"]) {
		case "blob":
			s.materializeBlob(targetRepo, sourceRepo, itemSha)
		case "tree":
			s.materializeTree(targetRepo, sourceRepo, itemSha, seen)
		}
	}
	row := s.store.Trees.Insert(corestore.Record{
		"repo_id":   intField(targetRepo, "id"),
		"sha":       stringField(source, "sha"),
		"node_id":   "",
		"tree":      source["tree"],
		"truncated": boolField(source, "truncated"),
	})
	s.store.Trees.Update(intField(row, "id"), corestore.Record{"node_id": generateNodeID("Tree", intField(row, "id"))})
}

func (s *Service) materializeBlob(targetRepo corestore.Record, sourceRepo corestore.Record, sha string) {
	if sha == "" || s.findBlobExact(targetRepo, sha) != nil {
		return
	}
	source := s.findBlobExact(sourceRepo, sha)
	if source == nil {
		return
	}
	row := s.store.Blobs.Insert(corestore.Record{
		"repo_id":  intField(targetRepo, "id"),
		"sha":      stringField(source, "sha"),
		"node_id":  "",
		"content":  source["content"],
		"encoding": stringField(source, "encoding"),
		"size":     intField(source, "size"),
	})
	s.store.Blobs.Update(intField(row, "id"), corestore.Record{"node_id": generateNodeID("Blob", intField(row, "id"))})
}

func (s *Service) mergeCommitMessage(pr corestore.Record, body map[string]any) string {
	title := ""
	if value, ok := body["commit_title"].(string); ok {
		title = strings.TrimSpace(value)
	}
	if title == "" {
		title = "Merge pull request #" + strconv.Itoa(intField(pr, "number")) + " from " + s.pullHeadLabel(pr)
	}
	message := ""
	if value, ok := body["commit_message"].(string); ok {
		message = strings.TrimSpace(value)
	}
	if message == "" {
		return title
	}
	return title + "\n\n" + message
}

func (s *Service) pullHeadLabel(pr corestore.Record) string {
	headRepo, ok := s.store.Repos.Get(intField(pr, "head_repo_id"))
	owner := "unknown"
	if ok {
		owner = s.ownerLogin(headRepo)
	}
	return owner + ":" + stringField(pr, "head_ref")
}
