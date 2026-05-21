package okta

import (
	"net/http"
	"net/url"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) requireManagementAuth(c *corehttp.Context) (string, bool) {
	if token := sswsTokenFromRequest(c.Request); token != "" && token != "invalid-token" {
		return s.defaultManagementLogin(), true
	}
	if token := tokenFromRequest(c.Request); token != "" {
		if token == "test-token" || token == "mgmt-token" || token == "test_token_admin" {
			return s.defaultManagementLogin(), true
		}
		row := firstRecord(s.store.AccessTokens.FindBy("token", token))
		if row != nil {
			if login := stringField(row, "username"); login != "" {
				return login, true
			}
			if clientID := stringField(row, "client_id"); clientID != "" {
				return clientID, true
			}
		}
	}
	oktaError(c, http.StatusUnauthorized, "E0000004", "Authentication failed")
	return "", false
}

func (s *Service) defaultManagementLogin() string {
	if user := firstRecord(s.store.Users.All()); user != nil {
		return stringField(user, "login")
	}
	return "admin"
}

func (s *Service) findUser(ref string) corestore.Record {
	decoded := decodePathValue(ref)
	if user := firstRecord(s.store.Users.FindBy("okta_id", decoded)); user != nil {
		return user
	}
	if user := firstRecord(s.store.Users.FindBy("login", decoded)); user != nil {
		return user
	}
	return firstRecord(s.store.Users.FindBy("email", decoded))
}

func (s *Service) findGroup(ref string) corestore.Record {
	return firstRecord(s.store.Groups.FindBy("okta_id", decodePathValue(ref)))
}

func (s *Service) findApp(ref string) corestore.Record {
	return firstRecord(s.store.Apps.FindBy("okta_id", decodePathValue(ref)))
}

func (s *Service) findAuthorizationServer(ref string) corestore.Record {
	return firstRecord(s.store.AuthorizationServers.FindBy("server_id", decodePathValue(ref)))
}

func decodePathValue(value string) string {
	decoded, err := url.PathUnescape(value)
	if err != nil {
		return value
	}
	return decoded
}

func userResponse(baseURL string, user corestore.Record) map[string]any {
	return map[string]any{
		"id":              stringField(user, "okta_id"),
		"status":          stringField(user, "status"),
		"created":         user["created_at"],
		"activated":       user["activated_at"],
		"statusChanged":   user["status_changed_at"],
		"lastLogin":       user["last_login_at"],
		"lastUpdated":     user["updated_at"],
		"passwordChanged": user["password_changed_at"],
		"profile": map[string]any{
			"login":       stringField(user, "login"),
			"email":       stringField(user, "email"),
			"firstName":   stringField(user, "first_name"),
			"lastName":    stringField(user, "last_name"),
			"displayName": userDisplayName(user),
			"locale":      stringField(user, "locale"),
			"timeZone":    stringField(user, "time_zone"),
		},
		"_links": map[string]any{
			"self": map[string]any{
				"href": strings.TrimRight(baseURL, "/") + "/api/v1/users/" + url.PathEscape(stringField(user, "okta_id")),
			},
		},
	}
}

func groupResponse(baseURL string, group corestore.Record) map[string]any {
	return map[string]any{
		"id":                    stringField(group, "okta_id"),
		"created":               group["created_at"],
		"lastUpdated":           group["updated_at"],
		"lastMembershipUpdated": group["updated_at"],
		"objectClass":           []string{"okta:user_group"},
		"type":                  stringField(group, "type"),
		"profile": map[string]any{
			"name":        stringField(group, "name"),
			"description": group["description"],
		},
		"_links": map[string]any{
			"self": map[string]any{
				"href": strings.TrimRight(baseURL, "/") + "/api/v1/groups/" + url.PathEscape(stringField(group, "okta_id")),
			},
		},
	}
}

func appResponse(baseURL string, app corestore.Record) map[string]any {
	return map[string]any{
		"id":          stringField(app, "okta_id"),
		"name":        stringField(app, "name"),
		"label":       stringField(app, "label"),
		"status":      stringField(app, "status"),
		"created":     app["created_at"],
		"lastUpdated": app["updated_at"],
		"signOnMode":  stringField(app, "sign_on_mode"),
		"credentials": mapValue(app["credentials"]),
		"settings":    mapValue(app["settings"]),
		"_links": map[string]any{
			"self": map[string]any{
				"href": strings.TrimRight(baseURL, "/") + "/api/v1/apps/" + url.PathEscape(stringField(app, "okta_id")),
			},
		},
	}
}

func authorizationServerResponse(baseURL string, server corestore.Record) map[string]any {
	serverID := stringField(server, "server_id")
	return map[string]any{
		"id":          serverID,
		"name":        stringField(server, "name"),
		"description": stringField(server, "description"),
		"audiences":   stringSliceValue(server["audiences"]),
		"issuer":      resolveIssuer(baseURL, serverID),
		"status":      stringField(server, "status"),
		"created":     server["created_at"],
		"lastUpdated": server["updated_at"],
		"_links": map[string]any{
			"self": map[string]any{
				"href": strings.TrimRight(baseURL, "/") + "/api/v1/authorizationServers/" + url.PathEscape(serverID),
			},
		},
	}
}

func bodyMap(body map[string]any, key string) map[string]any {
	return mapValue(body[key])
}

func bodyString(body map[string]any, key string) string {
	return strings.TrimSpace(stringValue(body[key]))
}

func bodyStringDefault(body map[string]any, key string, fallback string) string {
	if value := bodyString(body, key); value != "" {
		return value
	}
	return fallback
}

func bodyStringSlice(body map[string]any, key string, fallback []string) []string {
	value, ok := body[key]
	if !ok {
		return append([]string(nil), fallback...)
	}
	items := stringSliceValue(value)
	if len(items) == 0 {
		return append([]string(nil), fallback...)
	}
	return items
}

func writeNoContent(c *corehttp.Context) {
	c.Writer.WriteHeader(http.StatusNoContent)
}
