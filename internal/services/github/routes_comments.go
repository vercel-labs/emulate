package github

import (
	"net/http"
	"sort"
	"strconv"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerCommentRoutes(router *corehttp.Router) {
	router.Get("/repos/:owner/:repo/issues/comments/:comment_id", s.handleGetIssueComment)
	router.Patch("/repos/:owner/:repo/issues/comments/:comment_id", s.handlePatchIssueComment)
	router.Delete("/repos/:owner/:repo/issues/comments/:comment_id", s.handleDeleteIssueComment)
	router.Get("/repos/:owner/:repo/issues/:issue_number/comments", s.handleListIssueComments)
	router.Post("/repos/:owner/:repo/issues/:issue_number/comments", s.handleCreateIssueComment)
	router.Get("/repos/:owner/:repo/issues/comments", s.handleListRepoIssueComments)
}

func (s *Service) handleListIssueComments(c *corehttp.Context) {
	repo, issue, ok := s.issueFromRequest(c, true)
	if !ok {
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	comments := make([]corestore.Record, 0)
	for _, comment := range s.store.Comments.FindBy("repo_id", intField(repo, "id")) {
		if stringField(comment, "comment_type") == "issue" && intField(comment, "issue_number") == intField(issue, "number") {
			comments = append(comments, comment)
		}
	}
	s.respondCommentList(c, comments)
}

func (s *Service) handleListRepoIssueComments(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	comments := make([]corestore.Record, 0)
	for _, comment := range s.store.Comments.FindBy("repo_id", intField(repo, "id")) {
		if stringField(comment, "comment_type") == "issue" {
			comments = append(comments, comment)
		}
	}
	s.respondCommentList(c, comments)
}

func (s *Service) respondCommentList(c *corehttp.Context, comments []corestore.Record) {
	direction := c.Query("direction")
	if direction != "desc" {
		direction = "asc"
	}
	sortKey := c.Query("sort")
	if sortKey != "updated" {
		sortKey = "created"
	}
	sort.SliceStable(comments, func(i, j int) bool {
		field := "created_at"
		if sortKey == "updated" {
			field = "updated_at"
		}
		if direction == "desc" {
			return stringField(comments[i], field) > stringField(comments[j], field)
		}
		return stringField(comments[i], field) < stringField(comments[j], field)
	})
	page := paginateRecords(c, comments, parsePagination(c))
	out := make([]any, 0, len(page))
	for _, comment := range page {
		out = append(out, s.formatComment(comment))
	}
	c.JSON(http.StatusOK, out)
}

func (s *Service) handleCreateIssueComment(c *corehttp.Context) {
	repo, issue, ok := s.issueFromRequest(c, true)
	if !ok {
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
	text := stringValue(body["body"])
	if text == "" {
		writeValidation(c, "Validation failed")
		return
	}
	row := s.store.Comments.Insert(corestore.Record{
		"node_id":        "",
		"repo_id":        intField(repo, "id"),
		"issue_number":   intField(issue, "number"),
		"pull_number":    nil,
		"commit_sha":     nil,
		"body":           text,
		"user_id":        intField(actor, "id"),
		"in_reply_to_id": nil,
		"path":           nil,
		"position":       nil,
		"line":           nil,
		"side":           nil,
		"subject_type":   nil,
		"comment_type":   "issue",
		"review_id":      nil,
	})
	comment, _ := s.store.Comments.Update(intField(row, "id"), corestore.Record{"node_id": generateNodeID("IssueComment", intField(row, "id"))})
	s.store.Issues.Update(intField(issue, "id"), corestore.Record{"comments": intField(issue, "comments") + 1})
	if boolField(issue, "is_pull_request") {
		s.adjustPullIssueCommentCount(intField(repo, "id"), intField(issue, "number"), 1)
	}
	c.JSON(http.StatusCreated, s.formatComment(comment))
}

func (s *Service) handleGetIssueComment(c *corehttp.Context) {
	repo, comment, ok := s.issueCommentFromRequest(c)
	if !ok {
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	c.JSON(http.StatusOK, s.formatComment(comment))
}

func (s *Service) handlePatchIssueComment(c *corehttp.Context) {
	repo, comment, ok := s.issueCommentFromRequest(c)
	if !ok {
		return
	}
	if _, ok := s.assertRepoWrite(c, repo); !ok {
		return
	}
	body, err := parseJSONBody(c.Request)
	if err != nil {
		writeValidation(c, "Invalid JSON body")
		return
	}
	text, ok := body["body"].(string)
	if !ok {
		writeValidation(c, "Validation failed")
		return
	}
	updated, _ := s.store.Comments.Update(intField(comment, "id"), corestore.Record{"body": text})
	c.JSON(http.StatusOK, s.formatComment(updated))
}

func (s *Service) handleDeleteIssueComment(c *corehttp.Context) {
	repo, comment, ok := s.issueCommentFromRequest(c)
	if !ok {
		return
	}
	if _, ok := s.assertRepoWrite(c, repo); !ok {
		return
	}
	s.store.Comments.Delete(intField(comment, "id"))
	for _, issue := range s.store.Issues.FindBy("repo_id", intField(repo, "id")) {
		if intField(issue, "number") == intField(comment, "issue_number") {
			next := intField(issue, "comments") - 1
			if next < 0 {
				next = 0
			}
			s.store.Issues.Update(intField(issue, "id"), corestore.Record{"comments": next})
			if boolField(issue, "is_pull_request") {
				s.adjustPullIssueCommentCount(intField(repo, "id"), intField(issue, "number"), -1)
			}
		}
	}
	c.Writer.WriteHeader(http.StatusNoContent)
}

func (s *Service) adjustPullIssueCommentCount(repoID int, number int, delta int) {
	for _, pr := range s.store.PullRequests.FindBy("repo_id", repoID) {
		if intField(pr, "number") != number {
			continue
		}
		next := intField(pr, "comments") + delta
		if next < 0 {
			next = 0
		}
		s.store.PullRequests.Update(intField(pr, "id"), corestore.Record{"comments": next})
		return
	}
}

func (s *Service) issueCommentFromRequest(c *corehttp.Context) (corestore.Record, corestore.Record, bool) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return nil, nil, false
	}
	id, err := strconv.Atoi(c.Param("comment_id"))
	if err != nil {
		writeNotFound(c)
		return nil, nil, false
	}
	comment, ok := s.store.Comments.Get(id)
	if !ok || intField(comment, "repo_id") != intField(repo, "id") || stringField(comment, "comment_type") != "issue" {
		writeNotFound(c)
		return nil, nil, false
	}
	return repo, comment, true
}
