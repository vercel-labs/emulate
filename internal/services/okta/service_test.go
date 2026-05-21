package okta

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func TestOAuthAuthorizationCodeFlow(t *testing.T) {
	service, router := newTestService(t)
	user := firstRecord(service.store.Users.FindBy("login", "testuser@okta.local"))
	if user == nil {
		t.Fatal("missing default user")
	}

	discovery := serveOkta(router, httptest.NewRequest(http.MethodGet, "/oauth2/default/.well-known/openid-configuration", nil))
	if discovery.Code != http.StatusOK {
		t.Fatalf("discovery status = %d, body = %s", discovery.Code, discovery.Body.String())
	}
	if !strings.Contains(discovery.Body.String(), `"issuer":"http://localhost:4016/oauth2/default"`) ||
		!strings.Contains(discovery.Body.String(), `"introspection_endpoint"`) {
		t.Fatalf("unexpected discovery body: %s", discovery.Body.String())
	}

	form := url.Values{
		"user_ref":       {stringField(user, "okta_id")},
		"redirect_uri":   {"http://localhost:3000/callback"},
		"scope":          {"openid profile email groups"},
		"client_id":      {"okta-test-client"},
		"response_mode":  {"query"},
		"auth_server_id": {"default"},
		"state":          {"abc"},
	}
	callback := httptest.NewRequest(http.MethodPost, "/oauth2/default/v1/authorize/callback", strings.NewReader(form.Encode()))
	callback.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	callbackRes := serveOkta(router, callback)
	if callbackRes.Code != http.StatusFound {
		t.Fatalf("callback status = %d, body = %s", callbackRes.Code, callbackRes.Body.String())
	}
	location := callbackRes.Header().Get("Location")
	redirect, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	code := redirect.Query().Get("code")
	if code == "" || redirect.Query().Get("state") != "abc" {
		t.Fatalf("unexpected redirect location: %s", location)
	}

	tokenForm := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {"http://localhost:3000/callback"},
		"client_id":     {"okta-test-client"},
		"client_secret": {"okta-test-secret"},
	}
	tokenReq := httptest.NewRequest(http.MethodPost, "/oauth2/default/v1/token", strings.NewReader(tokenForm.Encode()))
	tokenReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	tokenRes := serveOkta(router, tokenReq)
	if tokenRes.Code != http.StatusOK {
		t.Fatalf("token status = %d, body = %s", tokenRes.Code, tokenRes.Body.String())
	}
	var tokenBody struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		Scope        string `json:"scope"`
	}
	if err := json.Unmarshal(tokenRes.Body.Bytes(), &tokenBody); err != nil {
		t.Fatal(err)
	}
	if tokenBody.AccessToken == "" || tokenBody.RefreshToken == "" || tokenBody.IDToken == "" || tokenBody.Scope != "openid profile email groups" {
		t.Fatalf("unexpected token body: %#v", tokenBody)
	}

	userinfoReq := httptest.NewRequest(http.MethodGet, "/oauth2/default/v1/userinfo", nil)
	userinfoReq.Header.Set("Authorization", "Bearer "+tokenBody.AccessToken)
	userinfoRes := serveOkta(router, userinfoReq)
	if userinfoRes.Code != http.StatusOK {
		t.Fatalf("userinfo status = %d, body = %s", userinfoRes.Code, userinfoRes.Body.String())
	}
	if !strings.Contains(userinfoRes.Body.String(), `"preferred_username":"testuser@okta.local"`) || !strings.Contains(userinfoRes.Body.String(), `"groups":["Everyone"]`) {
		t.Fatalf("unexpected userinfo body: %s", userinfoRes.Body.String())
	}

	introspectForm := url.Values{
		"token":         {tokenBody.AccessToken},
		"client_id":     {"okta-test-client"},
		"client_secret": {"okta-test-secret"},
	}
	introspectReq := httptest.NewRequest(http.MethodPost, "/oauth2/default/v1/introspect", strings.NewReader(introspectForm.Encode()))
	introspectReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	introspectRes := serveOkta(router, introspectReq)
	if introspectRes.Code != http.StatusOK {
		t.Fatalf("introspect status = %d, body = %s", introspectRes.Code, introspectRes.Body.String())
	}
	if !strings.Contains(introspectRes.Body.String(), `"active":true`) || !strings.Contains(introspectRes.Body.String(), `"client_id":"okta-test-client"`) {
		t.Fatalf("unexpected introspect body: %s", introspectRes.Body.String())
	}
}

func TestTokenRejectsGrantTypeNotAllowedForClient(t *testing.T) {
	service, router := newTestService(t)
	form := url.Values{
		"grant_type": {"client_credentials"},
		"client_id":  {"okta-test-app"},
	}
	req := httptest.NewRequest(http.MethodPost, "/oauth2/default/v1/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	res := serveOkta(router, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("token status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"error":"unauthorized_client"`) {
		t.Fatalf("unexpected token body: %s", res.Body.String())
	}
	if service.store.AccessTokens.Count() != 0 {
		t.Fatalf("access tokens were minted for a disallowed grant")
	}
}

func TestTokenRejectsUnsupportedPKCEMethod(t *testing.T) {
	service, router := newTestService(t)
	user := firstRecord(service.store.Users.FindBy("login", "testuser@okta.local"))
	if user == nil {
		t.Fatal("missing default user")
	}

	form := url.Values{
		"user_ref":              {stringField(user, "okta_id")},
		"redirect_uri":          {"http://localhost:3000/callback"},
		"scope":                 {"openid profile email"},
		"client_id":             {"okta-test-client"},
		"response_mode":         {"query"},
		"code_challenge":        {"same-secret"},
		"code_challenge_method": {"unsupported"},
	}
	callback := httptest.NewRequest(http.MethodPost, "/oauth2/default/v1/authorize/callback", strings.NewReader(form.Encode()))
	callback.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	callbackRes := serveOkta(router, callback)
	if callbackRes.Code != http.StatusFound {
		t.Fatalf("callback status = %d, body = %s", callbackRes.Code, callbackRes.Body.String())
	}
	redirect, err := url.Parse(callbackRes.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	code := redirect.Query().Get("code")
	if code == "" {
		t.Fatalf("missing code in redirect: %s", callbackRes.Header().Get("Location"))
	}

	tokenForm := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {"http://localhost:3000/callback"},
		"client_id":     {"okta-test-client"},
		"client_secret": {"okta-test-secret"},
		"code_verifier": {"same-secret"},
	}
	tokenReq := httptest.NewRequest(http.MethodPost, "/oauth2/default/v1/token", strings.NewReader(tokenForm.Encode()))
	tokenReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	tokenRes := serveOkta(router, tokenReq)
	if tokenRes.Code != http.StatusBadRequest {
		t.Fatalf("token status = %d, body = %s", tokenRes.Code, tokenRes.Body.String())
	}
	if !strings.Contains(tokenRes.Body.String(), `"error":"invalid_grant"`) || !strings.Contains(tokenRes.Body.String(), "PKCE verification failed") {
		t.Fatalf("unexpected token body: %s", tokenRes.Body.String())
	}
	if service.store.AccessTokens.Count() != 0 {
		t.Fatalf("access tokens were issued for unsupported PKCE method")
	}
}

func TestAuthorizeRejectsInactiveUsers(t *testing.T) {
	service, router := newTestService(t)
	user := firstRecord(service.store.Users.FindBy("login", "testuser@okta.local"))
	if user == nil {
		t.Fatal("missing default user")
	}
	if _, ok := service.store.Users.Update(intField(user, "id"), corestore.Record{"status": "SUSPENDED"}); !ok {
		t.Fatal("failed to suspend user")
	}

	authorize := serveOkta(router, httptest.NewRequest(http.MethodGet, "/oauth2/default/v1/authorize?client_id=okta-test-client&redirect_uri="+url.QueryEscape("http://localhost:3000/callback")+"&response_type=code", nil))
	if authorize.Code != http.StatusOK {
		t.Fatalf("authorize status = %d, body = %s", authorize.Code, authorize.Body.String())
	}
	if strings.Contains(authorize.Body.String(), "testuser@okta.local") || !strings.Contains(authorize.Body.String(), "No active users") {
		t.Fatalf("inactive user was shown in authorize body: %s", authorize.Body.String())
	}

	form := url.Values{
		"user_ref":      {stringField(user, "okta_id")},
		"redirect_uri":  {"http://localhost:3000/callback"},
		"scope":         {"openid profile email"},
		"client_id":     {"okta-test-client"},
		"response_mode": {"query"},
	}
	callback := httptest.NewRequest(http.MethodPost, "/oauth2/default/v1/authorize/callback", strings.NewReader(form.Encode()))
	callback.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	callbackRes := serveOkta(router, callback)
	if callbackRes.Code != http.StatusBadRequest {
		t.Fatalf("callback status = %d, body = %s", callbackRes.Code, callbackRes.Body.String())
	}
	if !strings.Contains(callbackRes.Body.String(), "User is not active") {
		t.Fatalf("unexpected callback body: %s", callbackRes.Body.String())
	}
	if service.store.OAuthCodes.Count() != 0 {
		t.Fatalf("oauth codes were issued for inactive user")
	}
}

func TestTokenRejectsUserSuspendedAfterAuthorization(t *testing.T) {
	service, router := newTestService(t)
	user := firstRecord(service.store.Users.FindBy("login", "testuser@okta.local"))
	if user == nil {
		t.Fatal("missing default user")
	}
	code := authorizeOktaCode(t, service, router, "openid profile email")
	if _, ok := service.store.Users.Update(intField(user, "id"), corestore.Record{"status": "SUSPENDED"}); !ok {
		t.Fatal("failed to suspend user")
	}

	tokenForm := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {"http://localhost:3000/callback"},
		"client_id":     {"okta-test-client"},
		"client_secret": {"okta-test-secret"},
	}
	tokenReq := httptest.NewRequest(http.MethodPost, "/oauth2/default/v1/token", strings.NewReader(tokenForm.Encode()))
	tokenReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	tokenRes := serveOkta(router, tokenReq)
	if tokenRes.Code != http.StatusBadRequest {
		t.Fatalf("token status = %d, body = %s", tokenRes.Code, tokenRes.Body.String())
	}
	if !strings.Contains(tokenRes.Body.String(), `"error":"invalid_grant"`) || !strings.Contains(tokenRes.Body.String(), "User is not active") {
		t.Fatalf("unexpected token body: %s", tokenRes.Body.String())
	}
	if service.store.AccessTokens.Count() != 0 {
		t.Fatalf("access tokens were issued for inactive user")
	}
}

func TestRefreshTokenRejectsScopeEscalation(t *testing.T) {
	service, router := newTestService(t)
	tokenBody := issueOktaToken(t, service, router, "openid email")

	refreshForm := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {tokenBody.RefreshToken},
		"client_id":     {"okta-test-client"},
		"client_secret": {"okta-test-secret"},
		"scope":         {"openid email groups"},
	}
	refreshReq := httptest.NewRequest(http.MethodPost, "/oauth2/default/v1/token", strings.NewReader(refreshForm.Encode()))
	refreshReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	refreshRes := serveOkta(router, refreshReq)
	if refreshRes.Code != http.StatusBadRequest {
		t.Fatalf("refresh status = %d, body = %s", refreshRes.Code, refreshRes.Body.String())
	}
	if !strings.Contains(refreshRes.Body.String(), `"error":"invalid_scope"`) {
		t.Fatalf("unexpected refresh body: %s", refreshRes.Body.String())
	}
	if service.store.RefreshTokens.Count() != 1 {
		t.Fatalf("refresh token was rotated after invalid scope")
	}
	if service.store.AccessTokens.Count() != 1 {
		t.Fatalf("access token was minted after invalid scope")
	}
}

func TestInactiveAuthorizationServerDoesNotServeOAuth(t *testing.T) {
	service, router := newTestService(t)
	server := firstRecord(service.store.AuthorizationServers.FindBy("server_id", "default"))
	if server == nil {
		t.Fatal("missing default authorization server")
	}
	if _, ok := service.store.AuthorizationServers.Update(intField(server, "id"), corestore.Record{"status": "INACTIVE"}); !ok {
		t.Fatal("failed to deactivate authorization server")
	}

	management := httptest.NewRequest(http.MethodGet, "/api/v1/authorizationServers/default", nil)
	management.Header.Set("Authorization", "SSWS dev-token")
	managementRes := serveOkta(router, management)
	if managementRes.Code != http.StatusOK || !strings.Contains(managementRes.Body.String(), `"status":"INACTIVE"`) {
		t.Fatalf("management status = %d, body = %s", managementRes.Code, managementRes.Body.String())
	}

	discovery := serveOkta(router, httptest.NewRequest(http.MethodGet, "/oauth2/default/.well-known/openid-configuration", nil))
	if discovery.Code != http.StatusNotFound {
		t.Fatalf("discovery status = %d, body = %s", discovery.Code, discovery.Body.String())
	}
	tokenReq := httptest.NewRequest(http.MethodPost, "/oauth2/default/v1/token", strings.NewReader(url.Values{"grant_type": {"client_credentials"}, "client_id": {"okta-test-client"}, "client_secret": {"okta-test-secret"}}.Encode()))
	tokenReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	tokenRes := serveOkta(router, tokenReq)
	if tokenRes.Code != http.StatusNotFound {
		t.Fatalf("token status = %d, body = %s", tokenRes.Code, tokenRes.Body.String())
	}
}

func TestManagementUsersGroupsAppsAndAuthorizationServers(t *testing.T) {
	_, router := newTestService(t)

	createUser := httptest.NewRequest(http.MethodPost, "/api/v1/users?activate=false", strings.NewReader(`{"profile":{"login":"alice@example.com","email":"alice@example.com","firstName":"Alice","lastName":"Admin"}}`))
	createUser.Header.Set("Content-Type", "application/json")
	createUser.Header.Set("Authorization", "SSWS dev-token")
	createUserRes := serveOkta(router, createUser)
	if createUserRes.Code != http.StatusCreated {
		t.Fatalf("create user status = %d, body = %s", createUserRes.Code, createUserRes.Body.String())
	}
	var user struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(createUserRes.Body.Bytes(), &user); err != nil {
		t.Fatal(err)
	}
	if user.ID == "" || user.Status != "STAGED" {
		t.Fatalf("unexpected user: %#v", user)
	}

	activate := httptest.NewRequest(http.MethodPost, "/api/v1/users/"+url.PathEscape(user.ID)+"/lifecycle/activate", nil)
	activate.Header.Set("Authorization", "SSWS dev-token")
	activateRes := serveOkta(router, activate)
	if activateRes.Code != http.StatusOK || !strings.Contains(activateRes.Body.String(), `"status":"ACTIVE"`) {
		t.Fatalf("activate status = %d, body = %s", activateRes.Code, activateRes.Body.String())
	}

	groupReq := httptest.NewRequest(http.MethodPost, "/api/v1/groups", strings.NewReader(`{"profile":{"name":"Admins","description":"Administrators"}}`))
	groupReq.Header.Set("Content-Type", "application/json")
	groupReq.Header.Set("Authorization", "SSWS dev-token")
	groupRes := serveOkta(router, groupReq)
	if groupRes.Code != http.StatusCreated {
		t.Fatalf("create group status = %d, body = %s", groupRes.Code, groupRes.Body.String())
	}
	var group struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(groupRes.Body.Bytes(), &group); err != nil {
		t.Fatal(err)
	}

	addMember := httptest.NewRequest(http.MethodPut, "/api/v1/groups/"+url.PathEscape(group.ID)+"/users/"+url.PathEscape(user.ID), nil)
	addMember.Header.Set("Authorization", "SSWS dev-token")
	addMemberRes := serveOkta(router, addMember)
	if addMemberRes.Code != http.StatusNoContent {
		t.Fatalf("add member status = %d, body = %s", addMemberRes.Code, addMemberRes.Body.String())
	}

	appReq := httptest.NewRequest(http.MethodPost, "/api/v1/apps", strings.NewReader(`{"name":"oidc_client","label":"Admin Console"}`))
	appReq.Header.Set("Content-Type", "application/json")
	appReq.Header.Set("Authorization", "SSWS dev-token")
	appRes := serveOkta(router, appReq)
	if appRes.Code != http.StatusCreated {
		t.Fatalf("create app status = %d, body = %s", appRes.Code, appRes.Body.String())
	}
	var app struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(appRes.Body.Bytes(), &app); err != nil {
		t.Fatal(err)
	}

	assign := httptest.NewRequest(http.MethodPut, "/api/v1/apps/"+url.PathEscape(app.ID)+"/users/"+url.PathEscape(user.ID), nil)
	assign.Header.Set("Authorization", "SSWS dev-token")
	assignRes := serveOkta(router, assign)
	if assignRes.Code != http.StatusNoContent {
		t.Fatalf("assign app status = %d, body = %s", assignRes.Code, assignRes.Body.String())
	}

	authServerReq := httptest.NewRequest(http.MethodPost, "/api/v1/authorizationServers", strings.NewReader(`{"name":"Partner API","audiences":["api://partner"]}`))
	authServerReq.Header.Set("Content-Type", "application/json")
	authServerReq.Header.Set("Authorization", "SSWS dev-token")
	authServerRes := serveOkta(router, authServerReq)
	if authServerRes.Code != http.StatusCreated {
		t.Fatalf("create auth server status = %d, body = %s", authServerRes.Code, authServerRes.Body.String())
	}
	if !strings.Contains(authServerRes.Body.String(), `"id":"partner-api"`) || !strings.Contains(authServerRes.Body.String(), `"api://partner"`) {
		t.Fatalf("unexpected auth server body: %s", authServerRes.Body.String())
	}
}

func TestPartialUserUpdateRejectsDuplicateLogin(t *testing.T) {
	service, router := newTestService(t)

	createUser := httptest.NewRequest(http.MethodPost, "/api/v1/users", strings.NewReader(`{"profile":{"login":"alice@example.com","email":"alice@example.com","firstName":"Alice","lastName":"Admin"}}`))
	createUser.Header.Set("Content-Type", "application/json")
	createUser.Header.Set("Authorization", "SSWS dev-token")
	createUserRes := serveOkta(router, createUser)
	if createUserRes.Code != http.StatusCreated {
		t.Fatalf("create user status = %d, body = %s", createUserRes.Code, createUserRes.Body.String())
	}
	var user struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(createUserRes.Body.Bytes(), &user); err != nil {
		t.Fatal(err)
	}
	if user.ID == "" {
		t.Fatalf("missing user id in create response: %s", createUserRes.Body.String())
	}

	updateUser := httptest.NewRequest(http.MethodPost, "/api/v1/users/"+url.PathEscape(user.ID), strings.NewReader(`{"profile":{"login":"testuser@okta.local"}}`))
	updateUser.Header.Set("Content-Type", "application/json")
	updateUser.Header.Set("Authorization", "SSWS dev-token")
	updateUserRes := serveOkta(router, updateUser)
	if updateUserRes.Code != http.StatusBadRequest {
		t.Fatalf("update user status = %d, body = %s", updateUserRes.Code, updateUserRes.Body.String())
	}
	if !strings.Contains(updateUserRes.Body.String(), "A user with the same login or email already exists") {
		t.Fatalf("unexpected update body: %s", updateUserRes.Body.String())
	}
	if got := len(service.store.Users.FindBy("login", "testuser@okta.local")); got != 1 {
		t.Fatalf("duplicate login count = %d", got)
	}
	alice := firstRecord(service.store.Users.FindBy("okta_id", user.ID))
	if alice == nil || stringField(alice, "login") != "alice@example.com" {
		t.Fatalf("alice login changed after rejected update: %#v", alice)
	}
}

type oktaTokenBody struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	Scope        string `json:"scope"`
}

func authorizeOktaCode(t *testing.T, service *Service, router *corehttp.Router, scope string) string {
	t.Helper()
	user := firstRecord(service.store.Users.FindBy("login", "testuser@okta.local"))
	if user == nil {
		t.Fatal("missing default user")
	}
	form := url.Values{
		"user_ref":      {stringField(user, "okta_id")},
		"redirect_uri":  {"http://localhost:3000/callback"},
		"scope":         {scope},
		"client_id":     {"okta-test-client"},
		"response_mode": {"query"},
	}
	callback := httptest.NewRequest(http.MethodPost, "/oauth2/default/v1/authorize/callback", strings.NewReader(form.Encode()))
	callback.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	callbackRes := serveOkta(router, callback)
	if callbackRes.Code != http.StatusFound {
		t.Fatalf("callback status = %d, body = %s", callbackRes.Code, callbackRes.Body.String())
	}
	redirect, err := url.Parse(callbackRes.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	code := redirect.Query().Get("code")
	if code == "" {
		t.Fatalf("missing code in redirect: %s", callbackRes.Header().Get("Location"))
	}
	return code
}

func issueOktaToken(t *testing.T, service *Service, router *corehttp.Router, scope string) oktaTokenBody {
	t.Helper()
	code := authorizeOktaCode(t, service, router, scope)
	tokenForm := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {"http://localhost:3000/callback"},
		"client_id":     {"okta-test-client"},
		"client_secret": {"okta-test-secret"},
	}
	tokenReq := httptest.NewRequest(http.MethodPost, "/oauth2/default/v1/token", strings.NewReader(tokenForm.Encode()))
	tokenReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	tokenRes := serveOkta(router, tokenReq)
	if tokenRes.Code != http.StatusOK {
		t.Fatalf("token status = %d, body = %s", tokenRes.Code, tokenRes.Body.String())
	}
	var body oktaTokenBody
	if err := json.Unmarshal(tokenRes.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.AccessToken == "" || body.RefreshToken == "" {
		t.Fatalf("unexpected token body: %#v", body)
	}
	return body
}

func newTestService(t *testing.T) (*Service, *corehttp.Router) {
	t.Helper()
	service := New(Options{Store: corestore.New(), BaseURL: "http://localhost:4016"})
	router := corehttp.NewRouter()
	service.RegisterRoutes(router)
	return service, router
}

func serveOkta(router *corehttp.Router, req *http.Request) *httptest.ResponseRecorder {
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	return res
}
