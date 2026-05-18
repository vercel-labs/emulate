package store

import (
	"encoding/json"
	"testing"
)

func TestCollectionIndexesAndSnapshotRestore(t *testing.T) {
	store := New()
	users, err := store.Collection("users", "email")
	if err != nil {
		t.Fatal(err)
	}

	alice := users.Insert(Record{"email": "alice@example.com", "name": "Alice"})
	bob := users.Insert(Record{"email": "bob@example.com", "name": "Bob"})
	if alice["id"] != 1 || bob["id"] != 2 {
		t.Fatalf("unexpected ids: %#v %#v", alice["id"], bob["id"])
	}

	matches := users.FindBy("email", "alice@example.com")
	if len(matches) != 1 || matches[0]["name"] != "Alice" {
		t.Fatalf("unexpected indexed matches: %#v", matches)
	}

	updated, ok := users.Update(1, Record{"email": "alice@new.test"})
	if !ok || updated["email"] != "alice@new.test" {
		t.Fatalf("unexpected update: %#v %v", updated, ok)
	}
	if oldMatches := users.FindBy("email", "alice@example.com"); len(oldMatches) != 0 {
		t.Fatalf("old index entry remained: %#v", oldMatches)
	}

	snapshot := store.Snapshot()
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}

	restored := New()
	if err := restored.RestoreJSON(raw); err != nil {
		t.Fatal(err)
	}
	restoredUsers, err := restored.Collection("users", "email")
	if err != nil {
		t.Fatal(err)
	}
	restoredMatches := restoredUsers.FindBy("email", "alice@new.test")
	if len(restoredMatches) != 1 || restoredMatches[0]["id"] != 1 {
		t.Fatalf("restored index did not work: %#v", restoredMatches)
	}

	carol := restoredUsers.Insert(Record{"email": "carol@example.com"})
	if carol["id"] != 3 {
		t.Fatalf("auto id after restore = %#v", carol["id"])
	}
}

func TestStoreResetClearsDataAndPreservesCollections(t *testing.T) {
	store := New()
	users := store.MustCollection("users", "email")
	users.Insert(Record{"email": "alice@example.com"})
	store.SetData("token", map[string]any{"login": "alice"})

	store.Reset()

	if users.Count() != 0 {
		t.Fatalf("reset left %d records", users.Count())
	}
	if _, ok := store.GetData("token"); ok {
		t.Fatal("reset left store data")
	}

	users.Insert(Record{"email": "bob@example.com"})
	matches := users.FindBy("email", "bob@example.com")
	if len(matches) != 1 {
		t.Fatalf("index did not survive reset: %#v", matches)
	}
}

func TestStoreRestoreRemovesCollectionsNotInSnapshot(t *testing.T) {
	store := New()
	store.MustCollection("users").Insert(Record{"name": "Alice"})
	store.MustCollection("repos").Insert(Record{"name": "emulate"})

	source := New()
	source.MustCollection("users").Insert(Record{"name": "Bob"})
	if err := store.Restore(source.Snapshot()); err != nil {
		t.Fatal(err)
	}

	if _, ok := store.Snapshot().Collections["repos"]; ok {
		t.Fatal("restore kept collection that was absent from snapshot")
	}
	users, err := store.Collection("users")
	if err != nil {
		t.Fatal(err)
	}
	all := users.All()
	if len(all) != 1 || all[0]["name"] != "Bob" {
		t.Fatalf("unexpected restored users: %#v", all)
	}
}

func TestCollectionRejectsMismatchedIndexes(t *testing.T) {
	store := New()
	if _, err := store.Collection("users", "email"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Collection("users", "login"); err == nil {
		t.Fatal("expected mismatched index error")
	}
}
