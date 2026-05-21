package clerk

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

const testBaseURL = "http://localhost:4017"

func TestOAuthAuthorizationCodeFlow(t *testing.T) {
	service, router := newTestService(t)
	alice := firstRecord(service.store.Users.FindBy("clerk_id", userIDByEmail(t, service, "alice@example.com")))
	if alice == nil {
		t.Fatal("missing alice")
	}

	discovery := serveClerk(router, httptest.NewRequest(http.MethodGet, "/.well-known/openid-configuration", nil))
	if discovery.Code != http.StatusOK {
		t.Fatalf("discovery status = %d, body = %s", discovery.Code, discovery.Body.String())
	}
	if !strings.Contains(discovery.Body.String(), `"issuer":"`+testBaseURL+`"`) ||
		!strings.Contains(discovery.Body.String(), `"jwks_uri":"`+testBaseURL+`/v1/jwks"`) {
		t.Fatalf("unexpected discovery body: %s", discovery.Body.String())
	}

	form := url.Values{
		"user_ref":     {stringField(alice, "clerk_id")},
		"redirect_uri": {"http://localhost:3000/callback"},
		"scope":        {"openid profile email"},
		"client_id":    {"test-client"},
		"state":        {"state-1"},
		"nonce":        {"nonce-1"},
	}
	callback := httptest.NewRequest(http.MethodPost, "/oauth/authorize/callback", strings.NewReader(form.Encode()))
	callback.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	callbackRes := serveClerk(router, callback)
	if callbackRes.Code != http.StatusFound {
		t.Fatalf("callback status = %d, body = %s", callbackRes.Code, callbackRes.Body.String())
	}
	redirect, err := url.Parse(callbackRes.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	code := redirect.Query().Get("code")
	if code == "" || redirect.Query().Get("state") != "state-1" {
		t.Fatalf("unexpected redirect: %s", callbackRes.Header().Get("Location"))
	}

	tokenForm := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {"http://localhost:3000/callback"},
		"client_id":     {"test-client"},
		"client_secret": {"test-secret"},
	}
	tokenReq := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(tokenForm.Encode()))
	tokenReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	tokenRes := serveClerk(router, tokenReq)
	if tokenRes.Code != http.StatusOK {
		t.Fatalf("token status = %d, body = %s", tokenRes.Code, tokenRes.Body.String())
	}
	var tokenBody struct {
		AccessToken string `json:"access_token"`
		IDToken     string `json:"id_token"`
		TokenType   string `json:"token_type"`
		Scope       string `json:"scope"`
	}
	if err := json.Unmarshal(tokenRes.Body.Bytes(), &tokenBody); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(tokenBody.AccessToken, "clerk_") || tokenBody.TokenType != "Bearer" || tokenBody.IDToken == "" || tokenBody.Scope != "openid profile email" {
		t.Fatalf("unexpected token body: %#v", tokenBody)
	}
	claims := decodeJWTClaims(t, tokenBody.IDToken)
	if claims["iss"] != testBaseURL || claims["sub"] != stringField(alice, "clerk_id") || claims["sid"] == "" || claims["nonce"] != "nonce-1" {
		t.Fatalf("unexpected id token claims: %#v", claims)
	}

	secondUse := serveClerk(router, tokenReqWithForm(tokenForm))
	if secondUse.Code != http.StatusBadRequest || !strings.Contains(secondUse.Body.String(), `"error":"invalid_grant"`) {
		t.Fatalf("second token status = %d, body = %s", secondUse.Code, secondUse.Body.String())
	}

	userinfoReq := httptest.NewRequest(http.MethodGet, "/oauth/userinfo", nil)
	userinfoReq.Header.Set("Authorization", "Bearer "+tokenBody.AccessToken)
	userinfoRes := serveClerk(router, userinfoReq)
	if userinfoRes.Code != http.StatusOK {
		t.Fatalf("userinfo status = %d, body = %s", userinfoRes.Code, userinfoRes.Body.String())
	}
	if !strings.Contains(userinfoRes.Body.String(), `"email":"alice@example.com"`) {
		t.Fatalf("unexpected userinfo body: %s", userinfoRes.Body.String())
	}
}

func TestOAuthAcceptsNormalizedRedirectURI(t *testing.T) {
	service, router := newTestService(t)
	aliceID := userIDByEmail(t, service, "alice@example.com")
	redirectURI := "http://localhost:3000/callback/?next=dashboard"

	authorize := serveClerk(router, httptest.NewRequest(http.MethodGet, "/oauth/authorize?client_id=test-client&response_type=code&redirect_uri="+url.QueryEscape(redirectURI), nil))
	if authorize.Code != http.StatusOK {
		t.Fatalf("authorize status = %d, body = %s", authorize.Code, authorize.Body.String())
	}

	form := url.Values{
		"user_ref":     {aliceID},
		"redirect_uri": {redirectURI},
		"scope":        {"openid profile email"},
		"client_id":    {"test-client"},
		"state":        {"state-1"},
	}
	callback := httptest.NewRequest(http.MethodPost, "/oauth/authorize/callback", strings.NewReader(form.Encode()))
	callback.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	callbackRes := serveClerk(router, callback)
	if callbackRes.Code != http.StatusFound {
		t.Fatalf("callback status = %d, body = %s", callbackRes.Code, callbackRes.Body.String())
	}
	redirect, err := url.Parse(callbackRes.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if redirect.Query().Get("code") == "" || redirect.Query().Get("next") != "dashboard" || redirect.Query().Get("state") != "state-1" {
		t.Fatalf("unexpected redirect: %s", callbackRes.Header().Get("Location"))
	}
}

func TestOAuthRejectsInvalidPKCEVerifier(t *testing.T) {
	service, router := newTestService(t)
	aliceID := userIDByEmail(t, service, "alice@example.com")
	form := url.Values{
		"user_ref":              {aliceID},
		"redirect_uri":          {"http://localhost:3000/callback"},
		"scope":                 {"openid profile email"},
		"client_id":             {"test-client"},
		"code_challenge":        {"expected"},
		"code_challenge_method": {"plain"},
	}
	callback := httptest.NewRequest(http.MethodPost, "/oauth/authorize/callback", strings.NewReader(form.Encode()))
	callback.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	callbackRes := serveClerk(router, callback)
	redirect, err := url.Parse(callbackRes.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	tokenForm := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {redirect.Query().Get("code")},
		"redirect_uri":  {"http://localhost:3000/callback"},
		"client_id":     {"test-client"},
		"client_secret": {"test-secret"},
		"code_verifier": {"wrong"},
	}
	tokenRes := serveClerk(router, tokenReqWithForm(tokenForm))
	if tokenRes.Code != http.StatusBadRequest || !strings.Contains(tokenRes.Body.String(), "PKCE verification failed") {
		t.Fatalf("token status = %d, body = %s", tokenRes.Code, tokenRes.Body.String())
	}
	if service.store.AccessTokens.Count() != 0 {
		t.Fatal("access token was issued for invalid PKCE verifier")
	}
}

func TestManagementAPIsAndSessionTokens(t *testing.T) {
	service, router := newTestService(t)

	unauthorized := serveClerk(router, httptest.NewRequest(http.MethodGet, "/v1/users", nil))
	if unauthorized.Code != http.StatusUnauthorized || !strings.Contains(unauthorized.Body.String(), "UNAUTHORIZED") {
		t.Fatalf("unauthorized status = %d, body = %s", unauthorized.Code, unauthorized.Body.String())
	}

	listUsers := clerkJSON(router, http.MethodGet, "/v1/users?query=alice", "")
	if listUsers.Code != http.StatusOK || !strings.Contains(listUsers.Body.String(), `"total_count":1`) {
		t.Fatalf("list users status = %d, body = %s", listUsers.Code, listUsers.Body.String())
	}
	countUsers := clerkJSON(router, http.MethodGet, "/v1/users/count?query=alice", "")
	if countUsers.Code != http.StatusOK {
		t.Fatalf("count users status = %d, body = %s", countUsers.Code, countUsers.Body.String())
	}
	var countBody struct {
		TotalCount int `json:"total_count"`
	}
	if err := json.Unmarshal(countUsers.Body.Bytes(), &countBody); err != nil {
		t.Fatal(err)
	}
	if countBody.TotalCount != 1 {
		t.Fatalf("filtered count = %d, body = %s", countBody.TotalCount, countUsers.Body.String())
	}

	createUser := clerkJSON(router, http.MethodPost, "/v1/users", `{"email_address":["new@example.com"],"first_name":"New","password":"secret"}`)
	if createUser.Code != http.StatusOK || !strings.Contains(createUser.Body.String(), `"first_name":"New"`) || !strings.Contains(createUser.Body.String(), `"password_enabled":true`) {
		t.Fatalf("create user status = %d, body = %s", createUser.Code, createUser.Body.String())
	}

	acme := firstRecord(service.store.Organizations.FindBy("slug", "acme"))
	if acme == nil || intField(acme, "members_count") != 2 {
		t.Fatalf("unexpected seeded org: %#v", acme)
	}
	aliceID := userIDByEmail(t, service, "alice@example.com")
	duplicate := clerkJSON(router, http.MethodPost, "/v1/organizations/"+stringField(acme, "clerk_id")+"/memberships", `{"user_id":"`+aliceID+`","role":"org:member"}`)
	if duplicate.Code != http.StatusUnprocessableEntity || !strings.Contains(duplicate.Body.String(), "DUPLICATE_RECORD") {
		t.Fatalf("duplicate membership status = %d, body = %s", duplicate.Code, duplicate.Body.String())
	}

	sessionRes := clerkJSON(router, http.MethodPost, "/v1/sessions", `{"user_id":"`+aliceID+`"}`)
	if sessionRes.Code != http.StatusOK {
		t.Fatalf("session status = %d, body = %s", sessionRes.Code, sessionRes.Body.String())
	}
	var session struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(sessionRes.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	tokenRes := clerkJSON(router, http.MethodPost, "/v1/sessions/"+session.ID+"/tokens", `{}`)
	if tokenRes.Code != http.StatusOK {
		t.Fatalf("session token status = %d, body = %s", tokenRes.Code, tokenRes.Body.String())
	}
	var tokenBody struct {
		JWT string `json:"jwt"`
	}
	if err := json.Unmarshal(tokenRes.Body.Bytes(), &tokenBody); err != nil {
		t.Fatal(err)
	}
	claims := decodeJWTClaims(t, tokenBody.JWT)
	if claims["sub"] != aliceID || claims["org_role"] != "org:admin" || claims["org_slug"] != "acme" {
		t.Fatalf("unexpected session token claims: %#v", claims)
	}

	templateTokenRes := clerkJSON(router, http.MethodPost, "/v1/sessions/"+session.ID+"/tokens/custom", `{}`)
	if templateTokenRes.Code != http.StatusOK {
		t.Fatalf("template session token status = %d, body = %s", templateTokenRes.Code, templateTokenRes.Body.String())
	}
	var templateTokenBody struct {
		JWT string `json:"jwt"`
	}
	if err := json.Unmarshal(templateTokenRes.Body.Bytes(), &templateTokenBody); err != nil {
		t.Fatal(err)
	}
	templateClaims := decodeJWTClaims(t, templateTokenBody.JWT)
	if templateClaims["sub"] != aliceID || templateClaims["sid"] != session.ID {
		t.Fatalf("unexpected template session token claims: %#v", templateClaims)
	}
	if _, ok := templateClaims["org_role"]; ok {
		t.Fatalf("template session token included org claims: %#v", templateClaims)
	}
}

func TestSeedFromConfigDoesNotDuplicateUsers(t *testing.T) {
	service, _ := newTestService(t)
	before := service.store.Users.Count()
	service.SeedFromConfig(SeedConfig{
		Users: []UserSeed{{EmailAddresses: []string{"alice@example.com"}, FirstName: "Alice"}},
	})
	if service.store.Users.Count() != before {
		t.Fatalf("seed duplicated user: before %d after %d", before, service.store.Users.Count())
	}
}

func newTestService(t *testing.T) (*Service, *corehttp.Router) {
	t.Helper()
	runtimeStore := corestore.New()
	service := New(Options{
		Store:   runtimeStore,
		BaseURL: testBaseURL,
		Seed: &SeedConfig{
			Users: []UserSeed{
				{EmailAddresses: []string{"alice@example.com"}, FirstName: "Alice", LastName: "Smith", Password: "alice123"},
				{EmailAddresses: []string{"bob@example.com"}, FirstName: "Bob", LastName: "Jones"},
			},
			Organizations: []OrganizationSeed{
				{
					Name: "Acme Corp",
					Slug: "acme",
					Members: []OrganizationUser{
						{Email: "alice@example.com", Role: "admin"},
						{Email: "bob@example.com", Role: "member"},
					},
				},
			},
			OAuthApplications: []OAuthApplicationSeed{
				{
					ClientID:     "test-client",
					ClientSecret: "test-secret",
					Name:         "Test App",
					RedirectURIs: []string{"http://localhost:3000/callback"},
				},
			},
		},
	})
	router := corehttp.NewRouter()
	service.RegisterRoutes(router)
	return service, router
}

func serveClerk(router *corehttp.Router, req *http.Request) *httptest.ResponseRecorder {
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	return res
}

func clerkJSON(router *corehttp.Router, method string, path string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer sk_test_emulate")
	req.Header.Set("Content-Type", "application/json")
	return serveClerk(router, req)
}

func tokenReqWithForm(form url.Values) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return req
}

func userIDByEmail(t *testing.T, service *Service, emailAddress string) string {
	t.Helper()
	email := firstRecord(service.store.EmailAddresses.FindBy("email_address", emailAddress))
	if email == nil {
		t.Fatalf("missing email %s", emailAddress)
	}
	return stringField(email, "user_id")
}

func decodeJWTClaims(t *testing.T, token string) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("invalid jwt: %s", token)
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatal(err)
	}
	return claims
}
