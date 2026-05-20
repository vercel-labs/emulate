package github

import corestore "github.com/vercel-labs/emulate/internal/core/store"

type Store struct {
	Users         *corestore.Collection
	Orgs          *corestore.Collection
	Teams         *corestore.Collection
	TeamMembers   *corestore.Collection
	Repos         *corestore.Collection
	Collaborators *corestore.Collection
	Issues        *corestore.Collection
	PullRequests  *corestore.Collection
	Labels        *corestore.Collection
	Milestones    *corestore.Collection
	Comments      *corestore.Collection
	Branches      *corestore.Collection
	Refs          *corestore.Collection
	Commits       *corestore.Collection
	Trees         *corestore.Collection
	Blobs         *corestore.Collection
	OAuthApps     *corestore.Collection
	OAuthCodes    *corestore.Collection
	OAuthTokens   *corestore.Collection
	Tokens        *corestore.Collection
	Webhooks      *corestore.Collection
}

func NewStore(runtimeStore *corestore.Store) Store {
	return Store{
		Users:         runtimeStore.MustCollection("github.users", "login"),
		Orgs:          runtimeStore.MustCollection("github.orgs", "login"),
		Teams:         runtimeStore.MustCollection("github.teams", "org_id", "slug"),
		TeamMembers:   runtimeStore.MustCollection("github.team_members", "team_id", "user_id"),
		Repos:         runtimeStore.MustCollection("github.repos", "owner_id", "full_name"),
		Collaborators: runtimeStore.MustCollection("github.collaborators", "repo_id", "user_id"),
		Issues:        runtimeStore.MustCollection("github.issues", "repo_id", "number"),
		PullRequests:  runtimeStore.MustCollection("github.pull_requests", "repo_id", "number"),
		Labels:        runtimeStore.MustCollection("github.labels", "repo_id"),
		Milestones:    runtimeStore.MustCollection("github.milestones", "repo_id", "number"),
		Comments:      runtimeStore.MustCollection("github.comments", "repo_id"),
		Branches:      runtimeStore.MustCollection("github.branches", "repo_id"),
		Refs:          runtimeStore.MustCollection("github.refs", "repo_id"),
		Commits:       runtimeStore.MustCollection("github.commits", "repo_id", "sha"),
		Trees:         runtimeStore.MustCollection("github.trees", "repo_id", "sha"),
		Blobs:         runtimeStore.MustCollection("github.blobs", "repo_id", "sha"),
		OAuthApps:     runtimeStore.MustCollection("github.oauth_apps", "client_id"),
		OAuthCodes:    runtimeStore.MustCollection("github.oauth_codes", "code", "client_id"),
		OAuthTokens:   runtimeStore.MustCollection("github.oauth_tokens", "tokenString", "login"),
		Tokens:        runtimeStore.MustCollection("github.tokens", "tokenString", "login"),
		Webhooks:      runtimeStore.MustCollection("github.webhooks", "repo_id", "org_id"),
	}
}
