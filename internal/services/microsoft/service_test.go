package microsoft

import (
	"crypto/sha256"
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

const testBaseURL = "http://localhost:4015"

func newTestHandler(seed *SeedConfig) http.Handler {
	router := corehttp.NewRouter()
	Register(router, Options{
		Store:   corestore.New(),
		BaseURL: testBaseURL,
		Seed:    seed,
	})
	return router
}

func microsoftSeed() *SeedConfig {
	return &SeedConfig{
		Users: []UserSeed{
			{Email: "testuser@example.com", Name: "Test User", GivenName: "Test", FamilyName: "User", TenantID: "tenant-1"},
		},
		OAuthClients: []OAuthClientSeed{
			{
				ClientID:     "test-client",
				ClientSecret: "test-secret",
				Name:         "Test App",
				RedirectURIs: []string{"http://localhost:3000/callback"},
				TenantID:     "tenant-1",
			},
		},
	}
}

func TestMicrosoftOpenIDConfigurationAndKeys(t *testing.T) {
	handler := newTestHandler(microsoftSeed())

	res := doRequest(handler, http.MethodGet, "/.well-known/openid-configuration", "", "")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var discovery map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &discovery); err != nil {
		t.Fatal(err)
	}
	if discovery["issuer"] != testBaseURL+"/"+defaultTenantID+"/v2.0" {
		t.Fatalf("issuer = %#v", discovery["issuer"])
	}
	if discovery["authorization_endpoint"] != testBaseURL+"/oauth2/v2.0/authorize" || discovery["jwks_uri"] != testBaseURL+"/discovery/v2.0/keys" {
		t.Fatalf("unexpected discovery: %#v", discovery)
	}

	res = doRequest(handler, http.MethodGet, "/tenant-1/v2.0/.well-known/openid-configuration", "", "")
	if res.Code != http.StatusOK {
		t.Fatalf("tenant status = %d, body = %s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &discovery); err != nil {
		t.Fatal(err)
	}
	if discovery["issuer"] != testBaseURL+"/tenant-1/v2.0" {
		t.Fatalf("tenant issuer = %#v", discovery["issuer"])
	}

	res = doRequest(handler, http.MethodGet, "/discovery/v2.0/keys", "", "")
	if res.Code != http.StatusOK {
		t.Fatalf("keys status = %d, body = %s", res.Code, res.Body.String())
	}
	var keys struct {
		Keys []map[string]string `json:"keys"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &keys); err != nil {
		t.Fatal(err)
	}
	if len(keys.Keys) != 1 || keys.Keys[0]["kid"] != keyID || keys.Keys[0]["kty"] != "RSA" {
		t.Fatalf("unexpected keys: %#v", keys)
	}
}

func TestMicrosoftAuthorizationCodeFlow(t *testing.T) {
	handler := newTestHandler(microsoftSeed())
	code := getAuthCode(t, handler, map[string]string{})

	body := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {"test-client"},
		"client_secret": {"test-secret"},
		"redirect_uri":  {"http://localhost:3000/callback"},
	}
	res := doFormRequest(handler, "/oauth2/v2.0/token", body, "")
	if res.Code != http.StatusOK {
		t.Fatalf("token status = %d, body = %s", res.Code, res.Body.String())
	}
	var tokenBody struct {
		AccessToken  string `json:"access_token"`
		TokenType    string `json:"token_type"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		Scope        string `json:"scope"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &tokenBody); err != nil {
		t.Fatal(err)
	}
	if tokenBody.AccessToken == "" || tokenBody.RefreshToken == "" || tokenBody.IDToken == "" || tokenBody.TokenType != "Bearer" {
		t.Fatalf("unexpected token body: %#v", tokenBody)
	}
	if tokenBody.Scope != "openid email profile" {
		t.Fatalf("scope = %q", tokenBody.Scope)
	}

	claims := decodeJWTClaims(t, tokenBody.IDToken)
	if claims["email"] != "testuser@example.com" || claims["tid"] != "tenant-1" || claims["aud"] != "test-client" {
		t.Fatalf("unexpected claims: %#v", claims)
	}

	userinfo := doRequest(handler, http.MethodGet, "/oidc/userinfo", "", "Bearer "+tokenBody.AccessToken)
	if userinfo.Code != http.StatusOK || !strings.Contains(userinfo.Body.String(), `"preferred_username":"testuser@example.com"`) {
		t.Fatalf("userinfo status = %d, body = %s", userinfo.Code, userinfo.Body.String())
	}

	me := doRequest(handler, http.MethodGet, "/v1.0/me", "", "Bearer "+tokenBody.AccessToken)
	if me.Code != http.StatusOK || !strings.Contains(me.Body.String(), `"displayName":"Test User"`) {
		t.Fatalf("me status = %d, body = %s", me.Code, me.Body.String())
	}
}

func TestMicrosoftAuthorizationCodeIsSingleUseAndValidatesRedirect(t *testing.T) {
	handler := newTestHandler(microsoftSeed())
	code := getAuthCode(t, handler, map[string]string{})

	wrongRedirect := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {"test-client"},
		"client_secret": {"test-secret"},
		"redirect_uri":  {"http://localhost:3000/wrong"},
	}
	res := doFormRequest(handler, "/oauth2/v2.0/token", wrongRedirect, "")
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "redirect_uri") {
		t.Fatalf("wrong redirect status = %d, body = %s", res.Code, res.Body.String())
	}

	reuse := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {"test-client"},
		"client_secret": {"test-secret"},
		"redirect_uri":  {"http://localhost:3000/callback"},
	}
	res = doFormRequest(handler, "/oauth2/v2.0/token", reuse, "")
	if res.Code != http.StatusBadRequest {
		t.Fatalf("reused status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestMicrosoftPKCES256AndFragmentResponseMode(t *testing.T) {
	handler := newTestHandler(microsoftSeed())
	verifier := "correct horse battery staple"
	challengeBytes := sha256Sum(verifier)
	challenge := base64.RawURLEncoding.EncodeToString(challengeBytes)
	code := getAuthCode(t, handler, map[string]string{
		"response_mode":         "fragment",
		"code_challenge":        challenge,
		"code_challenge_method": "S256",
	})

	wrongVerifier := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {"test-client"},
		"client_secret": {"test-secret"},
		"redirect_uri":  {"http://localhost:3000/callback"},
		"code_verifier": {"wrong"},
	}
	res := doFormRequest(handler, "/oauth2/v2.0/token", wrongVerifier, "")
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "PKCE") {
		t.Fatalf("wrong verifier status = %d, body = %s", res.Code, res.Body.String())
	}

	correctVerifier := wrongVerifier
	correctVerifier.Set("code_verifier", verifier)
	res = doFormRequest(handler, "/oauth2/v2.0/token", correctVerifier, "")
	if res.Code != http.StatusOK {
		t.Fatalf("correct verifier status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestMicrosoftRefreshTokenRotates(t *testing.T) {
	handler := newTestHandler(microsoftSeed())
	code := getAuthCode(t, handler, map[string]string{})
	token := exchangeCode(t, handler, code)

	refresh := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {token.RefreshToken},
		"client_id":     {"test-client"},
		"client_secret": {"test-secret"},
	}
	res := doFormRequest(handler, "/oauth2/v2.0/token", refresh, "")
	if res.Code != http.StatusOK {
		t.Fatalf("refresh status = %d, body = %s", res.Code, res.Body.String())
	}
	var refreshed struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &refreshed); err != nil {
		t.Fatal(err)
	}
	if refreshed.AccessToken == "" || refreshed.RefreshToken == "" || refreshed.RefreshToken == token.RefreshToken {
		t.Fatalf("unexpected refreshed token: %#v", refreshed)
	}

	res = doFormRequest(handler, "/oauth2/v2.0/token", refresh, "")
	if res.Code != http.StatusBadRequest {
		t.Fatalf("old refresh status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestMicrosoftRefreshTokenRejectsMismatchedClient(t *testing.T) {
	seed := microsoftSeed()
	seed.OAuthClients = append(seed.OAuthClients, OAuthClientSeed{
		ClientID:     "other-client",
		ClientSecret: "other-secret",
		Name:         "Other App",
		RedirectURIs: []string{"http://localhost:3000/callback"},
		TenantID:     "tenant-1",
	})
	handler := newTestHandler(seed)
	code := getAuthCode(t, handler, map[string]string{})
	token := exchangeCode(t, handler, code)

	wrongClient := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {token.RefreshToken},
		"client_id":     {"other-client"},
		"client_secret": {"other-secret"},
	}
	res := doFormRequest(handler, "/oauth2/v2.0/token", wrongClient, "")
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "invalid_grant") {
		t.Fatalf("wrong client refresh status = %d, body = %s", res.Code, res.Body.String())
	}

	originalClient := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {token.RefreshToken},
		"client_id":     {"test-client"},
		"client_secret": {"test-secret"},
	}
	res = doFormRequest(handler, "/oauth2/v2.0/token", originalClient, "")
	if res.Code != http.StatusOK {
		t.Fatalf("original client refresh status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestMicrosoftFormPostLogoutAndRevoke(t *testing.T) {
	handler := newTestHandler(microsoftSeed())
	code := getAuthCode(t, handler, map[string]string{"response_mode": "form_post"})
	token := exchangeCode(t, handler, code)

	logout := doRequest(handler, http.MethodGet, "/oauth2/v2.0/logout?post_logout_redirect_uri="+url.QueryEscape("http://localhost:3000/callback"), "", "")
	if logout.Code != http.StatusFound || logout.Header().Get("Location") != "http://localhost:3000/callback" {
		t.Fatalf("logout status = %d, location = %s, body = %s", logout.Code, logout.Header().Get("Location"), logout.Body.String())
	}

	revoke := doFormRequest(handler, "/oauth2/v2.0/revoke", url.Values{"token": {token.AccessToken}}, "")
	if revoke.Code != http.StatusOK {
		t.Fatalf("revoke status = %d, body = %s", revoke.Code, revoke.Body.String())
	}
	userinfo := doRequest(handler, http.MethodGet, "/oidc/userinfo", "", "Bearer "+token.AccessToken)
	if userinfo.Code != http.StatusUnauthorized {
		t.Fatalf("userinfo after revoke status = %d, body = %s", userinfo.Code, userinfo.Body.String())
	}
}

func TestMicrosoftClientCredentialsAndV1Resource(t *testing.T) {
	handler := newTestHandler(microsoftSeed())
	basic := "Basic " + base64.StdEncoding.EncodeToString([]byte("test-client:test-secret"))
	res := doFormRequest(handler, "/tenant-1/oauth2/token", url.Values{
		"grant_type": {"client_credentials"},
		"resource":   {"https://graph.microsoft.com"},
	}, basic)
	if res.Code != http.StatusOK {
		t.Fatalf("client credentials status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		AccessToken string `json:"access_token"`
		Scope       string `json:"scope"`
		IDToken     string `json:"id_token"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.AccessToken == "" || body.Scope != "https://graph.microsoft.com/.default" || body.IDToken != "" {
		t.Fatalf("unexpected client credentials body: %#v", body)
	}
}

func TestMicrosoftRejectsWrongClientSecret(t *testing.T) {
	handler := newTestHandler(microsoftSeed())
	code := getAuthCode(t, handler, map[string]string{})
	res := doFormRequest(handler, "/oauth2/v2.0/token", url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {"test-client"},
		"client_secret": {"wrong"},
		"redirect_uri":  {"http://localhost:3000/callback"},
	}, "")
	if res.Code != http.StatusUnauthorized || !strings.Contains(res.Body.String(), "invalid_client") {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestMicrosoftGraphUserByIDAndSeedConfig(t *testing.T) {
	store := corestore.New()
	SeedFromConfig(store, testBaseURL, *microsoftSeed())
	service := New(Options{Store: store, BaseURL: testBaseURL})
	user := firstRecord(service.store.Users.FindBy("email", "testuser@example.com"))
	if user == nil {
		t.Fatal("missing seeded user")
	}

	router := corehttp.NewRouter()
	service.RegisterRoutes(router)
	res := doRequest(router, http.MethodGet, "/v1.0/users/"+stringField(user, "oid"), "", "")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"userPrincipalName":"testuser@example.com"`) {
		t.Fatalf("user status = %d, body = %s", res.Code, res.Body.String())
	}
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
}

func getAuthCode(t *testing.T, handler http.Handler, overrides map[string]string) string {
	t.Helper()
	values := url.Values{
		"email":                 {"testuser@example.com"},
		"redirect_uri":          {"http://localhost:3000/callback"},
		"scope":                 {"openid email profile"},
		"state":                 {"test-state"},
		"nonce":                 {"test-nonce"},
		"client_id":             {"test-client"},
		"response_mode":         {"query"},
		"code_challenge":        {""},
		"code_challenge_method": {""},
	}
	for key, value := range overrides {
		values.Set(key, value)
	}
	res := doFormRequest(handler, "/oauth2/v2.0/authorize/callback", values, "")
	if res.Code != http.StatusFound && res.Code != http.StatusOK {
		t.Fatalf("callback status = %d, body = %s", res.Code, res.Body.String())
	}
	if values.Get("response_mode") == "form_post" {
		code := matchHTMLInput(res.Body.String(), "code")
		if code == "" {
			t.Fatalf("missing form_post code in %s", res.Body.String())
		}
		return code
	}
	location := res.Header().Get("Location")
	if location == "" {
		t.Fatalf("missing redirect location: %s", res.Body.String())
	}
	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	if values.Get("response_mode") == "fragment" {
		fragment, err := url.ParseQuery(parsed.Fragment)
		if err != nil {
			t.Fatal(err)
		}
		return fragment.Get("code")
	}
	return parsed.Query().Get("code")
}

func exchangeCode(t *testing.T, handler http.Handler, code string) tokenResponse {
	t.Helper()
	res := doFormRequest(handler, "/oauth2/v2.0/token", url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {"test-client"},
		"client_secret": {"test-secret"},
		"redirect_uri":  {"http://localhost:3000/callback"},
	}, "")
	if res.Code != http.StatusOK {
		t.Fatalf("token status = %d, body = %s", res.Code, res.Body.String())
	}
	var body tokenResponse
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func doRequest(handler http.Handler, method string, target string, body string, authorization string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func doFormRequest(handler http.Handler, target string, values url.Values, authorization string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(values.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func decodeJWTClaims(t *testing.T, token string) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("invalid token: %s", token)
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

func matchHTMLInput(html string, name string) string {
	marker := `name="` + name + `" value="`
	start := strings.Index(html, marker)
	if start < 0 {
		return ""
	}
	start += len(marker)
	end := strings.Index(html[start:], `"`)
	if end < 0 {
		return ""
	}
	return html[start : start+end]
}

func sha256Sum(value string) []byte {
	sum := sha256.Sum256([]byte(value))
	return sum[:]
}
