package apple

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/core/ui"
)

const pendingCodeTTL = 5 * time.Minute

func (s *Service) registerOAuthRoutes(router *corehttp.Router) {
	router.Get("/.well-known/openid-configuration", s.handleOpenIDConfiguration)
	router.Get("/auth/keys", s.handleKeys)
	router.Get("/auth/authorize", s.handleAuthorize)
	router.Post("/auth/authorize/callback", s.handleAuthorizeCallback)
	router.Post("/auth/token", s.handleToken)
	router.Post("/auth/revoke", s.handleRevoke)
}

func (s *Service) handleOpenIDConfiguration(c *corehttp.Context) {
	c.JSON(http.StatusOK, map[string]any{
		"issuer":                                s.baseURL,
		"authorization_endpoint":                s.baseURL + "/auth/authorize",
		"token_endpoint":                        s.baseURL + "/auth/token",
		"revocation_endpoint":                   s.baseURL + "/auth/revoke",
		"jwks_uri":                              s.baseURL + "/auth/keys",
		"response_types_supported":              []string{"code"},
		"response_modes_supported":              []string{"query", "fragment", "form_post"},
		"subject_types_supported":               []string{"pairwise"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"scopes_supported":                      []string{"openid", "email", "name"},
		"code_challenge_methods_supported":      []string{"plain", "S256"},
		"token_endpoint_auth_methods_supported": []string{"client_secret_post"},
		"claims_supported": []string{
			"aud",
			"email",
			"email_verified",
			"exp",
			"iat",
			"is_private_email",
			"iss",
			"nonce",
			"nonce_supported",
			"real_user_status",
			"sub",
			"transfer_sub",
		},
	})
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
		subtitle = "Sign in to <strong>" + ui.EscapeHTML(clientName) + "</strong> with your Apple ID."
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
				FormAction: "/auth/authorize/callback",
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
	c.HTML(http.StatusOK, ui.RenderCardPage("Sign in with Apple", subtitle, body.String(), ui.PageOptions{Service: serviceLabel}))
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
			writeOAuthError(c, http.StatusBadRequest, "invalid_client", "Application not found.")
			return
		}
		if redirectURI != "" && !matchesRedirectURI(redirectURI, stringSliceValue(client["redirect_uris"])) {
			writeOAuthError(c, http.StatusBadRequest, "invalid_request", "Redirect URI mismatch.")
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
		"response_mode":         responseMode,
		"code_challenge":        codeChallenge,
		"code_challenge_method": codeChallengeMethod,
		"created_at_ms":         time.Now().UnixMilli(),
	})

	userJSON := ""
	pairKey := email + ":" + clientID
	if firstRecord(s.store.FirstAuth.FindBy("pair_key", pairKey)) == nil {
		s.store.FirstAuth.Insert(corestore.Record{"pair_key": pairKey})
		if user := firstRecord(s.store.Users.FindBy("email", email)); user != nil {
			raw, _ := json.Marshal(map[string]any{
				"name": map[string]string{
					"firstName": stringField(user, "given_name"),
					"lastName":  stringField(user, "family_name"),
				},
				"email": appleEmailForUser(user),
			})
			userJSON = string(raw)
		}
	}

	if responseMode == "form_post" {
		fields := map[string]string{"code": code, "state": state}
		if userJSON != "" {
			fields["user"] = userJSON
		}
		c.HTML(http.StatusOK, ui.RenderFormPostPage(redirectURI, fields, ui.PageOptions{Service: serviceLabel}))
		return
	}

	target, err := url.Parse(redirectURI)
	if err != nil || target == nil || target.Scheme == "" {
		writeOAuthError(c, http.StatusBadRequest, "invalid_request", "Invalid redirect_uri.")
		return
	}
	if responseMode == "fragment" {
		fragment, _ := url.ParseQuery(target.Fragment)
		addAuthorizationResponseValues(fragment, code, state, userJSON)
		target.Fragment = fragment.Encode()
		target.RawFragment = ""
		c.Redirect(http.StatusFound, target.String())
		return
	}
	query := target.Query()
	addAuthorizationResponseValues(query, code, state, userJSON)
	target.RawQuery = query.Encode()
	c.Redirect(http.StatusFound, target.String())
}

func (s *Service) handleToken(c *corehttp.Context) {
	if err := c.Request.ParseForm(); err != nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_request", "Invalid form body.")
		return
	}
	grantType := c.Request.Form.Get("grant_type")
	switch grantType {
	case "authorization_code":
		s.handleAuthorizationCodeToken(c)
	case "refresh_token":
		s.handleRefreshToken(c)
	default:
		writeOAuthError(c, http.StatusBadRequest, "unsupported_grant_type", "Only authorization_code and refresh_token are supported.")
	}
}

func (s *Service) handleAuthorizationCodeToken(c *corehttp.Context) {
	code := c.Request.Form.Get("code")
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
	clientID := c.Request.Form.Get("client_id")
	redirectURI := c.Request.Form.Get("redirect_uri")
	if pendingClientID := stringField(pending, "client_id"); pendingClientID != "" && clientID != pendingClientID {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "The code is incorrect or expired.")
		return
	}
	if pendingRedirectURI := stringField(pending, "redirect_uri"); pendingRedirectURI != "" && redirectURI != "" && redirectURI != pendingRedirectURI {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "The code is incorrect or expired.")
		return
	}
	if !verifyPKCEChallenge(stringField(pending, "code_challenge"), stringField(pending, "code_challenge_method"), c.Request.Form.Get("code_verifier")) {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "The code is incorrect or expired.")
		return
	}
	s.deleteOAuthCode(code)

	user := firstRecord(s.store.Users.FindBy("email", stringField(pending, "email")))
	if user == nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "User not found.")
		return
	}

	refreshToken := generateToken("r_apple_")
	s.store.RefreshTokens.Insert(corestore.Record{
		"token":     refreshToken,
		"email":     stringField(user, "email"),
		"client_id": stringField(pending, "client_id"),
		"scope":     stringField(pending, "scope"),
		"nonce":     stringField(pending, "nonce"),
	})
	idToken, err := createIDToken(user, stringField(pending, "client_id"), stringField(pending, "nonce"), s.baseURL)
	if err != nil {
		writeOAuthError(c, http.StatusInternalServerError, "server_error", "Failed to sign id_token.")
		return
	}
	c.JSON(http.StatusOK, map[string]any{
		"access_token":  generateToken("apple_"),
		"token_type":    "Bearer",
		"expires_in":    3600,
		"refresh_token": refreshToken,
		"id_token":      idToken,
	})
}

func (s *Service) handleRefreshToken(c *corehttp.Context) {
	refreshToken := c.Request.Form.Get("refresh_token")
	stored := firstRecord(s.store.RefreshTokens.FindBy("token", refreshToken))
	if stored == nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "The refresh_token is invalid.")
		return
	}
	user := firstRecord(s.store.Users.FindBy("email", stringField(stored, "email")))
	if user == nil {
		writeOAuthError(c, http.StatusBadRequest, "invalid_grant", "User not found.")
		return
	}
	clientID := stringField(stored, "client_id")
	if clientID == "" {
		clientID = c.Request.Form.Get("client_id")
	}
	idToken, err := createIDToken(user, clientID, stringField(stored, "nonce"), s.baseURL)
	if err != nil {
		writeOAuthError(c, http.StatusInternalServerError, "server_error", "Failed to sign id_token.")
		return
	}
	c.JSON(http.StatusOK, map[string]any{
		"access_token": generateToken("apple_"),
		"token_type":   "Bearer",
		"expires_in":   3600,
		"id_token":     idToken,
	})
}

func (s *Service) handleRevoke(c *corehttp.Context) {
	if err := c.Request.ParseForm(); err == nil {
		s.deleteRefreshToken(c.Request.Form.Get("token"))
	}
	c.Writer.WriteHeader(http.StatusOK)
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

func pendingCodeCreatedAt(row corestore.Record) time.Time {
	millis := intField(row, "created_at_ms")
	if millis == 0 {
		return time.Now()
	}
	return time.UnixMilli(int64(millis))
}

func addAuthorizationResponseValues(values url.Values, code string, state string, userJSON string) {
	values.Set("code", code)
	if state != "" {
		values.Set("state", state)
	}
	if userJSON != "" {
		values.Set("user", userJSON)
	}
}

func writeOAuthError(c *corehttp.Context, status int, code string, description string) {
	c.JSON(status, map[string]any{
		"error":             code,
		"error_description": description,
	})
}
