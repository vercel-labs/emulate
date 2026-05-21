package runtime

import "fmt"

type Service struct {
	Name       string
	Label      string
	Endpoints  string
	InitConfig map[string]any
}

var Services = []Service{
	{
		Name:      "vercel",
		Label:     "Vercel REST API emulator",
		Endpoints: "projects, deployments, domains, env vars, users, teams, file uploads, protection bypass",
		InitConfig: map[string]any{
			"users":        []map[string]any{{"username": "developer", "name": "Developer", "email": "dev@example.com"}},
			"teams":        []map[string]any{{"slug": "my-team", "name": "My Team"}},
			"projects":     []map[string]any{{"name": "my-app", "team": "my-team", "framework": "nextjs"}},
			"integrations": []map[string]any{{"client_id": "oac_example_client_id", "client_secret": "example_client_secret", "name": "My Vercel App", "redirect_uris": []string{"http://localhost:3000/api/auth/callback/vercel"}}},
		},
	},
	{
		Name:      "github",
		Label:     "GitHub REST API emulator",
		Endpoints: "users, repos, issues, PRs, comments, reviews, labels, milestones, branches, git data, orgs, teams, releases, webhooks, search, actions, checks, rate limit",
		InitConfig: map[string]any{
			"users":      []map[string]any{{"login": "octocat", "name": "The Octocat", "email": "octocat@github.com", "bio": "I am the Octocat", "company": "GitHub", "location": "San Francisco"}},
			"orgs":       []map[string]any{{"login": "my-org", "name": "My Organization", "description": "A test organization"}},
			"repos":      []map[string]any{{"owner": "octocat", "name": "hello-world", "description": "My first repository", "language": "JavaScript", "topics": []string{"hello", "world"}, "auto_init": true}, {"owner": "my-org", "name": "org-repo", "description": "An organization repository", "language": "TypeScript", "auto_init": true}},
			"oauth_apps": []map[string]any{{"client_id": "Iv1.example_client_id", "client_secret": "example_client_secret", "name": "My App", "redirect_uris": []string{"http://localhost:3000/api/auth/callback/github"}}},
		},
	},
	{
		Name:      "google",
		Label:     "Google OAuth 2.0 / OpenID Connect + Gmail, Calendar, and Drive emulator",
		Endpoints: "OAuth authorize, token exchange, userinfo, OIDC discovery, token revocation, Gmail messages/drafts/threads/labels/history/settings, Calendar lists/events/freebusy, Drive files/uploads",
		InitConfig: map[string]any{
			"users":           []map[string]any{{"email": "testuser@example.com", "name": "Test User", "picture": "https://lh3.googleusercontent.com/a/default-user", "email_verified": true}},
			"oauth_clients":   []map[string]any{{"client_id": "example-client-id.apps.googleusercontent.com", "client_secret": "GOCSPX-example_secret", "name": "Code App (Google)", "redirect_uris": []string{"http://localhost:3000/api/auth/callback/google"}}},
			"labels":          []map[string]any{{"id": "Label_ops", "user_email": "testuser@example.com", "name": "Ops/Review", "color_background": "#DDEEFF", "color_text": "#111111"}},
			"messages":        []map[string]any{{"id": "msg_welcome", "user_email": "testuser@example.com", "from": "welcome@example.com", "to": "testuser@example.com", "subject": "Welcome to the Gmail emulator", "body_text": "You can now test Gmail, Calendar, and Drive flows locally.", "label_ids": []string{"INBOX", "UNREAD", "CATEGORY_UPDATES"}, "date": "2025-01-04T10:00:00.000Z"}},
			"calendars":       []map[string]any{{"id": "primary", "user_email": "testuser@example.com", "summary": "testuser@example.com", "primary": true, "selected": true, "time_zone": "UTC"}},
			"calendar_events": []map[string]any{{"id": "evt_kickoff", "user_email": "testuser@example.com", "calendar_id": "primary", "summary": "Project Kickoff", "start_date_time": "2025-01-10T09:00:00.000Z", "end_date_time": "2025-01-10T09:30:00.000Z"}},
			"drive_items":     []map[string]any{{"id": "drv_docs", "user_email": "testuser@example.com", "name": "Docs", "mime_type": "application/vnd.google-apps.folder", "parent_ids": []string{"root"}}},
		},
	},
	{Name: "slack", Label: "Slack API emulator", Endpoints: "auth, chat, conversations, users, reactions, team, OAuth, incoming webhooks", InitConfig: map[string]any{"team": map[string]any{"name": "My Workspace", "domain": "my-workspace"}, "users": []map[string]any{{"name": "developer", "real_name": "Developer", "email": "dev@example.com"}}, "channels": []map[string]any{{"name": "general", "topic": "General discussion"}, {"name": "random", "topic": "Random stuff"}}, "bots": []map[string]any{{"name": "my-bot"}}, "oauth_apps": []map[string]any{{"client_id": "12345.67890", "client_secret": "example_client_secret", "name": "My Slack App", "redirect_uris": []string{"http://localhost:3000/api/auth/callback/slack"}}}}},
	{Name: "apple", Label: "Apple Sign In / OAuth emulator", Endpoints: "OAuth authorize, token exchange, JWKS", InitConfig: map[string]any{"users": []map[string]any{{"email": "testuser@icloud.com", "name": "Test User"}}, "oauth_clients": []map[string]any{{"client_id": "com.example.app", "team_id": "TEAM001", "name": "My Apple App", "redirect_uris": []string{"http://localhost:3000/api/auth/callback/apple"}}}}},
	{Name: "microsoft", Label: "Microsoft Entra ID OAuth 2.0 / OpenID Connect emulator", Endpoints: "OAuth authorize, token exchange, userinfo, OIDC discovery, Graph /me, logout, token revocation", InitConfig: map[string]any{"users": []map[string]any{{"email": "testuser@outlook.com", "name": "Test User"}}, "oauth_clients": []map[string]any{{"client_id": "example-client-id", "client_secret": "example-client-secret", "name": "My Microsoft App", "redirect_uris": []string{"http://localhost:3000/api/auth/callback/microsoft-entra-id"}}}}},
	{Name: "okta", Label: "Okta OAuth 2.0 / OpenID Connect + management API emulator", Endpoints: "OIDC discovery, JWKS, OAuth authorize/token/userinfo/introspect/revoke/logout, users, groups, apps, authorization servers", InitConfig: map[string]any{"users": []map[string]any{{"login": "testuser@okta.local", "email": "testuser@okta.local", "first_name": "Test", "last_name": "User"}}, "groups": []map[string]any{{"name": "Everyone", "description": "All users", "type": "BUILT_IN", "okta_id": "00g_everyone"}}, "authorization_servers": []map[string]any{{"id": "default", "name": "default", "audiences": []string{"api://default"}}}, "oauth_clients": []map[string]any{{"client_id": "okta-test-client", "client_secret": "okta-test-secret", "name": "Sample OIDC Client", "redirect_uris": []string{"http://localhost:3000/callback"}, "auth_server_id": "default"}}}},
	{Name: "aws", Label: "AWS cloud service emulator", Endpoints: "S3 (buckets, objects), SQS (queues, messages), SNS (topics, subscriptions), DynamoDB (tables, items), IAM (users, roles, access keys), STS (assume role, caller identity)", InitConfig: map[string]any{"region": "us-east-1", "s3": map[string]any{"buckets": []map[string]any{{"name": "my-app-bucket"}, {"name": "my-app-uploads"}}}, "sqs": map[string]any{"queues": []map[string]any{{"name": "my-app-events"}, {"name": "my-app-dlq"}}}, "iam": map[string]any{"users": []map[string]any{{"user_name": "developer", "create_access_key": true}}, "roles": []map[string]any{{"role_name": "lambda-execution-role", "description": "Role for Lambda function execution"}}}}},
	{Name: "resend", Label: "Resend email API emulator", Endpoints: "emails, domains, contacts, API keys, inbox UI", InitConfig: map[string]any{"domains": []map[string]any{{"name": "example.com", "region": "us-east-1"}}, "contacts": []map[string]any{{"email": "test@example.com", "first_name": "Test", "last_name": "User"}}}},
	{Name: "stripe", Label: "Stripe payments emulator", Endpoints: "customers, payment methods, customer sessions, payment intents, charges, products, prices, checkout sessions, hosted checkout", InitConfig: map[string]any{"customers": []map[string]any{{"email": "test@example.com", "name": "Test Customer"}}, "products": []map[string]any{{"name": "Pro Plan", "description": "Monthly pro subscription"}}, "prices": []map[string]any{{"product_name": "Pro Plan", "currency": "usd", "unit_amount": 2000}}}},
	{Name: "mongoatlas", Label: "MongoDB Atlas service emulator", Endpoints: "Atlas Admin API v2 (projects, clusters, database users, databases, collections), Atlas Data API v1 (findOne, find, insertOne, insertMany, updateOne, updateMany, deleteOne, deleteMany, aggregate)", InitConfig: map[string]any{"projects": []map[string]any{{"name": "Project0"}}, "clusters": []map[string]any{{"name": "Cluster0", "project": "Project0"}}, "database_users": []map[string]any{{"username": "admin", "project": "Project0"}}, "databases": []map[string]any{{"cluster": "Cluster0", "name": "test", "collections": []string{"items"}}}}},
	{Name: "clerk", Label: "Clerk authentication and user management emulator", Endpoints: "OIDC discovery, JWKS, OAuth authorize/token/userinfo, users, email addresses, organizations, memberships, invitations, sessions", InitConfig: map[string]any{"users": []map[string]any{{"first_name": "Test", "last_name": "User", "email_addresses": []string{"test@example.com"}, "password": "clerk_test_password"}}, "organizations": []map[string]any{{"name": "My Company", "slug": "my-company", "members": []map[string]any{{"email": "test@example.com", "role": "admin"}}}}, "oauth_applications": []map[string]any{{"client_id": "clerk_emulate_client", "client_secret": "clerk_emulate_secret", "name": "Emulate App", "redirect_uris": []string{"http://localhost:3000/api/auth/callback/clerk"}}}}},
}

var DefaultTokens = map[string]any{
	"tokens": map[string]any{
		"test_token_admin": map[string]any{
			"login":  "admin",
			"scopes": []string{"repo", "user", "admin:org", "admin:repo_hook"},
		},
		"test_token_user1": map[string]any{
			"login":  "octocat",
			"scopes": []string{"repo", "user"},
		},
	},
}

func ServiceNames() []string {
	names := make([]string, 0, len(Services))
	for _, service := range Services {
		names = append(names, service.Name)
	}
	return names
}

func FindService(name string) (Service, bool) {
	for _, service := range Services {
		if service.Name == name {
			return service, true
		}
	}
	return Service{}, false
}

func StarterConfig(serviceName string) (map[string]any, error) {
	config := cloneMap(DefaultTokens)
	if serviceName == "all" {
		for _, service := range Services {
			config[service.Name] = service.InitConfig
		}
		return config, nil
	}
	service, ok := FindService(serviceName)
	if !ok {
		return nil, fmt.Errorf("unknown service: %s", serviceName)
	}
	config[service.Name] = service.InitConfig
	return config, nil
}

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
