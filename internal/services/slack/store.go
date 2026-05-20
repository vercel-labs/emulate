package slack

import corestore "github.com/vercel-labs/emulate/internal/core/store"

type Store struct {
	Teams            *corestore.Collection
	Users            *corestore.Collection
	Channels         *corestore.Collection
	Messages         *corestore.Collection
	Bots             *corestore.Collection
	OAuthApps        *corestore.Collection
	OAuthCodes       *corestore.Collection
	Tokens           *corestore.Collection
	IncomingWebhooks *corestore.Collection
}

func NewStore(store *corestore.Store) Store {
	return Store{
		Teams:            store.MustCollection("slack.teams", "team_id"),
		Users:            store.MustCollection("slack.users", "user_id", "email", "name"),
		Channels:         store.MustCollection("slack.channels", "channel_id", "name"),
		Messages:         store.MustCollection("slack.messages", "ts", "channel_id"),
		Bots:             store.MustCollection("slack.bots", "bot_id"),
		OAuthApps:        store.MustCollection("slack.oauth_apps", "client_id"),
		OAuthCodes:       store.MustCollection("slack.oauth_codes", "code"),
		Tokens:           store.MustCollection("slack.tokens", "token"),
		IncomingWebhooks: store.MustCollection("slack.incoming_webhooks", "token"),
	}
}
