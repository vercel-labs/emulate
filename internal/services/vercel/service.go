package vercel

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

const serviceLabel = "Vercel"

type Options struct {
	Store   *corestore.Store
	BaseURL string
	Seed    *SeedConfig
}

type SeedConfig struct {
	Port         int               `json:"port,omitempty"`
	Users        []UserSeed        `json:"users"`
	Teams        []TeamSeed        `json:"teams"`
	Projects     []ProjectSeed     `json:"projects"`
	Integrations []IntegrationSeed `json:"integrations"`
}

type UserSeed struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Name     string `json:"name"`
}

type TeamSeed struct {
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type ProjectSeed struct {
	Name            string       `json:"name"`
	Team            string       `json:"team"`
	Framework       string       `json:"framework"`
	BuildCommand    string       `json:"buildCommand"`
	OutputDirectory string       `json:"outputDirectory"`
	RootDirectory   string       `json:"rootDirectory"`
	NodeVersion     string       `json:"nodeVersion"`
	EnvVars         []EnvVarSeed `json:"envVars"`
}

type EnvVarSeed struct {
	Key    string   `json:"key"`
	Value  string   `json:"value"`
	Type   string   `json:"type"`
	Target []string `json:"target"`
}

type IntegrationSeed struct {
	ClientID     string   `json:"client_id"`
	ClientSecret string   `json:"client_secret"`
	Name         string   `json:"name"`
	RedirectURIs []string `json:"redirect_uris"`
}

type Service struct {
	store    Store
	baseURL  string
	mu       sync.Mutex
	codes    map[string]pendingCode
	tokenMap map[string]string
}

type pendingCode struct {
	Username            string
	Scope               string
	RedirectURI         string
	ClientID            string
	CodeChallenge       string
	CodeChallengeMethod string
	CreatedAt           time.Time
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
	baseURL := options.BaseURL
	if baseURL == "" {
		baseURL = "http://localhost:4000"
	}
	service := &Service{
		store:    NewStore(runtimeStore),
		baseURL:  strings.TrimRight(baseURL, "/"),
		codes:    map[string]pendingCode{},
		tokenMap: map[string]string{},
	}
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
	s.registerProjectRoutes(router)
	s.registerDeploymentRoutes(router)
	s.registerDomainRoutes(router)
	s.registerEnvRoutes(router)
	s.registerAPIKeyRoutes(router)
}

func (s *Service) SeedDefaults() {
	if firstRecord(s.store.Users.FindBy("username", "admin")) != nil {
		return
	}
	s.store.Users.Insert(defaultUserRecord("admin", "admin@localhost", "Admin"))
}

func (s *Service) SeedFromConfig(config SeedConfig) {
	for _, user := range config.Users {
		username := strings.TrimSpace(user.Username)
		if username == "" || firstRecord(s.store.Users.FindBy("username", username)) != nil {
			continue
		}
		email := user.Email
		if email == "" {
			email = username + "@localhost"
		}
		var name any
		if user.Name != "" {
			name = user.Name
		}
		record := defaultUserRecord(username, email, name)
		s.store.Users.Insert(record)
	}

	for _, teamSeed := range config.Teams {
		slug := strings.TrimSpace(teamSeed.Slug)
		if slug == "" || firstRecord(s.store.Teams.FindBy("slug", slug)) != nil {
			continue
		}
		creator := firstRecord(s.store.Users.All())
		creatorID := "unknown"
		if creator != nil {
			creatorID = stringField(creator, "uid")
		}
		name := teamSeed.Name
		if name == "" {
			name = slug
		}
		team := s.store.Teams.Insert(defaultTeamRecord(slug, name, nullableString(teamSeed.Description), creatorID, "pro"))
		for _, user := range s.store.Users.All() {
			role := "MEMBER"
			if stringField(user, "uid") == creatorID {
				role = "OWNER"
			}
			s.store.TeamMembers.Insert(corestore.Record{
				"teamId":     stringField(team, "uid"),
				"userId":     stringField(user, "uid"),
				"role":       role,
				"confirmed":  true,
				"joinedFrom": "seed",
			})
		}
	}

	for _, projectSeed := range config.Projects {
		name := strings.TrimSpace(projectSeed.Name)
		if name == "" {
			continue
		}
		accountID := ""
		if projectSeed.Team != "" {
			team := firstRecord(s.store.Teams.FindBy("slug", projectSeed.Team))
			if team == nil {
				continue
			}
			accountID = stringField(team, "uid")
		} else if user := firstRecord(s.store.Users.All()); user != nil {
			accountID = stringField(user, "uid")
		}
		if accountID == "" || s.lookupProject(name, accountID) != nil {
			continue
		}
		project := defaultProjectRecord(name, accountID)
		project["framework"] = nullableString(projectSeed.Framework)
		project["buildCommand"] = nullableString(projectSeed.BuildCommand)
		project["outputDirectory"] = nullableString(projectSeed.OutputDirectory)
		project["rootDirectory"] = nullableString(projectSeed.RootDirectory)
		if projectSeed.NodeVersion != "" {
			project["nodeVersion"] = projectSeed.NodeVersion
		}
		inserted := s.store.Projects.Insert(project)
		for _, envSeed := range projectSeed.EnvVars {
			if envSeed.Key == "" {
				continue
			}
			envType := envSeed.Type
			if !validEnvType(envType) {
				envType = "encrypted"
			}
			target := normalizeTargets(envSeed.Target)
			if len(target) == 0 {
				target = []string{"production", "preview", "development"}
			}
			s.store.EnvVars.Insert(corestore.Record{
				"uid":                  generateUID("env"),
				"projectId":            stringField(inserted, "uid"),
				"key":                  envSeed.Key,
				"value":                envSeed.Value,
				"type":                 envType,
				"target":               target,
				"gitBranch":            nil,
				"customEnvironmentIds": []string{},
				"comment":              nil,
				"decrypted":            false,
			})
		}
	}

	for _, integration := range config.Integrations {
		if integration.ClientID == "" || firstRecord(s.store.Integrations.FindBy("client_id", integration.ClientID)) != nil {
			continue
		}
		s.store.Integrations.Insert(corestore.Record{
			"client_id":     integration.ClientID,
			"client_secret": integration.ClientSecret,
			"name":          integration.Name,
			"redirect_uris": integration.RedirectURIs,
		})
	}
}

func defaultUserRecord(username string, email string, name any) corestore.Record {
	return corestore.Record{
		"uid":           generateUID("user"),
		"email":         email,
		"username":      username,
		"name":          name,
		"avatar":        nil,
		"defaultTeamId": nil,
		"softBlock":     nil,
		"billing": map[string]any{
			"plan":        "hobby",
			"period":      nil,
			"trial":       nil,
			"cancelation": nil,
			"addons":      nil,
		},
		"resourceConfig": map[string]any{
			"nodeType":         "Edge Functions",
			"concurrentBuilds": 1,
		},
		"stagingPrefix": "staging",
		"version":       nil,
	}
}

func defaultTeamRecord(slug string, name string, description any, creatorID string, plan string) corestore.Record {
	return corestore.Record{
		"uid":         generateUID("team"),
		"slug":        slug,
		"name":        name,
		"avatar":      nil,
		"description": description,
		"creatorId":   creatorID,
		"membership": map[string]any{
			"confirmed": true,
			"role":      "OWNER",
		},
		"billing": map[string]any{
			"plan":        plan,
			"period":      nil,
			"trial":       nil,
			"cancelation": nil,
			"addons":      nil,
		},
		"resourceConfig": map[string]any{
			"nodeType":         "Edge Functions",
			"concurrentBuilds": 1,
		},
		"stagingPrefix": "staging",
	}
}

func defaultProjectRecord(name string, accountID string) corestore.Record {
	return corestore.Record{
		"uid":                              generateUID("prj"),
		"name":                             name,
		"accountId":                        accountID,
		"framework":                        nil,
		"buildCommand":                     nil,
		"devCommand":                       nil,
		"installCommand":                   nil,
		"outputDirectory":                  nil,
		"rootDirectory":                    nil,
		"commandForIgnoringBuildStep":      nil,
		"nodeVersion":                      "20.x",
		"serverlessFunctionRegion":         nil,
		"publicSource":                     false,
		"autoAssignCustomDomains":          true,
		"autoAssignCustomDomainsUpdatedBy": nil,
		"gitForkProtection":                true,
		"sourceFilesOutsideRootDirectory":  false,
		"live":                             true,
		"link":                             nil,
		"latestDeployments":                []any{},
		"targets":                          map[string]any{},
		"protectionBypass":                 map[string]any{},
		"passwordProtection":               nil,
		"ssoProtection":                    nil,
		"trustedIps":                       nil,
		"connectConfigurationId":           nil,
		"gitComments": map[string]any{
			"onPullRequest": true,
			"onCommit":      false,
		},
		"webAnalytics":    nil,
		"speedInsights":   nil,
		"oidcTokenConfig": nil,
		"tier":            "hobby",
	}
}

func (s *Service) authLogin(c *corehttp.Context) (string, bool) {
	token := bearerToken(c.Request)
	if token == "" {
		return "", false
	}
	s.mu.Lock()
	login := s.tokenMap[token]
	s.mu.Unlock()
	if login != "" {
		return login, true
	}
	if apiKey := firstRecord(s.store.APIKeys.FindBy("tokenString", token)); apiKey != nil {
		user := firstRecord(s.store.Users.FindBy("uid", stringField(apiKey, "userId")))
		if user != nil {
			return stringField(user, "username"), true
		}
	}
	switch token {
	case "test-token":
		if firstRecord(s.store.Users.FindBy("username", "testuser")) != nil {
			return "testuser", true
		}
		return "admin", true
	case "test_token_admin":
		return "admin", true
	case "test_token_user1":
		if firstRecord(s.store.Users.FindBy("username", "octocat")) != nil {
			return "octocat", true
		}
		return "admin", true
	default:
		return "", false
	}
}

func (s *Service) currentUser(c *corehttp.Context) (corestore.Record, bool) {
	login, ok := s.authLogin(c)
	if !ok {
		writeVercelError(c, http.StatusUnauthorized, "not_authenticated", "Authentication required")
		return nil, false
	}
	user := firstRecord(s.store.Users.FindBy("username", login))
	if user == nil {
		writeVercelError(c, http.StatusForbidden, "forbidden", "User not found")
		return nil, false
	}
	return user, true
}

func bearerToken(req *http.Request) string {
	header := strings.TrimSpace(req.Header.Get("Authorization"))
	if header == "" {
		return ""
	}
	const prefix = "Bearer "
	if strings.HasPrefix(strings.ToLower(header), strings.ToLower(prefix)) {
		return strings.TrimSpace(header[len(prefix):])
	}
	return ""
}

type scope struct {
	AccountID string
	Team      corestore.Record
}

func (s *Service) resolveScope(c *corehttp.Context) (*scope, bool) {
	if teamID := strings.TrimSpace(c.Query("teamId")); teamID != "" {
		team := firstRecord(s.store.Teams.FindBy("uid", teamID))
		if team == nil {
			return nil, false
		}
		return &scope{AccountID: stringField(team, "uid"), Team: team}, true
	}
	if slug := strings.TrimSpace(c.Query("slug")); slug != "" {
		team := firstRecord(s.store.Teams.FindBy("slug", slug))
		if team == nil {
			return nil, false
		}
		return &scope{AccountID: stringField(team, "uid"), Team: team}, true
	}
	login, ok := s.authLogin(c)
	if !ok {
		return nil, false
	}
	user := firstRecord(s.store.Users.FindBy("username", login))
	if user == nil {
		return nil, false
	}
	return &scope{AccountID: stringField(user, "uid")}, true
}

func (s *Service) lookupProject(idOrName string, accountID string) corestore.Record {
	if project := firstRecord(s.store.Projects.FindBy("uid", idOrName)); project != nil && stringField(project, "accountId") == accountID {
		return project
	}
	for _, project := range s.store.Projects.FindBy("name", idOrName) {
		if stringField(project, "accountId") == accountID {
			return project
		}
	}
	return nil
}

func writeVercelError(c *corehttp.Context, status int, code string, message string) {
	c.JSON(status, map[string]any{
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})
}

func parseJSONBody(req *http.Request) (map[string]any, error) {
	defer req.Body.Close()
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return map[string]any{}, nil
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	if body == nil {
		body = map[string]any{}
	}
	return body, nil
}

func parseAnyJSONBody(req *http.Request) (any, error) {
	defer req.Body.Close()
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil, nil
	}
	var body any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	return body, nil
}

func generateUID(prefix string) string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	id := base64.RawURLEncoding.EncodeToString(raw)
	if len(id) > 20 {
		id = id[:20]
	}
	if prefix == "" {
		return id
	}
	return prefix + "_" + id
}

func generateSecret() string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func generateHex(size int) string {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return hex.EncodeToString(raw)
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

func firstRecord(records []corestore.Record) corestore.Record {
	if len(records) == 0 {
		return nil
	}
	return records[0]
}

func intField(record corestore.Record, key string) int {
	switch value := record[key].(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	case json.Number:
		number, _ := value.Int64()
		return int(number)
	default:
		return 0
	}
}

func stringField(record corestore.Record, key string) string {
	return stringValue(record[key])
}

func stringValue(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case fmt.Stringer:
		return v.String()
	case nil:
		return ""
	default:
		return fmt.Sprint(v)
	}
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func boolField(record corestore.Record, key string) bool {
	value, _ := record[key].(bool)
	return value
}

func mapField(record corestore.Record, key string) map[string]any {
	if value, ok := record[key].(map[string]any); ok {
		return value
	}
	if value, ok := record[key].(corestore.Record); ok {
		out := make(map[string]any, len(value))
		for key, item := range value {
			out[key] = item
		}
		return out
	}
	return map[string]any{}
}

func stringSliceValue(value any) []string {
	switch v := value.(type) {
	case []string:
		out := make([]string, len(v))
		copy(out, v)
		return out
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func parseStringSliceStrict(value any) ([]string, bool) {
	switch v := value.(type) {
	case []string:
		out := make([]string, len(v))
		copy(out, v)
		return out, true
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			s, ok := item.(string)
			if !ok {
				return nil, false
			}
			out = append(out, s)
		}
		return out, true
	default:
		return nil, false
	}
}

func stringMapValue(value any) map[string]string {
	out := map[string]string{}
	if raw, ok := value.(map[string]any); ok {
		for key, item := range raw {
			if str, ok := item.(string); ok {
				out[key] = str
			}
		}
	}
	return out
}

func timeMillisField(record corestore.Record, key string) int64 {
	return timeMillis(record[key])
}

func timeMillis(value any) int64 {
	switch v := value.(type) {
	case string:
		t, err := time.Parse(time.RFC3339Nano, v)
		if err == nil {
			return t.UnixMilli()
		}
	case int:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case json.Number:
		n, _ := v.Int64()
		return n
	}
	return 0
}

func validEnvType(value string) bool {
	switch value {
	case "system", "encrypted", "plain", "secret", "sensitive":
		return true
	default:
		return false
	}
}

func validTarget(value string) bool {
	switch value {
	case "production", "preview", "development":
		return true
	default:
		return false
	}
}

func normalizeTargets(input []string) []string {
	targets := make([]string, 0, len(input))
	seen := map[string]bool{}
	for _, target := range input {
		if validTarget(target) && !seen[target] {
			targets = append(targets, target)
			seen[target] = true
		}
	}
	return targets
}

func targetsOverlap(left []string, right []string) bool {
	seen := map[string]bool{}
	for _, target := range left {
		seen[target] = true
	}
	for _, target := range right {
		if seen[target] {
			return true
		}
	}
	return false
}

func parseQueryBool(value string) bool {
	value = strings.ToLower(value)
	return value == "true" || value == "1" || value == "yes"
}

type paginationOptions struct {
	Limit int
	Since *int64
	Until *int64
	From  *int64
}

func parsePagination(c *corehttp.Context) paginationOptions {
	limit, err := strconv.Atoi(c.Query("limit"))
	if err != nil || limit < 1 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	return paginationOptions{
		Limit: limit,
		Since: parseOptionalInt64(c.Query("since")),
		Until: parseOptionalInt64(c.Query("until")),
		From:  parseOptionalInt64(c.Query("from")),
	}
}

func parseOptionalInt64(value string) *int64 {
	if value == "" {
		return nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return nil
	}
	return &parsed
}

func applyPagination(items []corestore.Record, options paginationOptions) ([]corestore.Record, map[string]any) {
	filtered := append([]corestore.Record(nil), items...)
	sortRecordsByCreatedAt(filtered)
	if options.Since != nil {
		next := filtered[:0]
		for _, item := range filtered {
			if timeMillisField(item, "created_at") > *options.Since {
				next = append(next, item)
			}
		}
		filtered = next
	}
	if options.Until != nil {
		next := filtered[:0]
		for _, item := range filtered {
			if timeMillisField(item, "created_at") <= *options.Until {
				next = append(next, item)
			}
		}
		filtered = next
	}
	total := len(filtered)
	if len(filtered) > options.Limit {
		filtered = filtered[:options.Limit]
	}
	var next any
	var prev any
	next = nil
	prev = nil
	if total > options.Limit && len(filtered) > 0 {
		next = timeMillisField(filtered[len(filtered)-1], "created_at")
	}
	if len(filtered) > 0 {
		prev = timeMillisField(filtered[0], "created_at")
	}
	return filtered, map[string]any{
		"count": len(filtered),
		"next":  next,
		"prev":  prev,
	}
}

func sortRecordsByCreatedAt(items []corestore.Record) {
	sort.SliceStable(items, func(i int, j int) bool {
		return timeMillisField(items[i], "created_at") > timeMillisField(items[j], "created_at")
	})
}

func formatUser(user corestore.Record) map[string]any {
	return map[string]any{
		"id":             stringField(user, "uid"),
		"email":          stringField(user, "email"),
		"name":           user["name"],
		"username":       stringField(user, "username"),
		"avatar":         user["avatar"],
		"defaultTeamId":  user["defaultTeamId"],
		"version":        user["version"],
		"createdAt":      timeMillisField(user, "created_at"),
		"softBlock":      user["softBlock"],
		"billing":        user["billing"],
		"resourceConfig": user["resourceConfig"],
		"stagingPrefix":  user["stagingPrefix"],
	}
}

func formatTeam(team corestore.Record) map[string]any {
	return map[string]any{
		"id":             stringField(team, "uid"),
		"slug":           stringField(team, "slug"),
		"name":           stringField(team, "name"),
		"avatar":         team["avatar"],
		"description":    team["description"],
		"creatorId":      stringField(team, "creatorId"),
		"createdAt":      timeMillisField(team, "created_at"),
		"updatedAt":      timeMillisField(team, "updated_at"),
		"membership":     team["membership"],
		"billing":        team["billing"],
		"resourceConfig": team["resourceConfig"],
		"stagingPrefix":  team["stagingPrefix"],
	}
}

func formatProject(project corestore.Record, baseURL string) map[string]any {
	return map[string]any{
		"accountId":                        stringField(project, "accountId"),
		"autoAssignCustomDomains":          project["autoAssignCustomDomains"],
		"autoAssignCustomDomainsUpdatedBy": project["autoAssignCustomDomainsUpdatedBy"],
		"buildCommand":                     project["buildCommand"],
		"createdAt":                        timeMillisField(project, "created_at"),
		"devCommand":                       project["devCommand"],
		"directoryListing":                 false,
		"framework":                        project["framework"],
		"gitForkProtection":                project["gitForkProtection"],
		"gitComments":                      project["gitComments"],
		"id":                               stringField(project, "uid"),
		"installCommand":                   project["installCommand"],
		"name":                             stringField(project, "name"),
		"nodeVersion":                      stringField(project, "nodeVersion"),
		"outputDirectory":                  project["outputDirectory"],
		"publicSource":                     project["publicSource"],
		"rootDirectory":                    project["rootDirectory"],
		"commandForIgnoringBuildStep":      project["commandForIgnoringBuildStep"],
		"serverlessFunctionRegion":         project["serverlessFunctionRegion"],
		"sourceFilesOutsideRootDirectory":  project["sourceFilesOutsideRootDirectory"],
		"updatedAt":                        timeMillisField(project, "updated_at"),
		"live":                             project["live"],
		"link":                             project["link"],
		"latestDeployments":                arrayOrEmpty(project["latestDeployments"]),
		"targets":                          mapOrEmpty(project["targets"]),
		"protectionBypass":                 mapOrEmpty(project["protectionBypass"]),
		"passwordProtection":               project["passwordProtection"],
		"ssoProtection":                    project["ssoProtection"],
		"trustedIps":                       project["trustedIps"],
		"connectConfigurationId":           project["connectConfigurationId"],
		"webAnalytics":                     project["webAnalytics"],
		"speedInsights":                    project["speedInsights"],
		"oidcTokenConfig":                  project["oidcTokenConfig"],
		"tier":                             project["tier"],
	}
}

func formatDeployment(dep corestore.Record, store Store, baseURL string) map[string]any {
	creator := firstRecord(store.Users.FindBy("uid", stringField(dep, "creatorId")))
	aliases := store.DeploymentAliases.FindBy("deploymentId", stringField(dep, "uid"))
	aliasValues := make([]string, 0, len(aliases))
	for _, alias := range aliases {
		aliasValues = append(aliasValues, stringField(alias, "alias"))
	}
	var creatorOut any
	if creator != nil {
		creatorOut = map[string]any{
			"uid":      stringField(creator, "uid"),
			"email":    stringField(creator, "email"),
			"username": stringField(creator, "username"),
		}
	}
	return map[string]any{
		"uid":           stringField(dep, "uid"),
		"id":            stringField(dep, "uid"),
		"name":          stringField(dep, "name"),
		"url":           stringField(dep, "url"),
		"created":       timeMillisField(dep, "created_at"),
		"createdAt":     timeMillisField(dep, "created_at"),
		"source":        dep["source"],
		"state":         dep["state"],
		"readyState":    dep["readyState"],
		"readySubstate": dep["readySubstate"],
		"type":          "LAMBDAS",
		"creator":       creatorOut,
		"inspectorUrl":  dep["inspectorUrl"],
		"meta":          mapOrEmpty(dep["meta"]),
		"target":        dep["target"],
		"aliasAssigned": dep["aliasAssigned"],
		"aliasError":    dep["aliasError"],
		"buildingAt":    dep["buildingAt"],
		"readyAt":       dep["readyAt"],
		"bootedAt":      dep["bootedAt"],
		"canceledAt":    dep["canceledAt"],
		"errorCode":     dep["errorCode"],
		"errorMessage":  dep["errorMessage"],
		"regions":       arrayOrEmpty(dep["regions"]),
		"functions":     dep["functions"],
		"routes":        dep["routes"],
		"plan":          dep["plan"],
		"projectId":     dep["projectId"],
		"gitSource":     dep["gitSource"],
		"alias":         aliasValues,
	}
}

func formatDeploymentBrief(dep corestore.Record, store Store) map[string]any {
	creator := firstRecord(store.Users.FindBy("uid", stringField(dep, "creatorId")))
	var creatorOut any
	if creator != nil {
		creatorOut = map[string]any{
			"uid":      stringField(creator, "uid"),
			"email":    stringField(creator, "email"),
			"username": stringField(creator, "username"),
		}
	}
	return map[string]any{
		"uid":           stringField(dep, "uid"),
		"name":          stringField(dep, "name"),
		"url":           stringField(dep, "url"),
		"created":       timeMillisField(dep, "created_at"),
		"state":         dep["state"],
		"readyState":    dep["readyState"],
		"type":          "LAMBDAS",
		"creator":       creatorOut,
		"meta":          mapOrEmpty(dep["meta"]),
		"target":        dep["target"],
		"aliasAssigned": dep["aliasAssigned"],
		"projectId":     dep["projectId"],
	}
}

func formatDomain(domain corestore.Record) map[string]any {
	verification := domain["verification"]
	if boolField(domain, "verified") {
		verification = []any{}
	}
	return map[string]any{
		"name":                stringField(domain, "name"),
		"apexName":            stringField(domain, "apexName"),
		"projectId":           stringField(domain, "projectId"),
		"redirect":            domain["redirect"],
		"redirectStatusCode":  domain["redirectStatusCode"],
		"gitBranch":           domain["gitBranch"],
		"customEnvironmentId": domain["customEnvironmentId"],
		"updatedAt":           timeMillisField(domain, "updated_at"),
		"createdAt":           timeMillisField(domain, "created_at"),
		"verified":            boolField(domain, "verified"),
		"verification":        verification,
	}
}

func formatEnvVar(env corestore.Record, decrypt bool) map[string]any {
	value := ""
	if decrypt || stringField(env, "type") == "plain" {
		value = stringField(env, "value")
	}
	comment := env["comment"]
	if comment == nil {
		comment = ""
	}
	return map[string]any{
		"type":                 stringField(env, "type"),
		"id":                   stringField(env, "uid"),
		"key":                  stringField(env, "key"),
		"value":                value,
		"target":               stringSliceValue(env["target"]),
		"gitBranch":            env["gitBranch"],
		"customEnvironmentIds": stringSliceValue(env["customEnvironmentIds"]),
		"configurationId":      nil,
		"createdAt":            timeMillisField(env, "created_at"),
		"updatedAt":            timeMillisField(env, "updated_at"),
		"createdBy":            nil,
		"updatedBy":            nil,
		"comment":              comment,
	}
}

func arrayOrEmpty(value any) any {
	if value == nil {
		return []any{}
	}
	return value
}

func mapOrEmpty(value any) any {
	if value == nil {
		return map[string]any{}
	}
	return value
}

func constantTimeEqual(left string, right string) bool {
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func matchesRedirectURI(uri string, registered []string) bool {
	for _, candidate := range registered {
		if uri == candidate {
			return true
		}
	}
	return false
}

func encodePKCES256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func normalizeURLParam(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		parsed, err := url.Parse(raw)
		if err == nil && parsed.Hostname() != "" {
			return parsed.Hostname()
		}
	}
	return raw
}

func primaryHostFromBaseURL(baseURL string) string {
	parsed, err := url.Parse(baseURL)
	if err == nil && parsed.Hostname() != "" && parsed.Hostname() != "localhost" && parsed.Hostname() != "127.0.0.1" {
		return parsed.Hostname()
	}
	return "vercel.app"
}

func deploymentHostname(name string, uid string, baseURL string) string {
	shortID := uid
	if strings.HasPrefix(shortID, "dpl_") {
		shortID = strings.TrimPrefix(shortID, "dpl_")
	}
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	return fmt.Sprintf("%s-%s.%s", name, shortID, primaryHostFromBaseURL(baseURL))
}

func productionProjectAlias(projectName string, baseURL string) string {
	return projectName + "." + primaryHostFromBaseURL(baseURL)
}
