package okta

import (
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

const serviceLabel = "Okta"

type Options struct {
	Store   *corestore.Store
	BaseURL string
	Seed    *SeedConfig
}

type SeedConfig struct {
	Users                []UserSeed                `json:"users"`
	Groups               []GroupSeed               `json:"groups"`
	Apps                 []AppSeed                 `json:"apps"`
	OAuthClients         []OAuthClientSeed         `json:"oauth_clients"`
	AuthorizationServers []AuthorizationServerSeed `json:"authorization_servers"`
	GroupMemberships     []GroupMembershipSeed     `json:"group_memberships"`
	AppAssignments       []AppAssignmentSeed       `json:"app_assignments"`
}

type UserSeed struct {
	OktaID      string `json:"okta_id"`
	Status      string `json:"status"`
	Login       string `json:"login"`
	Email       string `json:"email"`
	FirstName   string `json:"first_name"`
	LastName    string `json:"last_name"`
	DisplayName string `json:"display_name"`
	Locale      string `json:"locale"`
	TimeZone    string `json:"time_zone"`
}

type GroupSeed struct {
	OktaID      string `json:"okta_id"`
	Type        string `json:"type"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type AppSeed struct {
	OktaID      string         `json:"okta_id"`
	Name        string         `json:"name"`
	Label       string         `json:"label"`
	Status      string         `json:"status"`
	SignOnMode  string         `json:"sign_on_mode"`
	Settings    map[string]any `json:"settings"`
	Credentials map[string]any `json:"credentials"`
}

type OAuthClientSeed struct {
	ClientID                string   `json:"client_id"`
	ClientSecret            string   `json:"client_secret"`
	Name                    string   `json:"name"`
	RedirectURIs            []string `json:"redirect_uris"`
	ResponseTypes           []string `json:"response_types"`
	GrantTypes              []string `json:"grant_types"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	AuthServerID            string   `json:"auth_server_id"`
}

type AuthorizationServerSeed struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Audiences   []string `json:"audiences"`
	Status      string   `json:"status"`
}

type GroupMembershipSeed struct {
	GroupOktaID string `json:"group_okta_id"`
	UserOktaID  string `json:"user_okta_id"`
}

type AppAssignmentSeed struct {
	AppOktaID  string `json:"app_okta_id"`
	UserOktaID string `json:"user_okta_id"`
}

type Service struct {
	store   Store
	baseURL string
}

func Register(router *corehttp.Router, options Options) {
	service := New(options)
	service.RegisterRoutes(router)
}

func New(options Options) *Service {
	runtimeStore := options.Store
	if runtimeStore == nil {
		runtimeStore = corestore.New()
	}
	baseURL := strings.TrimRight(options.BaseURL, "/")
	if baseURL == "" {
		baseURL = "http://localhost:4000"
	}
	service := &Service{store: NewStore(runtimeStore), baseURL: baseURL}
	service.SeedDefaults()
	if options.Seed != nil {
		service.SeedFromConfig(*options.Seed)
	}
	return service
}

func SeedFromConfig(runtimeStore *corestore.Store, baseURL string, config SeedConfig) {
	New(Options{Store: runtimeStore, BaseURL: baseURL, Seed: &config})
}

func (s *Service) RegisterRoutes(router *corehttp.Router) {
	s.registerOAuthRoutes(router)
	s.registerUserRoutes(router)
	s.registerGroupRoutes(router)
	s.registerAppRoutes(router)
	s.registerAuthorizationServerRoutes(router)
}

func (s *Service) SeedDefaults() {
	if firstRecord(s.store.AuthorizationServers.FindBy("server_id", defaultAuthServerID)) == nil {
		s.store.AuthorizationServers.Insert(corestore.Record{
			"server_id":   defaultAuthServerID,
			"name":        "default",
			"description": "Default custom authorization server",
			"audiences":   []string{defaultAudience},
			"status":      "ACTIVE",
		})
	}
	everyone := firstRecord(s.store.Groups.FindBy("okta_id", defaultEveryoneGroupID))
	if everyone == nil {
		everyone = s.store.Groups.Insert(corestore.Record{
			"okta_id":     defaultEveryoneGroupID,
			"type":        "BUILT_IN",
			"name":        defaultEveryoneGroupName,
			"description": "All users in the organization",
		})
	}
	user := firstRecord(s.store.Users.FindBy("login", "testuser@okta.local"))
	if user == nil {
		now := nowISO()
		user = s.store.Users.Insert(corestore.Record{
			"okta_id":                 oktaID("00u"),
			"status":                  "ACTIVE",
			"activated_at":            now,
			"status_changed_at":       now,
			"last_login_at":           nil,
			"password_changed_at":     nil,
			"transitioning_to_status": nil,
			"login":                   "testuser@okta.local",
			"email":                   "testuser@okta.local",
			"first_name":              "Test",
			"last_name":               "User",
			"display_name":            "Test User",
			"locale":                  "en-US",
			"time_zone":               "UTC",
		})
	}
	if firstRecord(s.store.OAuthClients.FindBy("client_id", "okta-test-client")) == nil {
		s.store.OAuthClients.Insert(corestore.Record{
			"client_id":                  "okta-test-client",
			"client_secret":              "okta-test-secret",
			"name":                       "Sample OIDC Client",
			"redirect_uris":              []string{"http://localhost:3000/callback"},
			"response_types":             []string{"code"},
			"grant_types":                []string{"authorization_code", "refresh_token", "client_credentials"},
			"token_endpoint_auth_method": "client_secret_post",
			"auth_server_id":             defaultAuthServerID,
		})
	}
	if firstRecord(s.store.OAuthClients.FindBy("client_id", "okta-test-app")) == nil {
		s.store.OAuthClients.Insert(corestore.Record{
			"client_id":                  "okta-test-app",
			"client_secret":              "",
			"name":                       "Sample Public PKCE Client",
			"redirect_uris":              []string{"http://localhost:3000/official-sdk/callback", "http://localhost:3000/official-sdk"},
			"response_types":             []string{"code"},
			"grant_types":                []string{"authorization_code", "refresh_token"},
			"token_endpoint_auth_method": "none",
			"auth_server_id":             defaultAuthServerID,
		})
	}
	if s.store.Apps.Count() == 0 {
		s.store.Apps.Insert(corestore.Record{
			"okta_id":      oktaID("0oa"),
			"name":         "oidc_client",
			"label":        "Sample OIDC App",
			"status":       "ACTIVE",
			"sign_on_mode": "OPENID_CONNECT",
			"settings":     map[string]any{"oauthClient": map[string]any{"redirect_uris": []string{"http://localhost:3000/callback"}}},
			"credentials":  map[string]any{},
		})
	}
	s.ensureMembership(stringField(everyone, "okta_id"), stringField(user, "okta_id"))
}

func (s *Service) SeedFromConfig(config SeedConfig) {
	for _, server := range config.AuthorizationServers {
		if server.ID == "" || firstRecord(s.store.AuthorizationServers.FindBy("server_id", server.ID)) != nil {
			continue
		}
		audiences := server.Audiences
		if len(audiences) == 0 {
			audiences = []string{defaultAudience}
		}
		s.store.AuthorizationServers.Insert(corestore.Record{
			"server_id":   server.ID,
			"name":        server.Name,
			"description": server.Description,
			"audiences":   audiences,
			"status":      normalizeActiveStatus(server.Status, "ACTIVE"),
		})
	}
	for _, user := range config.Users {
		if user.Login == "" || firstRecord(s.store.Users.FindBy("login", user.Login)) != nil {
			continue
		}
		status := normalizeUserStatus(user.Status, "ACTIVE")
		now := nowISO()
		id := user.OktaID
		if id == "" {
			id = oktaID("00u")
		}
		email := user.Email
		if email == "" {
			email = user.Login
		}
		firstName := user.FirstName
		if firstName == "" {
			firstName = "Test"
		}
		lastName := user.LastName
		if lastName == "" {
			lastName = "User"
		}
		displayName := user.DisplayName
		if displayName == "" {
			displayName = strings.TrimSpace(firstName + " " + lastName)
		}
		activatedAt := stringOrNil("")
		if status == "ACTIVE" {
			activatedAt = now
		}
		s.store.Users.Insert(corestore.Record{
			"okta_id":                 id,
			"status":                  status,
			"activated_at":            activatedAt,
			"status_changed_at":       now,
			"last_login_at":           nil,
			"password_changed_at":     nil,
			"transitioning_to_status": nil,
			"login":                   user.Login,
			"email":                   email,
			"first_name":              firstName,
			"last_name":               lastName,
			"display_name":            displayName,
			"locale":                  firstNonEmpty(user.Locale, "en-US"),
			"time_zone":               firstNonEmpty(user.TimeZone, "UTC"),
		})
	}
	for _, group := range config.Groups {
		if group.Name == "" || firstRecord(s.store.Groups.FindBy("name", group.Name)) != nil {
			continue
		}
		id := group.OktaID
		if id == "" {
			id = oktaID("00g")
		}
		s.store.Groups.Insert(corestore.Record{
			"okta_id":     id,
			"type":        normalizeGroupType(group.Type, "OKTA_GROUP"),
			"name":        group.Name,
			"description": stringOrNil(group.Description),
		})
	}
	for _, app := range config.Apps {
		if app.Name == "" || firstRecord(s.store.Apps.FindBy("name", app.Name)) != nil {
			continue
		}
		id := app.OktaID
		if id == "" {
			id = oktaID("0oa")
		}
		s.store.Apps.Insert(corestore.Record{
			"okta_id":      id,
			"name":         app.Name,
			"label":        firstNonEmpty(app.Label, app.Name),
			"status":       normalizeActiveStatus(app.Status, "ACTIVE"),
			"sign_on_mode": firstNonEmpty(app.SignOnMode, "OPENID_CONNECT"),
			"settings":     firstMap(app.Settings),
			"credentials":  firstMap(app.Credentials),
		})
	}
	for _, client := range config.OAuthClients {
		if client.ClientID == "" || firstRecord(s.store.OAuthClients.FindBy("client_id", client.ClientID)) != nil {
			continue
		}
		responseTypes := client.ResponseTypes
		if len(responseTypes) == 0 {
			responseTypes = []string{"code"}
		}
		grantTypes := client.GrantTypes
		if len(grantTypes) == 0 {
			grantTypes = []string{"authorization_code", "refresh_token", "client_credentials"}
		}
		authMethod := client.TokenEndpointAuthMethod
		if authMethod == "" {
			authMethod = "client_secret_post"
		}
		authServerID := client.AuthServerID
		if authServerID == "" {
			authServerID = defaultAuthServerID
		}
		s.store.OAuthClients.Insert(corestore.Record{
			"client_id":                  client.ClientID,
			"client_secret":              client.ClientSecret,
			"name":                       client.Name,
			"redirect_uris":              client.RedirectURIs,
			"response_types":             responseTypes,
			"grant_types":                grantTypes,
			"token_endpoint_auth_method": authMethod,
			"auth_server_id":             authServerID,
		})
	}
	for _, membership := range config.GroupMemberships {
		if firstRecord(s.store.Groups.FindBy("okta_id", membership.GroupOktaID)) != nil && firstRecord(s.store.Users.FindBy("okta_id", membership.UserOktaID)) != nil {
			s.ensureMembership(membership.GroupOktaID, membership.UserOktaID)
		}
	}
	for _, assignment := range config.AppAssignments {
		if firstRecord(s.store.Apps.FindBy("okta_id", assignment.AppOktaID)) != nil && firstRecord(s.store.Users.FindBy("okta_id", assignment.UserOktaID)) != nil {
			s.ensureAppAssignment(assignment.AppOktaID, assignment.UserOktaID)
		}
	}
}

func (s *Service) ensureMembership(groupID string, userID string) {
	for _, record := range s.store.GroupMemberships.FindBy("group_okta_id", groupID) {
		if stringField(record, "user_okta_id") == userID {
			return
		}
	}
	s.store.GroupMemberships.Insert(corestore.Record{"group_okta_id": groupID, "user_okta_id": userID})
}

func (s *Service) ensureAppAssignment(appID string, userID string) {
	for _, record := range s.store.AppAssignments.FindBy("app_okta_id", appID) {
		if stringField(record, "user_okta_id") == userID {
			return
		}
	}
	s.store.AppAssignments.Insert(corestore.Record{"app_okta_id": appID, "user_okta_id": userID})
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func firstMap(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	return value
}
