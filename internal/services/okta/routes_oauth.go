package okta

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

type resolvedAuthServer struct {
	id        string
	issuer    string
	audiences []string
}

func (s *Service) registerOAuthRoutes(router *corehttp.Router) {
	router.Get("/.well-known/openid-configuration", s.handleOrgOpenIDConfiguration)
	router.Get("/oauth2/:authServerId/.well-known/openid-configuration", s.handleAuthServerOpenIDConfiguration)
	router.Get("/oauth2/v1/keys", s.handleOrgKeys)
	router.Get("/oauth2/:authServerId/v1/keys", s.handleAuthServerKeys)
	router.Get("/oauth2/v1/authorize", s.handleOrgAuthorize)
	router.Get("/oauth2/:authServerId/v1/authorize", s.handleAuthServerAuthorize)
	router.Post("/oauth2/v1/authorize/callback", s.handleOrgAuthorizeCallback)
	router.Post("/oauth2/:authServerId/v1/authorize/callback", s.handleAuthServerAuthorizeCallback)
	router.Post("/oauth2/v1/token", s.handleOrgToken)
	router.Post("/oauth2/:authServerId/v1/token", s.handleAuthServerToken)
	router.Get("/oauth2/v1/userinfo", s.handleOrgUserinfo)
	router.Get("/oauth2/:authServerId/v1/userinfo", s.handleAuthServerUserinfo)
	router.Post("/oauth2/v1/revoke", s.handleOrgRevoke)
	router.Post("/oauth2/:authServerId/v1/revoke", s.handleAuthServerRevoke)
	router.Post("/oauth2/v1/introspect", s.handleOrgIntrospect)
	router.Post("/oauth2/:authServerId/v1/introspect", s.handleAuthServerIntrospect)
	router.Get("/oauth2/v1/logout", s.handleOrgLogout)
	router.Get("/oauth2/:authServerId/v1/logout", s.handleAuthServerLogout)
}

func (s *Service) handleOrgOpenIDConfiguration(c *corehttp.Context) {
	s.handleOpenIDConfiguration(c, orgAuthServerID)
}

func (s *Service) handleAuthServerOpenIDConfiguration(c *corehttp.Context) {
	s.handleOpenIDConfiguration(c, c.Param("authServerId"))
}

func (s *Service) handleOpenIDConfiguration(c *corehttp.Context, authServerID string) {
	server := s.resolveAuthServer(authServerID)
	if server == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: authorization server '"+authServerID+"'")
		return
	}
	oauthBase := oauthBasePath(server.id)
	oauthURLBase := s.baseURL + oauthBase
	authMethods := []string{"client_secret_post", "client_secret_basic", "none"}
	c.JSON(http.StatusOK, map[string]any{
		"issuer":                                        server.issuer,
		"authorization_endpoint":                        oauthURLBase + "/authorize",
		"token_endpoint":                                oauthURLBase + "/token",
		"userinfo_endpoint":                             oauthURLBase + "/userinfo",
		"jwks_uri":                                      oauthURLBase + "/keys",
		"end_session_endpoint":                          oauthURLBase + "/logout",
		"revocation_endpoint":                           oauthURLBase + "/revoke",
		"introspection_endpoint":                        oauthURLBase + "/introspect",
		"registration_endpoint":                         oauthURLBase + "/clients",
		"response_types_supported":                      []string{"code"},
		"response_modes_supported":                      []string{"query", "fragment", "form_post"},
		"grant_types_supported":                         []string{"authorization_code", "refresh_token", "client_credentials"},
		"subject_types_supported":                       []string{"public"},
		"id_token_signing_alg_values_supported":         []string{"RS256"},
		"scopes_supported":                              []string{"openid", "profile", "email", "offline_access", "groups"},
		"token_endpoint_auth_methods_supported":         authMethods,
		"revocation_endpoint_auth_methods_supported":    authMethods,
		"introspection_endpoint_auth_methods_supported": authMethods,
		"request_parameter_supported":                   false,
		"request_uri_parameter_supported":               false,
		"claims_parameter_supported":                    false,
		"request_object_signing_alg_values_supported":   []string{"RS256"},
		"code_challenge_methods_supported":              []string{"plain", "S256"},
		"claims_supported":                              []string{"sub", "iss", "aud", "exp", "iat", "auth_time", "nonce", "name", "preferred_username", "email", "email_verified", "locale", "zoneinfo", "groups"},
	})
}

func (s *Service) handleOrgKeys(c *corehttp.Context) {
	c.JSON(http.StatusOK, oktaSigner.jwks())
}

func (s *Service) handleAuthServerKeys(c *corehttp.Context) {
	authServerID := c.Param("authServerId")
	if s.resolveAuthServer(authServerID) == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: authorization server '"+authServerID+"'")
		return
	}
	c.JSON(http.StatusOK, oktaSigner.jwks())
}

func (s *Service) handleOrgAuthorize(c *corehttp.Context) {
	s.handleAuthorize(c, orgAuthServerID)
}

func (s *Service) handleAuthServerAuthorize(c *corehttp.Context) {
	s.handleAuthorize(c, c.Param("authServerId"))
}

func (s *Service) handleAuthorize(c *corehttp.Context, authServerID string) {
	if s.resolveAuthServer(authServerID) == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: authorization server '"+authServerID+"'")
		return
	}
	clientID := c.Query("client_id")
	redirectURI := c.Query("redirect_uri")
	scope := firstNonEmpty(c.Query("scope"), "openid profile email")
	state := c.Query("state")
	nonce := c.Query("nonce")
	responseMode := firstNonEmpty(c.Query("response_mode"), "query")
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

	clientName := ""
	configuredClients := s.clientsForServer(authServerID)
	if len(configuredClients) > 0 {
		client := recordWithField(configuredClients, "client_id", clientID)
		if client == nil {
			c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Application not found", "The client_id '"+clientID+"' is not registered.", ui.PageOptions{Service: serviceLabel}))
			return
		}
		if !matchesRedirectURI(redirectURI, stringSliceValue(client["redirect_uris"])) {
			c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", ui.PageOptions{Service: serviceLabel}))
			return
		}
		clientName = stringField(client, "name")
	}

	var body strings.Builder
	users := s.store.Users.All()
	if len(users) == 0 {
		body.WriteString(`<p class="empty">No users in the emulator store.</p>`)
	} else {
		for _, user := range users {
			login := stringField(user, "login")
			letter := "?"
			if login != "" {
				letter = strings.ToUpper(login[:1])
			}
			body.WriteString(ui.RenderUserButton(ui.UserButtonOptions{
				Letter:     letter,
				Login:      login,
				Name:       userDisplayName(user),
				Email:      stringField(user, "email"),
				FormAction: oauthBasePath(authServerID) + "/authorize/callback",
				HiddenFields: map[string]string{
					"user_ref":              stringField(user, "okta_id"),
					"redirect_uri":          redirectURI,
					"scope":                 scope,
					"state":                 state,
					"nonce":                 nonce,
					"client_id":             clientID,
					"response_mode":         responseMode,
					"code_challenge":        codeChallenge,
					"code_challenge_method": codeChallengeMethod,
					"auth_server_id":        authServerID,
				},
			}))
		}
	}

	subtitle := "Choose a seeded user to continue."
	if clientName != "" {
		subtitle = "Sign in to <strong>" + ui.EscapeHTML(clientName) + "</strong> with your Okta account."
	}
	c.HTML(http.StatusOK, ui.RenderCardPage("Sign in with Okta", subtitle, body.String(), ui.PageOptions{Service: serviceLabel}))
}

func (s *Service) handleOrgAuthorizeCallback(c *corehttp.Context) {
	s.handleAuthorizeCallback(c, orgAuthServerID)
}

func (s *Service) handleAuthServerAuthorizeCallback(c *corehttp.Context) {
	s.handleAuthorizeCallback(c, c.Param("authServerId"))
}

func (s *Service) handleAuthorizeCallback(c *corehttp.Context, authServerID string) {
	if s.resolveAuthServer(authServerID) == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: authorization server '"+authServerID+"'")
		return
	}
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
	responseMode := firstNonEmpty(c.Request.Form.Get("response_mode"), "query")
	codeChallenge := c.Request.Form.Get("code_challenge")
	codeChallengeMethod := c.Request.Form.Get("code_challenge_method")

	if redirectURI == "" {
		c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Missing redirect URI", "The redirect_uri parameter is required.", ui.PageOptions{Service: serviceLabel}))
		return
	}
	user := s.findUser(userRef)
	if user == nil {
		c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Unknown user", "The selected user is not available.", ui.PageOptions{Service: serviceLabel}))
		return
	}
	configuredClients := s.clientsForServer(authServerID)
	if len(configuredClients) > 0 {
		client := recordWithField(configuredClients, "client_id", clientID)
		if client == nil {
			c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Application not found", "The client_id '"+clientID+"' is not registered.", ui.PageOptions{Service: serviceLabel}))
			return
		}
		if !matchesRedirectURI(redirectURI, stringSliceValue(client["redirect_uris"])) {
			c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", ui.PageOptions{Service: serviceLabel}))
			return
		}
	}

	code := oktaToken("")
	s.store.OAuthCodes.Insert(corestore.Record{
		"code":                  code,
		"user_okta_id":          stringField(user, "okta_id"),
		"scope":                 scope,
		"redirect_uri":          redirectURI,
		"client_id":             clientID,
		"nonce":                 nonce,
		"code_challenge":        codeChallenge,
		"code_challenge_method": codeChallengeMethod,
		"auth_server_id":        authServerID,
		"created_at_ms":         time.Now().UnixMilli(),
	})

	if responseMode == "form_post" {
		c.HTML(http.StatusOK, ui.RenderFormPostPage(redirectURI, map[string]string{"code": code, "state": state}, ui.PageOptions{Service: serviceLabel}))
		return
	}
	target, err := url.Parse(redirectURI)
	if err != nil || target == nil || target.Scheme == "" {
		c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Invalid redirect URI", "The redirect_uri parameter is invalid.", ui.PageOptions{Service: serviceLabel}))
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

func (s *Service) handleOrgToken(c *corehttp.Context) {
	s.handleToken(c, orgAuthServerID)
}

func (s *Service) handleAuthServerToken(c *corehttp.Context) {
	s.handleToken(c, c.Param("authServerId"))
}

func (s *Service) handleToken(c *corehttp.Context, authServerID string) {
	server := s.resolveAuthServer(authServerID)
	if server == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: authorization server '"+authServerID+"'")
		return
	}
	body := parseTokenBody(c.Request)
	clientID := body["client_id"]
	clientSecret := body["client_secret"]
	applyBasicCredentials(c.Request, &clientID, &clientSecret)
	client, ok := s.validateClient(c, authServerID, clientID, clientSecret)
	if !ok {
		return
	}

	switch body["grant_type"] {
	case "authorization_code":
		s.handleAuthorizationCodeToken(c, server, body, clientID, client)
	case "refresh_token":
		s.handleRefreshToken(c, server, body, client)
	case "client_credentials":
		s.handleClientCredentialsToken(c, server, body, clientID, client)
	default:
		oauthError(c, http.StatusBadRequest, "unsupported_grant_type", "Only authorization_code, refresh_token, and client_credentials are supported.")
	}
}

func (s *Service) handleAuthorizationCodeToken(c *corehttp.Context, server *resolvedAuthServer, body map[string]string, clientID string, client corestore.Record) {
	code := firstRecord(s.store.OAuthCodes.FindBy("code", body["code"]))
	if code == nil {
		oauthError(c, http.StatusBadRequest, "invalid_grant", "Authorization code is invalid or expired.")
		return
	}
	if stringField(code, "auth_server_id") != server.id {
		oauthError(c, http.StatusBadRequest, "invalid_grant", "Authorization server mismatch.")
		return
	}
	if time.Since(time.UnixMilli(int64(intField(code, "created_at_ms")))) > pendingCodeTTL {
		s.deleteOAuthCode(stringField(code, "code"))
		oauthError(c, http.StatusBadRequest, "invalid_grant", "Authorization code is invalid or expired.")
		return
	}
	if redirectURI := stringField(code, "redirect_uri"); redirectURI != "" && body["redirect_uri"] != "" && body["redirect_uri"] != redirectURI {
		oauthError(c, http.StatusBadRequest, "invalid_grant", "redirect_uri does not match.")
		return
	}
	if client != nil && stringField(client, "client_id") != stringField(code, "client_id") {
		oauthError(c, http.StatusBadRequest, "invalid_grant", "Authorization code was not issued to this client.")
		return
	}
	if !verifyPKCE(stringField(code, "code_challenge"), stringField(code, "code_challenge_method"), body["code_verifier"]) {
		oauthError(c, http.StatusBadRequest, "invalid_grant", "PKCE verification failed.")
		return
	}
	user := firstRecord(s.store.Users.FindBy("okta_id", stringField(code, "user_okta_id")))
	if user == nil {
		oauthError(c, http.StatusBadRequest, "invalid_grant", "Unknown user.")
		return
	}
	s.deleteOAuthCode(stringField(code, "code"))

	now := time.Now().Unix()
	scope := firstNonEmpty(stringField(code, "scope"), "openid profile email")
	audienceClient := firstNonEmpty(stringField(code, "client_id"), clientID, "okta-client")
	accessToken := oktaToken("okta_")
	refreshToken := oktaToken("r_okta_")
	s.store.AccessTokens.Insert(corestore.Record{
		"token":          accessToken,
		"auth_server_id": server.id,
		"client_id":      audienceClient,
		"scope":          scope,
		"issued_at":      now,
		"expires_at":     now + 3600,
		"user_okta_id":   stringField(user, "okta_id"),
		"username":       stringField(user, "login"),
	})
	s.store.RefreshTokens.Insert(corestore.Record{
		"token":          refreshToken,
		"auth_server_id": server.id,
		"client_id":      audienceClient,
		"scope":          scope,
		"user_okta_id":   stringField(user, "okta_id"),
		"username":       stringField(user, "login"),
		"nonce":          stringField(code, "nonce"),
	})
	idToken, err := createIDToken(s.store, user, audienceClient, stringField(code, "nonce"), server.issuer, scope)
	if err != nil {
		oauthError(c, http.StatusInternalServerError, "server_error", "Failed to sign id_token.")
		return
	}
	c.JSON(http.StatusOK, map[string]any{
		"token_type":    "Bearer",
		"expires_in":    3600,
		"access_token":  accessToken,
		"refresh_token": refreshToken,
		"id_token":      idToken,
		"scope":         scope,
	})
}

func (s *Service) handleRefreshToken(c *corehttp.Context, server *resolvedAuthServer, body map[string]string, client corestore.Record) {
	refresh := firstRecord(s.store.RefreshTokens.FindBy("token", body["refresh_token"]))
	if refresh == nil {
		oauthError(c, http.StatusBadRequest, "invalid_grant", "Invalid refresh token.")
		return
	}
	if stringField(refresh, "auth_server_id") != server.id {
		oauthError(c, http.StatusBadRequest, "invalid_grant", "Authorization server mismatch.")
		return
	}
	if client != nil && stringField(client, "client_id") != stringField(refresh, "client_id") {
		oauthError(c, http.StatusBadRequest, "invalid_grant", "Refresh token was not issued to this client.")
		return
	}
	user := firstRecord(s.store.Users.FindBy("okta_id", stringField(refresh, "user_okta_id")))
	if user == nil {
		oauthError(c, http.StatusBadRequest, "invalid_grant", "Unknown user.")
		return
	}
	s.deleteRefreshToken(stringField(refresh, "token"))

	now := time.Now().Unix()
	scope := firstNonEmpty(body["scope"], stringField(refresh, "scope"), "openid profile email")
	clientID := stringField(refresh, "client_id")
	accessToken := oktaToken("okta_")
	refreshToken := oktaToken("r_okta_")
	s.store.AccessTokens.Insert(corestore.Record{
		"token":          accessToken,
		"auth_server_id": server.id,
		"client_id":      clientID,
		"scope":          scope,
		"issued_at":      now,
		"expires_at":     now + 3600,
		"user_okta_id":   stringField(user, "okta_id"),
		"username":       stringField(user, "login"),
	})
	s.store.RefreshTokens.Insert(corestore.Record{
		"token":          refreshToken,
		"auth_server_id": server.id,
		"client_id":      clientID,
		"scope":          scope,
		"user_okta_id":   stringField(user, "okta_id"),
		"username":       stringField(user, "login"),
		"nonce":          stringField(refresh, "nonce"),
	})
	response := map[string]any{
		"token_type":    "Bearer",
		"expires_in":    3600,
		"access_token":  accessToken,
		"refresh_token": refreshToken,
		"scope":         scope,
	}
	if scopeHas(scope, "openid") {
		idToken, err := createIDToken(s.store, user, clientID, stringField(refresh, "nonce"), server.issuer, scope)
		if err != nil {
			oauthError(c, http.StatusInternalServerError, "server_error", "Failed to sign id_token.")
			return
		}
		response["id_token"] = idToken
	}
	c.JSON(http.StatusOK, response)
}

func (s *Service) handleClientCredentialsToken(c *corehttp.Context, server *resolvedAuthServer, body map[string]string, clientID string, client corestore.Record) {
	if len(s.clientsForServer(server.id)) > 0 && client == nil {
		oauthError(c, http.StatusUnauthorized, "invalid_client", "Unknown client.")
		return
	}
	clientID = firstNonEmpty(stringField(client, "client_id"), clientID)
	if clientID == "" {
		oauthError(c, http.StatusUnauthorized, "invalid_client", "client_id is required.")
		return
	}
	scope := firstNonEmpty(body["scope"], ".default")
	now := time.Now().Unix()
	accessToken := oktaToken("okta_")
	s.store.AccessTokens.Insert(corestore.Record{
		"token":          accessToken,
		"auth_server_id": server.id,
		"client_id":      clientID,
		"scope":          scope,
		"issued_at":      now,
		"expires_at":     now + 3600,
		"user_okta_id":   "",
		"username":       "",
	})
	c.JSON(http.StatusOK, map[string]any{
		"token_type":   "Bearer",
		"expires_in":   3600,
		"access_token": accessToken,
		"scope":        scope,
	})
}

func (s *Service) handleOrgUserinfo(c *corehttp.Context) {
	s.handleUserinfo(c, orgAuthServerID)
}

func (s *Service) handleAuthServerUserinfo(c *corehttp.Context) {
	s.handleUserinfo(c, c.Param("authServerId"))
}

func (s *Service) handleUserinfo(c *corehttp.Context, authServerID string) {
	if s.resolveAuthServer(authServerID) == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: authorization server '"+authServerID+"'")
		return
	}
	token := tokenFromRequest(c.Request)
	access := firstRecord(s.store.AccessTokens.FindBy("token", token))
	if access == nil || stringField(access, "auth_server_id") != authServerID || stringField(access, "user_okta_id") == "" || int64(intField(access, "expires_at")) <= time.Now().Unix() {
		oauthError(c, http.StatusUnauthorized, "invalid_token", "The access token is invalid.")
		return
	}
	user := firstRecord(s.store.Users.FindBy("okta_id", stringField(access, "user_okta_id")))
	if user == nil {
		oauthError(c, http.StatusUnauthorized, "invalid_token", "The access token is invalid.")
		return
	}
	body := map[string]any{
		"sub":                stringField(user, "okta_id"),
		"name":               userDisplayName(user),
		"preferred_username": stringField(user, "login"),
		"email":              stringField(user, "email"),
		"email_verified":     true,
		"locale":             stringField(user, "locale"),
		"zoneinfo":           stringField(user, "time_zone"),
	}
	if scopeHas(stringField(access, "scope"), "groups") {
		body["groups"] = collectUserGroupNames(s.store, user)
	}
	c.JSON(http.StatusOK, body)
}

func (s *Service) handleOrgRevoke(c *corehttp.Context) {
	s.handleRevoke(c, orgAuthServerID)
}

func (s *Service) handleAuthServerRevoke(c *corehttp.Context) {
	s.handleRevoke(c, c.Param("authServerId"))
}

func (s *Service) handleRevoke(c *corehttp.Context, authServerID string) {
	if s.resolveAuthServer(authServerID) == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: authorization server '"+authServerID+"'")
		return
	}
	body := parseTokenBody(c.Request)
	s.deleteAccessToken(body["token"])
	s.deleteRefreshToken(body["token"])
	c.Writer.WriteHeader(http.StatusOK)
}

func (s *Service) handleOrgIntrospect(c *corehttp.Context) {
	s.handleIntrospect(c, orgAuthServerID)
}

func (s *Service) handleAuthServerIntrospect(c *corehttp.Context) {
	s.handleIntrospect(c, c.Param("authServerId"))
}

func (s *Service) handleIntrospect(c *corehttp.Context, authServerID string) {
	server := s.resolveAuthServer(authServerID)
	if server == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: authorization server '"+authServerID+"'")
		return
	}
	body := parseTokenBody(c.Request)
	clientID := body["client_id"]
	clientSecret := body["client_secret"]
	applyBasicCredentials(c.Request, &clientID, &clientSecret)
	if _, ok := s.validateClient(c, authServerID, clientID, clientSecret); !ok {
		return
	}
	token := body["token"]
	now := time.Now().Unix()
	access := firstRecord(s.store.AccessTokens.FindBy("token", token))
	if access != nil && stringField(access, "auth_server_id") == authServerID && int64(intField(access, "expires_at")) > now {
		c.JSON(http.StatusOK, map[string]any{
			"active":     true,
			"token_type": "Bearer",
			"scope":      stringField(access, "scope"),
			"client_id":  stringField(access, "client_id"),
			"username":   stringOrNil(stringField(access, "username")),
			"sub":        stringOrNil(stringField(access, "user_okta_id")),
			"aud":        server.audiences,
			"iss":        server.issuer,
			"exp":        intField(access, "expires_at"),
			"iat":        intField(access, "issued_at"),
		})
		return
	}
	refresh := firstRecord(s.store.RefreshTokens.FindBy("token", token))
	if refresh != nil && stringField(refresh, "auth_server_id") == authServerID {
		c.JSON(http.StatusOK, map[string]any{
			"active":     true,
			"token_type": "refresh_token",
			"scope":      stringField(refresh, "scope"),
			"client_id":  stringField(refresh, "client_id"),
			"username":   stringField(refresh, "username"),
			"sub":        stringField(refresh, "user_okta_id"),
			"aud":        server.audiences,
			"iss":        server.issuer,
		})
		return
	}
	c.JSON(http.StatusOK, map[string]any{"active": false})
}

func (s *Service) handleOrgLogout(c *corehttp.Context) {
	s.handleLogout(c, orgAuthServerID)
}

func (s *Service) handleAuthServerLogout(c *corehttp.Context) {
	s.handleLogout(c, c.Param("authServerId"))
}

func (s *Service) handleLogout(c *corehttp.Context, authServerID string) {
	if s.resolveAuthServer(authServerID) == nil {
		oktaError(c, http.StatusNotFound, "E0000007", "Not found: authorization server '"+authServerID+"'")
		return
	}
	redirectURI := c.Query("post_logout_redirect_uri")
	if redirectURI == "" {
		c.Text(http.StatusOK, "Logged out")
		return
	}
	configuredClients := s.clientsForServer(authServerID)
	if len(configuredClients) > 0 {
		allowed := false
		for _, client := range configuredClients {
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

func (s *Service) resolveAuthServer(authServerID string) *resolvedAuthServer {
	if authServerID == orgAuthServerID {
		return &resolvedAuthServer{id: orgAuthServerID, issuer: s.baseURL, audiences: []string{defaultAudience}}
	}
	server := firstRecord(s.store.AuthorizationServers.FindBy("server_id", authServerID))
	if server == nil {
		return nil
	}
	audiences := stringSliceValue(server["audiences"])
	if len(audiences) == 0 {
		audiences = []string{defaultAudience}
	}
	return &resolvedAuthServer{id: authServerID, issuer: resolveIssuer(s.baseURL, authServerID), audiences: audiences}
}

func (s *Service) clientsForServer(authServerID string) []corestore.Record {
	return s.store.OAuthClients.FindBy("auth_server_id", authServerID)
}

func (s *Service) validateClient(c *corehttp.Context, authServerID string, clientID string, clientSecret string) (corestore.Record, bool) {
	configuredClients := s.clientsForServer(authServerID)
	if len(configuredClients) == 0 {
		return nil, true
	}
	client := recordWithField(configuredClients, "client_id", clientID)
	if client == nil {
		oauthError(c, http.StatusUnauthorized, "invalid_client", "Unknown client.")
		return nil, false
	}
	if stringField(client, "token_endpoint_auth_method") == "none" {
		return client, true
	}
	if !constantTimeEqual(clientSecret, stringField(client, "client_secret")) {
		oauthError(c, http.StatusUnauthorized, "invalid_client", "Invalid client credentials.")
		return nil, false
	}
	return client, true
}

func recordWithField(records []corestore.Record, field string, value string) corestore.Record {
	for _, record := range records {
		if stringField(record, field) == value {
			return record
		}
	}
	return nil
}

func (s *Service) deleteOAuthCode(code string) {
	for _, record := range s.store.OAuthCodes.FindBy("code", code) {
		s.store.OAuthCodes.Delete(intField(record, "id"))
	}
}

func (s *Service) deleteAccessToken(token string) {
	for _, record := range s.store.AccessTokens.FindBy("token", token) {
		s.store.AccessTokens.Delete(intField(record, "id"))
	}
}

func (s *Service) deleteRefreshToken(token string) {
	for _, record := range s.store.RefreshTokens.FindBy("token", token) {
		s.store.RefreshTokens.Delete(intField(record, "id"))
	}
}

func addAuthorizationResponseValues(values url.Values, code string, state string) {
	values.Set("code", code)
	if state != "" {
		values.Set("state", state)
	}
}

func collectUserGroupNames(store Store, user corestore.Record) []string {
	names := []string{}
	for _, membership := range store.GroupMemberships.FindBy("user_okta_id", stringField(user, "okta_id")) {
		group := firstRecord(store.Groups.FindBy("okta_id", stringField(membership, "group_okta_id")))
		if group != nil {
			names = append(names, stringField(group, "name"))
		}
	}
	return names
}
