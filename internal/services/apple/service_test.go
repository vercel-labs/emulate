package apple

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

const testBaseURL = "http://localhost:4004"

func newTestHandler() http.Handler {
	return newTestHandlerWithSeed(&SeedConfig{
		Users: []UserSeed{{Email: "testuser@example.com", Name: "Test User"}},
	})
}

func newTestHandlerWithSeed(seed *SeedConfig) http.Handler {
	router := corehttp.NewRouter()
	Register(router, Options{
		BaseURL: testBaseURL,
		Seed:    seed,
	})
	router.NotFound(func(c *corehttp.Context) {
		c.JSON(http.StatusNotFound, map[string]any{"message": "Not Found"})
	})
	return router
}

func TestOpenIDConfiguration(t *testing.T) {
	handler := newTestHandler()
	res, body := requestJSON(t, handler, http.MethodGet, "/.well-known/openid-configuration", "")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if body["issuer"] != testBaseURL || body["authorization_endpoint"] != testBaseURL+"/auth/authorize" {
		t.Fatalf("unexpected discovery: %#v", body)
	}
	if !containsString(body["claims_supported"], "is_private_email") ||
		!containsString(body["response_modes_supported"], "form_post") ||
		!containsString(body["code_challenge_methods_supported"], "S256") {
		t.Fatalf("missing discovery metadata: %#v", body)
	}
}

func TestKeys(t *testing.T) {
	handler := newTestHandler()
	res, body := requestJSON(t, handler, http.MethodGet, "/auth/keys", "")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	keys, _ := body["keys"].([]any)
	if len(keys) != 1 {
		t.Fatalf("unexpected keys: %#v", body)
	}
	key := keys[0].(map[string]any)
	if key["kty"] != "RSA" || key["kid"] != keyID || key["alg"] != "RS256" || key["e"] != "AQAB" || key["n"] == "" {
		t.Fatalf("unexpected key: %#v", key)
	}
}

func TestAuthorizePage(t *testing.T) {
	handler := newTestHandler()
	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/auth/authorize?client_id=test-client&redirect_uri="+url.QueryEscape("http://localhost:3000/callback")+"&response_type=code&scope=openid%20email%20name", nil)
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Header().Get("Content-Type"), "text/html") || !strings.Contains(res.Body.String(), "Sign in") {
		t.Fatalf("unexpected authorize page: status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestAuthorizationCodeFlow(t *testing.T) {
	handler := newTestHandler()
	code, state, userJSON := getAuthCode(t, handler, authCodeOptions{})
	if code == "" || state != "test-state" {
		t.Fatalf("unexpected callback values: code=%q state=%q", code, state)
	}
	if userJSON == "" {
		t.Fatalf("missing first authorization user JSON")
	}

	res, tokenBody := exchangeCode(t, handler, code)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.HasPrefix(stringValue(tokenBody["access_token"]), "apple_") ||
		!strings.HasPrefix(stringValue(tokenBody["refresh_token"]), "r_apple_") ||
		tokenBody["token_type"] != "Bearer" ||
		int(tokenBody["expires_in"].(float64)) != 3600 {
		t.Fatalf("unexpected token response: %#v", tokenBody)
	}
	claims := decodeJWTClaims(t, stringValue(tokenBody["id_token"]))
	if claims["iss"] != testBaseURL || claims["aud"] != "test-client" || claims["email"] != "testuser@example.com" {
		t.Fatalf("unexpected claims: %#v", claims)
	}
	if claims["email_verified"] != "true" || claims["is_private_email"] != "false" || claims["nonce"] != "test-nonce" || claims["nonce_supported"] != true {
		t.Fatalf("unexpected Apple claim types: %#v", claims)
	}
}

func TestRefreshTokenFlow(t *testing.T) {
	handler := newTestHandler()
	code, _, _ := getAuthCode(t, handler, authCodeOptions{})
	res, tokenBody := exchangeCode(t, handler, code)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	refreshToken := stringValue(tokenBody["refresh_token"])

	form := url.Values{
		"grant_type":    []string{"refresh_token"},
		"refresh_token": []string{refreshToken},
		"client_id":     []string{"test-client"},
		"client_secret": []string{"fake"},
	}
	res, body := requestJSON(t, handler, http.MethodPost, "/auth/token", form.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.HasPrefix(stringValue(body["access_token"]), "apple_") || body["id_token"] == "" {
		t.Fatalf("unexpected refresh response: %#v", body)
	}
	if _, ok := body["refresh_token"]; ok {
		t.Fatalf("refresh response issued a new refresh token: %#v", body)
	}
}

func TestAuthorizationCodeIsSingleUse(t *testing.T) {
	handler := newTestHandler()
	code, _, _ := getAuthCode(t, handler, authCodeOptions{})
	res, _ := exchangeCode(t, handler, code)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	res, body := exchangeCode(t, handler, code)
	if res.Code != http.StatusBadRequest || body["error"] != "invalid_grant" {
		t.Fatalf("unexpected second exchange: status=%d body=%#v", res.Code, body)
	}
}

func TestPKCES256Flow(t *testing.T) {
	handler := newTestHandler()
	verifier := "pkce-verifier-12345"
	code, _, _ := getAuthCode(t, handler, authCodeOptions{
		CodeChallenge:       s256Challenge(verifier),
		CodeChallengeMethod: "S256",
	})

	res, body := exchangeCode(t, handler, code, tokenExchangeOptions{CodeVerifier: "wrong-verifier"})
	if res.Code != http.StatusBadRequest || body["error"] != "invalid_grant" {
		t.Fatalf("unexpected wrong verifier response: status=%d body=%#v", res.Code, body)
	}

	res, body = exchangeCode(t, handler, code, tokenExchangeOptions{CodeVerifier: verifier})
	if res.Code != http.StatusOK || body["id_token"] == "" {
		t.Fatalf("unexpected verifier success response: status=%d body=%#v", res.Code, body)
	}
}

func TestUserJSONOnlyOnFirstAuthorization(t *testing.T) {
	handler := newTestHandler()
	_, _, userJSON := getAuthCode(t, handler, authCodeOptions{})
	if userJSON == "" {
		t.Fatalf("missing first auth user JSON")
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(userJSON), &parsed); err != nil {
		t.Fatalf("invalid user JSON: %v", err)
	}
	if parsed["email"] != "testuser@example.com" {
		t.Fatalf("unexpected user JSON: %#v", parsed)
	}

	_, _, secondUserJSON := getAuthCode(t, handler, authCodeOptions{})
	if secondUserJSON != "" {
		t.Fatalf("second auth included user JSON: %s", secondUserJSON)
	}
}

func TestPrivateEmailUsesRelayInUserJSONAndIDToken(t *testing.T) {
	handler := newTestHandlerWithSeed(&SeedConfig{
		Users: []UserSeed{{Email: "private@example.com", Name: "Private User", IsPrivateEmail: true}},
	})
	code, _, userJSON := getAuthCode(t, handler, authCodeOptions{Email: "private@example.com"})
	if userJSON == "" {
		t.Fatalf("missing first auth user JSON")
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(userJSON), &parsed); err != nil {
		t.Fatalf("invalid user JSON: %v", err)
	}
	userEmail := stringValue(parsed["email"])
	if userEmail == "private@example.com" || !strings.HasSuffix(userEmail, "@privaterelay.appleid.com") {
		t.Fatalf("user JSON leaked real email: %#v", parsed)
	}

	res, tokenBody := exchangeCode(t, handler, code)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	claims := decodeJWTClaims(t, stringValue(tokenBody["id_token"]))
	if claims["email"] != userEmail {
		t.Fatalf("email mismatch between user JSON and id_token: user=%q claims=%#v", userEmail, claims)
	}
}

func TestFormPostResponseMode(t *testing.T) {
	handler := newTestHandler()
	code, state, _ := getAuthCode(t, handler, authCodeOptions{ResponseMode: "form_post"})
	if code == "" || state != "test-state" {
		t.Fatalf("unexpected form_post values: code=%q state=%q", code, state)
	}
}

func TestFragmentResponseMode(t *testing.T) {
	handler := newTestHandler()
	code, state, userJSON := getAuthCode(t, handler, authCodeOptions{ResponseMode: "fragment"})
	if code == "" || state != "test-state" {
		t.Fatalf("unexpected fragment values: code=%q state=%q", code, state)
	}
	if userJSON == "" {
		t.Fatalf("missing first authorization user JSON")
	}
}

func TestAuthorizationCodeRejectsMismatchedClientID(t *testing.T) {
	handler := newTestHandler()
	code, _, _ := getAuthCode(t, handler, authCodeOptions{})

	res, body := exchangeCode(t, handler, code, tokenExchangeOptions{ClientID: "other-client"})
	if res.Code != http.StatusBadRequest || body["error"] != "invalid_grant" {
		t.Fatalf("unexpected mismatched client response: status=%d body=%#v", res.Code, body)
	}
}

func TestAuthorizationCodeRejectsMismatchedRedirectURI(t *testing.T) {
	handler := newTestHandler()
	code, _, _ := getAuthCode(t, handler, authCodeOptions{})

	res, body := exchangeCode(t, handler, code, tokenExchangeOptions{RedirectURI: "http://localhost:3000/other"})
	if res.Code != http.StatusBadRequest || body["error"] != "invalid_grant" {
		t.Fatalf("unexpected mismatched redirect response: status=%d body=%#v", res.Code, body)
	}
}

func TestUnsupportedGrantType(t *testing.T) {
	handler := newTestHandler()
	form := url.Values{
		"grant_type":    []string{"client_credentials"},
		"client_id":     []string{"test-client"},
		"client_secret": []string{"fake"},
	}
	res, body := requestJSON(t, handler, http.MethodPost, "/auth/token", form.Encode())
	if res.Code != http.StatusBadRequest || body["error"] != "unsupported_grant_type" {
		t.Fatalf("unexpected unsupported grant response: status=%d body=%#v", res.Code, body)
	}
}

func TestSeedFromConfig(t *testing.T) {
	runtimeStore := corestore.New()
	SeedFromConfig(runtimeStore, testBaseURL, SeedConfig{
		Users: []UserSeed{{Email: "private@example.com", Name: "Private User", IsPrivateEmail: true}},
		OAuthClients: []OAuthClientSeed{{
			ClientID:     "com.example.app",
			TeamID:       "TEAM001",
			Name:         "My Apple App",
			RedirectURIs: []string{"http://localhost:3000/callback"},
		}},
	})
	store := NewStore(runtimeStore)
	if firstRecord(store.Users.FindBy("email", "private@example.com")) == nil {
		t.Fatalf("missing seeded user")
	}
	client := firstRecord(store.OAuthClients.FindBy("client_id", "com.example.app"))
	if client == nil || stringField(client, "key_id") != "TESTKEY001" {
		t.Fatalf("unexpected seeded client: %#v", client)
	}
}

type authCodeOptions struct {
	Email               string
	ClientID            string
	RedirectURI         string
	Scope               string
	State               string
	Nonce               string
	ResponseMode        string
	CodeChallenge       string
	CodeChallengeMethod string
}

func getAuthCode(t *testing.T, handler http.Handler, opts authCodeOptions) (string, string, string) {
	t.Helper()
	email := firstNonEmpty(opts.Email, "testuser@example.com")
	clientID := firstNonEmpty(opts.ClientID, "test-client")
	redirectURI := firstNonEmpty(opts.RedirectURI, "http://localhost:3000/callback")
	scope := firstNonEmpty(opts.Scope, "openid email name")
	state := firstNonEmpty(opts.State, "test-state")
	nonce := firstNonEmpty(opts.Nonce, "test-nonce")
	responseMode := firstNonEmpty(opts.ResponseMode, "query")

	form := url.Values{
		"email":                 []string{email},
		"redirect_uri":          []string{redirectURI},
		"scope":                 []string{scope},
		"state":                 []string{state},
		"nonce":                 []string{nonce},
		"client_id":             []string{clientID},
		"response_mode":         []string{responseMode},
		"code_challenge":        []string{opts.CodeChallenge},
		"code_challenge_method": []string{opts.CodeChallengeMethod},
	}
	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/auth/authorize/callback", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusFound && res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if responseMode == "form_post" {
		html := res.Body.String()
		return htmlInputValue(html, "code"), htmlInputValue(html, "state"), htmlInputValue(html, "user")
	}
	location := res.Header().Get("Location")
	if location == "" {
		t.Fatalf("missing redirect location: %s", res.Body.String())
	}
	target, err := url.Parse(location)
	if err != nil {
		t.Fatalf("invalid redirect location: %v", err)
	}
	if responseMode == "fragment" {
		fragment, err := url.ParseQuery(target.Fragment)
		if err != nil {
			t.Fatalf("invalid redirect fragment: %v", err)
		}
		return fragment.Get("code"), fragment.Get("state"), fragment.Get("user")
	}
	return target.Query().Get("code"), target.Query().Get("state"), target.Query().Get("user")
}

type tokenExchangeOptions struct {
	ClientID     string
	RedirectURI  string
	CodeVerifier string
}

func exchangeCode(t *testing.T, handler http.Handler, code string, opts ...tokenExchangeOptions) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	options := tokenExchangeOptions{}
	if len(opts) > 0 {
		options = opts[0]
	}
	form := url.Values{
		"grant_type":    []string{"authorization_code"},
		"code":          []string{code},
		"client_id":     []string{firstNonEmpty(options.ClientID, "test-client")},
		"client_secret": []string{"fake"},
		"redirect_uri":  []string{firstNonEmpty(options.RedirectURI, "http://localhost:3000/callback")},
	}
	if options.CodeVerifier != "" {
		form.Set("code_verifier", options.CodeVerifier)
	}
	return requestJSON(t, handler, http.MethodPost, "/auth/token", form.Encode())
}

func requestJSON(t *testing.T, handler http.Handler, method string, path string, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	var parsed map[string]any
	if strings.Contains(res.Header().Get("Content-Type"), "application/json") && res.Body.Len() > 0 {
		if err := json.Unmarshal(res.Body.Bytes(), &parsed); err != nil {
			t.Fatalf("failed to parse response JSON: %v\nbody: %s", err, res.Body.String())
		}
	}
	return res, parsed
}

func decodeJWTClaims(t *testing.T, token string) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("invalid token: %s", token)
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("invalid claims encoding: %v", err)
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatalf("invalid claims JSON: %v", err)
	}
	return claims
}

func htmlInputValue(html string, name string) string {
	pattern := `name="` + name + `" value="`
	start := strings.Index(html, pattern)
	if start < 0 {
		return ""
	}
	start += len(pattern)
	end := strings.Index(html[start:], `"`)
	if end < 0 {
		return ""
	}
	return strings.NewReplacer("&quot;", `"`, "&#39;", "'", "&#x27;", "'", "&amp;", "&", "&lt;", "<", "&gt;", ">").Replace(html[start : start+end])
}

func containsString(value any, needle string) bool {
	for _, item := range stringSliceValue(value) {
		if item == needle {
			return true
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func s256Challenge(verifier string) string {
	digest := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}
