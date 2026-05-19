package resend

import corestore "github.com/vercel-labs/emulate/internal/core/store"

type Store struct {
	Emails    *corestore.Collection
	Domains   *corestore.Collection
	APIKeys   *corestore.Collection
	Audiences *corestore.Collection
	Contacts  *corestore.Collection
}

func NewStore(runtimeStore *corestore.Store) Store {
	return Store{
		Emails:    runtimeStore.MustCollection("resend.emails", "uuid"),
		Domains:   runtimeStore.MustCollection("resend.domains", "uuid", "name"),
		APIKeys:   runtimeStore.MustCollection("resend.api_keys", "uuid"),
		Audiences: runtimeStore.MustCollection("resend.audiences", "uuid", "name"),
		Contacts:  runtimeStore.MustCollection("resend.contacts", "uuid", "audience_id"),
	}
}
