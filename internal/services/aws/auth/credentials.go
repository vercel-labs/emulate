package auth

type Credential struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	AccountID       string
	PrincipalARN    string
	Disabled        bool
}

type Store struct {
	credentials map[string]Credential
}

func NewStore(credentials ...Credential) *Store {
	store := &Store{credentials: map[string]Credential{}}
	for _, credential := range credentials {
		if credential.AccessKeyID == "" {
			continue
		}
		store.credentials[credential.AccessKeyID] = credential
	}
	return store
}

func (store *Store) Resolve(accessKeyID string) (Credential, bool) {
	if store == nil || accessKeyID == "" {
		return Credential{}, false
	}
	credential, ok := store.credentials[accessKeyID]
	if !ok || credential.Disabled {
		return Credential{}, false
	}
	return credential, true
}
