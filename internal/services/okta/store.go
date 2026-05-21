package okta

import corestore "github.com/vercel-labs/emulate/internal/core/store"

type Store struct {
	Users                *corestore.Collection
	Groups               *corestore.Collection
	Apps                 *corestore.Collection
	OAuthClients         *corestore.Collection
	AuthorizationServers *corestore.Collection
	GroupMemberships     *corestore.Collection
	AppAssignments       *corestore.Collection
	OAuthCodes           *corestore.Collection
	AccessTokens         *corestore.Collection
	RefreshTokens        *corestore.Collection
}

func NewStore(store *corestore.Store) Store {
	return Store{
		Users:                store.MustCollection("okta.users", "okta_id", "login", "email"),
		Groups:               store.MustCollection("okta.groups", "okta_id", "name"),
		Apps:                 store.MustCollection("okta.apps", "okta_id", "name"),
		OAuthClients:         store.MustCollection("okta.oauth_clients", "client_id", "auth_server_id"),
		AuthorizationServers: store.MustCollection("okta.auth_servers", "server_id"),
		GroupMemberships:     store.MustCollection("okta.group_memberships", "group_okta_id", "user_okta_id"),
		AppAssignments:       store.MustCollection("okta.app_assignments", "app_okta_id", "user_okta_id"),
		OAuthCodes:           store.MustCollection("okta.oauth_codes", "code", "auth_server_id", "client_id", "user_okta_id"),
		AccessTokens:         store.MustCollection("okta.access_tokens", "token", "auth_server_id", "client_id", "user_okta_id"),
		RefreshTokens:        store.MustCollection("okta.refresh_tokens", "token", "auth_server_id", "client_id", "user_okta_id"),
	}
}
