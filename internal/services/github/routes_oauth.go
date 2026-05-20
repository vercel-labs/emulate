package github

import (
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/core/ui"
)

const pendingCodeTTL = 10 * time.Minute

func (s *Service) registerOAuthRoutes(router *corehttp.Router) {
	router.Get("/login/oauth/authorize", s.handleOAuthAuthorize)
	router.Post("/login/oauth/callback", s.handleOAuthCallback)
	router.Post("/login/oauth/access_token", s.handleOAuthToken)
	router.Get("/login/oauth/userinfo", s.handleOAuthUserinfo)
	router.Get("/userinfo", s.handleOAuthUserinfo)
	router.Get("/user/emails", s.handleUserEmails)
}

func (s *Service) handleOAuthAuthorize(c *corehttp.Context) {
	clientID := c.Query("client_id")
	redirectURI := c.Query("redirect_uri")
	scope := c.Query("scope")
	state := c.Query("state")
	appName := ""
	if len(s.store.OAuthApps.All()) > 0 {
		app := firstRecord(s.store.OAuthApps.FindBy("client_id", clientID))
		if app == nil {
			c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Application not found", "The client_id '"+clientID+"' is not registered.", ui.PageOptions{Service: serviceLabel}))
			return
		}
		if redirectURI != "" && !matchesRedirectURI(redirectURI, stringSliceValue(app["redirect_uris"])) {
			c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", ui.PageOptions{Service: serviceLabel}))
			return
		}
		appName = stringField(app, "name")
	}
	users := s.store.Users.All()
	sortRecordsByString(users, "login", false)
	subtitle := "Choose a seeded user to authorize this application."
	if appName != "" {
		subtitle = "Authorize <strong>" + ui.EscapeHTML(appName) + "</strong> to access your account."
	}
	var body strings.Builder
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
				Name:       stringField(user, "name"),
				Email:      stringField(user, "email"),
				FormAction: "/login/oauth/callback",
				HiddenFields: map[string]string{
					"login":        login,
					"redirect_uri": redirectURI,
					"scope":        scope,
					"state":        state,
					"client_id":    clientID,
				},
			}))
		}
	}
	c.HTML(http.StatusOK, ui.RenderCardPage("Sign in to GitHub", subtitle, body.String(), ui.PageOptions{Service: serviceLabel}))
}

func (s *Service) handleOAuthCallback(c *corehttp.Context) {
	if err := c.Request.ParseForm(); err != nil {
		writeGitHubError(c, http.StatusBadRequest, "Invalid form body")
		return
	}
	login := c.Request.Form.Get("login")
	redirectURI := c.Request.Form.Get("redirect_uri")
	clientID := c.Request.Form.Get("client_id")
	scope := c.Request.Form.Get("scope")
	state := c.Request.Form.Get("state")
	if firstRecord(s.store.Users.FindBy("login", login)) == nil {
		writeGitHubError(c, http.StatusBadRequest, "User not found")
		return
	}
	if len(s.store.OAuthApps.All()) > 0 {
		app := firstRecord(s.store.OAuthApps.FindBy("client_id", clientID))
		if app == nil {
			writeGitHubError(c, http.StatusBadRequest, "Application not found")
			return
		}
		if redirectURI != "" && !matchesRedirectURI(redirectURI, stringSliceValue(app["redirect_uris"])) {
			writeGitHubError(c, http.StatusBadRequest, "Redirect URI mismatch")
			return
		}
	}
	target, err := url.Parse(redirectURI)
	if err != nil || target == nil || target.Scheme == "" {
		writeGitHubError(c, http.StatusBadRequest, "Invalid redirect_uri")
		return
	}
	code := generateHex(20)
	s.store.OAuthCodes.Insert(corestore.Record{
		"code":        code,
		"login":       login,
		"scope":       scope,
		"redirectURI": redirectURI,
		"client_id":   clientID,
		"createdAt":   time.Now().UnixMilli(),
	})
	query := target.Query()
	query.Set("code", code)
	query.Set("state", state)
	target.RawQuery = query.Encode()
	c.Redirect(http.StatusFound, target.String())
}

func (s *Service) handleOAuthToken(c *corehttp.Context) {
	body, err := parseOAuthBody(c.Request)
	if err != nil {
		writeBadVerificationCode(c)
		return
	}
	code := stringValue(body["code"])
	clientID := stringValue(body["client_id"])
	clientSecret := stringValue(body["client_secret"])
	redirectURI := stringValue(body["redirect_uri"])
	if len(s.store.OAuthApps.All()) > 0 {
		app := firstRecord(s.store.OAuthApps.FindBy("client_id", clientID))
		if app == nil || subtle.ConstantTimeCompare([]byte(clientSecret), []byte(stringField(app, "client_secret"))) != 1 {
			c.JSON(http.StatusOK, map[string]any{
				"error":             "incorrect_client_credentials",
				"error_description": "The client_id and/or client_secret passed are incorrect.",
			})
			return
		}
	}
	pending := firstRecord(s.store.OAuthCodes.FindBy("code", code))
	if pending == nil || time.Since(pendingCodeCreatedAt(pending)) > pendingCodeTTL {
		writeBadVerificationCode(c)
		return
	}
	pendingClientID := stringField(pending, "client_id")
	if pendingClientID != "" && clientID != "" && clientID != pendingClientID {
		writeBadVerificationCode(c)
		return
	}
	pendingRedirectURI := stringField(pending, "redirectURI")
	if redirectURI != "" && pendingRedirectURI != "" && redirectURI != pendingRedirectURI {
		writeBadVerificationCode(c)
		return
	}
	s.deleteOAuthCode(code)
	user := firstRecord(s.store.Users.FindBy("login", stringField(pending, "login")))
	if user == nil {
		writeBadVerificationCode(c)
		return
	}
	scope := stringField(pending, "scope")
	scopes := []string{"repo", "user"}
	if scope != "" {
		scopes = strings.FieldsFunc(scope, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\n' })
	}
	token := "gho_" + base64URLSecret(20)
	s.store.OAuthTokens.Insert(corestore.Record{
		"tokenString": token,
		"login":       stringField(user, "login"),
		"scopes":      scopes,
		"client_id":   stringField(pending, "client_id"),
	})
	if strings.Contains(c.Request.Header.Get("Accept"), "application/x-www-form-urlencoded") {
		c.Writer.Header().Set("Content-Type", "application/x-www-form-urlencoded")
		c.Text(http.StatusOK, "access_token="+url.QueryEscape(token)+"&token_type=bearer&scope="+url.QueryEscape(scope))
		return
	}
	c.JSON(http.StatusOK, map[string]any{
		"access_token": token,
		"token_type":   "bearer",
		"scope":        scope,
	})
}

func writeBadVerificationCode(c *corehttp.Context) {
	c.JSON(http.StatusOK, map[string]any{
		"error":             "bad_verification_code",
		"error_description": "The code passed is incorrect or expired.",
	})
}

func (s *Service) handleOAuthUserinfo(c *corehttp.Context) {
	user, ok := s.currentUser(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, map[string]any{
		"sub":                strconv.Itoa(intField(user, "id")),
		"email":              user["email"],
		"name":               user["name"],
		"preferred_username": stringField(user, "login"),
		"email_verified":     true,
		"picture":            s.baseURL + "/avatars/u/" + stringField(user, "login"),
	})
}

func (s *Service) handleUserEmails(c *corehttp.Context) {
	user, ok := s.currentUser(c)
	if !ok {
		return
	}
	email := stringField(user, "email")
	if email == "" {
		email = stringField(user, "login") + "@users.noreply.localhost"
	}
	c.JSON(http.StatusOK, []any{
		map[string]any{"email": email, "primary": true, "verified": true, "visibility": "public"},
	})
}

func (s *Service) deleteOAuthCode(code string) {
	for _, row := range s.store.OAuthCodes.FindBy("code", code) {
		s.store.OAuthCodes.Delete(intField(row, "id"))
	}
}

func base64URLSecret(size int) string {
	return strings.TrimRight(base64.RawURLEncoding.EncodeToString([]byte(generateHex(size))), "=")
}
