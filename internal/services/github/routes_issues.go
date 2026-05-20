package github

import (
	"net/http"
	"sort"
	"strconv"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerIssueRoutes(router *corehttp.Router) {
	router.Get("/repos/:owner/:repo/issues", s.handleListIssues)
	router.Post("/repos/:owner/:repo/issues", s.handleCreateIssue)
	router.Get("/repos/:owner/:repo/issues/:issue_number", s.handleGetIssue)
	router.Patch("/repos/:owner/:repo/issues/:issue_number", s.handlePatchIssue)
}

func (s *Service) handleListIssues(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	if !boolField(repo, "has_issues") {
		writeNotFound(c)
		return
	}
	state := c.Query("state")
	if state == "" {
		state = "open"
	}
	list := make([]corestore.Record, 0)
	for _, issue := range s.store.Issues.FindBy("repo_id", intField(repo, "id")) {
		if state == "open" || state == "closed" {
			if stringField(issue, "state") != state {
				continue
			}
		}
		list = append(list, issue)
	}
	labelNames := issueLabelFilters(c.Query("labels"))
	if len(labelNames) > 0 {
		labelIDs := make([]int, 0, len(labelNames))
		for _, name := range labelNames {
			var labelID int
			for _, label := range s.store.Labels.FindBy("repo_id", intField(repo, "id")) {
				if stringField(label, "name") == name {
					labelID = intField(label, "id")
					break
				}
			}
			if labelID == 0 {
				list = nil
				break
			}
			labelIDs = append(labelIDs, labelID)
		}
		if len(list) > 0 {
			filtered := list[:0]
			for _, issue := range list {
				issueLabelIDs := intSliceValue(issue["label_ids"])
				matches := true
				for _, labelID := range labelIDs {
					if !containsInt(issueLabelIDs, labelID) {
						matches = false
						break
					}
				}
				if matches {
					filtered = append(filtered, issue)
				}
			}
			list = filtered
		}
	}
	if milestone := c.Query("milestone"); milestone != "" {
		switch milestone {
		case "none":
			filtered := list[:0]
			for _, issue := range list {
				if intField(issue, "milestone_id") == 0 {
					filtered = append(filtered, issue)
				}
			}
			list = filtered
		case "*":
			filtered := list[:0]
			for _, issue := range list {
				if intField(issue, "milestone_id") > 0 {
					filtered = append(filtered, issue)
				}
			}
			list = filtered
		default:
			number, err := strconv.Atoi(milestone)
			if err != nil {
				list = nil
				break
			}
			var milestoneID int
			for _, row := range s.store.Milestones.FindBy("repo_id", intField(repo, "id")) {
				if intField(row, "number") == number {
					milestoneID = intField(row, "id")
					break
				}
			}
			if milestoneID == 0 {
				list = nil
				break
			}
			filtered := list[:0]
			for _, issue := range list {
				if intField(issue, "milestone_id") == milestoneID {
					filtered = append(filtered, issue)
				}
			}
			list = filtered
		}
	}
	if assignee := c.Query("assignee"); assignee != "" {
		switch assignee {
		case "none":
			filtered := list[:0]
			for _, issue := range list {
				if len(intSliceValue(issue["assignee_ids"])) == 0 {
					filtered = append(filtered, issue)
				}
			}
			list = filtered
		case "*":
			filtered := list[:0]
			for _, issue := range list {
				if len(intSliceValue(issue["assignee_ids"])) > 0 {
					filtered = append(filtered, issue)
				}
			}
			list = filtered
		default:
			user := firstRecord(s.store.Users.FindBy("login", assignee))
			if user == nil {
				list = nil
				break
			}
			userID := intField(user, "id")
			filtered := list[:0]
			for _, issue := range list {
				if containsInt(intSliceValue(issue["assignee_ids"]), userID) {
					filtered = append(filtered, issue)
				}
			}
			list = filtered
		}
	}
	if creator := c.Query("creator"); creator != "" {
		user := firstRecord(s.store.Users.FindBy("login", creator))
		if user == nil {
			list = nil
		} else {
			userID := intField(user, "id")
			filtered := list[:0]
			for _, issue := range list {
				if intField(issue, "user_id") == userID {
					filtered = append(filtered, issue)
				}
			}
			list = filtered
		}
	}
	if since := c.Query("since"); since != "" {
		filtered := list[:0]
		for _, issue := range list {
			if stringField(issue, "updated_at") >= since {
				filtered = append(filtered, issue)
			}
		}
		list = filtered
	}
	sortKey := c.Query("sort")
	if sortKey == "" {
		sortKey = "created"
	}
	direction := c.Query("direction")
	if direction != "asc" {
		direction = "desc"
	}
	sort.SliceStable(list, func(i, j int) bool {
		if sortKey == "comments" {
			if direction == "asc" {
				return intField(list[i], "comments") < intField(list[j], "comments")
			}
			return intField(list[i], "comments") > intField(list[j], "comments")
		}
		field := "created_at"
		if sortKey == "updated" {
			field = "updated_at"
		}
		if direction == "asc" {
			return stringField(list[i], field) < stringField(list[j], field)
		}
		return stringField(list[i], field) > stringField(list[j], field)
	})
	page := paginateRecords(c, list, parsePagination(c))
	out := make([]any, 0, len(page))
	for _, issue := range page {
		out = append(out, s.formatIssue(issue))
	}
	c.JSON(http.StatusOK, out)
}

func (s *Service) handleCreateIssue(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if !boolField(repo, "has_issues") {
		writeNotFound(c)
		return
	}
	actor, ok := s.assertIssueParticipant(c, repo)
	if !ok {
		return
	}
	body, err := parseJSONBody(c.Request)
	if err != nil {
		writeValidation(c, "Invalid JSON body")
		return
	}
	title := strings.TrimSpace(stringValue(body["title"]))
	if title == "" {
		writeValidation(c, "Validation failed")
		return
	}
	assigneeIDs, ok := s.resolveAssignees(c, body["assignees"])
	if !ok {
		return
	}
	labelIDs, ok := s.resolveLabelIDs(c, repo, body["labels"], true)
	if !ok {
		return
	}
	row := s.store.Issues.Insert(corestore.Record{
		"node_id":            "",
		"number":             s.nextIssueNumber(intField(repo, "id")),
		"repo_id":            intField(repo, "id"),
		"title":              title,
		"body":               nullableIssueBody(body["body"]),
		"state":              "open",
		"state_reason":       nil,
		"locked":             false,
		"active_lock_reason": nil,
		"user_id":            intField(actor, "id"),
		"assignee_ids":       assigneeIDs,
		"label_ids":          labelIDs,
		"milestone_id":       nil,
		"comments":           0,
		"closed_at":          nil,
		"closed_by_id":       nil,
		"is_pull_request":    false,
	})
	issue, _ := s.store.Issues.Update(intField(row, "id"), corestore.Record{"node_id": generateNodeID("Issue", intField(row, "id"))})
	s.adjustOpenIssues(intField(repo, "id"), 1)
	c.JSON(http.StatusCreated, s.formatIssue(issue))
}

func (s *Service) handleGetIssue(c *corehttp.Context) {
	repo, issue, ok := s.issueFromRequest(c, true)
	if !ok {
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	c.JSON(http.StatusOK, s.formatIssue(issue))
}

func (s *Service) handlePatchIssue(c *corehttp.Context) {
	repo, issue, ok := s.issueFromRequest(c, true)
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
	if title, ok := body["title"].(string); ok {
		patch["title"] = title
	}
	if value, exists := body["body"]; exists {
		patch["body"] = nullableIssueBody(value)
	}
	oldState := stringField(issue, "state")
	openIssuesDelta := 0
	if state := stringValue(body["state"]); state == "open" || state == "closed" {
		if state == "open" && boolField(issue, "is_pull_request") {
			if pr := s.findPullByNumber(intField(repo, "id"), intField(issue, "number")); pr != nil && boolField(pr, "merged") {
				writeValidation(c, "Validation failed")
				return
			}
		}
		patch["state"] = state
		if state == "closed" && oldState == "open" {
			patch["closed_at"] = nowISO()
			patch["closed_by_id"] = intField(actor, "id")
			if _, exists := body["state_reason"]; !exists {
				patch["state_reason"] = "completed"
			}
			openIssuesDelta = -1
		}
		if state == "open" && oldState == "closed" {
			patch["closed_at"] = nil
			patch["closed_by_id"] = nil
			if _, exists := body["state_reason"]; !exists {
				patch["state_reason"] = "reopened"
			}
			openIssuesDelta = 1
		}
	}
	if reason, exists := body["state_reason"]; exists {
		if reason == nil {
			patch["state_reason"] = nil
		} else if value := stringValue(reason); value == "completed" || value == "not_planned" || value == "reopened" {
			patch["state_reason"] = value
		}
	}
	if _, exists := body["assignees"]; exists {
		assigneeIDs, ok := s.resolveAssignees(c, body["assignees"])
		if !ok {
			return
		}
		patch["assignee_ids"] = assigneeIDs
	}
	if _, exists := body["labels"]; exists {
		labelIDs, ok := s.resolveLabelIDs(c, repo, body["labels"], true)
		if !ok {
			return
		}
		patch["label_ids"] = labelIDs
	}
	updated, _ := s.store.Issues.Update(intField(issue, "id"), patch)
	if boolField(issue, "is_pull_request") {
		s.syncPullFromIssuePatch(intField(repo, "id"), intField(issue, "number"), patch)
	}
	if openIssuesDelta != 0 {
		s.adjustOpenIssues(intField(repo, "id"), openIssuesDelta)
	}
	c.JSON(http.StatusOK, s.formatIssue(updated))
}

func (s *Service) issueFromRequest(c *corehttp.Context, allowPull bool) (corestore.Record, corestore.Record, bool) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return nil, nil, false
	}
	if !boolField(repo, "has_issues") {
		writeNotFound(c)
		return nil, nil, false
	}
	number, err := strconv.Atoi(c.Param("issue_number"))
	if err != nil {
		writeNotFound(c)
		return nil, nil, false
	}
	for _, issue := range s.store.Issues.FindBy("repo_id", intField(repo, "id")) {
		if intField(issue, "number") == number && (allowPull || !boolField(issue, "is_pull_request")) {
			return repo, issue, true
		}
	}
	writeNotFound(c)
	return nil, nil, false
}

func (s *Service) syncPullFromIssuePatch(repoID int, number int, issuePatch corestore.Record) {
	if len(issuePatch) == 0 {
		return
	}
	patch := corestore.Record{}
	for _, key := range []string{"title", "body", "state", "closed_at", "assignee_ids", "label_ids", "milestone_id"} {
		if value, exists := issuePatch[key]; exists {
			patch[key] = value
		}
	}
	if len(patch) == 0 {
		return
	}
	for _, pr := range s.store.PullRequests.FindBy("repo_id", repoID) {
		if intField(pr, "number") == number {
			s.store.PullRequests.Update(intField(pr, "id"), patch)
			return
		}
	}
}

func (s *Service) nextIssueNumber(repoID int) int {
	maxNumber := 0
	for _, issue := range s.store.Issues.FindBy("repo_id", repoID) {
		if n := intField(issue, "number"); n > maxNumber {
			maxNumber = n
		}
	}
	for _, pr := range s.store.PullRequests.FindBy("repo_id", repoID) {
		if n := intField(pr, "number"); n > maxNumber {
			maxNumber = n
		}
	}
	return maxNumber + 1
}

func (s *Service) adjustOpenIssues(repoID int, delta int) {
	repo, ok := s.store.Repos.Get(repoID)
	if !ok {
		return
	}
	next := intField(repo, "open_issues_count") + delta
	if next < 0 {
		next = 0
	}
	s.store.Repos.Update(repoID, corestore.Record{"open_issues_count": next})
}

func (s *Service) resolveAssignees(c *corehttp.Context, raw any) ([]int, bool) {
	if raw == nil {
		return []int{}, true
	}
	logins := stringSliceValue(raw)
	ids := make([]int, 0, len(logins))
	for _, login := range logins {
		user := firstRecord(s.store.Users.FindBy("login", login))
		if user == nil {
			writeValidation(c, "Validation failed")
			return nil, false
		}
		ids = append(ids, intField(user, "id"))
	}
	return uniqueInts(ids), true
}

func (s *Service) resolveLabelIDs(c *corehttp.Context, repo corestore.Record, raw any, createMissing bool) ([]int, bool) {
	if raw == nil {
		return []int{}, true
	}
	values, ok := raw.([]any)
	if !ok {
		writeValidation(c, "Validation failed")
		return nil, false
	}
	ids := make([]int, 0, len(values))
	for _, item := range values {
		switch value := item.(type) {
		case string:
			label := firstRecord(s.store.Labels.FindBy("repo_id", intField(repo, "id")))
			for _, candidate := range s.store.Labels.FindBy("repo_id", intField(repo, "id")) {
				if stringField(candidate, "name") == value {
					label = candidate
					break
				}
			}
			if label == nil || stringField(label, "name") != value {
				if !createMissing {
					writeValidation(c, "Validation failed")
					return nil, false
				}
				inserted := s.store.Labels.Insert(corestore.Record{
					"node_id":     "",
					"repo_id":     intField(repo, "id"),
					"name":        value,
					"description": nil,
					"color":       "ededed",
					"default":     false,
				})
				label, _ = s.store.Labels.Update(intField(inserted, "id"), corestore.Record{"node_id": generateNodeID("Label", intField(inserted, "id"))})
			}
			ids = append(ids, intField(label, "id"))
		case float64:
			id := int(value)
			label, ok := s.store.Labels.Get(id)
			if !ok || intField(label, "repo_id") != intField(repo, "id") {
				writeValidation(c, "Validation failed")
				return nil, false
			}
			ids = append(ids, id)
		default:
			writeValidation(c, "Validation failed")
			return nil, false
		}
	}
	return uniqueInts(ids), true
}

func nullableIssueBody(value any) any {
	if value == nil {
		return nil
	}
	if body, ok := value.(string); ok {
		return body
	}
	return nil
}

func issueLabelFilters(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if label := strings.TrimSpace(part); label != "" {
			out = append(out, label)
		}
	}
	return out
}
