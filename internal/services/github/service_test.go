package github

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	router := corehttp.NewRouter()
	Register(router, Options{Store: corestore.New(), BaseURL: testBaseURL, Seed: seed})
	router.NotFound(func(c *corehttp.Context) {
		c.JSON(http.StatusNotFound, map[string]any{"message": "Not Found"})
	})
	return router
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
