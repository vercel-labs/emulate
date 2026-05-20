package github

import (
	"net/url"
	"regexp"
	"strings"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

const serviceLabel = "GitHub"

type Options struct {
	Store   *corestore.Store
	BaseURL string
	Seed    *SeedConfig
}

type SeedConfig struct {
	Port      int                  `json:"port,omitempty"`
	Users     []UserSeed           `json:"users"`
	Orgs      []OrgSeed            `json:"orgs"`
	Tokens    map[string]TokenSeed `json:"tokens"`
	Repos     []RepoSeed           `json:"repos"`
	OAuthApps []OAuthAppSeed       `json:"oauth_apps"`
}

type UserSeed struct {
	Login           string `json:"login"`
	Name            string `json:"name"`
	Email           string `json:"email"`
	Bio             string `json:"bio"`
	Company         string `json:"company"`
	Location        string `json:"location"`
	Blog            string `json:"blog"`
	TwitterUsername string `json:"twitter_username"`
	SiteAdmin       bool   `json:"site_admin"`
}

type OrgSeed struct {
	Login       string `json:"login"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Email       string `json:"email"`
}

type TokenSeed struct {
	Login  string   `json:"login"`
	Scopes []string `json:"scopes"`
}

type RepoSeed struct {
	Owner         string   `json:"owner"`
	Name          string   `json:"name"`
	Description   string   `json:"description"`
	Private       bool     `json:"private"`
	Language      string   `json:"language"`
	Topics        []string `json:"topics"`
	DefaultBranch string   `json:"default_branch"`
	AutoInit      *bool    `json:"auto_init"`
}

type OAuthAppSeed struct {
	ClientID     string   `json:"client_id"`
	ClientSecret string   `json:"client_secret"`
	Name         string   `json:"name"`
	RedirectURIs []string `json:"redirect_uris"`
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
	service := &Service{
		store:   NewStore(runtimeStore),
		baseURL: baseURL,
	}
	service.SeedDefaults()
	if options.Seed == nil || options.Seed.Tokens == nil {
		service.SeedDefaultTokens()
	}
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
	s.registerUserAndOrgRoutes(router)
	s.registerCommentRoutes(router)
	s.registerIssueRoutes(router)
	s.registerPullRoutes(router)
	s.registerBranchAndGitRoutes(router)
	s.registerRepoRoutes(router)
	s.registerMetaRoutes(router)
}

func (s *Service) SeedDefaults() {
	if firstRecord(s.store.Users.FindBy("login", "ghost")) == nil {
		ghost := s.store.Users.Insert(defaultUserRecord("ghost", "Ghost", "", false))
		s.store.Users.Update(intField(ghost, "id"), corestore.Record{"node_id": generateNodeID("User", intField(ghost, "id"))})
	}
	if firstRecord(s.store.Users.FindBy("login", "admin")) == nil {
		admin := s.store.Users.Insert(defaultUserRecord("admin", "Admin", "admin@localhost", true))
		s.store.Users.Update(intField(admin, "id"), corestore.Record{
			"node_id": generateNodeID("User", intField(admin, "id")),
			"bio":     "Default admin user",
		})
	}
}

func (s *Service) SeedDefaultTokens() {
	if firstRecord(s.store.Tokens.FindBy("tokenString", "test_token_admin")) == nil {
		s.store.Tokens.Insert(corestore.Record{
			"tokenString": "test_token_admin",
			"login":       "admin",
			"scopes":      []string{"repo", "user", "admin:org", "admin:repo_hook"},
		})
	}
	if firstRecord(s.store.Tokens.FindBy("tokenString", "test_token_user1")) == nil {
		s.store.Tokens.Insert(corestore.Record{
			"tokenString": "test_token_user1",
			"login":       "octocat",
			"scopes":      []string{"repo", "user"},
		})
	}
}

func (s *Service) SeedFromConfig(config SeedConfig) {
	for _, seed := range config.Users {
		login := strings.TrimSpace(seed.Login)
		if login == "" || firstRecord(s.store.Users.FindBy("login", login)) != nil {
			continue
		}
		user := s.store.Users.Insert(defaultUserRecord(login, seed.Name, seed.Email, seed.SiteAdmin))
		patch := corestore.Record{"node_id": generateNodeID("User", intField(user, "id"))}
		if seed.Bio != "" {
			patch["bio"] = seed.Bio
		}
		if seed.Company != "" {
			patch["company"] = seed.Company
		}
		if seed.Location != "" {
			patch["location"] = seed.Location
		}
		if seed.Blog != "" {
			patch["blog"] = seed.Blog
		}
		if seed.TwitterUsername != "" {
			patch["twitter_username"] = seed.TwitterUsername
		}
		s.store.Users.Update(intField(user, "id"), patch)
	}

	for _, seed := range config.Orgs {
		login := strings.TrimSpace(seed.Login)
		if login == "" || firstRecord(s.store.Orgs.FindBy("login", login)) != nil {
			continue
		}
		org := s.store.Orgs.Insert(defaultOrgRecord(login, seed.Name, seed.Description, seed.Email))
		s.store.Orgs.Update(intField(org, "id"), corestore.Record{"node_id": generateNodeID("Organization", intField(org, "id"))})
	}

	for token, seed := range config.Tokens {
		if strings.TrimSpace(token) == "" || strings.TrimSpace(seed.Login) == "" {
			continue
		}
		if firstRecord(s.store.Tokens.FindBy("tokenString", token)) != nil {
			continue
		}
		scopes := seed.Scopes
		if len(scopes) == 0 {
			scopes = []string{"repo", "user", "admin:org", "admin:repo_hook"}
		}
		s.store.Tokens.Insert(corestore.Record{
			"tokenString": token,
			"login":       seed.Login,
			"scopes":      scopes,
		})
	}

	for _, seed := range config.Repos {
		if strings.TrimSpace(seed.Owner) == "" || strings.TrimSpace(seed.Name) == "" {
			continue
		}
		owner := s.lookupOwner(seed.Owner)
		if owner == nil {
			continue
		}
		if s.lookupRepo(seed.Owner, seed.Name) != nil {
			continue
		}
		defaultBranch := seed.DefaultBranch
		if defaultBranch == "" {
			defaultBranch = "main"
		}
		repo := s.createRepoRecord(createRepoOptions{
			Name:          seed.Name,
			Description:   nullableString(seed.Description),
			Private:       seed.Private,
			OwnerID:       intField(owner, "id"),
			OwnerType:     ownerType(owner),
			OwnerLogin:    seed.Owner,
			DefaultBranch: defaultBranch,
			Language:      nullableString(seed.Language),
			Topics:        seed.Topics,
		})
		autoInit := true
		if seed.AutoInit != nil {
			autoInit = *seed.AutoInit
		}
		if autoInit {
			s.seedInitialGit(repo, owner)
		}
		if seed.Language != "" {
			s.store.Repos.Update(intField(repo, "id"), corestore.Record{
				"language":  seed.Language,
				"languages": map[string]int{seed.Language: 10000},
			})
		}
	}

	for _, seed := range config.OAuthApps {
		if seed.ClientID == "" || firstRecord(s.store.OAuthApps.FindBy("client_id", seed.ClientID)) != nil {
			continue
		}
		s.store.OAuthApps.Insert(corestore.Record{
			"client_id":     seed.ClientID,
			"client_secret": seed.ClientSecret,
			"name":          seed.Name,
			"redirect_uris": seed.RedirectURIs,
		})
	}
}

func defaultUserRecord(login string, name string, email string, siteAdmin bool) corestore.Record {
	if name == "" {
		name = login
	}
	return corestore.Record{
		"login":            login,
		"node_id":          "",
		"avatar_url":       "",
		"gravatar_id":      "",
		"type":             "User",
		"site_admin":       siteAdmin,
		"name":             nullableString(name),
		"company":          nil,
		"blog":             "",
		"location":         nil,
		"email":            nullableString(email),
		"hireable":         nil,
		"bio":              nil,
		"twitter_username": nil,
		"public_repos":     0,
		"public_gists":     0,
		"followers":        0,
		"following":        0,
	}
}

func defaultOrgRecord(login string, name string, description string, email string) corestore.Record {
	return corestore.Record{
		"login":                           login,
		"node_id":                         "",
		"description":                     nullableString(description),
		"name":                            nullableString(name),
		"company":                         nil,
		"blog":                            "",
		"location":                        nil,
		"email":                           nullableString(email),
		"twitter_username":                nil,
		"is_verified":                     false,
		"has_organization_projects":       true,
		"has_repository_projects":         true,
		"public_repos":                    0,
		"public_gists":                    0,
		"followers":                       0,
		"following":                       0,
		"members_can_create_repositories": true,
		"default_repository_permission":   "read",
		"billing_email":                   nil,
	}
}

func (s *Service) authUser(c *corehttp.Context) (*authUser, bool) {
	token := tokenFromRequest(c.Request)
	if token == "" {
		return nil, false
	}
	if row := firstRecord(s.store.OAuthTokens.FindBy("tokenString", token)); row != nil {
		return s.authUserFromLogin(stringField(row, "login"), stringSliceValue(row["scopes"]))
	}
	if row := firstRecord(s.store.Tokens.FindBy("tokenString", token)); row != nil {
		return s.authUserFromLogin(stringField(row, "login"), stringSliceValue(row["scopes"]))
	}
	if token == "test-token" {
		if firstRecord(s.store.Users.FindBy("login", "octocat")) != nil {
			return s.authUserFromLogin("octocat", []string{"repo", "user", "admin:org"})
		}
		return s.authUserFromLogin("admin", []string{"repo", "user", "admin:org", "admin:repo_hook"})
	}
	return nil, false
}

func (s *Service) authUserFromLogin(login string, scopes []string) (*authUser, bool) {
	user := firstRecord(s.store.Users.FindBy("login", login))
	if user == nil {
		return &authUser{Login: login, Scopes: scopes}, true
	}
	if len(scopes) == 0 {
		scopes = []string{"repo", "user"}
	}
	return &authUser{Login: login, ID: intField(user, "id"), Scopes: scopes}, true
}

func (s *Service) currentAuthUser(c *corehttp.Context) (corestore.Record, *authUser, bool) {
	auth, ok := s.authUser(c)
	if !ok {
		writeUnauthorized(c)
		return nil, nil, false
	}
	user := firstRecord(s.store.Users.FindBy("login", auth.Login))
	if user == nil {
		writeUnauthorized(c)
		return nil, nil, false
	}
	return user, auth, true
}

func (s *Service) currentUser(c *corehttp.Context) (corestore.Record, bool) {
	user, _, ok := s.currentAuthUser(c)
	return user, ok
}

func (s *Service) lookupOwner(login string) corestore.Record {
	if user := firstRecord(s.store.Users.FindBy("login", login)); user != nil {
		return user
	}
	return firstRecord(s.store.Orgs.FindBy("login", login))
}

func (s *Service) lookupRepo(owner string, name string) corestore.Record {
	return firstRecord(s.store.Repos.FindBy("full_name", owner+"/"+name))
}

func (s *Service) assertRepoRead(c *corehttp.Context, repo corestore.Record) bool {
	if repo == nil {
		writeNotFound(c)
		return false
	}
	if !boolField(repo, "private") {
		return true
	}
	user, ok := s.authUser(c)
	if !ok {
		writeUnauthorized(c)
		return false
	}
	if !hasScope(user, "repo") {
		writeForbidden(c)
		return false
	}
	if s.canAccessRepo(user, repo) {
		return true
	}
	writeForbidden(c)
	return false
}

func (s *Service) viewerID(c *corehttp.Context) int {
	auth, ok := s.authUser(c)
	if !ok {
		return 0
	}
	return auth.ID
}

func (s *Service) filterReadableRepos(c *corehttp.Context, repos []corestore.Record) []corestore.Record {
	auth, authenticated := s.authUser(c)
	out := make([]corestore.Record, 0, len(repos))
	for _, repo := range repos {
		if !boolField(repo, "private") {
			out = append(out, repo)
			continue
		}
		if authenticated && hasScope(auth, "repo") && s.canAccessRepo(auth, repo) {
			out = append(out, repo)
		}
	}
	return out
}

func (s *Service) assertRepoWrite(c *corehttp.Context, repo corestore.Record) (corestore.Record, bool) {
	user, auth, ok := s.currentAuthUser(c)
	if !ok {
		return nil, false
	}
	if !hasRepoMutationScope(auth, repo) {
		writeForbidden(c)
		return nil, false
	}
	if s.hasRepoAdmin(user, repo) || s.canAccessRepo(auth, repo) {
		return user, true
	}
	writeForbidden(c)
	return nil, false
}

func (s *Service) assertRepoAdmin(c *corehttp.Context, repo corestore.Record) (corestore.Record, bool) {
	user, auth, ok := s.currentAuthUser(c)
	if !ok {
		return nil, false
	}
	if !hasRepoMutationScope(auth, repo) {
		writeForbidden(c)
		return nil, false
	}
	if s.hasRepoAdmin(user, repo) {
		return user, true
	}
	writeForbidden(c)
	return nil, false
}

func (s *Service) assertIssueParticipant(c *corehttp.Context, repo corestore.Record) (corestore.Record, bool) {
	user, auth, ok := s.currentAuthUser(c)
	if !ok {
		return nil, false
	}
	if boolField(repo, "private") {
		if !hasScope(auth, "repo") || !s.canAccessRepo(auth, repo) {
			writeForbidden(c)
			return nil, false
		}
	}
	return user, true
}

func hasRepoMutationScope(user *authUser, repo corestore.Record) bool {
	if boolField(repo, "private") {
		return hasScope(user, "repo")
	}
	return hasScope(user, "repo") || hasScope(user, "public_repo")
}

func hasScope(user *authUser, scope string) bool {
	if user == nil {
		return false
	}
	for _, candidate := range user.Scopes {
		if candidate == scope {
			return true
		}
	}
	return false
}

func (s *Service) canAccessRepo(user *authUser, repo corestore.Record) bool {
	if user == nil {
		return false
	}
	userRecord := firstRecord(s.store.Users.FindBy("login", user.Login))
	if userRecord == nil {
		return false
	}
	userID := intField(userRecord, "id")
	if boolField(userRecord, "site_admin") {
		return true
	}
	if stringField(repo, "owner_type") == "User" && intField(repo, "owner_id") == userID {
		return true
	}
	if stringField(repo, "owner_type") == "Organization" && s.isOrgMember(userID, intField(repo, "owner_id")) {
		return true
	}
	for _, collab := range s.store.Collaborators.FindBy("repo_id", intField(repo, "id")) {
		if intField(collab, "user_id") == userID {
			return true
		}
	}
	return false
}

func (s *Service) hasRepoAdmin(user corestore.Record, repo corestore.Record) bool {
	userID := intField(user, "id")
	if boolField(user, "site_admin") {
		return true
	}
	if stringField(repo, "owner_type") == "User" && intField(repo, "owner_id") == userID {
		return true
	}
	if stringField(repo, "owner_type") == "Organization" && s.isOrgMember(userID, intField(repo, "owner_id")) {
		return true
	}
	for _, collab := range s.store.Collaborators.FindBy("repo_id", intField(repo, "id")) {
		if intField(collab, "user_id") == userID {
			permission := stringField(collab, "permission")
			return permission == "admin" || permission == "maintain"
		}
	}
	return false
}

func (s *Service) isOrgMember(userID int, orgID int) bool {
	for _, team := range s.store.Teams.FindBy("org_id", orgID) {
		for _, member := range s.store.TeamMembers.FindBy("team_id", intField(team, "id")) {
			if intField(member, "user_id") == userID {
				return true
			}
		}
	}
	return false
}

func ownerType(owner corestore.Record) string {
	if stringField(owner, "type") == "User" {
		return "User"
	}
	return "Organization"
}

func validateRepoName(name string) bool {
	if strings.TrimSpace(name) == "" || len(name) > 100 {
		return false
	}
	return regexp.MustCompile(`^[a-zA-Z0-9._-]+$`).MatchString(name)
}

func matchesRedirectURI(candidate string, allowed []string) bool {
	if candidate == "" {
		return true
	}
	candidateURL, err := url.Parse(candidate)
	if err != nil {
		return false
	}
	for _, registered := range allowed {
		registeredURL, err := url.Parse(registered)
		if err != nil {
			continue
		}
		if candidateURL.Scheme == registeredURL.Scheme && candidateURL.Host == registeredURL.Host && strings.TrimRight(candidateURL.Path, "/") == strings.TrimRight(registeredURL.Path, "/") {
			return true
		}
	}
	return false
}

func pendingCodeCreatedAt(row corestore.Record) time.Time {
	millis := intField(row, "createdAt")
	if millis == 0 {
		return time.Now()
	}
	return time.UnixMilli(int64(millis))
}
