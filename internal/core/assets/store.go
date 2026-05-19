package assets

import (
	"bytes"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"sort"
	"sync"
	"time"
)

const (
	DefaultContentType = "application/octet-stream"
	ReferenceDriver    = "memory"
)

type Store struct {
	mu     sync.RWMutex
	assets map[string]asset
	now    func() time.Time
}

type Option func(*Store)

type PutOptions struct {
	Purpose      string
	ContentType  string
	ETag         string
	LastModified time.Time
	UserMetadata map[string]string
}

type Metadata struct {
	ID             string            `json:"id"`
	Purpose        string            `json:"purpose,omitempty"`
	ContentType    string            `json:"contentType"`
	ContentLength  int64             `json:"contentLength"`
	ChecksumMD5    string            `json:"checksumMd5"`
	ChecksumSHA256 string            `json:"checksumSha256"`
	ETag           string            `json:"etag"`
	LastModified   time.Time         `json:"lastModified"`
	UserMetadata   map[string]string `json:"userMetadata,omitempty"`
}

type Reference struct {
	Purpose        string `json:"purpose,omitempty"`
	Driver         string `json:"driver"`
	Key            string `json:"key"`
	ContentLength  int64  `json:"contentLength"`
	ChecksumSHA256 string `json:"checksumSha256"`
}

type AssetSnapshot struct {
	Metadata  Metadata  `json:"metadata"`
	Reference Reference `json:"reference"`
}

type StoreSnapshot struct {
	Assets []AssetSnapshot `json:"assets"`
}

type asset struct {
	metadata Metadata
	body     []byte
}

func New(options ...Option) *Store {
	store := &Store{
		assets: map[string]asset{},
		now: func() time.Time {
			return time.Now().UTC()
		},
	}
	for _, option := range options {
		option(store)
	}
	return store
}

func WithClock(now func() time.Time) Option {
	return func(store *Store) {
		if now != nil {
			store.now = now
		}
	}
}

func (store *Store) Put(id string, reader io.Reader, options PutOptions) (Metadata, error) {
	if reader == nil {
		reader = bytes.NewReader(nil)
	}
	body, err := io.ReadAll(reader)
	if err != nil {
		return Metadata{}, fmt.Errorf("read asset body: %w", err)
	}
	return store.PutBytes(id, body, options)
}

func (store *Store) PutBytes(id string, body []byte, options PutOptions) (Metadata, error) {
	if id == "" {
		return Metadata{}, fmt.Errorf("asset id is required")
	}
	metadata := buildMetadata(id, body, options, store.now)
	stored := asset{
		metadata: cloneMetadata(metadata),
		body:     append([]byte(nil), body...),
	}

	store.mu.Lock()
	store.assets[id] = stored
	store.mu.Unlock()

	return cloneMetadata(metadata), nil
}

func (store *Store) Get(id string) (Metadata, bool) {
	store.mu.RLock()
	defer store.mu.RUnlock()

	asset, ok := store.assets[id]
	if !ok {
		return Metadata{}, false
	}
	return cloneMetadata(asset.metadata), true
}

func (store *Store) Bytes(id string) ([]byte, Metadata, bool) {
	store.mu.RLock()
	defer store.mu.RUnlock()

	asset, ok := store.assets[id]
	if !ok {
		return nil, Metadata{}, false
	}
	return append([]byte(nil), asset.body...), cloneMetadata(asset.metadata), true
}

func (store *Store) Open(id string) (io.ReadCloser, Metadata, bool) {
	body, metadata, ok := store.Bytes(id)
	if !ok {
		return nil, Metadata{}, false
	}
	return io.NopCloser(bytes.NewReader(body)), metadata, true
}

func (store *Store) Delete(id string) bool {
	store.mu.Lock()
	defer store.mu.Unlock()

	if _, ok := store.assets[id]; !ok {
		return false
	}
	delete(store.assets, id)
	return true
}

func (store *Store) Reset() {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.assets = map[string]asset{}
}

func (store *Store) Count() int {
	store.mu.RLock()
	defer store.mu.RUnlock()
	return len(store.assets)
}

func (store *Store) List() []Metadata {
	store.mu.RLock()
	defer store.mu.RUnlock()

	ids := store.sortedIDsLocked()
	items := make([]Metadata, 0, len(ids))
	for _, id := range ids {
		items = append(items, cloneMetadata(store.assets[id].metadata))
	}
	return items
}

func (store *Store) Snapshot() StoreSnapshot {
	store.mu.RLock()
	defer store.mu.RUnlock()

	ids := store.sortedIDsLocked()
	snapshot := StoreSnapshot{Assets: make([]AssetSnapshot, 0, len(ids))}
	for _, id := range ids {
		asset := store.assets[id]
		metadata := cloneMetadata(asset.metadata)
		snapshot.Assets = append(snapshot.Assets, AssetSnapshot{
			Metadata: metadata,
			Reference: Reference{
				Purpose:        metadata.Purpose,
				Driver:         ReferenceDriver,
				Key:            metadata.ID,
				ContentLength:  metadata.ContentLength,
				ChecksumSHA256: metadata.ChecksumSHA256,
			},
		})
	}
	return snapshot
}

func (store *Store) sortedIDsLocked() []string {
	ids := make([]string, 0, len(store.assets))
	for id := range store.assets {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func buildMetadata(id string, body []byte, options PutOptions, now func() time.Time) Metadata {
	md5sum := md5.Sum(body)
	sha256sum := sha256.Sum256(body)
	contentType := options.ContentType
	if contentType == "" {
		contentType = DefaultContentType
	}
	lastModified := options.LastModified
	if lastModified.IsZero() {
		lastModified = now()
	}
	lastModified = lastModified.UTC()
	etag := options.ETag
	if etag == "" {
		etag = fmt.Sprintf("%q", hex.EncodeToString(md5sum[:]))
	}

	return Metadata{
		ID:             id,
		Purpose:        options.Purpose,
		ContentType:    contentType,
		ContentLength:  int64(len(body)),
		ChecksumMD5:    hex.EncodeToString(md5sum[:]),
		ChecksumSHA256: hex.EncodeToString(sha256sum[:]),
		ETag:           etag,
		LastModified:   lastModified,
		UserMetadata:   cloneStringMap(options.UserMetadata),
	}
}

func cloneMetadata(metadata Metadata) Metadata {
	metadata.UserMetadata = cloneStringMap(metadata.UserMetadata)
	return metadata
}

func cloneStringMap(values map[string]string) map[string]string {
	if len(values) == 0 {
		return nil
	}
	out := make(map[string]string, len(values))
	for key, value := range values {
		out[key] = value
	}
	return out
}
