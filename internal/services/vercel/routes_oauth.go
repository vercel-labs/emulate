package vercel

import (
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
	router.Get("/oauth/authorize", func(c *corehttp.Context) {
		clientID := c.Query("client_id")
		redirectURI := c.Query("redirect_uri")
		scope := c.Query("scope")
		state := c.Query("state")
		codeChallenge := c.Query("code_challenge")
		codeChallengeMethod := c.Query("code_challenge_method")

		integrations := s.store.Integrations.All()
		integrationName := ""
		if len(integrations) > 0 {
			integration := firstRecord(s.store.Integrations.FindBy("client_id", clientID))
			if integration == nil {
				c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Application not found", "The client_id '"+clientID+"' is not registered.", ui.PageOptions{Service: serviceLabel}))
				return
			}
			if redirectURI != "" && !matchesRedirectURI(redirectURI, stringSliceValue(integration["redirect_uris"])) {
				c.HTML(http.StatusBadRequest, ui.RenderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", ui.PageOptions{Service: serviceLabel}))
				return
			}
			integrationName = stringField(integration, "name")
		}

		subtitle := "Choose a seeded user to continue."
		if integrationName != "" {
			subtitle = "Authorize <strong>" + ui.EscapeHTML(integrationName) + "</strong> to access your account."
		}
		var body strings.Builder
		users := s.store.Users.All()
		if len(users) == 0 {
			body.WriteString(`<p class="empty">No users in the emulator store.</p>`)
		} else {
			for _, user := range users {
				formatted := formatUser(user)
				username := stringValue(formatted["username"])
				letter := "?"
				if username != "" {
					letter = strings.ToUpper(username[:1])
				}
				body.WriteString(ui.RenderUserButton(ui.UserButtonOptions{
					Letter:     letter,
					Login:      username,
					Name:       stringValue(formatted["name"]),
					Email:      stringValue(formatted["email"]),
					FormAction: "/oauth/authorize/callback",
					HiddenFields: map[string]string{
						"username":              username,
						"redirect_uri":          redirectURI,
						"scope":                 scope,
						"state":                 state,
						"client_id":             clientID,
						"code_challenge":        codeChallenge,
						"code_challenge_method": codeChallengeMethod,
					},
				}))
			}
		}
		c.HTML(http.StatusOK, ui.RenderCardPage("Sign in to Vercel", subtitle, body.String(), ui.PageOptions{Service: serviceLabel}))
	})

	router.Post("/oauth/authorize/callback", func(c *corehttp.Context) {
		if err := c.Request.ParseForm(); err != nil {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid form body")
			return
		}
		pending := pendingCode{
			Username:            c.Request.Form.Get("username"),
			Scope:               c.Request.Form.Get("scope"),
			RedirectURI:         c.Request.Form.Get("redirect_uri"),
			ClientID:            c.Request.Form.Get("client_id"),
			CodeChallenge:       c.Request.Form.Get("code_challenge"),
			CodeChallengeMethod: c.Request.Form.Get("code_challenge_method"),
			CreatedAt:           time.Now(),
		}
		if len(s.store.Integrations.All()) > 0 {
			integration := firstRecord(s.store.Integrations.FindBy("client_id", pending.ClientID))
			if integration == nil {
				writeVercelError(c, http.StatusBadRequest, "bad_request", "Application not found")
				return
			}
			if pending.RedirectURI != "" && !matchesRedirectURI(pending.RedirectURI, stringSliceValue(integration["redirect_uris"])) {
				writeVercelError(c, http.StatusBadRequest, "bad_request", "Redirect URI mismatch")
				return
			}
		}
		redirectTarget, err := url.Parse(pending.RedirectURI)
		if err != nil || redirectTarget == nil {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid redirect_uri")
			return
		}
		code := generateHex(20)
		s.storePendingCode(code, pending)
		query := redirectTarget.Query()
		query.Set("code", code)
		if state := c.Request.Form.Get("state"); state != "" {
			query.Set("state", state)
		}
		redirectTarget.RawQuery = query.Encode()
		c.Redirect(http.StatusFound, redirectTarget.String())
	})

	router.Post("/login/oauth/token", func(c *corehttp.Context) {
		body, err := parseOAuthTokenBody(c.Request)
		if err != nil {
			c.JSON(http.StatusBadRequest, map[string]any{"error": "invalid_request", "error_description": "Invalid request body."})
			return
		}
		code := stringValue(body["code"])
		redirectURI := stringValue(body["redirect_uri"])
		codeVerifier := stringValue(body["code_verifier"])
		clientID := stringValue(body["client_id"])
		clientSecret := stringValue(body["client_secret"])

		if len(s.store.Integrations.All()) > 0 {
			integration := firstRecord(s.store.Integrations.FindBy("client_id", clientID))
			if integration == nil || !constantTimeEqual(clientSecret, stringField(integration, "client_secret")) {
				c.JSON(http.StatusUnauthorized, map[string]any{"error": "invalid_client", "error_description": "The client_id and/or client_secret passed are incorrect."})
				return
			}
		}

		pending, ok := s.pendingCode(code)
		if !ok {
			c.JSON(http.StatusBadRequest, map[string]any{"error": "invalid_grant", "error_description": "The code passed is incorrect or expired."})
			return
		}
		if time.Since(pending.CreatedAt) > pendingCodeTTL {
			s.deletePendingCode(code)
			c.JSON(http.StatusBadRequest, map[string]any{"error": "invalid_grant", "error_description": "The code passed is incorrect or expired."})
			return
		}
		if pending.ClientID != "" && clientID != "" && pending.ClientID != clientID {
			s.deletePendingCode(code)
			c.JSON(http.StatusBadRequest, map[string]any{"error": "invalid_grant", "error_description": "The client_id does not match the one used during authorization."})
			return
		}
		if redirectURI != "" && pending.RedirectURI != "" && redirectURI != pending.RedirectURI {
			s.deletePendingCode(code)
			c.JSON(http.StatusBadRequest, map[string]any{"error": "invalid_grant", "error_description": "The redirect_uri does not match the one used during authorization."})
			return
		}
		if pending.CodeChallenge != "" && !verifyPKCE(pending, codeVerifier) {
			c.JSON(http.StatusBadRequest, map[string]any{"error": "invalid_grant", "error_description": "PKCE verification failed."})
			return
		}
		user := firstRecord(s.store.Users.FindBy("username", pending.Username))
		if user == nil {
			c.JSON(http.StatusBadRequest, map[string]any{"error": "invalid_grant", "error_description": "The user associated with this code was not found."})
			return
		}
		token := "vercel_" + generateSecret()
		s.deletePendingCode(code)
		s.storeOAuthToken(token, stringField(user, "username"), pending.Scope)
		c.JSON(http.StatusOK, map[string]any{
			"access_token": token,
			"token_type":   "Bearer",
			"scope":        pending.Scope,
		})
	})

	router.Get("/login/oauth/userinfo", func(c *corehttp.Context) {
		user, ok := s.currentUser(c)
		if !ok {
			return
		}
		c.JSON(http.StatusOK, map[string]any{
			"sub":                stringField(user, "uid"),
			"email":              stringField(user, "email"),
			"name":               user["name"],
			"preferred_username": stringField(user, "username"),
			"email_verified":     true,
			"picture":            user["avatar"],
		})
	})
}

func (s *Service) storePendingCode(code string, pending pendingCode) {
	s.store.OAuthCodes.Insert(corestore.Record{
		"code":                code,
		"username":            pending.Username,
		"scope":               pending.Scope,
		"redirectURI":         pending.RedirectURI,
		"clientID":            pending.ClientID,
		"codeChallenge":       pending.CodeChallenge,
		"codeChallengeMethod": pending.CodeChallengeMethod,
		"createdAt":           pending.CreatedAt.UnixMilli(),
	})
}

func (s *Service) pendingCode(code string) (pendingCode, bool) {
	row := firstRecord(s.store.OAuthCodes.FindBy("code", code))
	if row == nil {
		return pendingCode{}, false
	}
	createdMillis := timeMillis(row["createdAt"])
	if createdMillis == 0 {
		createdMillis = timeMillis(row["created_at"])
	}
	return pendingCode{
		Username:            stringField(row, "username"),
		Scope:               stringField(row, "scope"),
		RedirectURI:         stringField(row, "redirectURI"),
		ClientID:            stringField(row, "clientID"),
		CodeChallenge:       stringField(row, "codeChallenge"),
		CodeChallengeMethod: stringField(row, "codeChallengeMethod"),
		CreatedAt:           time.UnixMilli(createdMillis),
	}, true
}

func (s *Service) deletePendingCode(code string) {
	for _, row := range s.store.OAuthCodes.FindBy("code", code) {
		s.store.OAuthCodes.Delete(intField(row, "id"))
	}
}

func (s *Service) storeOAuthToken(token string, username string, scope string) {
	s.store.OAuthTokens.Insert(corestore.Record{
		"tokenString": token,
		"username":    username,
		"scope":       scope,
	})
}

func parseOAuthTokenBody(req *http.Request) (map[string]any, error) {
	defer req.Body.Close()
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	contentType := req.Header.Get("Content-Type")
	if strings.Contains(contentType, "application/json") {
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			return map[string]any{}, nil
		}
		return body, nil
	}
	values, err := url.ParseQuery(string(raw))
	if err != nil {
		return nil, err
	}
	body := make(map[string]any, len(values))
	for key := range values {
		body[key] = values.Get(key)
	}
	return body, nil
}

func verifyPKCE(pending pendingCode, verifier string) bool {
	if verifier == "" {
		return false
	}
	method := strings.ToLower(pending.CodeChallengeMethod)
	if method == "" || method == "plain" {
		return verifier == pending.CodeChallenge
	}
	if method == "s256" {
		return encodePKCES256(verifier) == pending.CodeChallenge
	}
	return false
}
