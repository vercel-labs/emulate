package microsoft

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/core/ui"
)

const pendingCodeTTL = 10 * time.Minute

func (s *Service) registerOAuthRoutes(router *corehttp.Router) {
	router.Get("/.well-known/openid-configuration", s.handleOpenIDConfiguration)
	router.Get("/:tenant/v2.0/.well-known/openid-configuration", s.handleTenantOpenIDConfiguration)
	router.Get("/discovery/v2.0/keys", s.handleKeys)
	router.Get("/oauth2/v2.0/authorize", s.handleAuthorize)
	router.Post("/oauth2/v2.0/authorize/callback", s.handleAuthorizeCallback)
	router.Post("/oauth2/v2.0/token", s.handleToken)
	router.Post("/:tenant/oauth2/token", s.handleV1Token)
	router.Get("/oidc/userinfo", s.handleUserinfo)
	router.Get("/v1.0/me", s.handleGraphMe)
	router.Get("/v1.0/users/:id", s.handleGraphUserByID)
	router.Get("/oauth2/v2.0/logout", s.handleLogout)
	router.Post("/oauth2/v2.0/revoke", s.handleRevoke)
}

func (s *Service) handleOpenIDConfiguration(c *corehttp.Context) {
	c.JSON(http.StatusOK, s.openIDConfiguration(defaultTenantID))
}

func (s *Service) handleTenantOpenIDConfiguration(c *corehttp.Context) {
	c.JSON(http.StatusOK, s.openIDConfiguration(normalizeTenant(c.Param("tenant"))))
}

func (s *Service) openIDConfiguration(tenantID string) map[string]any {
	return map[string]any{
		"issuer":                                s.baseURL + "/" + tenantID + "/v2.0",
		"authorization_endpoint":                s.baseURL + "/oauth2/v2.0/authorize",
		"token_endpoint":                        s.baseURL + "/oauth2/v2.0/token",
		"userinfo_endpoint":                     s.baseURL + "/oidc/userinfo",
		"end_session_endpoint":                  s.baseURL + "/oauth2/v2.0/logout",
		"jwks_uri":                              s.baseURL + "/discovery/v2.0/keys",
		"response_types_supported":              []string{"code"},
		"response_modes_supported":              []string{"query", "fragment", "form_post"},
		"subject_types_supported":               []string{"pairwise"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"scopes_supported":                      []string{"openid", "email", "profile", "offline_access", "User.Read", ".default"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token", "client_credentials"},
		"token_endpoint_auth_methods_supported": []string{"client_secret_post", "client_secret_basic"},
		"claims_supported": []string{
			"aud",
			"email",
			"exp",
			"family_name",
			"given_name",
			"iat",
			"iss",
			"name",
			"nonce",
			"oid",
			"preferred_username",
			"sub",
			"tid",
			"ver",
		},
		"code_challenge_methods_supported": []string{"plain", "S256"},
	}
}

func (s *Service) handleKeys(c *corehttp.Context) {
	c.JSON(http.StatusOK, signer.jwks())
}

func (s *Service) handleAuthorize(c *corehttp.Context) {
	clientID := c.Query("client_id")
	redirectURI := c.Query("redirect_uri")
	scope := c.Query("scope")
	state := c.Query("state")
	nonce := c.Query("nonce")
	responseMode := c.Query("response_mode")
	codeChallenge := c.Query("code_challenge")
	codeChallengeMethod := c.Query("code_challenge_method")
	if responseMode == "" {
		responseMode = "query"
	}

	clientName := ""
	if len(s.store.OAuthClients.All()) > 0 {
		client := firstRecord(s.store.OAuthClients.FindBy("client_id", clientID))
		if client == nil {
			c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Application not found", "The client_id '"+clientID+"' is not registered.", ui.PageOptions{Service: serviceLabel}))
			return
		}
		if redirectURI != "" && !matchesRedirectURI(redirectURI, stringSliceValue(client["redirect_uris"])) {
			c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", ui.PageOptions{Service: serviceLabel}))
			return
		}
		clientName = stringField(client, "name")
	}

	subtitle := "Choose a seeded user to continue."
	if clientName != "" {
		subtitle = "Sign in to <strong>" + ui.EscapeHTML(clientName) + "</strong> with your Microsoft account."
	}

	users := s.store.Users.All()
	var body strings.Builder
	if len(users) == 0 {
		body.WriteString(`<p class="empty">No users in the emulator store.</p>`)
	} else {
		for _, user := range users {
			email := stringField(user, "email")
			letter := "?"
			if email != "" {
				letter = strings.ToUpper(email[:1])
			}
			body.WriteString(ui.RenderUserButton(ui.UserButtonOptions{
				Letter:     letter,
				Login:      email,
				Name:       stringField(user, "name"),
				Email:      email,
				FormAction: "/oauth2/v2.0/authorize/callback",
				HiddenFields: map[string]string{
					"email":                 email,
					"redirect_uri":          redirectURI,
					"scope":                 scope,
					"state":                 state,
					"nonce":                 nonce,
					"client_id":             clientID,
					"response_mode":         responseMode,
					"code_challenge":        codeChallenge,
					"code_challenge_method": codeChallengeMethod,
				},
			}))
		}
	}
	c.HTML(http.StatusOK, ui.RenderCardPage("Sign in with Microsoft", subtitle, body.String(), ui.PageOptions{Service: serviceLabel}))
}

func (s *Service) handleAuthorizeCallback(c *corehttp.Context) {
	if err := c.Request.ParseForm(); err != nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_request", "Invalid form body.")
		return
	}
	email := c.Request.Form.Get("email")
	redirectURI := c.Request.Form.Get("redirect_uri")
	scope := c.Request.Form.Get("scope")
	state := c.Request.Form.Get("state")
	clientID := c.Request.Form.Get("client_id")
	nonce := c.Request.Form.Get("nonce")
	responseMode := c.Request.Form.Get("response_mode")
	codeChallenge := c.Request.Form.Get("code_challenge")
	codeChallengeMethod := c.Request.Form.Get("code_challenge_method")
	if responseMode == "" {
		responseMode = "query"
	}

	if firstRecord(s.store.Users.FindBy("email", email)) == nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_request", "User not found.")
		return
	}
	if len(s.store.OAuthClients.All()) > 0 {
		client := firstRecord(s.store.OAuthClients.FindBy("client_id", clientID))
		if client == nil {
			c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Application not found", "The client_id '"+clientID+"' is not registered.", ui.PageOptions{Service: serviceLabel}))
			return
		}
		if redirectURI != "" && !matchesRedirectURI(redirectURI, stringSliceValue(client["redirect_uris"])) {
			c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", ui.PageOptions{Service: serviceLabel}))
			return
		}
	}

	code := generateHex(20)
	s.store.OAuthCodes.Insert(corestore.Record{
		"code":                  code,
		"email":                 email,
		"scope":                 scope,
		"redirect_uri":          redirectURI,
		"client_id":             clientID,
		"nonce":                 nonce,
		"code_challenge":        codeChallenge,
		"code_challenge_method": codeChallengeMethod,
		"created_at_ms":         time.Now().UnixMilli(),
	})

	if responseMode == "form_post" {
		c.HTML(http.StatusOK, ui.RenderFormPostPage(redirectURI, map[string]string{"code": code, "state": state}, ui.PageOptions{Service: serviceLabel}))
		return
	}

	target, err := url.Parse(redirectURI)
	if err != nil || target == nil || target.Scheme == "" {
		writeOAuthError(c, http.StatusBadRequest, "invalid_request", "Invalid redirect_uri.")
		return
	}
	if responseMode == "fragment" {
		fragment, _ := url.ParseQuery(target.Fragment)
		addAuthorizationResponseValues(fragment, code, state)
		target.Fragment = fragment.Encode()
		target.RawFragment = ""
		c.Redirect(http.StatusFound, target.String())
		return
	}
	query := target.Query()
	addAuthorizationResponseValues(query, code, state)
	target.RawQuery = query.Encode()
	c.Redirect(http.StatusFound, target.String())
}

func (s *Service) handleToken(c *corehttp.Context) {
	body, err := parseTokenBody(c.Request)
	if err != nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_request", "Invalid token request body.")
		return
	}
	s.handleParsedToken(c, body)
}

func (s *Service) handleV1Token(c *corehttp.Context) {
	body, err := parseTokenBody(c.Request)
	if err != nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_request", "Invalid token request body.")
		return
	}
	if body["scope"] == "" && body["resource"] != "" {
		resource := strings.TrimRight(body["resource"], "/")
		if resource != "" {
			body["scope"] = resource + "/.default"
		}
	}
	s.handleParsedToken(c, body)
}

func (s *Service) handleParsedToken(c *corehttp.Context, body map[string]string) {
	clientID := body["client_id"]
	clientSecret := body["client_secret"]
	applyBasicCredentials(c.Request, &clientID, &clientSecret)

	switch body["grant_type"] {
	case "authorization_code":
		s.handleAuthorizationCodeToken(c, body, clientID, clientSecret)
	case "refresh_token":
		s.handleRefreshToken(c, body, clientID, clientSecret)
	case "client_credentials":
		s.handleClientCredentialsToken(c, body, clientID, clientSecret)
	default:
		writeOAuthError(c, http.StatusBadRequest, "unsupported_grant_type", "Only authorization_code, refresh_token, and client_credentials are supported.")
	}
}

func (s *Service) handleAuthorizationCodeToken(c *corehttp.Context, body map[string]string, clientID string, clientSecret string) {
	if !s.validateClient(c, clientID, clientSecret) {
		return
	}
	code := body["code"]
	pending := firstRecord(s.store.OAuthCodes.FindBy("code", code))
	if pending == nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "The code is incorrect or expired.")
		return
	}
	if time.Since(pendingCodeCreatedAt(pending)) > pendingCodeTTL {
		s.deleteOAuthCode(code)
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "The code is incorrect or expired.")
		return
	}
	if pendingClientID := stringField(pending, "client_id"); pendingClientID != "" && clientID != pendingClientID {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "The code is incorrect or expired.")
		return
	}
	if pendingRedirectURI := stringField(pending, "redirect_uri"); pendingRedirectURI != "" && body["redirect_uri"] != "" && body["redirect_uri"] != pendingRedirectURI {
		s.deleteOAuthCode(code)
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "The redirect_uri does not match the one used in the authorization request.")
		return
	}
	if !verifyPKCEChallenge(stringField(pending, "code_challenge"), stringField(pending, "code_challenge_method"), body["code_verifier"]) {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "PKCE verification failed.")
		return
	}
	s.deleteOAuthCode(code)

	user := firstRecord(s.store.Users.FindBy("email", stringField(pending, "email")))
	if user == nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "User not found.")
		return
	}

	accessToken := generateToken("microsoft_")
	refreshToken := generateToken("r_microsoft_")
	scope := stringField(pending, "scope")
	if scope == "" {
		scope = "openid email profile"
	}
	s.store.AccessTokens.Insert(corestore.Record{
		"token":     accessToken,
		"login":     stringField(user, "email"),
		"client_id": stringField(pending, "client_id"),
		"scopes":    splitScopes(scope),
		"kind":      "user",
	})
	s.store.RefreshTokens.Insert(corestore.Record{
		"token":     refreshToken,
		"email":     stringField(user, "email"),
		"client_id": stringField(pending, "client_id"),
		"scope":     scope,
		"nonce":     stringField(pending, "nonce"),
	})

	idToken, err := createIDToken(user, stringField(pending, "client_id"), stringField(pending, "nonce"), s.baseURL)
	if err != nil {
		writeOAuthError(c, http.StatusInternalServerError, "server_error", "Failed to sign id_token.")
		return
	}
	c.JSON(http.StatusOK, map[string]any{
		"access_token":  accessToken,
		"token_type":    "Bearer",
		"expires_in":    3600,
		"scope":         scope,
		"refresh_token": refreshToken,
		"id_token":      idToken,
	})
}

func (s *Service) handleRefreshToken(c *corehttp.Context, body map[string]string, clientID string, clientSecret string) {
	if !s.validateClient(c, clientID, clientSecret) {
		return
	}
	refreshToken := body["refresh_token"]
	stored := firstRecord(s.store.RefreshTokens.FindBy("token", refreshToken))
	if stored == nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "The refresh_token is invalid.")
		return
	}
	storedClientID := stringField(stored, "client_id")
	if storedClientID != "" && clientID != storedClientID {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "The refresh_token is invalid.")
		return
	}
	user := firstRecord(s.store.Users.FindBy("email", stringField(stored, "email")))
	if user == nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "User not found.")
		return
	}
	s.deleteRefreshToken(refreshToken)

	accessToken := generateToken("microsoft_")
	newRefreshToken := generateToken("r_microsoft_")
	scope := stringField(stored, "scope")
	if scope == "" {
		scope = "openid email profile"
	}
	if storedClientID == "" {
		storedClientID = clientID
	}
	s.store.AccessTokens.Insert(corestore.Record{
		"token":     accessToken,
		"login":     stringField(user, "email"),
		"client_id": storedClientID,
		"scopes":    splitScopes(scope),
		"kind":      "user",
	})
	s.store.RefreshTokens.Insert(corestore.Record{
		"token":     newRefreshToken,
		"email":     stringField(user, "email"),
		"client_id": storedClientID,
		"scope":     scope,
		"nonce":     stringField(stored, "nonce"),
	})

	idToken, err := createIDToken(user, storedClientID, stringField(stored, "nonce"), s.baseURL)
	if err != nil {
		writeOAuthError(c, http.StatusInternalServerError, "server_error", "Failed to sign id_token.")
		return
	}
	c.JSON(http.StatusOK, map[string]any{
		"access_token":  accessToken,
		"token_type":    "Bearer",
		"expires_in":    3600,
		"scope":         scope,
		"refresh_token": newRefreshToken,
		"id_token":      idToken,
	})
}

func (s *Service) handleClientCredentialsToken(c *corehttp.Context, body map[string]string, clientID string, clientSecret string) {
	if !s.validateClient(c, clientID, clientSecret) {
		return
	}
	scope := body["scope"]
	if scope == "" {
		scope = ".default"
	}
	accessToken := generateToken("microsoft_")
	s.store.AccessTokens.Insert(corestore.Record{
		"token":     accessToken,
		"login":     clientID,
		"client_id": clientID,
		"scopes":    splitScopes(scope),
		"kind":      "client",
	})
	c.JSON(http.StatusOK, map[string]any{
		"access_token": accessToken,
		"token_type":   "Bearer",
		"expires_in":   3600,
		"scope":        scope,
	})
}

func (s *Service) validateClient(c *corehttp.Context, clientID string, clientSecret string) bool {
	if len(s.store.OAuthClients.All()) == 0 {
		return true
	}
	client := firstRecord(s.store.OAuthClients.FindBy("client_id", clientID))
	if client == nil {
		writeOAuthError(c, http.StatusUnauthorized, "invalid_client", "The client_id is incorrect.")
		return false
	}
	if !constantTimeSecretEqual(clientSecret, stringField(client, "client_secret")) {
		writeOAuthError(c, http.StatusUnauthorized, "invalid_client", "The client_secret is incorrect.")
		return false
	}
	return true
}

func (s *Service) handleUserinfo(c *corehttp.Context) {
	user, ok := s.currentUser(c)
	if !ok {
		writeOAuthError(c, http.StatusUnauthorized, "invalid_token", "Authentication required.")
		return
	}
	c.JSON(http.StatusOK, map[string]any{
		"sub":                stringField(user, "oid"),
		"email":              stringField(user, "email"),
		"name":               stringField(user, "name"),
		"given_name":         stringField(user, "given_name"),
		"family_name":        stringField(user, "family_name"),
		"preferred_username": stringField(user, "preferred_username"),
	})
}

func (s *Service) handleGraphMe(c *corehttp.Context) {
	user, ok := s.currentUser(c)
	if !ok {
		writeGraphError(c, http.StatusUnauthorized, "InvalidAuthenticationToken", "Authentication required.")
		return
	}
	c.JSON(http.StatusOK, s.graphUser(user))
}

func (s *Service) handleGraphUserByID(c *corehttp.Context) {
	user := firstRecord(s.store.Users.FindBy("oid", c.Param("id")))
	if user == nil {
		writeGraphError(c, http.StatusNotFound, "Request_ResourceNotFound", "Resource '"+c.Param("id")+"' does not exist or one of its queried reference-property objects are not present.")
		return
	}
	c.JSON(http.StatusOK, s.graphUser(user))
}

func (s *Service) graphUser(user corestore.Record) map[string]any {
	return map[string]any{
		"@odata.context":    s.baseURL + "/v1.0/$metadata#users/$entity",
		"id":                stringField(user, "oid"),
		"displayName":       stringField(user, "name"),
		"givenName":         stringField(user, "given_name"),
		"surname":           stringField(user, "family_name"),
		"mail":              stringField(user, "email"),
		"userPrincipalName": stringField(user, "preferred_username"),
	}
}

func (s *Service) currentUser(c *corehttp.Context) (corestore.Record, bool) {
	token := bearerToken(c.Request)
	if token == "" {
		return nil, false
	}
	row := firstRecord(s.store.AccessTokens.FindBy("token", token))
	if row == nil || stringField(row, "kind") != "user" {
		return nil, false
	}
	user := firstRecord(s.store.Users.FindBy("email", stringField(row, "login")))
	return user, user != nil
}

func (s *Service) handleLogout(c *corehttp.Context) {
	redirectURI := c.Query("post_logout_redirect_uri")
	if redirectURI == "" {
		c.Text(http.StatusOK, "Logged out")
		return
	}
	if len(s.store.OAuthClients.All()) > 0 {
		allowed := false
		for _, client := range s.store.OAuthClients.All() {
			if matchesRedirectURI(redirectURI, stringSliceValue(client["redirect_uris"])) {
				allowed = true
				break
			}
		}
		if !allowed {
			c.Text(http.StatusBadRequest, "Invalid post_logout_redirect_uri")
			return
		}
	}
	c.Redirect(http.StatusFound, redirectURI)
}

func (s *Service) handleRevoke(c *corehttp.Context) {
	body, err := parseTokenBody(c.Request)
	if err == nil {
		token := body["token"]
		s.deleteAccessToken(token)
		s.deleteRefreshToken(token)
	}
	c.Writer.WriteHeader(http.StatusOK)
}

func parseTokenBody(req *http.Request) (map[string]string, error) {
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	if strings.Contains(req.Header.Get("Content-Type"), "application/json") {
		var parsed map[string]any
		if len(strings.TrimSpace(string(raw))) == 0 {
			return out, nil
		}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return out, nil
		}
		for key, value := range parsed {
			if s, ok := value.(string); ok {
				out[key] = s
			}
		}
		return out, nil
	}
	values, err := url.ParseQuery(string(raw))
	if err != nil {
		return nil, err
	}
	for key := range values {
		out[key] = values.Get(key)
	}
	return out, nil
}

func applyBasicCredentials(req *http.Request, clientID *string, clientSecret *string) {
	header := strings.TrimSpace(req.Header.Get("Authorization"))
	if !strings.HasPrefix(header, "Basic ") {
		return
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(strings.TrimPrefix(header, "Basic ")))
	if err != nil {
		return
	}
	id, secret, ok := strings.Cut(string(decoded), ":")
	if !ok {
		return
	}
	if *clientID == "" {
		if unescaped, err := url.QueryUnescape(id); err == nil {
			*clientID = unescaped
		} else {
			*clientID = id
		}
	}
	if *clientSecret == "" {
		if unescaped, err := url.QueryUnescape(secret); err == nil {
			*clientSecret = unescaped
		} else {
			*clientSecret = secret
		}
	}
}

func (s *Service) deleteOAuthCode(code string) {
	for _, row := range s.store.OAuthCodes.FindBy("code", code) {
		s.store.OAuthCodes.Delete(intField(row, "id"))
	}
}

func (s *Service) deleteRefreshToken(token string) {
	for _, row := range s.store.RefreshTokens.FindBy("token", token) {
		s.store.RefreshTokens.Delete(intField(row, "id"))
	}
}

func (s *Service) deleteAccessToken(token string) {
	for _, row := range s.store.AccessTokens.FindBy("token", token) {
		s.store.AccessTokens.Delete(intField(row, "id"))
	}
}

func pendingCodeCreatedAt(row corestore.Record) time.Time {
	millis := intField(row, "created_at_ms")
	if millis == 0 {
		return time.Now()
	}
	return time.UnixMilli(int64(millis))
}

func addAuthorizationResponseValues(values url.Values, code string, state string) {
	values.Set("code", code)
	if state != "" {
		values.Set("state", state)
	}
}

func writeOAuthError(c *corehttp.Context, status int, code string, description string) {
	c.JSON(status, map[string]any{
		"error":             code,
		"error_description": description,
	})
}

func writeGraphError(c *corehttp.Context, status int, code string, message string) {
	c.JSON(status, map[string]any{
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})
}
