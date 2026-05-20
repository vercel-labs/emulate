package github

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

const testBaseURL = "http://localhost:4000"

func TestGitHubCurrentUserUsesDefaultToken(t *testing.T) {
	handler := newGitHubTestHandler(nil)
	res := doGitHubJSON(handler, http.MethodGet, "/user", "", "Bearer test_token_admin")

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		Login string `json:"login"`
		Email string `json:"email"`
	}
	decodeGitHubBody(t, res, &body)
	if body.Login != "admin" || body.Email != "admin@localhost" {
		t.Fatalf("unexpected user: %#v", body)
	}
}

func TestGitHubDefaultUserTokenUsesDefaultOctocat(t *testing.T) {
	handler := newGitHubTestHandler(nil)
	res := doGitHubJSON(handler, http.MethodGet, "/user", "", "Bearer test_token_user1")

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		Login string `json:"login"`
		Email string `json:"email"`
	}
	decodeGitHubBody(t, res, &body)
	if body.Login != "octocat" || body.Email != "octocat@github.com" {
		t.Fatalf("unexpected user: %#v", body)
	}
}

func TestGitHubConfiguredTokensReplaceDefaultTokens(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Tokens: map[string]TokenSeed{
			"test_token_admin": {Login: "octocat", Scopes: []string{"user"}},
		},
	})

	res := doGitHubJSON(handler, http.MethodGet, "/user", "", "Bearer test_token_admin")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		Login string `json:"login"`
	}
	decodeGitHubBody(t, res, &body)
	if body.Login != "octocat" {
		t.Fatalf("configured token did not replace default admin token: %#v", body)
	}

	defaultUserToken := doGitHubJSON(handler, http.MethodGet, "/user", "", "Bearer test_token_user1")
	if defaultUserToken.Code != http.StatusUnauthorized {
		t.Fatalf("default token remained active: status = %d, body = %s", defaultUserToken.Code, defaultUserToken.Body.String())
	}
}

func TestGitHubReposIssuesCommentsAndPulls(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Name: "The Octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world", Description: "Hello", Topics: []string{"hello"}, Language: "Go"}},
	})

	repo := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world", "", "Bearer test_token_user1")
	if repo.Code != http.StatusOK {
		t.Fatalf("repo status = %d, body = %s", repo.Code, repo.Body.String())
	}
	var repoBody struct {
		FullName      string `json:"full_name"`
		DefaultBranch string `json:"default_branch"`
	}
	decodeGitHubBody(t, repo, &repoBody)
	if repoBody.FullName != "octocat/hello-world" || repoBody.DefaultBranch != "main" {
		t.Fatalf("unexpected repo: %#v", repoBody)
	}

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches", "", "Bearer test_token_user1")
	if branches.Code != http.StatusOK || !strings.Contains(branches.Body.String(), `"name":"main"`) {
		t.Fatalf("unexpected branches: status = %d, body = %s", branches.Code, branches.Body.String())
	}
	mainSha := defaultBranchSha(t, branches, "main")

	issue := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/issues", `{"title":"Bug","body":"broken"}`, "Bearer test_token_user1")
	if issue.Code != http.StatusCreated {
		t.Fatalf("issue status = %d, body = %s", issue.Code, issue.Body.String())
	}
	var issueBody struct {
		Number int    `json:"number"`
		Title  string `json:"title"`
	}
	decodeGitHubBody(t, issue, &issueBody)
	if issueBody.Number != 1 || issueBody.Title != "Bug" {
		t.Fatalf("unexpected issue: %#v", issueBody)
	}

	comment := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/issues/1/comments", `{"body":"confirmed"}`, "Bearer test_token_user1")
	if comment.Code != http.StatusCreated || !strings.Contains(comment.Body.String(), "confirmed") {
		t.Fatalf("comment status = %d, body = %s", comment.Code, comment.Body.String())
	}

	ref := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/git/refs", `{"ref":"refs/heads/feature","sha":"`+mainSha+`"}`, "Bearer test_token_user1")
	if ref.Code != http.StatusCreated {
		t.Fatalf("ref status = %d, body = %s", ref.Code, ref.Body.String())
	}

	pr := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/pulls", `{"title":"Feature","head":"feature","base":"main"}`, "Bearer test_token_user1")
	if pr.Code != http.StatusCreated {
		t.Fatalf("pull status = %d, body = %s", pr.Code, pr.Body.String())
	}
	if !strings.Contains(pr.Body.String(), `"number":2`) {
		t.Fatalf("unexpected pull body: %s", pr.Body.String())
	}
}

func TestGitHubPullRequestIsVisibleThroughIssuesAPI(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches", "", "Bearer test_token_user1")
	if branches.Code != http.StatusOK {
		t.Fatalf("branches status = %d, body = %s", branches.Code, branches.Body.String())
	}
	mainSha := defaultBranchSha(t, branches, "main")
	ref := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/git/refs", `{"ref":"refs/heads/feature","sha":"`+mainSha+`"}`, "Bearer test_token_user1")
	if ref.Code != http.StatusCreated {
		t.Fatalf("ref status = %d, body = %s", ref.Code, ref.Body.String())
	}
	pr := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/pulls", `{"title":"Feature","head":"feature","base":"main"}`, "Bearer test_token_user1")
	if pr.Code != http.StatusCreated {
		t.Fatalf("pull status = %d, body = %s", pr.Code, pr.Body.String())
	}

	issue := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/issues/1", "", "Bearer test_token_user1")
	if issue.Code != http.StatusOK {
		t.Fatalf("issue status = %d, body = %s", issue.Code, issue.Body.String())
	}
	var issueBody struct {
		Number      int `json:"number"`
		PullRequest *struct {
			URL string `json:"url"`
		} `json:"pull_request"`
	}
	decodeGitHubBody(t, issue, &issueBody)
	if issueBody.Number != 1 || issueBody.PullRequest == nil || issueBody.PullRequest.URL == "" {
		t.Fatalf("unexpected pull issue: %#v, body = %s", issueBody, issue.Body.String())
	}

	list := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/issues", "", "Bearer test_token_user1")
	if list.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", list.Code, list.Body.String())
	}
	var listBody []struct {
		Number      int            `json:"number"`
		PullRequest map[string]any `json:"pull_request"`
	}
	decodeGitHubBody(t, list, &listBody)
	if len(listBody) != 1 || listBody[0].Number != 1 || listBody[0].PullRequest == nil {
		t.Fatalf("unexpected issue list: %#v, body = %s", listBody, list.Body.String())
	}

	patch := doGitHubJSON(handler, http.MethodPatch, "/repos/octocat/hello-world/issues/1", `{"title":"Retitled","state":"closed"}`, "Bearer test_token_user1")
	if patch.Code != http.StatusOK {
		t.Fatalf("patch status = %d, body = %s", patch.Code, patch.Body.String())
	}
	pull := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/pulls/1", "", "Bearer test_token_user1")
	if pull.Code != http.StatusOK {
		t.Fatalf("pull status = %d, body = %s", pull.Code, pull.Body.String())
	}
	var pullBody struct {
		Title string `json:"title"`
		State string `json:"state"`
	}
	decodeGitHubBody(t, pull, &pullBody)
	if pullBody.Title != "Retitled" || pullBody.State != "closed" {
		t.Fatalf("issue patch did not sync pull: %#v, body = %s", pullBody, pull.Body.String())
	}
}

func TestGitHubListIssuesAppliesFilters(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{
			{Login: "octocat", Email: "octocat@github.com"},
			{Login: "alice", Email: "alice@example.com"},
		},
		Tokens: map[string]TokenSeed{
			"octo_token":  {Login: "octocat", Scopes: []string{"repo", "user"}},
			"alice_token": {Login: "alice", Scopes: []string{"repo", "user"}},
		},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	for _, request := range []struct {
		body  string
		token string
	}{
		{`{"title":"Bug","assignees":["octocat"],"labels":["bug"]}`, "octo_token"},
		{`{"title":"Docs","assignees":["alice"],"labels":["docs"]}`, "octo_token"},
		{`{"title":"No owner","labels":["bug"]}`, "alice_token"},
	} {
		res := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/issues", request.body, "Bearer "+request.token)
		if res.Code != http.StatusCreated {
			t.Fatalf("issue status = %d, body = %s", res.Code, res.Body.String())
		}
	}

	assertIssueTitles := func(target string, want ...string) {
		t.Helper()
		res := doGitHubJSON(handler, http.MethodGet, target, "", "Bearer octo_token")
		if res.Code != http.StatusOK {
			t.Fatalf("%s status = %d, body = %s", target, res.Code, res.Body.String())
		}
		var body []struct {
			Title string `json:"title"`
		}
		decodeGitHubBody(t, res, &body)
		if len(body) != len(want) {
			t.Fatalf("%s returned %#v, want %#v, body = %s", target, body, want, res.Body.String())
		}
		for i, title := range want {
			if body[i].Title != title {
				t.Fatalf("%s returned %#v, want %#v, body = %s", target, body, want, res.Body.String())
			}
		}
	}

	assertIssueTitles("/repos/octocat/hello-world/issues?labels=docs", "Docs")
	assertIssueTitles("/repos/octocat/hello-world/issues?assignee=alice", "Docs")
	assertIssueTitles("/repos/octocat/hello-world/issues?assignee=none", "No owner")
	assertIssueTitles("/repos/octocat/hello-world/issues?creator=alice", "No owner")
	assertIssueTitles("/repos/octocat/hello-world/issues?since=9999-01-01T00:00:00Z")
}

func TestGitHubPullFormattingIncludesSyncedIssueMetadata(t *testing.T) {
	service, handler := newGitHubTestServiceHandler(&SeedConfig{
		Users: []UserSeed{
			{Login: "octocat", Email: "octocat@github.com"},
			{Login: "alice", Email: "alice@example.com"},
		},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches", "", "Bearer test_token_user1")
	if branches.Code != http.StatusOK {
		t.Fatalf("branches status = %d, body = %s", branches.Code, branches.Body.String())
	}
	mainSha := defaultBranchSha(t, branches, "main")
	ref := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/git/refs", `{"ref":"refs/heads/feature","sha":"`+mainSha+`"}`, "Bearer test_token_user1")
	if ref.Code != http.StatusCreated {
		t.Fatalf("ref status = %d, body = %s", ref.Code, ref.Body.String())
	}
	pr := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/pulls", `{"title":"Feature","head":"feature","base":"main"}`, "Bearer test_token_user1")
	if pr.Code != http.StatusCreated {
		t.Fatalf("pull status = %d, body = %s", pr.Code, pr.Body.String())
	}

	patchIssue := doGitHubJSON(handler, http.MethodPatch, "/repos/octocat/hello-world/issues/1", `{"assignees":["alice"],"labels":["bug"]}`, "Bearer test_token_user1")
	if patchIssue.Code != http.StatusOK {
		t.Fatalf("issue patch status = %d, body = %s", patchIssue.Code, patchIssue.Body.String())
	}

	repo := service.lookupRepo("octocat", "hello-world")
	alice := firstRecord(service.store.Users.FindBy("login", "alice"))
	milestoneRow := service.store.Milestones.Insert(corestore.Record{
		"node_id":       "",
		"repo_id":       intField(repo, "id"),
		"number":        1,
		"title":         "v1",
		"description":   nil,
		"state":         "open",
		"open_issues":   1,
		"closed_issues": 0,
		"due_on":        nil,
		"closed_at":     nil,
		"creator_id":    intField(alice, "id"),
	})
	milestone, _ := service.store.Milestones.Update(intField(milestoneRow, "id"), corestore.Record{"node_id": generateNodeID("Milestone", intField(milestoneRow, "id"))})
	if issue := service.findPullIssue(intField(repo, "id"), 1); issue != nil {
		service.store.Issues.Update(intField(issue, "id"), corestore.Record{"milestone_id": intField(milestone, "id")})
	}
	if pull := service.findPullByNumber(intField(repo, "id"), 1); pull != nil {
		service.store.PullRequests.Update(intField(pull, "id"), corestore.Record{"milestone_id": intField(milestone, "id")})
	}

	pull := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/pulls/1", "", "Bearer test_token_user1")
	if pull.Code != http.StatusOK {
		t.Fatalf("pull status = %d, body = %s", pull.Code, pull.Body.String())
	}
	var body struct {
		Assignee *struct {
			Login string `json:"login"`
		} `json:"assignee"`
		Assignees []struct {
			Login string `json:"login"`
		} `json:"assignees"`
		Labels []struct {
			Name string `json:"name"`
		} `json:"labels"`
		Milestone *struct {
			Title string `json:"title"`
		} `json:"milestone"`
	}
	decodeGitHubBody(t, pull, &body)
	if body.Assignee == nil || body.Assignee.Login != "alice" || len(body.Assignees) != 1 || body.Assignees[0].Login != "alice" {
		t.Fatalf("unexpected assignees: %#v, body = %s", body, pull.Body.String())
	}
	if len(body.Labels) != 1 || body.Labels[0].Name != "bug" {
		t.Fatalf("unexpected labels: %#v, body = %s", body.Labels, pull.Body.String())
	}
	if body.Milestone == nil || body.Milestone.Title != "v1" {
		t.Fatalf("unexpected milestone: %#v, body = %s", body.Milestone, pull.Body.String())
	}
}

func TestGitHubRepoWithoutTopicsReturnsEmptyArrays(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	repo := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world", "", "Bearer test_token_user1")
	if repo.Code != http.StatusOK {
		t.Fatalf("repo status = %d, body = %s", repo.Code, repo.Body.String())
	}
	var repoBody struct {
		Topics []string `json:"topics"`
	}
	decodeGitHubBody(t, repo, &repoBody)
	if repoBody.Topics == nil || len(repoBody.Topics) != 0 {
		t.Fatalf("topics should be an empty array: %#v, body = %s", repoBody.Topics, repo.Body.String())
	}

	topics := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/topics", "", "Bearer test_token_user1")
	if topics.Code != http.StatusOK {
		t.Fatalf("topics status = %d, body = %s", topics.Code, topics.Body.String())
	}
	var topicsBody struct {
		Names []string `json:"names"`
	}
	decodeGitHubBody(t, topics, &topicsBody)
	if topicsBody.Names == nil || len(topicsBody.Names) != 0 {
		t.Fatalf("topic names should be an empty array: %#v, body = %s", topicsBody.Names, topics.Body.String())
	}
}

func TestGitHubOrgRepoSeedCommitDoesNotResolveToCollidingUser(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Orgs:  []OrgSeed{{Login: "my-org", Name: "My Org"}},
		Repos: []RepoSeed{{Owner: "my-org", Name: "org-repo"}},
	})

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/my-org/org-repo/branches", "", "Bearer test_token_admin")
	if branches.Code != http.StatusOK {
		t.Fatalf("branches status = %d, body = %s", branches.Code, branches.Body.String())
	}
	mainSha := defaultBranchSha(t, branches, "main")
	commit := doGitHubJSON(handler, http.MethodGet, "/repos/my-org/org-repo/git/commits/"+mainSha, "", "Bearer test_token_admin")
	if commit.Code != http.StatusOK {
		t.Fatalf("commit status = %d, body = %s", commit.Code, commit.Body.String())
	}
	var body struct {
		Author *struct {
			Login string `json:"login"`
		} `json:"author"`
		Commit struct {
			Author struct {
				Name string `json:"name"`
			} `json:"author"`
		} `json:"commit"`
	}
	decodeGitHubBody(t, commit, &body)
	if body.Author != nil {
		t.Fatalf("org seed commit resolved to user author: %#v, body = %s", body.Author, commit.Body.String())
	}
	if body.Commit.Author.Name != "My Org" {
		t.Fatalf("unexpected commit author name: %#v, body = %s", body.Commit.Author, commit.Body.String())
	}
}

func TestGitHubListPullsFiltersForkHeadByOwnerAndBranch(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{
			{Login: "octocat", Email: "octocat@github.com"},
			{Login: "forker", Email: "forker@example.com"},
		},
		Repos: []RepoSeed{
			{Owner: "octocat", Name: "hello-world"},
			{Owner: "forker", Name: "hello-world"},
		},
	})

	forkBranches := doGitHubJSON(handler, http.MethodGet, "/repos/forker/hello-world/branches", "", "Bearer test_token_admin")
	if forkBranches.Code != http.StatusOK {
		t.Fatalf("fork branches status = %d, body = %s", forkBranches.Code, forkBranches.Body.String())
	}
	forkMainSha := defaultBranchSha(t, forkBranches, "main")
	ref := doGitHubJSON(handler, http.MethodPost, "/repos/forker/hello-world/git/refs", `{"ref":"refs/heads/feature","sha":"`+forkMainSha+`"}`, "Bearer test_token_admin")
	if ref.Code != http.StatusCreated {
		t.Fatalf("ref status = %d, body = %s", ref.Code, ref.Body.String())
	}

	pr := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/pulls", `{"title":"Fork feature","head":"forker:feature","base":"main"}`, "Bearer test_token_admin")
	if pr.Code != http.StatusCreated {
		t.Fatalf("pull status = %d, body = %s", pr.Code, pr.Body.String())
	}

	list := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/pulls?head=forker:feature", "", "Bearer test_token_admin")
	if list.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", list.Code, list.Body.String())
	}
	var body []struct {
		Number int `json:"number"`
		Head   struct {
			Label string `json:"label"`
		} `json:"head"`
	}
	decodeGitHubBody(t, list, &body)
	if len(body) != 1 || body[0].Head.Label != "forker:feature" {
		t.Fatalf("unexpected filtered pulls: %#v, body = %s", body, list.Body.String())
	}
}

func TestGitHubPublicForkOwnerCanCreatePullAgainstBaseRepo(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{
			{Login: "octocat", Email: "octocat@github.com"},
			{Login: "forker", Email: "forker@example.com"},
		},
		Tokens: map[string]TokenSeed{
			"forker_token": {Login: "forker", Scopes: []string{"repo", "user"}},
		},
		Repos: []RepoSeed{
			{Owner: "octocat", Name: "hello-world"},
			{Owner: "forker", Name: "hello-world"},
		},
	})

	forkBranches := doGitHubJSON(handler, http.MethodGet, "/repos/forker/hello-world/branches", "", "Bearer forker_token")
	if forkBranches.Code != http.StatusOK {
		t.Fatalf("fork branches status = %d, body = %s", forkBranches.Code, forkBranches.Body.String())
	}
	forkMainSha := defaultBranchSha(t, forkBranches, "main")
	ref := doGitHubJSON(handler, http.MethodPost, "/repos/forker/hello-world/git/refs", `{"ref":"refs/heads/feature","sha":"`+forkMainSha+`"}`, "Bearer forker_token")
	if ref.Code != http.StatusCreated {
		t.Fatalf("ref status = %d, body = %s", ref.Code, ref.Body.String())
	}

	pr := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/pulls", `{"title":"Fork feature","head":"forker:feature","base":"main"}`, "Bearer forker_token")
	if pr.Code != http.StatusCreated {
		t.Fatalf("pull status = %d, body = %s", pr.Code, pr.Body.String())
	}
	var body struct {
		Head struct {
			Label string `json:"label"`
		} `json:"head"`
		Base struct {
			Label string `json:"label"`
		} `json:"base"`
	}
	decodeGitHubBody(t, pr, &body)
	if body.Head.Label != "forker:feature" || body.Base.Label != "octocat:main" {
		t.Fatalf("unexpected pull sides: %#v, body = %s", body, pr.Body.String())
	}
}

func TestGitHubRejectsRefsToMissingCommits(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	res := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/git/refs", `{"ref":"refs/heads/missing","sha":"abc123"}`, "Bearer test_token_user1")
	if res.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "Invalid sha") {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestGitHubPatchRefRequiresFastForwardUnlessForced(t *testing.T) {
	service, handler := newGitHubTestServiceHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches", "", "Bearer test_token_user1")
	if branches.Code != http.StatusOK {
		t.Fatalf("branches status = %d, body = %s", branches.Code, branches.Body.String())
	}
	mainSha := defaultBranchSha(t, branches, "main")
	repo := service.lookupRepo("octocat", "hello-world")
	actor := firstRecord(service.store.Users.FindBy("login", "octocat"))
	baseCommit := service.findCommitExact(repo, mainSha)
	if baseCommit == nil {
		t.Fatalf("missing base commit %s", mainSha)
	}
	commitA := service.insertCommit(repo, stringField(baseCommit, "tree_sha"), []string{mainSha}, "Commit A", actor)
	commitB := service.insertCommit(repo, stringField(baseCommit, "tree_sha"), []string{mainSha}, "Commit B", actor)

	ref := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/git/refs", `{"ref":"refs/heads/feature","sha":"`+stringField(commitA, "sha")+`"}`, "Bearer test_token_user1")
	if ref.Code != http.StatusCreated {
		t.Fatalf("ref status = %d, body = %s", ref.Code, ref.Body.String())
	}

	nonFastForward := doGitHubJSON(handler, http.MethodPatch, "/repos/octocat/hello-world/git/refs/heads/feature", `{"sha":"`+stringField(commitB, "sha")+`"}`, "Bearer test_token_user1")
	if nonFastForward.Code != http.StatusUnprocessableEntity {
		t.Fatalf("non-fast-forward status = %d, body = %s", nonFastForward.Code, nonFastForward.Body.String())
	}
	if !strings.Contains(nonFastForward.Body.String(), "Update is not a fast-forward") {
		t.Fatalf("unexpected non-fast-forward body: %s", nonFastForward.Body.String())
	}

	forced := doGitHubJSON(handler, http.MethodPatch, "/repos/octocat/hello-world/git/refs/heads/feature", `{"sha":"`+stringField(commitB, "sha")+`","force":true}`, "Bearer test_token_user1")
	if forced.Code != http.StatusOK {
		t.Fatalf("forced status = %d, body = %s", forced.Code, forced.Body.String())
	}
}

func TestGitHubCreatePullRejectsMissingBranches(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	res := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/pulls", `{"title":"Missing","head":"feature","base":"main"}`, "Bearer test_token_user1")
	if res.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches", "", "Bearer test_token_user1")
	if branches.Code != http.StatusOK {
		t.Fatalf("branches status = %d, body = %s", branches.Code, branches.Body.String())
	}
	if strings.Contains(branches.Body.String(), `"name":"feature"`) {
		t.Fatalf("missing head branch was created: %s", branches.Body.String())
	}
}

func TestGitHubPatchPullRejectsMissingBaseBranch(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches", "", "Bearer test_token_user1")
	mainSha := defaultBranchSha(t, branches, "main")
	ref := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/git/refs", `{"ref":"refs/heads/feature","sha":"`+mainSha+`"}`, "Bearer test_token_user1")
	if ref.Code != http.StatusCreated {
		t.Fatalf("ref status = %d, body = %s", ref.Code, ref.Body.String())
	}
	pr := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/pulls", `{"title":"Feature","head":"feature","base":"main"}`, "Bearer test_token_user1")
	if pr.Code != http.StatusCreated {
		t.Fatalf("pull status = %d, body = %s", pr.Code, pr.Body.String())
	}

	patch := doGitHubJSON(handler, http.MethodPatch, "/repos/octocat/hello-world/pulls/1", `{"base":"missing"}`, "Bearer test_token_user1")
	if patch.Code != http.StatusUnprocessableEntity {
		t.Fatalf("patch status = %d, body = %s", patch.Code, patch.Body.String())
	}

	repo := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world", "", "Bearer test_token_user1")
	if repo.Code != http.StatusOK {
		t.Fatalf("repo status = %d, body = %s", repo.Code, repo.Body.String())
	}
	var repoBody struct {
		OpenIssuesCount int `json:"open_issues_count"`
	}
	decodeGitHubBody(t, repo, &repoBody)
	if repoBody.OpenIssuesCount != 1 {
		t.Fatalf("open_issues_count = %d, body = %s", repoBody.OpenIssuesCount, repo.Body.String())
	}
}

func TestGitHubMergeCreatesResolvableCommit(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches", "", "Bearer test_token_user1")
	if branches.Code != http.StatusOK {
		t.Fatalf("branches status = %d, body = %s", branches.Code, branches.Body.String())
	}
	mainSha := defaultBranchSha(t, branches, "main")

	ref := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/git/refs", `{"ref":"refs/heads/feature","sha":"`+mainSha+`"}`, "Bearer test_token_user1")
	if ref.Code != http.StatusCreated {
		t.Fatalf("ref status = %d, body = %s", ref.Code, ref.Body.String())
	}

	pr := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/pulls", `{"title":"Feature","head":"feature","base":"main"}`, "Bearer test_token_user1")
	if pr.Code != http.StatusCreated {
		t.Fatalf("pull status = %d, body = %s", pr.Code, pr.Body.String())
	}

	stale := doGitHubJSON(handler, http.MethodPut, "/repos/octocat/hello-world/pulls/1/merge", `{"sha":"deadbeef"}`, "Bearer test_token_user1")
	if stale.Code != http.StatusUnprocessableEntity {
		t.Fatalf("stale merge status = %d, body = %s", stale.Code, stale.Body.String())
	}
	if !strings.Contains(stale.Body.String(), "Head sha is out of date") {
		t.Fatalf("unexpected stale merge body: %s", stale.Body.String())
	}

	merge := doGitHubJSON(handler, http.MethodPut, "/repos/octocat/hello-world/pulls/1/merge", `{}`, "Bearer test_token_user1")
	if merge.Code != http.StatusOK {
		t.Fatalf("merge status = %d, body = %s", merge.Code, merge.Body.String())
	}
	var mergeBody struct {
		Sha string `json:"sha"`
	}
	decodeGitHubBody(t, merge, &mergeBody)
	if mergeBody.Sha == "" {
		t.Fatalf("missing merge sha: %s", merge.Body.String())
	}

	commit := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/git/commits/"+mergeBody.Sha, "", "Bearer test_token_user1")
	if commit.Code != http.StatusOK {
		t.Fatalf("commit status = %d, body = %s", commit.Code, commit.Body.String())
	}
	var commitBody struct {
		Author *struct {
			Login string `json:"login"`
		} `json:"author"`
		Committer *struct {
			Login string `json:"login"`
		} `json:"committer"`
	}
	decodeGitHubBody(t, commit, &commitBody)
	if commitBody.Author == nil || commitBody.Author.Login != "octocat" || commitBody.Committer == nil || commitBody.Committer.Login != "octocat" {
		t.Fatalf("unexpected commit identity: %#v, body = %s", commitBody, commit.Body.String())
	}

	pull := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/pulls/1", "", "Bearer test_token_user1")
	if pull.Code != http.StatusOK {
		t.Fatalf("pull status = %d, body = %s", pull.Code, pull.Body.String())
	}
	var pullBody struct {
		MergedBy *struct {
			Login string `json:"login"`
		} `json:"merged_by"`
	}
	decodeGitHubBody(t, pull, &pullBody)
	if pullBody.MergedBy == nil || pullBody.MergedBy.Login != "octocat" {
		t.Fatalf("unexpected merged_by: %#v, body = %s", pullBody.MergedBy, pull.Body.String())
	}
}

func TestGitHubMergedPullCannotBeReopened(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches", "", "Bearer test_token_user1")
	if branches.Code != http.StatusOK {
		t.Fatalf("branches status = %d, body = %s", branches.Code, branches.Body.String())
	}
	mainSha := defaultBranchSha(t, branches, "main")
	ref := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/git/refs", `{"ref":"refs/heads/feature","sha":"`+mainSha+`"}`, "Bearer test_token_user1")
	if ref.Code != http.StatusCreated {
		t.Fatalf("ref status = %d, body = %s", ref.Code, ref.Body.String())
	}
	pr := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/pulls", `{"title":"Feature","head":"feature","base":"main"}`, "Bearer test_token_user1")
	if pr.Code != http.StatusCreated {
		t.Fatalf("pull status = %d, body = %s", pr.Code, pr.Body.String())
	}
	merge := doGitHubJSON(handler, http.MethodPut, "/repos/octocat/hello-world/pulls/1/merge", `{}`, "Bearer test_token_user1")
	if merge.Code != http.StatusOK {
		t.Fatalf("merge status = %d, body = %s", merge.Code, merge.Body.String())
	}

	issueReopen := doGitHubJSON(handler, http.MethodPatch, "/repos/octocat/hello-world/issues/1", `{"state":"open"}`, "Bearer test_token_user1")
	if issueReopen.Code != http.StatusUnprocessableEntity {
		t.Fatalf("issue reopen status = %d, body = %s", issueReopen.Code, issueReopen.Body.String())
	}
	pullReopen := doGitHubJSON(handler, http.MethodPatch, "/repos/octocat/hello-world/pulls/1", `{"state":"open"}`, "Bearer test_token_user1")
	if pullReopen.Code != http.StatusUnprocessableEntity {
		t.Fatalf("pull reopen status = %d, body = %s", pullReopen.Code, pullReopen.Body.String())
	}

	repo := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world", "", "Bearer test_token_user1")
	if repo.Code != http.StatusOK {
		t.Fatalf("repo status = %d, body = %s", repo.Code, repo.Body.String())
	}
	var repoBody struct {
		OpenIssuesCount int `json:"open_issues_count"`
	}
	decodeGitHubBody(t, repo, &repoBody)
	if repoBody.OpenIssuesCount != 0 {
		t.Fatalf("open_issues_count = %d, body = %s", repoBody.OpenIssuesCount, repo.Body.String())
	}

	pull := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/pulls/1", "", "Bearer test_token_user1")
	if pull.Code != http.StatusOK {
		t.Fatalf("pull status = %d, body = %s", pull.Code, pull.Body.String())
	}
	var pullBody struct {
		State  string `json:"state"`
		Merged bool   `json:"merged"`
	}
	decodeGitHubBody(t, pull, &pullBody)
	if pullBody.State != "closed" || !pullBody.Merged {
		t.Fatalf("merged pull was reopened: %#v, body = %s", pullBody, pull.Body.String())
	}
}

func TestGitHubCrossRepoMergeMaterializesHeadGitObjects(t *testing.T) {
	service, handler := newGitHubTestServiceHandler(&SeedConfig{
		Users: []UserSeed{
			{Login: "octocat", Email: "octocat@github.com"},
			{Login: "forker", Email: "forker@example.com"},
		},
		Repos: []RepoSeed{
			{Owner: "octocat", Name: "hello-world"},
			{Owner: "forker", Name: "hello-world"},
		},
	})

	forkBranches := doGitHubJSON(handler, http.MethodGet, "/repos/forker/hello-world/branches", "", "Bearer test_token_admin")
	if forkBranches.Code != http.StatusOK {
		t.Fatalf("fork branches status = %d, body = %s", forkBranches.Code, forkBranches.Body.String())
	}
	forkMainSha := defaultBranchSha(t, forkBranches, "main")
	forkRepo := service.lookupRepo("forker", "hello-world")
	forkMainCommit := service.findCommitExact(forkRepo, forkMainSha)
	if forkMainCommit == nil {
		t.Fatalf("missing fork main commit %s", forkMainSha)
	}
	actor := firstRecord(service.store.Users.FindBy("login", "forker"))
	headCommit := service.insertCommit(forkRepo, stringField(forkMainCommit, "tree_sha"), []string{forkMainSha}, "Fork feature", actor)

	ref := doGitHubJSON(handler, http.MethodPost, "/repos/forker/hello-world/git/refs", `{"ref":"refs/heads/feature","sha":"`+stringField(headCommit, "sha")+`"}`, "Bearer test_token_admin")
	if ref.Code != http.StatusCreated {
		t.Fatalf("ref status = %d, body = %s", ref.Code, ref.Body.String())
	}
	pr := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/pulls", `{"title":"Fork feature","head":"forker:feature","base":"main"}`, "Bearer test_token_admin")
	if pr.Code != http.StatusCreated {
		t.Fatalf("pull status = %d, body = %s", pr.Code, pr.Body.String())
	}
	merge := doGitHubJSON(handler, http.MethodPut, "/repos/octocat/hello-world/pulls/1/merge", `{}`, "Bearer test_token_admin")
	if merge.Code != http.StatusOK {
		t.Fatalf("merge status = %d, body = %s", merge.Code, merge.Body.String())
	}
	var mergeBody struct {
		Sha string `json:"sha"`
	}
	decodeGitHubBody(t, merge, &mergeBody)

	commit := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/git/commits/"+mergeBody.Sha, "", "Bearer test_token_admin")
	if commit.Code != http.StatusOK {
		t.Fatalf("merge commit status = %d, body = %s", commit.Code, commit.Body.String())
	}
	var commitBody struct {
		Commit struct {
			Tree struct {
				Sha string `json:"sha"`
			} `json:"tree"`
		} `json:"commit"`
		Parents []struct {
			Sha string `json:"sha"`
		} `json:"parents"`
	}
	decodeGitHubBody(t, commit, &commitBody)
	if commitBody.Commit.Tree.Sha == "" || len(commitBody.Parents) != 2 {
		t.Fatalf("unexpected merge commit: %#v, body = %s", commitBody, commit.Body.String())
	}

	tree := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/git/trees/"+commitBody.Commit.Tree.Sha, "", "Bearer test_token_admin")
	if tree.Code != http.StatusOK {
		t.Fatalf("merge tree status = %d, body = %s", tree.Code, tree.Body.String())
	}
	headParent := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/git/commits/"+commitBody.Parents[1].Sha, "", "Bearer test_token_admin")
	if headParent.Code != http.StatusOK {
		t.Fatalf("head parent status = %d, body = %s", headParent.Code, headParent.Body.String())
	}
	var headParentBody struct {
		Parents []struct {
			Sha string `json:"sha"`
		} `json:"parents"`
	}
	decodeGitHubBody(t, headParent, &headParentBody)
	if len(headParentBody.Parents) != 1 {
		t.Fatalf("unexpected head parent commit: %#v, body = %s", headParentBody, headParent.Body.String())
	}
	forkParent := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/git/commits/"+headParentBody.Parents[0].Sha, "", "Bearer test_token_admin")
	if forkParent.Code != http.StatusOK {
		t.Fatalf("fork parent status = %d, body = %s", forkParent.Code, forkParent.Body.String())
	}
}

func TestGitHubMergeRejectsDraftPull(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches", "", "Bearer test_token_user1")
	if branches.Code != http.StatusOK {
		t.Fatalf("branches status = %d, body = %s", branches.Code, branches.Body.String())
	}
	mainSha := defaultBranchSha(t, branches, "main")

	ref := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/git/refs", `{"ref":"refs/heads/feature","sha":"`+mainSha+`"}`, "Bearer test_token_user1")
	if ref.Code != http.StatusCreated {
		t.Fatalf("ref status = %d, body = %s", ref.Code, ref.Body.String())
	}

	pr := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/pulls", `{"title":"Feature","head":"feature","base":"main","draft":true}`, "Bearer test_token_user1")
	if pr.Code != http.StatusCreated {
		t.Fatalf("pull status = %d, body = %s", pr.Code, pr.Body.String())
	}

	merge := doGitHubJSON(handler, http.MethodPut, "/repos/octocat/hello-world/pulls/1/merge", `{}`, "Bearer test_token_user1")
	if merge.Code != http.StatusUnprocessableEntity {
		t.Fatalf("merge status = %d, body = %s", merge.Code, merge.Body.String())
	}
	if !strings.Contains(merge.Body.String(), "Draft pull requests cannot be merged.") {
		t.Fatalf("unexpected merge body: %s", merge.Body.String())
	}

	pull := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/pulls/1", "", "Bearer test_token_user1")
	if pull.Code != http.StatusOK {
		t.Fatalf("pull status = %d, body = %s", pull.Code, pull.Body.String())
	}
	var body struct {
		State  string `json:"state"`
		Merged bool   `json:"merged"`
	}
	decodeGitHubBody(t, pull, &body)
	if body.State != "open" || body.Merged {
		t.Fatalf("draft pull was merged: %#v, body = %s", body, pull.Body.String())
	}
}

func TestGitHubMergeHonorsRepoPoliciesMethodAndBranchDeletion(t *testing.T) {
	service, handler := newGitHubTestServiceHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches", "", "Bearer test_token_user1")
	if branches.Code != http.StatusOK {
		t.Fatalf("branches status = %d, body = %s", branches.Code, branches.Body.String())
	}
	mainSha := defaultBranchSha(t, branches, "main")
	repo := service.lookupRepo("octocat", "hello-world")
	actor := firstRecord(service.store.Users.FindBy("login", "octocat"))
	baseCommit := service.findCommitExact(repo, mainSha)
	if baseCommit == nil {
		t.Fatalf("missing base commit %s", mainSha)
	}
	headCommit := service.insertCommit(repo, stringField(baseCommit, "tree_sha"), []string{mainSha}, "Feature commit", actor)

	ref := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/git/refs", `{"ref":"refs/heads/feature","sha":"`+stringField(headCommit, "sha")+`"}`, "Bearer test_token_user1")
	if ref.Code != http.StatusCreated {
		t.Fatalf("ref status = %d, body = %s", ref.Code, ref.Body.String())
	}
	pr := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/pulls", `{"title":"Feature","head":"feature","base":"main"}`, "Bearer test_token_user1")
	if pr.Code != http.StatusCreated {
		t.Fatalf("pull status = %d, body = %s", pr.Code, pr.Body.String())
	}

	patchRepo := doGitHubJSON(handler, http.MethodPatch, "/repos/octocat/hello-world", `{"allow_merge_commit":false,"delete_branch_on_merge":true}`, "Bearer test_token_user1")
	if patchRepo.Code != http.StatusOK {
		t.Fatalf("patch repo status = %d, body = %s", patchRepo.Code, patchRepo.Body.String())
	}
	defaultMerge := doGitHubJSON(handler, http.MethodPut, "/repos/octocat/hello-world/pulls/1/merge", `{}`, "Bearer test_token_user1")
	if defaultMerge.Code != http.StatusUnprocessableEntity {
		t.Fatalf("default merge status = %d, body = %s", defaultMerge.Code, defaultMerge.Body.String())
	}
	if !strings.Contains(defaultMerge.Body.String(), "Merge commits are not allowed on this repository.") {
		t.Fatalf("unexpected default merge body: %s", defaultMerge.Body.String())
	}

	merge := doGitHubJSON(handler, http.MethodPut, "/repos/octocat/hello-world/pulls/1/merge", `{"merge_method":"squash","commit_title":"Squash feature","commit_message":"Body"}`, "Bearer test_token_user1")
	if merge.Code != http.StatusOK {
		t.Fatalf("merge status = %d, body = %s", merge.Code, merge.Body.String())
	}
	var mergeBody struct {
		Sha string `json:"sha"`
	}
	decodeGitHubBody(t, merge, &mergeBody)
	if mergeBody.Sha == "" {
		t.Fatalf("missing merge sha: %s", merge.Body.String())
	}

	commit := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/git/commits/"+mergeBody.Sha, "", "Bearer test_token_user1")
	if commit.Code != http.StatusOK {
		t.Fatalf("commit status = %d, body = %s", commit.Code, commit.Body.String())
	}
	var commitBody struct {
		Commit struct {
			Message string `json:"message"`
		} `json:"commit"`
		Parents []struct {
			Sha string `json:"sha"`
		} `json:"parents"`
	}
	decodeGitHubBody(t, commit, &commitBody)
	if commitBody.Commit.Message != "Squash feature\n\nBody" || len(commitBody.Parents) != 1 || commitBody.Parents[0].Sha != mainSha {
		t.Fatalf("unexpected merge commit: %#v, body = %s", commitBody, commit.Body.String())
	}

	feature := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches/feature", "", "Bearer test_token_user1")
	if feature.Code != http.StatusNotFound {
		t.Fatalf("feature branch status = %d, body = %s", feature.Code, feature.Body.String())
	}
}

func TestGitHubPullFilesRequirePrivateRepoReadAccess(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "private-repo", Private: true}},
	})

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/private-repo/branches", "", "Bearer test_token_user1")
	if branches.Code != http.StatusOK {
		t.Fatalf("branches status = %d, body = %s", branches.Code, branches.Body.String())
	}
	mainSha := defaultBranchSha(t, branches, "main")

	ref := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/private-repo/git/refs", `{"ref":"refs/heads/feature","sha":"`+mainSha+`"}`, "Bearer test_token_user1")
	if ref.Code != http.StatusCreated {
		t.Fatalf("ref status = %d, body = %s", ref.Code, ref.Body.String())
	}
	pr := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/private-repo/pulls", `{"title":"Feature","head":"feature","base":"main"}`, "Bearer test_token_user1")
	if pr.Code != http.StatusCreated {
		t.Fatalf("pull status = %d, body = %s", pr.Code, pr.Body.String())
	}

	files := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/private-repo/pulls/1/files", "", "")
	if files.Code != http.StatusUnauthorized {
		t.Fatalf("files status = %d, body = %s", files.Code, files.Body.String())
	}
}

func TestGitHubPublicRepoListsHidePrivateRepos(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Orgs:  []OrgSeed{{Login: "my-org", Name: "My Org"}},
		Repos: []RepoSeed{
			{Owner: "octocat", Name: "public-repo"},
			{Owner: "octocat", Name: "private-repo", Private: true},
			{Owner: "my-org", Name: "public-org-repo"},
			{Owner: "my-org", Name: "private-org-repo", Private: true},
		},
	})

	userRepos := doGitHubJSON(handler, http.MethodGet, "/users/octocat/repos", "", "")
	if userRepos.Code != http.StatusOK {
		t.Fatalf("user repos status = %d, body = %s", userRepos.Code, userRepos.Body.String())
	}
	var userBody []struct {
		FullName    string          `json:"full_name"`
		Private     bool            `json:"private"`
		Permissions map[string]bool `json:"permissions"`
	}
	decodeGitHubBody(t, userRepos, &userBody)
	if len(userBody) != 1 || userBody[0].FullName != "octocat/public-repo" || userBody[0].Private {
		t.Fatalf("unexpected user repos: %#v, body = %s", userBody, userRepos.Body.String())
	}
	if userBody[0].Permissions["admin"] || !userBody[0].Permissions["pull"] {
		t.Fatalf("unexpected public permissions: %#v", userBody[0].Permissions)
	}

	orgRepos := doGitHubJSON(handler, http.MethodGet, "/orgs/my-org/repos", "", "")
	if orgRepos.Code != http.StatusOK {
		t.Fatalf("org repos status = %d, body = %s", orgRepos.Code, orgRepos.Body.String())
	}
	var orgBody []struct {
		FullName string `json:"full_name"`
		Private  bool   `json:"private"`
	}
	decodeGitHubBody(t, orgRepos, &orgBody)
	if len(orgBody) != 1 || orgBody[0].FullName != "my-org/public-org-repo" || orgBody[0].Private {
		t.Fatalf("unexpected org repos: %#v, body = %s", orgBody, orgRepos.Body.String())
	}
}

func TestGitHubPublicRepoIssuesAllowAuthenticatedNonCollaborator(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{
			{Login: "octocat", Email: "octocat@github.com"},
			{Login: "intruder", Email: "intruder@example.com"},
		},
		Tokens: map[string]TokenSeed{
			"intruder_token": {Login: "intruder", Scopes: []string{"repo", "user"}},
		},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	issue := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/issues", `{"title":"Bug"}`, "Bearer intruder_token")
	if issue.Code != http.StatusCreated {
		t.Fatalf("issue status = %d, body = %s", issue.Code, issue.Body.String())
	}
	comment := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/issues/1/comments", `{"body":"confirmed"}`, "Bearer intruder_token")
	if comment.Code != http.StatusCreated {
		t.Fatalf("comment status = %d, body = %s", comment.Code, comment.Body.String())
	}
}

func TestGitHubPatchRepoPrivateSyncsVisibility(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	res := doGitHubJSON(handler, http.MethodPatch, "/repos/octocat/hello-world", `{"private":true}`, "Bearer test_token_admin")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		Private    bool   `json:"private"`
		Visibility string `json:"visibility"`
	}
	decodeGitHubBody(t, res, &body)
	if !body.Private || body.Visibility != "private" {
		t.Fatalf("unexpected repo visibility: %#v", body)
	}
}

func TestGitHubCreateRepoHonorsFeatureFlags(t *testing.T) {
	handler := newGitHubTestHandler(nil)

	res := doGitHubJSON(handler, http.MethodPost, "/user/repos", `{"name":"configured","has_issues":false,"has_projects":false,"has_wiki":false,"allow_merge_commit":false,"allow_squash_merge":false,"allow_rebase_merge":false,"delete_branch_on_merge":true}`, "Bearer test_token_user1")
	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		HasIssues           bool `json:"has_issues"`
		HasProjects         bool `json:"has_projects"`
		HasWiki             bool `json:"has_wiki"`
		AllowMergeCommit    bool `json:"allow_merge_commit"`
		AllowSquashMerge    bool `json:"allow_squash_merge"`
		AllowRebaseMerge    bool `json:"allow_rebase_merge"`
		DeleteBranchOnMerge bool `json:"delete_branch_on_merge"`
	}
	decodeGitHubBody(t, res, &body)
	if body.HasIssues || body.HasProjects || body.HasWiki || body.AllowMergeCommit || body.AllowSquashMerge || body.AllowRebaseMerge || !body.DeleteBranchOnMerge {
		t.Fatalf("unexpected repo flags: %#v, body = %s", body, res.Body.String())
	}

	issue := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/configured/issues", `{"title":"Bug"}`, "Bearer test_token_user1")
	if issue.Code != http.StatusNotFound {
		t.Fatalf("issue status = %d, body = %s", issue.Code, issue.Body.String())
	}
}

func TestGitHubRepoScopeRequiredForPrivateReadAndRepoMutation(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Tokens: map[string]TokenSeed{
			"user_only_token": {Login: "octocat", Scopes: []string{"user"}},
		},
		Repos: []RepoSeed{
			{Owner: "octocat", Name: "hello-world"},
			{Owner: "octocat", Name: "private-repo", Private: true},
		},
	})

	privateRepo := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/private-repo", "", "Bearer user_only_token")
	if privateRepo.Code != http.StatusForbidden {
		t.Fatalf("private repo status = %d, body = %s", privateRepo.Code, privateRepo.Body.String())
	}
	userRepos := doGitHubJSON(handler, http.MethodGet, "/user/repos", "", "Bearer user_only_token")
	if userRepos.Code != http.StatusOK {
		t.Fatalf("user repos status = %d, body = %s", userRepos.Code, userRepos.Body.String())
	}
	if strings.Contains(userRepos.Body.String(), "private-repo") {
		t.Fatalf("user-only token listed private repo: %s", userRepos.Body.String())
	}

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches", "", "Bearer user_only_token")
	if branches.Code != http.StatusOK {
		t.Fatalf("branches status = %d, body = %s", branches.Code, branches.Body.String())
	}
	mainSha := defaultBranchSha(t, branches, "main")
	ref := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/git/refs", `{"ref":"refs/heads/user-only","sha":"`+mainSha+`"}`, "Bearer user_only_token")
	if ref.Code != http.StatusForbidden {
		t.Fatalf("ref status = %d, body = %s", ref.Code, ref.Body.String())
	}
}

func TestGitHubAdminCanReadPrivateRepo(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "private-repo", Private: true}},
	})

	res := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/private-repo", "", "Bearer test_token_admin")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestGitHubOrgMembershipDoesNotGrantPrivateUserRepoWithMatchingID(t *testing.T) {
	service, handler := newGitHubTestServiceHandler(&SeedConfig{
		Users: []UserSeed{{Login: "member", Email: "member@example.com"}},
		Orgs:  []OrgSeed{{Login: "shared-id-org", Name: "Shared ID Org"}},
		Tokens: map[string]TokenSeed{
			"member_token": {Login: "member", Scopes: []string{"repo", "user"}},
		},
		Repos: []RepoSeed{{Owner: "ghost", Name: "private-repo", Private: true}},
	})
	ghost := firstRecord(service.store.Users.FindBy("login", "ghost"))
	member := firstRecord(service.store.Users.FindBy("login", "member"))
	org := firstRecord(service.store.Orgs.FindBy("login", "shared-id-org"))
	if ghost == nil || member == nil || org == nil {
		t.Fatal("missing seed records")
	}
	if intField(ghost, "id") != intField(org, "id") {
		t.Fatalf("test setup expected matching user and org ids, got user=%d org=%d", intField(ghost, "id"), intField(org, "id"))
	}
	team := service.store.Teams.Insert(corestore.Record{
		"org_id":     intField(org, "id"),
		"slug":       "engineering",
		"name":       "Engineering",
		"permission": "pull",
	})
	service.store.TeamMembers.Insert(corestore.Record{
		"team_id": intField(team, "id"),
		"user_id": intField(member, "id"),
		"role":    "member",
	})

	res := doGitHubJSON(handler, http.MethodGet, "/repos/ghost/private-repo", "", "Bearer member_token")
	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestGitHubRejectsPublicRepoMutationByNonCollaborator(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{
			{Login: "octocat", Email: "octocat@github.com"},
			{Login: "intruder", Email: "intruder@example.com"},
		},
		Tokens: map[string]TokenSeed{
			"intruder_token": {Login: "intruder", Scopes: []string{"repo", "user"}},
		},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches", "", "Bearer intruder_token")
	if branches.Code != http.StatusOK {
		t.Fatalf("branches status = %d, body = %s", branches.Code, branches.Body.String())
	}
	mainSha := defaultBranchSha(t, branches, "main")

	res := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/git/refs", `{"ref":"refs/heads/intruder","sha":"`+mainSha+`"}`, "Bearer intruder_token")
	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestGitHubRejectsRepoMutationByReadOnlyCollaborator(t *testing.T) {
	service, handler := newGitHubTestServiceHandler(&SeedConfig{
		Users: []UserSeed{
			{Login: "octocat", Email: "octocat@github.com"},
			{Login: "reader", Email: "reader@example.com"},
		},
		Tokens: map[string]TokenSeed{
			"reader_token": {Login: "reader", Scopes: []string{"repo", "user"}},
		},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})
	repo := service.lookupRepo("octocat", "hello-world")
	reader := firstRecord(service.store.Users.FindBy("login", "reader"))
	service.store.Collaborators.Insert(corestore.Record{
		"repo_id":    intField(repo, "id"),
		"user_id":    intField(reader, "id"),
		"permission": "pull",
	})

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches", "", "Bearer reader_token")
	if branches.Code != http.StatusOK {
		t.Fatalf("branches status = %d, body = %s", branches.Code, branches.Body.String())
	}
	mainSha := defaultBranchSha(t, branches, "main")

	res := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/git/refs", `{"ref":"refs/heads/reader","sha":"`+mainSha+`"}`, "Bearer reader_token")
	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestGitHubAllowsRepoMutationByPushCollaborator(t *testing.T) {
	service, handler := newGitHubTestServiceHandler(&SeedConfig{
		Users: []UserSeed{
			{Login: "octocat", Email: "octocat@github.com"},
			{Login: "writer", Email: "writer@example.com"},
		},
		Tokens: map[string]TokenSeed{
			"writer_token": {Login: "writer", Scopes: []string{"repo", "user"}},
		},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})
	repo := service.lookupRepo("octocat", "hello-world")
	writer := firstRecord(service.store.Users.FindBy("login", "writer"))
	service.store.Collaborators.Insert(corestore.Record{
		"repo_id":    intField(repo, "id"),
		"user_id":    intField(writer, "id"),
		"permission": "push",
	})

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches", "", "Bearer writer_token")
	if branches.Code != http.StatusOK {
		t.Fatalf("branches status = %d, body = %s", branches.Code, branches.Body.String())
	}
	mainSha := defaultBranchSha(t, branches, "main")

	res := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/git/refs", `{"ref":"refs/heads/writer","sha":"`+mainSha+`"}`, "Bearer writer_token")
	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestGitHubFailedIssuePatchDoesNotAdjustOpenIssueCount(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	issue := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/issues", `{"title":"Bug"}`, "Bearer test_token_user1")
	if issue.Code != http.StatusCreated {
		t.Fatalf("issue status = %d, body = %s", issue.Code, issue.Body.String())
	}

	failedPatch := doGitHubJSON(handler, http.MethodPatch, "/repos/octocat/hello-world/issues/1", `{"state":"closed","labels":[999]}`, "Bearer test_token_user1")
	if failedPatch.Code != http.StatusUnprocessableEntity {
		t.Fatalf("patch status = %d, body = %s", failedPatch.Code, failedPatch.Body.String())
	}

	repo := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world", "", "Bearer test_token_user1")
	if repo.Code != http.StatusOK {
		t.Fatalf("repo status = %d, body = %s", repo.Code, repo.Body.String())
	}
	var repoBody struct {
		OpenIssuesCount int `json:"open_issues_count"`
	}
	decodeGitHubBody(t, repo, &repoBody)
	if repoBody.OpenIssuesCount != 1 {
		t.Fatalf("open_issues_count = %d, body = %s", repoBody.OpenIssuesCount, repo.Body.String())
	}

	gotIssue := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/issues/1", "", "Bearer test_token_user1")
	if gotIssue.Code != http.StatusOK {
		t.Fatalf("get issue status = %d, body = %s", gotIssue.Code, gotIssue.Body.String())
	}
	var issueBody struct {
		State string `json:"state"`
	}
	decodeGitHubBody(t, gotIssue, &issueBody)
	if issueBody.State != "open" {
		t.Fatalf("issue state = %s, body = %s", issueBody.State, gotIssue.Body.String())
	}
}

func TestGitHubPullIssueCommentsSyncPullCommentCount(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		Repos: []RepoSeed{{Owner: "octocat", Name: "hello-world"}},
	})

	branches := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/branches", "", "Bearer test_token_user1")
	if branches.Code != http.StatusOK {
		t.Fatalf("branches status = %d, body = %s", branches.Code, branches.Body.String())
	}
	mainSha := defaultBranchSha(t, branches, "main")

	ref := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/git/refs", `{"ref":"refs/heads/feature","sha":"`+mainSha+`"}`, "Bearer test_token_user1")
	if ref.Code != http.StatusCreated {
		t.Fatalf("ref status = %d, body = %s", ref.Code, ref.Body.String())
	}

	pr := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/pulls", `{"title":"Feature","head":"feature","base":"main"}`, "Bearer test_token_user1")
	if pr.Code != http.StatusCreated {
		t.Fatalf("pull status = %d, body = %s", pr.Code, pr.Body.String())
	}

	comment := doGitHubJSON(handler, http.MethodPost, "/repos/octocat/hello-world/issues/1/comments", `{"body":"looks good"}`, "Bearer test_token_user1")
	if comment.Code != http.StatusCreated {
		t.Fatalf("comment status = %d, body = %s", comment.Code, comment.Body.String())
	}
	var commentBody struct {
		ID int `json:"id"`
	}
	decodeGitHubBody(t, comment, &commentBody)

	pull := doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/pulls/1", "", "Bearer test_token_user1")
	if pull.Code != http.StatusOK {
		t.Fatalf("pull status = %d, body = %s", pull.Code, pull.Body.String())
	}
	var pullBody struct {
		Comments int `json:"comments"`
	}
	decodeGitHubBody(t, pull, &pullBody)
	if pullBody.Comments != 1 {
		t.Fatalf("pull comments after create = %d, body = %s", pullBody.Comments, pull.Body.String())
	}

	deleted := doGitHubJSON(handler, http.MethodDelete, "/repos/octocat/hello-world/issues/comments/"+strconv.Itoa(commentBody.ID), "", "Bearer test_token_user1")
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", deleted.Code, deleted.Body.String())
	}

	pull = doGitHubJSON(handler, http.MethodGet, "/repos/octocat/hello-world/pulls/1", "", "Bearer test_token_user1")
	if pull.Code != http.StatusOK {
		t.Fatalf("pull status = %d, body = %s", pull.Code, pull.Body.String())
	}
	decodeGitHubBody(t, pull, &pullBody)
	if pullBody.Comments != 0 {
		t.Fatalf("pull comments after delete = %d, body = %s", pullBody.Comments, pull.Body.String())
	}
}

func TestGitHubOAuthIssuesUsableToken(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		OAuthApps: []OAuthAppSeed{{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
			Name:         "Test App",
			RedirectURIs: []string{"http://localhost:3000/callback"},
		}},
	})

	form := url.Values{
		"login":        {"octocat"},
		"redirect_uri": {"http://localhost:3000/callback"},
		"scope":        {"repo user"},
		"state":        {"state-1"},
		"client_id":    {"client-id"},
	}
	req := httptest.NewRequest(http.MethodPost, "/login/oauth/callback", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusFound {
		t.Fatalf("callback status = %d, body = %s", res.Code, res.Body.String())
	}
	location, err := url.Parse(res.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	code := location.Query().Get("code")
	if code == "" || location.Query().Get("state") != "state-1" {
		t.Fatalf("unexpected callback location: %s", location.String())
	}

	token := doGitHubJSON(handler, http.MethodPost, "/login/oauth/access_token", `{"code":"`+code+`","client_id":"client-id","client_secret":"client-secret"}`, "")
	if token.Code != http.StatusOK {
		t.Fatalf("token status = %d, body = %s", token.Code, token.Body.String())
	}
	var tokenBody struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}
	decodeGitHubBody(t, token, &tokenBody)
	if tokenBody.AccessToken == "" || tokenBody.TokenType != "bearer" {
		t.Fatalf("unexpected token: %#v", tokenBody)
	}

	user := doGitHubJSON(handler, http.MethodGet, "/user", "", "Bearer "+tokenBody.AccessToken)
	if user.Code != http.StatusOK || !strings.Contains(user.Body.String(), `"login":"octocat"`) {
		t.Fatalf("user status = %d, body = %s", user.Code, user.Body.String())
	}
}

func TestGitHubDoesNotRegisterConflictingLoginOAuthUserinfo(t *testing.T) {
	handler := newGitHubTestHandler(nil)

	conflicting := doGitHubJSON(handler, http.MethodGet, "/login/oauth/userinfo", "", "Bearer test_token_admin")
	if conflicting.Code != http.StatusNotFound {
		t.Fatalf("conflicting userinfo status = %d, body = %s", conflicting.Code, conflicting.Body.String())
	}

	userinfo := doGitHubJSON(handler, http.MethodGet, "/userinfo", "", "Bearer test_token_admin")
	if userinfo.Code != http.StatusOK {
		t.Fatalf("userinfo status = %d, body = %s", userinfo.Code, userinfo.Body.String())
	}
	if !strings.Contains(userinfo.Body.String(), `"preferred_username":"admin"`) {
		t.Fatalf("unexpected userinfo body: %s", userinfo.Body.String())
	}
}

func TestGitHubOAuthRejectsCodeForDifferentClient(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		OAuthApps: []OAuthAppSeed{
			{
				ClientID:     "client-a",
				ClientSecret: "secret-a",
				Name:         "App A",
				RedirectURIs: []string{"http://localhost:3000/callback-a"},
			},
			{
				ClientID:     "client-b",
				ClientSecret: "secret-b",
				Name:         "App B",
				RedirectURIs: []string{"http://localhost:3000/callback-b"},
			},
		},
	})

	code := authorizeGitHubCode(t, handler, "client-a", "http://localhost:3000/callback-a")
	token := doGitHubJSON(handler, http.MethodPost, "/login/oauth/access_token", `{"code":"`+code+`","client_id":"client-b","client_secret":"secret-b"}`, "")

	assertBadVerificationCode(t, token)
}

func TestGitHubOAuthRejectsMismatchedRedirectURI(t *testing.T) {
	handler := newGitHubTestHandler(&SeedConfig{
		Users: []UserSeed{{Login: "octocat", Email: "octocat@github.com"}},
		OAuthApps: []OAuthAppSeed{{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
			Name:         "Test App",
			RedirectURIs: []string{"http://localhost:3000/callback", "http://localhost:3000/other-callback"},
		}},
	})

	code := authorizeGitHubCode(t, handler, "client-id", "http://localhost:3000/callback")
	token := doGitHubJSON(handler, http.MethodPost, "/login/oauth/access_token", `{"code":"`+code+`","client_id":"client-id","client_secret":"client-secret","redirect_uri":"http://localhost:3000/other-callback"}`, "")

	assertBadVerificationCode(t, token)
}

func newGitHubTestHandler(seed *SeedConfig) http.Handler {
	_, handler := newGitHubTestServiceHandler(seed)
	return handler
}

func newGitHubTestServiceHandler(seed *SeedConfig) (*Service, http.Handler) {
	router := corehttp.NewRouter()
	service := New(Options{Store: corestore.New(), BaseURL: testBaseURL, Seed: seed})
	service.RegisterRoutes(router)
	router.NotFound(func(c *corehttp.Context) {
		c.JSON(http.StatusNotFound, map[string]any{"message": "Not Found"})
	})
	return service, router
}

func doGitHubJSON(handler http.Handler, method string, target string, body string, authorization string) *httptest.ResponseRecorder {
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func authorizeGitHubCode(t *testing.T, handler http.Handler, clientID string, redirectURI string) string {
	t.Helper()
	form := url.Values{
		"login":        {"octocat"},
		"redirect_uri": {redirectURI},
		"scope":        {"repo user"},
		"state":        {"state-1"},
		"client_id":    {clientID},
	}
	req := httptest.NewRequest(http.MethodPost, "/login/oauth/callback", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusFound {
		t.Fatalf("callback status = %d, body = %s", res.Code, res.Body.String())
	}
	location, err := url.Parse(res.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	code := location.Query().Get("code")
	if code == "" {
		t.Fatalf("missing code in callback location: %s", location.String())
	}
	return code
}

func assertBadVerificationCode(t *testing.T, res *httptest.ResponseRecorder) {
	t.Helper()
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		Error       string `json:"error"`
		AccessToken string `json:"access_token"`
	}
	decodeGitHubBody(t, res, &body)
	if body.Error != "bad_verification_code" || body.AccessToken != "" {
		t.Fatalf("unexpected token response: %#v, body = %s", body, res.Body.String())
	}
}

func decodeGitHubBody(t *testing.T, res *httptest.ResponseRecorder, target any) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(res.Body.Bytes()))
	if err := decoder.Decode(target); err != nil {
		t.Fatalf("decode body %q: %v", res.Body.String(), err)
	}
}

func defaultBranchSha(t *testing.T, res *httptest.ResponseRecorder, branchName string) string {
	t.Helper()
	var branches []struct {
		Name   string `json:"name"`
		Commit struct {
			Sha string `json:"sha"`
		} `json:"commit"`
	}
	decodeGitHubBody(t, res, &branches)
	for _, branch := range branches {
		if branch.Name == branchName {
			if branch.Commit.Sha == "" {
				t.Fatalf("branch %s missing sha: %s", branchName, res.Body.String())
			}
			return branch.Commit.Sha
		}
	}
	t.Fatalf("branch %s not found: %s", branchName, res.Body.String())
	return ""
}
