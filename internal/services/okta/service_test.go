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
