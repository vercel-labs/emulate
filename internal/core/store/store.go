package store

import (
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"
)

type Record map[string]any

type CollectionSnapshot struct {
	Items       []Record `json:"items"`
	AutoID      int      `json:"autoId"`
	IndexFields []string `json:"indexFields"`
}

type StoreSnapshot struct {
	Collections map[string]CollectionSnapshot `json:"collections"`
	Data        map[string]any                `json:"data"`
}

type Store struct {
	mu          sync.RWMutex
	collections map[string]*Collection
	data        map[string]any
}

func New() *Store {
	return &Store{
		collections: map[string]*Collection{},
		data:        map[string]any{},
	}
}

func (s *Store) Collection(name string, indexFields ...string) (*Collection, error) {
	requested := normalizeFields(indexFields)

	s.mu.Lock()
	defer s.mu.Unlock()

	if existing, ok := s.collections[name]; ok {
		if len(requested) > 0 && !sameStrings(existing.IndexFields(), requested) {
			return nil, fmt.Errorf("collection %q already exists with indexes %v but was requested with %v", name, existing.IndexFields(), requested)
		}
		return existing, nil
	}

	collection := newCollection(requested)
	s.collections[name] = collection
	return collection, nil
}

func (s *Store) MustCollection(name string, indexFields ...string) *Collection {
	collection, err := s.Collection(name, indexFields...)
	if err != nil {
		panic(err)
	}
	return collection
}

func (s *Store) SetData(key string, value any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[key] = cloneValue(value)
}

func (s *Store) GetData(key string) (any, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	value, ok := s.data[key]
	if !ok {
		return nil, false
	}
	return cloneValue(value), true
}

func (s *Store) Reset() {
	s.mu.Lock()
	collections := make([]*Collection, 0, len(s.collections))
	for _, collection := range s.collections {
		collections = append(collections, collection)
	}
	s.data = map[string]any{}
	s.mu.Unlock()

	for _, collection := range collections {
		collection.Clear()
	}
}

func (s *Store) Snapshot() StoreSnapshot {
	s.mu.RLock()
	names := make([]string, 0, len(s.collections))
	for name := range s.collections {
		names = append(names, name)
	}
	sort.Strings(names)

	collections := make(map[string]*Collection, len(s.collections))
	for _, name := range names {
		collections[name] = s.collections[name]
	}

	data := make(map[string]any, len(s.data))
	for key, value := range s.data {
		data[key] = cloneValue(value)
	}
	s.mu.RUnlock()

	snapshots := make(map[string]CollectionSnapshot, len(collections))
	for _, name := range names {
		snapshots[name] = collections[name].Snapshot()
	}

	return StoreSnapshot{Collections: snapshots, Data: data}
}

func (s *Store) Restore(snapshot StoreSnapshot) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for name := range s.collections {
		if _, ok := snapshot.Collections[name]; !ok {
			delete(s.collections, name)
		}
	}

	for name, collectionSnapshot := range snapshot.Collections {
		fields := normalizeFields(collectionSnapshot.IndexFields)
		collection, ok := s.collections[name]
		if !ok || !sameStrings(collection.IndexFields(), fields) {
			collection = newCollection(fields)
			s.collections[name] = collection
		}
		if err := collection.Restore(collectionSnapshot); err != nil {
			return fmt.Errorf("restore collection %q: %w", name, err)
		}
	}

	s.data = make(map[string]any, len(snapshot.Data))
	for key, value := range snapshot.Data {
		s.data[key] = cloneValue(value)
	}
	return nil
}

func (s *Store) MarshalSnapshot() ([]byte, error) {
	return json.MarshalIndent(s.Snapshot(), "", "  ")
}

func (s *Store) RestoreJSON(raw []byte) error {
	var snapshot StoreSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return err
	}
	return s.Restore(snapshot)
}

type Collection struct {
	mu          sync.RWMutex
	items       map[int]Record
	indexes     map[string]map[string]map[int]struct{}
	indexFields []string
	autoID      int
}

func newCollection(indexFields []string) *Collection {
	indexes := make(map[string]map[string]map[int]struct{}, len(indexFields))
	for _, field := range indexFields {
		indexes[field] = map[string]map[int]struct{}{}
	}
	return &Collection{
		items:       map[int]Record{},
		indexes:     indexes,
		indexFields: append([]string(nil), indexFields...),
		autoID:      1,
	}
}

func (c *Collection) Insert(record Record) Record {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := timestamp()
	item := cloneRecord(record)
	id, ok := numericID(item["id"])
	if !ok || id <= 0 {
		id = c.autoID
	}
	if id >= c.autoID {
		c.autoID = id + 1
	}

	if existing, ok := c.items[id]; ok {
		c.removeFromIndexes(existing)
	}

	item["id"] = id
	if _, ok := item["created_at"]; !ok {
		item["created_at"] = now
	}
	item["updated_at"] = now
	c.items[id] = item
	c.addToIndexes(item)
	return cloneRecord(item)
}

func (c *Collection) Get(id int) (Record, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	item, ok := c.items[id]
	if !ok {
		return nil, false
	}
	return cloneRecord(item), true
}

func (c *Collection) Update(id int, patch Record) (Record, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	existing, ok := c.items[id]
	if !ok {
		return nil, false
	}
	c.removeFromIndexes(existing)

	updated := cloneRecord(existing)
	for key, value := range patch {
		if key == "id" {
			continue
		}
		updated[key] = cloneValue(value)
	}
	updated["updated_at"] = timestamp()
	c.items[id] = updated
	c.addToIndexes(updated)
	return cloneRecord(updated), true
}

func (c *Collection) Delete(id int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	existing, ok := c.items[id]
	if !ok {
		return false
	}
	c.removeFromIndexes(existing)
	delete(c.items, id)
	return true
}

func (c *Collection) All() []Record {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.allLocked()
}

func (c *Collection) FindBy(field string, value any) []Record {
	c.mu.RLock()
	defer c.mu.RUnlock()

	key := indexKey(value)
	if index, ok := c.indexes[field]; ok {
		ids := sortedIDs(index[key])
		records := make([]Record, 0, len(ids))
		for _, id := range ids {
			if item, ok := c.items[id]; ok {
				records = append(records, cloneRecord(item))
			}
		}
		return records
	}

	records := make([]Record, 0)
	for _, item := range c.allLocked() {
		if indexKey(item[field]) == key {
			records = append(records, item)
		}
	}
	return records
}

func (c *Collection) Count() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.items)
}

func (c *Collection) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items = map[int]Record{}
	for _, index := range c.indexes {
		for key := range index {
			delete(index, key)
		}
	}
	c.autoID = 1
}

func (c *Collection) Snapshot() CollectionSnapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return CollectionSnapshot{
		Items:       c.allLocked(),
		AutoID:      c.autoID,
		IndexFields: append([]string(nil), c.indexFields...),
	}
}

func (c *Collection) Restore(snapshot CollectionSnapshot) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	fields := normalizeFields(snapshot.IndexFields)
	if !sameStrings(c.indexFields, fields) {
		c.indexFields = fields
		c.indexes = map[string]map[string]map[int]struct{}{}
		for _, field := range fields {
			c.indexes[field] = map[string]map[int]struct{}{}
		}
	}

	c.items = map[int]Record{}
	for _, index := range c.indexes {
		for key := range index {
			delete(index, key)
		}
	}

	c.autoID = snapshot.AutoID
	if c.autoID < 1 {
		c.autoID = 1
	}
	for _, item := range snapshot.Items {
		id, ok := numericID(item["id"])
		if !ok || id <= 0 {
			return fmt.Errorf("record is missing positive numeric id")
		}
		record := cloneRecord(item)
		record["id"] = id
		c.items[id] = record
		c.addToIndexes(record)
		if id >= c.autoID {
			c.autoID = id + 1
		}
	}
	return nil
}

func (c *Collection) IndexFields() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return append([]string(nil), c.indexFields...)
}

func (c *Collection) allLocked() []Record {
	ids := make([]int, 0, len(c.items))
	for id := range c.items {
		ids = append(ids, id)
	}
	sort.Ints(ids)

	records := make([]Record, 0, len(ids))
	for _, id := range ids {
		records = append(records, cloneRecord(c.items[id]))
	}
	return records
}

func (c *Collection) addToIndexes(item Record) {
	id, ok := numericID(item["id"])
	if !ok {
		return
	}
	for field, index := range c.indexes {
		value, ok := item[field]
		if !ok || value == nil {
			continue
		}
		key := indexKey(value)
		if _, ok := index[key]; !ok {
			index[key] = map[int]struct{}{}
		}
		index[key][id] = struct{}{}
	}
}

func (c *Collection) removeFromIndexes(item Record) {
	id, ok := numericID(item["id"])
	if !ok {
		return
	}
	for field, index := range c.indexes {
		value, ok := item[field]
		if !ok || value == nil {
			continue
		}
		key := indexKey(value)
		delete(index[key], id)
		if len(index[key]) == 0 {
			delete(index, key)
		}
	}
}

func normalizeFields(fields []string) []string {
	seen := map[string]bool{}
	normalized := make([]string, 0, len(fields))
	for _, field := range fields {
		if field == "" || seen[field] {
			continue
		}
		seen[field] = true
		normalized = append(normalized, field)
	}
	sort.Strings(normalized)
	return normalized
}

func sameStrings(a []string, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sortedIDs(ids map[int]struct{}) []int {
	if len(ids) == 0 {
		return nil
	}
	out := make([]int, 0, len(ids))
	for id := range ids {
		out = append(out, id)
	}
	sort.Ints(out)
	return out
}

func numericID(value any) (int, bool) {
	switch v := value.(type) {
	case int:
		return v, true
	case int8:
		return int(v), true
	case int16:
		return int(v), true
	case int32:
		return int(v), true
	case int64:
		return int(v), true
	case uint:
		return int(v), true
	case uint8:
		return int(v), true
	case uint16:
		return int(v), true
	case uint32:
		return int(v), true
	case uint64:
		return int(v), true
	case float64:
		id := int(v)
		return id, float64(id) == v
	case json.Number:
		id, err := v.Int64()
		return int(id), err == nil
	default:
		return 0, false
	}
}

func indexKey(value any) string {
	return fmt.Sprint(value)
}

func timestamp() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func cloneRecord(record Record) Record {
	if record == nil {
		return Record{}
	}
	out := make(Record, len(record))
	for key, value := range record {
		out[key] = cloneValue(value)
	}
	return out
}

func cloneValue(value any) any {
	switch v := value.(type) {
	case Record:
		return cloneRecord(v)
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, nested := range v {
			out[key] = cloneValue(nested)
		}
		return out
	case []Record:
		out := make([]Record, len(v))
		for i, nested := range v {
			out[i] = cloneRecord(nested)
		}
		return out
	case []map[string]any:
		out := make([]map[string]any, len(v))
		for i, nested := range v {
			out[i] = cloneValue(nested).(map[string]any)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, nested := range v {
			out[i] = cloneValue(nested)
		}
		return out
	case []string:
		return append([]string(nil), v...)
	case []int:
		return append([]int(nil), v...)
	default:
		return v
	}
}
