package clerk

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
	router.Get("/v1/jwks", s.handleJWKS)
	router.Get("/oauth/authorize", s.handleAuthorize)
	router.Post("/oauth/authorize/callback", s.handleAuthorizeCallback)
	router.Post("/oauth/token", s.handleToken)
	router.Get("/oauth/userinfo", s.handleUserinfo)
}

func (s *Service) handleOpenIDConfiguration(c *corehttp.Context) {
	c.JSON(http.StatusOK, map[string]any{
		"issuer":                                s.baseURL,
		"authorization_endpoint":                s.baseURL + "/oauth/authorize",
		"token_endpoint":                        s.baseURL + "/oauth/token",
		"userinfo_endpoint":                     s.baseURL + "/oauth/userinfo",
		"jwks_uri":                              s.baseURL + "/v1/jwks",
		"response_types_supported":              []string{"code"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"scopes_supported":                      []string{"openid", "profile", "email"},
		"token_endpoint_auth_methods_supported": []string{"client_secret_post", "client_secret_basic"},
		"claims_supported":                      []string{"sub", "iss", "aud", "exp", "iat", "nbf", "azp", "sid", "org_id", "org_role", "org_slug", "org_permissions"},
		"code_challenge_methods_supported":      []string{"plain", "S256"},
	})
}

func (s *Service) handleJWKS(c *corehttp.Context) {
	c.JSON(http.StatusOK, clerkSigner.jwks())
}

func (s *Service) handleAuthorize(c *corehttp.Context) {
	clientID := c.Query("client_id")
	redirectURI := c.Query("redirect_uri")
	scope := firstNonEmpty(c.Query("scope"), "openid profile email")
	state := c.Query("state")
	nonce := c.Query("nonce")
	responseType := firstNonEmpty(c.Query("response_type"), "code")
	codeChallenge := c.Query("code_challenge")
	codeChallengeMethod := c.Query("code_challenge_method")

	if responseType != "code" {
		c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Unsupported response_type", "Only response_type=code is supported.", ui.PageOptions{Service: serviceLabel}))
		return
	}
	if redirectURI == "" {
		c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Missing redirect URI", "The redirect_uri parameter is required.", ui.PageOptions{Service: serviceLabel}))
		return
	}

	appName := ""
	if s.store.OAuthApps.Count() > 0 {
		app := firstRecord(s.store.OAuthApps.FindBy("client_id", clientID))
		if app == nil {
			c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Application not found", "The client_id '"+clientID+"' is not registered.", ui.PageOptions{Service: serviceLabel}))
			return
		}
		if !matchesRedirectURI(redirectURI, stringSliceValue(app["redirect_uris"])) {
			c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", ui.PageOptions{Service: serviceLabel}))
			return
		}
		appName = stringField(app, "name")
	}

	users := s.store.Users.All()
	var body strings.Builder
	if len(users) == 0 {
		body.WriteString(`<p class="empty">No users in the emulator store.</p>`)
	} else {
		for _, user := range users {
			emails := s.store.EmailAddresses.FindBy("user_id", stringField(user, "clerk_id"))
			primary := primaryEmail(emails)
			login := firstNonEmpty(stringField(primary, "email_address"), stringField(user, "username"), stringField(user, "clerk_id"))
			letter := "?"
			if source := firstNonEmpty(stringField(user, "first_name"), stringField(user, "username"), login); source != "" {
				letter = strings.ToUpper(source[:1])
			}
			body.WriteString(ui.RenderUserButton(ui.UserButtonOptions{
				Letter:     letter,
				Login:      login,
				Name:       userDisplayName(user),
				Email:      stringField(primary, "email_address"),
				FormAction: "/oauth/authorize/callback",
				HiddenFields: map[string]string{
					"user_ref":              stringField(user, "clerk_id"),
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

	subtitle := "Choose a seeded user to continue."
	if appName != "" {
		subtitle = "Sign in to <strong>" + ui.EscapeHTML(appName) + "</strong> with your Clerk account."
	}
	c.HTML(http.StatusOK, ui.RenderCardPage("Sign in with Clerk", subtitle, body.String(), ui.PageOptions{Service: serviceLabel}))
}

func (s *Service) handleAuthorizeCallback(c *corehttp.Context) {
	if err := c.Request.ParseForm(); err != nil {
		c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Invalid request", "The authorization form body is invalid.", ui.PageOptions{Service: serviceLabel}))
		return
	}
	userRef := c.Request.Form.Get("user_ref")
	redirectURI := c.Request.Form.Get("redirect_uri")
	scope := firstNonEmpty(c.Request.Form.Get("scope"), "openid profile email")
	state := c.Request.Form.Get("state")
	nonce := c.Request.Form.Get("nonce")
	clientID := c.Request.Form.Get("client_id")
	codeChallenge := c.Request.Form.Get("code_challenge")
	codeChallengeMethod := c.Request.Form.Get("code_challenge_method")

	if redirectURI == "" {
		c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Missing redirect URI", "The redirect_uri parameter is required.", ui.PageOptions{Service: serviceLabel}))
		return
	}
	user := firstRecord(s.store.Users.FindBy("clerk_id", userRef))
	if user == nil {
		c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Unknown user", "The selected user is not available.", ui.PageOptions{Service: serviceLabel}))
		return
	}
	if s.store.OAuthApps.Count() > 0 {
		app := firstRecord(s.store.OAuthApps.FindBy("client_id", clientID))
		if app == nil {
			c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Application not found", "The client_id '"+clientID+"' is not registered.", ui.PageOptions{Service: serviceLabel}))
			return
		}
		if !matchesRedirectURI(redirectURI, stringSliceValue(app["redirect_uris"])) {
			c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", ui.PageOptions{Service: serviceLabel}))
			return
		}
	}
	target, err := url.Parse(redirectURI)
	if err != nil || target == nil || target.Scheme == "" {
		c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Invalid redirect URI", "The redirect_uri parameter is invalid.", ui.PageOptions{Service: serviceLabel}))
		return
	}
	code := clerkToken("")
	s.store.OAuthCodes.Insert(corestore.Record{
		"code":                  code,
		"user_id":               stringField(user, "clerk_id"),
		"scope":                 scope,
		"redirect_uri":          redirectURI,
		"client_id":             clientID,
		"nonce":                 nonce,
		"code_challenge":        codeChallenge,
		"code_challenge_method": codeChallengeMethod,
		"created_at_ms":         time.Now().UnixMilli(),
	})

	query := target.Query()
	query.Set("code", code)
	if state != "" {
		query.Set("state", state)
	}
	target.RawQuery = query.Encode()
	c.Redirect(http.StatusFound, target.String())
}

func (s *Service) handleToken(c *corehttp.Context) {
	body := parseTokenBody(c.Request)
	grantType := body["grant_type"]
	code := body["code"]
	redirectURI := body["redirect_uri"]
	codeVerifier := body["code_verifier"]
	clientID := body["client_id"]
	clientSecret := body["client_secret"]
	applyBasicCredentials(c.Request, &clientID, &clientSecret)

	if grantType != "authorization_code" {
		oauthError(c, http.StatusBadRequest, "unsupported_grant_type", "Only authorization_code is supported.")
		return
	}

	pending := firstRecord(s.store.OAuthCodes.FindBy("code", code))
	if pending == nil || time.Since(time.UnixMilli(int64Field(pending, "created_at_ms"))) > pendingCodeTTL {
		if pending != nil {
			s.deleteOAuthCode(code)
		}
		oauthError(c, http.StatusBadRequest, "invalid_grant", "Authorization code is invalid or expired.")
		return
	}
	if redirectURI != "" && redirectURI != stringField(pending, "redirect_uri") {
		oauthError(c, http.StatusBadRequest, "invalid_grant", "redirect_uri does not match.")
		return
	}
	if pendingClient := stringField(pending, "client_id"); pendingClient != "" && clientID != "" && clientID != pendingClient {
		oauthError(c, http.StatusBadRequest, "invalid_grant", "client_id does not match.")
		return
	}
	if s.store.OAuthApps.Count() > 0 {
		app := firstRecord(s.store.OAuthApps.FindBy("client_id", clientID))
		if app == nil {
			oauthError(c, http.StatusUnauthorized, "invalid_client", "Unknown client.")
			return
		}
		if !boolField(app, "is_public") && !constantTimeEqual(stringField(app, "client_secret"), clientSecret) {
			oauthError(c, http.StatusUnauthorized, "invalid_client", "Invalid client credentials.")
			return
		}
	}
	if !verifyPKCE(stringField(pending, "code_challenge"), stringField(pending, "code_challenge_method"), codeVerifier) {
		oauthError(c, http.StatusBadRequest, "invalid_grant", "PKCE verification failed.")
		return
	}

	user := firstRecord(s.store.Users.FindBy("clerk_id", stringField(pending, "user_id")))
	if user == nil {
		oauthError(c, http.StatusBadRequest, "invalid_grant", "Unknown user.")
		return
	}
	s.deleteOAuthCode(code)
	now := nowUnix()
	sessionID := clerkID("sess_")
	s.store.Sessions.Insert(corestore.Record{
		"clerk_id":        sessionID,
		"user_id":         stringField(user, "clerk_id"),
		"client_id":       firstNonEmpty(clientID, "default"),
		"status":          "active",
		"last_active_at":  now,
		"expire_at":       now + 86400,
		"abandon_at":      now + 604800,
		"created_at_unix": now,
		"updated_at_unix": now,
	})
	accessToken := clerkToken("clerk_")
	scope := stringField(pending, "scope")
	s.store.AccessTokens.Insert(corestore.Record{
		"token":           accessToken,
		"user_id":         stringField(user, "clerk_id"),
		"session_id":      sessionID,
		"client_id":       firstNonEmpty(clientID, "default"),
		"scope":           scope,
		"created_at_unix": now,
		"expires_at":      now + 3600,
	})
	emails := s.store.EmailAddresses.FindBy("user_id", stringField(user, "clerk_id"))
	idToken, err := createIDToken(user, emails, sessionID, firstNonEmpty(clientID, "default"), s.baseURL, stringField(pending, "nonce"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, map[string]any{"message": "Failed to sign ID token"})
		return
	}
	c.JSON(http.StatusOK, map[string]any{
		"token_type":   "Bearer",
		"expires_in":   3600,
		"access_token": accessToken,
		"id_token":     idToken,
		"scope":        scope,
	})
}

func (s *Service) handleUserinfo(c *corehttp.Context) {
	token := tokenFromRequest(c.Request)
	accessToken := firstRecord(s.store.AccessTokens.FindBy("token", token))
	if accessToken == nil {
		oauthError(c, http.StatusUnauthorized, "invalid_token", "The access token is invalid.")
		return
	}
	user := firstRecord(s.store.Users.FindBy("clerk_id", stringField(accessToken, "user_id")))
	if user == nil {
		oauthError(c, http.StatusUnauthorized, "invalid_token", "User not found.")
		return
	}
	emails := s.store.EmailAddresses.FindBy("user_id", stringField(user, "clerk_id"))
	primary := primaryEmail(emails)
	c.JSON(http.StatusOK, map[string]any{
		"sub":            stringField(user, "clerk_id"),
		"name":           userDisplayName(user),
		"email":          nilString(primary, "email_address"),
		"email_verified": stringField(primary, "verification_status") == "verified",
		"picture":        nilString(user, "image_url"),
	})
}

func (s *Service) deleteOAuthCode(code string) {
	for _, row := range s.store.OAuthCodes.FindBy("code", code) {
		s.store.OAuthCodes.Delete(intField(row, "id"))
	}
}
