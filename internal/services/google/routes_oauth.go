package google

import (
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
	router.Get("/oauth2/v3/certs", s.handleCerts)
	router.Get("/o/oauth2/v2/auth", s.handleAuthorize)
	router.Post("/o/oauth2/v2/auth/callback", s.handleAuthorizeCallback)
	router.Post("/oauth2/token", s.handleToken)
	router.Post("/oauth2/revoke", s.handleRevoke)
	router.Get("/oauth2/v2/userinfo", s.handleUserinfo)
	router.Get("/oauth2/v3/userinfo", s.handleUserinfo)
	router.Get("/userinfo", s.handleUserinfo)
	router.Get("/tokeninfo", s.handleTokeninfo)
	router.Post("/tokeninfo", s.handleTokeninfo)
}

func (s *Service) handleOpenIDConfiguration(c *corehttp.Context) {
	c.JSON(http.StatusOK, map[string]any{
		"issuer":                                s.baseURL,
		"authorization_endpoint":                s.baseURL + "/o/oauth2/v2/auth",
		"token_endpoint":                        s.baseURL + "/oauth2/token",
		"userinfo_endpoint":                     s.baseURL + "/oauth2/v2/userinfo",
		"revocation_endpoint":                   s.baseURL + "/oauth2/revoke",
		"jwks_uri":                              s.baseURL + "/oauth2/v3/certs",
		"response_types_supported":              []string{"code"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"scopes_supported":                      []string{"openid", "email", "profile"},
		"token_endpoint_auth_methods_supported": []string{"client_secret_post", "client_secret_basic"},
		"claims_supported": []string{
			"sub",
			"email",
			"email_verified",
			"name",
			"given_name",
			"family_name",
			"picture",
			"locale",
			"hd",
		},
		"code_challenge_methods_supported": []string{"plain", "S256"},
	})
}

func (s *Service) handleCerts(c *corehttp.Context) {
	c.JSON(http.StatusOK, googleSigner.jwks())
}

func (s *Service) handleAuthorize(c *corehttp.Context) {
	clientID := c.Query("client_id")
	redirectURI := c.Query("redirect_uri")
	scope := c.Query("scope")
	state := c.Query("state")
	nonce := c.Query("nonce")
	codeChallenge := c.Query("code_challenge")
	codeChallengeMethod := c.Query("code_challenge_method")

	clientName := ""
	if s.store.OAuthClients.Count() > 0 {
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
		subtitle = "Sign in to <strong>" + ui.EscapeHTML(clientName) + "</strong> with your Google account."
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
				FormAction: "/o/oauth2/v2/auth/callback",
				HiddenFields: map[string]string{
					"email":                 email,
					"redirect_uri":          redirectURI,
					"scope":                 scope,
					"state":                 state,
					"nonce":                 nonce,
					"client_id":             clientID,
					"code_challenge":        codeChallenge,
					"code_challenge_method": codeChallengeMethod,
				},
			}))
		}
	}
	c.HTML(http.StatusOK, ui.RenderCardPage("Sign in to Google", subtitle, body.String(), ui.PageOptions{Service: serviceLabel}))
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
	codeChallenge := c.Request.Form.Get("code_challenge")
	codeChallengeMethod := c.Request.Form.Get("code_challenge_method")

	if firstRecord(s.store.Users.FindBy("email", email)) == nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_request", "User not found.")
		return
	}
	if s.store.OAuthClients.Count() > 0 {
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

	target, err := url.Parse(redirectURI)
	if err != nil || target == nil || target.Scheme == "" {
		writeOAuthError(c, http.StatusBadRequest, "invalid_request", "Invalid redirect_uri.")
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
	clientID := body["client_id"]
	clientSecret := body["client_secret"]
	applyBasicCredentials(c.Request, &clientID, &clientSecret)
	switch body["grant_type"] {
	case "authorization_code":
		s.handleAuthorizationCodeToken(c, body, clientID, clientSecret)
	case "refresh_token":
		s.handleRefreshToken(c, body, clientID, clientSecret)
	default:
		writeOAuthError(c, http.StatusBadRequest, "unsupported_grant_type", "Only authorization_code and refresh_token are supported.")
	}
}

func (s *Service) handleAuthorizationCodeToken(c *corehttp.Context, body map[string]string, clientID string, clientSecret string) {
	if !s.validateClient(c, clientID, clientSecret) {
		return
	}
	code := firstRecord(s.store.OAuthCodes.FindBy("code", body["code"]))
	if code == nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "Invalid authorization code.")
		return
	}
	if time.Now().UnixMilli()-int64(intField(code, "created_at_ms")) > pendingCodeTTL.Milliseconds() {
		s.store.OAuthCodes.Delete(intField(code, "id"))
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "Authorization code expired.")
		return
	}
	if redirect := stringField(code, "redirect_uri"); redirect != "" && body["redirect_uri"] != "" && body["redirect_uri"] != redirect {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "redirect_uri does not match authorization request.")
		return
	}
	if stringField(code, "client_id") != "" && stringField(code, "client_id") != clientID {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "client_id does not match authorization request.")
		return
	}
	if !verifyCodeChallenge(body["code_verifier"], stringField(code, "code_challenge"), stringField(code, "code_challenge_method")) {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "Invalid code_verifier.")
		return
	}
	user := firstRecord(s.store.Users.FindBy("email", stringField(code, "email")))
	if user == nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "User not found.")
		return
	}
	s.store.OAuthCodes.Delete(intField(code, "id"))
	accessToken := "google_" + generateHex(16)
	refreshToken := "google_refresh_" + generateHex(16)
	scope := stringField(code, "scope")
	s.store.AccessTokens.Insert(corestore.Record{
		"token":     accessToken,
		"email":     stringField(user, "email"),
		"scope":     normalizeScope(scope),
		"client_id": clientID,
	})
	s.store.RefreshTokens.Insert(corestore.Record{
		"token":     refreshToken,
		"email":     stringField(user, "email"),
		"scope":     normalizeScope(scope),
		"client_id": clientID,
	})
	response := map[string]any{
		"access_token":  accessToken,
		"expires_in":    3600,
		"refresh_token": refreshToken,
		"scope":         normalizeScope(scope),
		"token_type":    "Bearer",
	}
	if strings.Contains(" "+scope+" ", " openid ") {
		idToken, err := signIDToken(user, clientID, stringField(code, "nonce"), s.baseURL)
		if err != nil {
			writeOAuthError(c, http.StatusInternalServerError, "server_error", "Failed to sign ID token.")
			return
		}
		response["id_token"] = idToken
	}
	c.JSON(http.StatusOK, response)
}

func (s *Service) handleRefreshToken(c *corehttp.Context, body map[string]string, clientID string, clientSecret string) {
	if !s.validateClient(c, clientID, clientSecret) {
		return
	}
	stored := firstRecord(s.store.RefreshTokens.FindBy("token", body["refresh_token"]))
	if stored == nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "Invalid refresh token.")
		return
	}
	if storedClientID := stringField(stored, "client_id"); storedClientID != "" && storedClientID != clientID {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "Refresh token was issued to a different client.")
		return
	}
	accessToken := "google_" + generateHex(16)
	s.store.AccessTokens.Insert(corestore.Record{
		"token":     accessToken,
		"email":     stringField(stored, "email"),
		"scope":     stringField(stored, "scope"),
		"client_id": clientID,
	})
	c.JSON(http.StatusOK, map[string]any{
		"access_token": accessToken,
		"expires_in":   3600,
		"scope":        stringField(stored, "scope"),
		"token_type":   "Bearer",
	})
}

func (s *Service) handleRevoke(c *corehttp.Context) {
	body, _ := parseTokenBody(c.Request)
	token := body["token"]
	for _, record := range s.store.AccessTokens.FindBy("token", token) {
		s.store.AccessTokens.Delete(intField(record, "id"))
	}
	for _, record := range s.store.RefreshTokens.FindBy("token", token) {
		s.store.RefreshTokens.Delete(intField(record, "id"))
	}
	c.Writer.WriteHeader(http.StatusOK)
}

func (s *Service) handleUserinfo(c *corehttp.Context) {
	email, ok := s.authenticatedEmail(c)
	if !ok {
		return
	}
	user := firstRecord(s.store.Users.FindBy("email", email))
	if user == nil {
		googleAPIError(c, http.StatusUnauthorized, "Request had invalid authentication credentials.", "authError", "UNAUTHENTICATED")
		return
	}
	body := map[string]any{
		"sub":            stringField(user, "uid"),
		"email":          stringField(user, "email"),
		"email_verified": boolField(user, "email_verified"),
		"name":           stringField(user, "name"),
		"given_name":     stringField(user, "given_name"),
		"family_name":    stringField(user, "family_name"),
		"picture":        user["picture"],
		"locale":         stringField(user, "locale"),
	}
	if hd := stringField(user, "hd"); hd != "" {
		body["hd"] = hd
	}
	c.JSON(http.StatusOK, body)
}

func (s *Service) handleTokeninfo(c *corehttp.Context) {
	token := c.Query("access_token")
	if token == "" {
		token = c.Query("id_token")
	}
	if token == "" {
		body, _ := parseTokenBody(c.Request)
		token = firstNonEmpty(body["access_token"], body["id_token"])
	}
	record := firstRecord(s.store.AccessTokens.FindBy("token", token))
	if record == nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_token", "Invalid token.")
		return
	}
	c.JSON(http.StatusOK, map[string]any{
		"aud":            stringField(record, "client_id"),
		"scope":          stringField(record, "scope"),
		"email":          stringField(record, "email"),
		"email_verified": "true",
		"expires_in":     3600,
	})
}

func writeOAuthError(c *corehttp.Context, status int, code string, description string) {
	c.JSON(status, map[string]any{"error": code, "error_description": description})
}
