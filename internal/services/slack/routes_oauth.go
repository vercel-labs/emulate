package slack

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
	router.Get("/oauth/v2/authorize", s.handleAuthorize)
	router.Post("/oauth/v2/authorize/callback", s.handleAuthorizeCallback)
	router.Post("/api/oauth.v2.access", s.handleOAuthAccess)
}

func (s *Service) handleAuthorize(c *corehttp.Context) {
	clientID := c.Query("client_id")
	redirectURI := c.Query("redirect_uri")
	scope := c.Query("scope")
	state := c.Query("state")

	appName := ""
	if s.store.OAuthApps.Count() > 0 {
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

	subtitle := "Choose a user to authorize."
	if appName != "" {
		subtitle = "Authorize <strong>" + ui.EscapeHTML(appName) + "</strong> to access your Slack workspace."
	}
	var body strings.Builder
	users := s.store.Users.All()
	count := 0
	for _, user := range users {
		if boolField(user, "deleted") || boolField(user, "is_bot") {
			continue
		}
		name := stringField(user, "name")
		letter := "?"
		if name != "" {
			letter = strings.ToUpper(name[:1])
		}
		body.WriteString(ui.RenderUserButton(ui.UserButtonOptions{
			Letter:     letter,
			Login:      name,
			Name:       stringField(user, "real_name"),
			Email:      stringField(user, "email"),
			FormAction: "/oauth/v2/authorize/callback",
			HiddenFields: map[string]string{
				"user_id":      stringField(user, "user_id"),
				"redirect_uri": redirectURI,
				"scope":        scope,
				"state":        state,
				"client_id":    clientID,
			},
		}))
		count++
	}
	if count == 0 {
		body.WriteString(`<p class="empty">No users in the emulator store.</p>`)
	}
	c.HTML(http.StatusOK, ui.RenderCardPage("Sign in to Slack", subtitle, body.String(), ui.PageOptions{Service: serviceLabel}))
}

func (s *Service) handleAuthorizeCallback(c *corehttp.Context) {
	if err := c.Request.ParseForm(); err != nil {
		c.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_request"})
		return
	}
	userID := c.Request.Form.Get("user_id")
	redirectURI := c.Request.Form.Get("redirect_uri")
	scope := c.Request.Form.Get("scope")
	state := c.Request.Form.Get("state")
	clientID := c.Request.Form.Get("client_id")
	if s.findUser(userID) == nil {
		c.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "user_not_found"})
		return
	}
	if s.store.OAuthApps.Count() > 0 {
		app := firstRecord(s.store.OAuthApps.FindBy("client_id", clientID))
		if app == nil || (redirectURI != "" && !matchesRedirectURI(redirectURI, stringSliceValue(app["redirect_uris"]))) {
			c.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_client_id"})
			return
		}
	}
	target, err := url.Parse(redirectURI)
	if err != nil || target == nil || target.Scheme == "" {
		c.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_redirect_uri"})
		return
	}
	code := generateSlackCode()
	s.store.OAuthCodes.Insert(corestore.Record{
		"code":          code,
		"user_id":       userID,
		"scope":         scope,
		"redirect_uri":  redirectURI,
		"client_id":     clientID,
		"created_at_ms": time.Now().UnixMilli(),
	})
	query := target.Query()
	query.Set("code", code)
	if state != "" {
		query.Set("state", state)
	}
	target.RawQuery = query.Encode()
	c.Redirect(http.StatusFound, target.String())
}

func (s *Service) handleOAuthAccess(c *corehttp.Context) {
	body := parseSlackBody(c.Request)
	codeValue := stringValue(body["code"])
	clientID := stringValue(body["client_id"])
	clientSecret := stringValue(body["client_secret"])
	redirectURI := stringValue(body["redirect_uri"])
	if s.store.OAuthApps.Count() > 0 {
		app := firstRecord(s.store.OAuthApps.FindBy("client_id", clientID))
		if app == nil || !constantTimeEqual(clientSecret, stringField(app, "client_secret")) {
			slackError(c, "invalid_client_id")
			return
		}
	}
	code := firstRecord(s.store.OAuthCodes.FindBy("code", codeValue))
	if code == nil || time.Now().UnixMilli()-int64(intField(code, "created_at_ms")) > pendingCodeTTL.Milliseconds() {
		if code != nil {
			s.store.OAuthCodes.Delete(intField(code, "id"))
		}
		slackError(c, "invalid_code")
		return
	}
	if stringField(code, "client_id") != "" && clientID != "" && stringField(code, "client_id") != clientID {
		slackError(c, "invalid_code")
		return
	}
	if pendingRedirectURI := stringField(code, "redirect_uri"); pendingRedirectURI != "" && redirectURI != "" && redirectURI != pendingRedirectURI {
		slackError(c, "invalid_code")
		return
	}
	s.store.OAuthCodes.Delete(intField(code, "id"))
	user := s.findUser(stringField(code, "user_id"))
	if user == nil {
		slackError(c, "invalid_code")
		return
	}
	accessToken := generateSlackToken()
	scopes := strings.FieldsFunc(stringField(code, "scope"), func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n'
	})
	s.store.Tokens.Insert(corestore.Record{
		"token":  accessToken,
		"login":  stringField(user, "user_id"),
		"scopes": scopes,
	})
	team := firstRecord(s.store.Teams.All())
	teamID := "T000000001"
	teamName := "Emulate"
	if team != nil {
		teamID = stringField(team, "team_id")
		teamName = stringField(team, "name")
	}
	scope := stringField(code, "scope")
	if scope == "" {
		scope = "chat:write,channels:read"
	}
	slackOK(c, map[string]any{
		"access_token": accessToken,
		"token_type":   "bot",
		"scope":        scope,
		"bot_user_id":  stringField(user, "user_id"),
		"app_id":       clientID,
		"team":         map[string]any{"id": teamID, "name": teamName},
		"authed_user":  map[string]any{"id": stringField(user, "user_id")},
	})
}
