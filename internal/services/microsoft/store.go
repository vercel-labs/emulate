package microsoft

import corestore "github.com/vercel-labs/emulate/internal/core/store"

type Store struct {
	Users         *corestore.Collection
	OAuthClients  *corestore.Collection
	OAuthCodes    *corestore.Collection
	RefreshTokens *corestore.Collection
	AccessTokens  *corestore.Collection
}

func NewStore(runtimeStore *corestore.Store) Store {
	return Store{
		Users:         runtimeStore.MustCollection("microsoft.users", "oid", "email"),
		OAuthClients:  runtimeStore.MustCollection("microsoft.oauth_clients", "client_id"),
		OAuthCodes:    runtimeStore.MustCollection("microsoft.oauth_codes", "code", "client_id", "email"),
		RefreshTokens: runtimeStore.MustCollection("microsoft.refresh_tokens", "token", "client_id", "email"),
		AccessTokens:  runtimeStore.MustCollection("microsoft.access_tokens", "token", "login"),
	}
}
