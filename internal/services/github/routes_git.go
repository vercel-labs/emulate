package github

import (
	"net/http"
	"sort"
	"strconv"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerBranchAndGitRoutes(router *corehttp.Router) {
	router.Get("/repos/:owner/:repo/branches/:branch{.+}", s.handleGetBranch)
	router.Get("/repos/:owner/:repo/branches", s.handleListBranches)
	router.Get("/repos/:owner/:repo/git/ref/:ref{.+}", s.handleGetRef)
	router.Get("/repos/:owner/:repo/git/matching-refs/:ref{.+}", s.handleMatchingRefs)
	router.Post("/repos/:owner/:repo/git/refs", s.handleCreateRef)
	router.Patch("/repos/:owner/:repo/git/refs/:ref{.+}", s.handlePatchRef)
	router.Delete("/repos/:owner/:repo/git/refs/:ref{.+}", s.handleDeleteRef)
	router.Get("/repos/:owner/:repo/git/commits/:commit_sha", s.handleGetCommit)
	router.Get("/repos/:owner/:repo/commits/:commit_sha", s.handleGetCommit)
	router.Get("/repos/:owner/:repo/git/trees/:tree_sha", s.handleGetTree)
}

func (s *Service) handleListBranches(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	branches := s.store.Branches.FindBy("repo_id", intField(repo, "id"))
	if protected := c.Query("protected"); protected == "true" || protected == "false" {
		want := protected == "true"
		filtered := branches[:0]
		for _, branch := range branches {
			if boolField(branch, "protected") == want {
				filtered = append(filtered, branch)
			}
		}
		branches = filtered
	}
	sortRecordsByString(branches, "name", false)
	page := paginateRecords(c, branches, parsePagination(c))
	out := make([]any, 0, len(page))
	for _, branch := range page {
		out = append(out, s.formatBranch(branch, repo))
	}
	c.JSON(http.StatusOK, out)
}

func (s *Service) handleGetBranch(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	branch := s.findBranch(repo, c.Param("branch"))
	if branch == nil {
		writeNotFound(c)
		return
	}
	c.JSON(http.StatusOK, s.formatBranch(branch, repo))
}

func (s *Service) handleGetRef(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	ref := s.findRef(repo, fullRefFromParam(c.Param("ref")))
	if ref == nil {
		writeNotFound(c)
		return
	}
	c.JSON(http.StatusOK, s.formatRef(repo, ref))
}

func (s *Service) handleMatchingRefs(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	prefix := fullRefFromParam(c.Param("ref"))
	refs := make([]corestore.Record, 0)
	for _, ref := range s.store.Refs.FindBy("repo_id", intField(repo, "id")) {
		if strings.HasPrefix(stringField(ref, "ref"), prefix) {
			refs = append(refs, ref)
		}
	}
	sortRecordsByString(refs, "ref", false)
	out := make([]any, 0, len(refs))
	for _, ref := range refs {
		out = append(out, s.formatRef(repo, ref))
	}
	c.JSON(http.StatusOK, out)
}

func (s *Service) handleCreateRef(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
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
	fullRef := stringValue(body["ref"])
	sha := stringValue(body["sha"])
	if !strings.HasPrefix(fullRef, "refs/") {
		writeValidation(c, "Invalid ref")
		return
	}
	if sha == "" {
		writeValidation(c, "sha is required")
		return
	}
	if s.findCommitExact(repo, sha) == nil {
		writeValidation(c, "Invalid sha")
		return
	}
	if s.findRef(repo, fullRef) != nil {
		writeValidation(c, "Reference already exists")
		return
	}
	row := s.store.Refs.Insert(corestore.Record{
		"repo_id": intField(repo, "id"),
		"ref":     fullRef,
		"sha":     sha,
		"node_id": "",
	})
	ref, _ := s.store.Refs.Update(intField(row, "id"), corestore.Record{"node_id": generateNodeID("Ref", intField(row, "id"))})
	s.syncBranchFromRef(repo, fullRef, sha)
	c.JSON(http.StatusCreated, s.formatRef(repo, ref))
}

func (s *Service) handlePatchRef(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if _, ok := s.assertRepoWrite(c, repo); !ok {
		return
	}
	ref := s.findRef(repo, fullRefFromParam(c.Param("ref")))
	if ref == nil {
		writeNotFound(c)
		return
	}
	body, err := parseJSONBody(c.Request)
	if err != nil {
		writeValidation(c, "Invalid JSON body")
		return
	}
	sha := stringValue(body["sha"])
	if sha == "" {
		writeValidation(c, "sha is required")
		return
	}
	if s.findCommitExact(repo, sha) == nil {
		writeValidation(c, "Invalid sha")
		return
	}
	force := false
	if value, ok := body["force"].(bool); ok {
		force = value
	}
	if !force {
		oldSha := stringField(ref, "sha")
		oldCommit := s.findCommitExact(repo, oldSha)
		newCommit := s.findCommitExact(repo, sha)
		if oldCommit == nil || newCommit == nil {
			writeValidation(c, "Fast-forward update requires commit objects")
			return
		}
		if !s.isDescendantOf(repo, oldSha, sha) {
			writeValidation(c, "Update is not a fast-forward")
			return
		}
	}
	updated, _ := s.store.Refs.Update(intField(ref, "id"), corestore.Record{"sha": sha})
	s.syncBranchFromRef(repo, stringField(updated, "ref"), sha)
	c.JSON(http.StatusOK, s.formatRef(repo, updated))
}

func (s *Service) handleDeleteRef(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if _, ok := s.assertRepoWrite(c, repo); !ok {
		return
	}
	ref := s.findRef(repo, fullRefFromParam(c.Param("ref")))
	if ref == nil {
		writeNotFound(c)
		return
	}
	s.store.Refs.Delete(intField(ref, "id"))
	if strings.HasPrefix(stringField(ref, "ref"), "refs/heads/") {
		if branch := s.findBranch(repo, strings.TrimPrefix(stringField(ref, "ref"), "refs/heads/")); branch != nil {
			s.store.Branches.Delete(intField(branch, "id"))
		}
	}
	c.Writer.WriteHeader(http.StatusNoContent)
}

func (s *Service) handleGetCommit(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	commit := s.findCommit(repo, c.Param("commit_sha"))
	if commit == nil {
		writeNotFound(c)
		return
	}
	c.JSON(http.StatusOK, s.formatCommit(repo, commit))
}

func (s *Service) handleGetTree(c *corehttp.Context) {
	repo := s.lookupRepo(c.Param("owner"), c.Param("repo"))
	if repo == nil {
		writeNotFound(c)
		return
	}
	if !s.assertRepoRead(c, repo) {
		return
	}
	for _, tree := range s.store.Trees.FindBy("repo_id", intField(repo, "id")) {
		if stringField(tree, "sha") == c.Param("tree_sha") {
			c.JSON(http.StatusOK, map[string]any{
				"sha":       stringField(tree, "sha"),
				"node_id":   stringField(tree, "node_id"),
				"url":       s.baseURL + "/repos/" + stringField(repo, "full_name") + "/git/trees/" + stringField(tree, "sha"),
				"tree":      tree["tree"],
				"truncated": boolField(tree, "truncated"),
			})
			return
		}
	}
	writeNotFound(c)
}

func (s *Service) createBranch(repo corestore.Record, branchName string, sha string) corestore.Record {
	branch := s.store.Branches.Insert(corestore.Record{
		"repo_id":   intField(repo, "id"),
		"name":      branchName,
		"sha":       sha,
		"protected": false,
	})
	if s.findRef(repo, "refs/heads/"+branchName) == nil {
		ref := s.store.Refs.Insert(corestore.Record{
			"repo_id": intField(repo, "id"),
			"ref":     "refs/heads/" + branchName,
			"sha":     sha,
			"node_id": "",
		})
		s.store.Refs.Update(intField(ref, "id"), corestore.Record{"node_id": generateNodeID("Ref", intField(ref, "id"))})
	}
	return branch
}

func (s *Service) updateBranchSha(repo corestore.Record, branchName string, sha string) {
	if branch := s.findBranch(repo, branchName); branch != nil {
		s.store.Branches.Update(intField(branch, "id"), corestore.Record{"sha": sha})
	}
	if ref := s.findRef(repo, "refs/heads/"+branchName); ref != nil {
		s.store.Refs.Update(intField(ref, "id"), corestore.Record{"sha": sha})
	}
}

func (s *Service) deleteBranchByName(repo corestore.Record, branchName string) {
	if branch := s.findBranch(repo, branchName); branch != nil {
		s.store.Branches.Delete(intField(branch, "id"))
	}
	if ref := s.findRef(repo, "refs/heads/"+branchName); ref != nil {
		s.store.Refs.Delete(intField(ref, "id"))
	}
}

func (s *Service) syncBranchFromRef(repo corestore.Record, fullRef string, sha string) {
	if !strings.HasPrefix(fullRef, "refs/heads/") {
		return
	}
	branchName := strings.TrimPrefix(fullRef, "refs/heads/")
	if branch := s.findBranch(repo, branchName); branch != nil {
		s.store.Branches.Update(intField(branch, "id"), corestore.Record{"sha": sha})
	} else {
		s.createBranch(repo, branchName, sha)
	}
}

func (s *Service) findBranch(repo corestore.Record, branchName string) corestore.Record {
	for _, branch := range s.store.Branches.FindBy("repo_id", intField(repo, "id")) {
		if stringField(branch, "name") == branchName {
			return branch
		}
	}
	return nil
}

func (s *Service) findRef(repo corestore.Record, fullRef string) corestore.Record {
	for _, ref := range s.store.Refs.FindBy("repo_id", intField(repo, "id")) {
		if stringField(ref, "ref") == fullRef {
			return ref
		}
	}
	return nil
}

func (s *Service) findCommit(repo corestore.Record, sha string) corestore.Record {
	for _, commit := range s.store.Commits.FindBy("repo_id", intField(repo, "id")) {
		full := stringField(commit, "sha")
		if full == sha || strings.HasPrefix(full, sha) {
			return commit
		}
	}
	return nil
}

func (s *Service) findCommitExact(repo corestore.Record, sha string) corestore.Record {
	for _, commit := range s.store.Commits.FindBy("repo_id", intField(repo, "id")) {
		if stringField(commit, "sha") == sha {
			return commit
		}
	}
	return nil
}

func (s *Service) findTreeExact(repo corestore.Record, sha string) corestore.Record {
	for _, tree := range s.store.Trees.FindBy("repo_id", intField(repo, "id")) {
		if stringField(tree, "sha") == sha {
			return tree
		}
	}
	return nil
}

func (s *Service) findBlobExact(repo corestore.Record, sha string) corestore.Record {
	for _, blob := range s.store.Blobs.FindBy("repo_id", intField(repo, "id")) {
		if stringField(blob, "sha") == sha {
			return blob
		}
	}
	return nil
}

func treeEntries(value any) []map[string]any {
	switch entries := value.(type) {
	case []map[string]any:
		return entries
	case []any:
		out := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			if row, ok := entry.(map[string]any); ok {
				out = append(out, row)
			}
		}
		return out
	default:
		return nil
	}
}

func (s *Service) isDescendantOf(repo corestore.Record, ancestorSha string, descendantSha string) bool {
	seen := map[string]bool{}
	stack := []string{descendantSha}
	for len(stack) > 0 {
		sha := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if sha == ancestorSha {
			return true
		}
		if seen[sha] {
			continue
		}
		seen[sha] = true
		commit := s.findCommitExact(repo, sha)
		if commit == nil {
			continue
		}
		stack = append(stack, stringSliceValue(commit["parent_shas"])...)
	}
	return false
}

func fullRefFromParam(ref string) string {
	if strings.HasPrefix(ref, "refs/") {
		return ref
	}
	return "refs/" + ref
}

func sortedRefs(refs []corestore.Record) {
	sort.SliceStable(refs, func(i, j int) bool {
		return stringField(refs[i], "ref") < stringField(refs[j], "ref")
	})
}

func parseIntParam(value string) (int, bool) {
	n, err := strconv.Atoi(value)
	return n, err == nil
}
