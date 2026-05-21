package mongoatlas

import corestore "github.com/vercel-labs/emulate/internal/core/store"

type Store struct {
	Clusters    *corestore.Collection
	Databases   *corestore.Collection
	Collections *corestore.Collection
	Documents   *corestore.Collection
	Projects    *corestore.Collection
	Users       *corestore.Collection
}

func NewStore(store *corestore.Store) Store {
	return Store{
		Clusters:    store.MustCollection("mongoatlas.clusters", "cluster_id", "name"),
		Databases:   store.MustCollection("mongoatlas.databases", "cluster_id", "name"),
		Collections: store.MustCollection("mongoatlas.collections", "cluster_id", "database", "name"),
		Documents:   store.MustCollection("mongoatlas.documents", "cluster_id", "doc_id"),
		Projects:    store.MustCollection("mongoatlas.projects", "group_id"),
		Users:       store.MustCollection("mongoatlas.users", "user_id", "username"),
	}
}
