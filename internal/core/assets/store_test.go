package assets

import (
	"bytes"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"reflect"
	"testing"
	"time"
)

func TestStoreBytesRoundTripIsBinarySafe(t *testing.T) {
	store := New(WithClock(fixedClock()))
	body := []byte{0x00, 0xff, 0x10, 'a', '\n'}

	metadata, err := store.PutBytes("s3/photos/raw.bin", body, PutOptions{
		ContentType: "application/octet-stream",
	})
	if err != nil {
		t.Fatal(err)
	}
	body[1] = 0x01

	readBody, readMetadata, ok := store.Bytes("s3/photos/raw.bin")
	if !ok {
		t.Fatal("asset was not stored")
	}
	want := []byte{0x00, 0xff, 0x10, 'a', '\n'}
	if !bytes.Equal(readBody, want) {
		t.Fatalf("body = %v, want %v", readBody, want)
	}
	readBody[0] = 0x7f
	secondRead, _, ok := store.Bytes("s3/photos/raw.bin")
	if !ok {
		t.Fatal("asset was not stored on second read")
	}
	if !bytes.Equal(secondRead, want) {
		t.Fatalf("second read body = %v, want %v", secondRead, want)
	}

	if metadata.ContentLength != int64(len(want)) || readMetadata.ContentLength != int64(len(want)) {
		t.Fatalf("content length metadata = %#v %#v", metadata, readMetadata)
	}
	if metadata.ChecksumMD5 != hexDigestMD5(want) {
		t.Fatalf("md5 = %q, want %q", metadata.ChecksumMD5, hexDigestMD5(want))
	}
	if metadata.ChecksumSHA256 != hexDigestSHA256(want) {
		t.Fatalf("sha256 = %q, want %q", metadata.ChecksumSHA256, hexDigestSHA256(want))
	}
	if metadata.ETag != `"`+hexDigestMD5(want)+`"` {
		t.Fatalf("etag = %q", metadata.ETag)
	}
}

func TestStoreStreamingWriteAndRead(t *testing.T) {
	store := New(WithClock(fixedClock()))
	userMetadata := map[string]string{"source": "upload"}

	metadata, err := store.Put("lambda/function.zip", bytes.NewReader([]byte("zip-bytes")), PutOptions{
		Purpose:      "aws.lambda.package",
		ContentType:  "application/zip",
		UserMetadata: userMetadata,
	})
	if err != nil {
		t.Fatal(err)
	}
	userMetadata["source"] = "mutated"

	reader, readMetadata, ok := store.Open("lambda/function.zip")
	if !ok {
		t.Fatal("asset was not stored")
	}
	defer reader.Close()
	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}

	if string(body) != "zip-bytes" {
		t.Fatalf("body = %q, want zip-bytes", body)
	}
	if metadata.ContentType != "application/zip" || readMetadata.ContentType != "application/zip" {
		t.Fatalf("content type metadata = %#v %#v", metadata, readMetadata)
	}
	if readMetadata.Purpose != "aws.lambda.package" {
		t.Fatalf("purpose = %q, want aws.lambda.package", readMetadata.Purpose)
	}
	if readMetadata.LastModified != fixedTime() {
		t.Fatalf("last modified = %s, want %s", readMetadata.LastModified, fixedTime())
	}
	if readMetadata.UserMetadata["source"] != "upload" {
		t.Fatalf("user metadata = %#v", readMetadata.UserMetadata)
	}
	readMetadata.UserMetadata["source"] = "changed"
	storedMetadata, ok := store.Get("lambda/function.zip")
	if !ok {
		t.Fatal("asset was not stored after metadata read")
	}
	if storedMetadata.UserMetadata["source"] != "upload" {
		t.Fatalf("stored metadata was mutated: %#v", storedMetadata.UserMetadata)
	}
}

func TestStoreDefaultsAndOverrides(t *testing.T) {
	store := New(WithClock(fixedClock()))
	customModified := time.Date(2026, 5, 19, 6, 30, 0, 0, time.FixedZone("offset", -5*60*60))

	metadata, err := store.PutBytes("custom", []byte("body"), PutOptions{
		ETag:         `"custom-etag"`,
		LastModified: customModified,
	})
	if err != nil {
		t.Fatal(err)
	}

	if metadata.ContentType != DefaultContentType {
		t.Fatalf("content type = %q, want %q", metadata.ContentType, DefaultContentType)
	}
	if metadata.ETag != `"custom-etag"` {
		t.Fatalf("etag = %q, want custom", metadata.ETag)
	}
	if metadata.LastModified.Location() != time.UTC {
		t.Fatalf("last modified location = %s, want UTC", metadata.LastModified.Location())
	}
	if metadata.LastModified != customModified.UTC() {
		t.Fatalf("last modified = %s, want %s", metadata.LastModified, customModified.UTC())
	}
}

func TestStoreSnapshotUsesStableReferences(t *testing.T) {
	store := New(WithClock(fixedClock()))
	if _, err := store.PutBytes("zeta", []byte("z-body"), PutOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PutBytes("alpha", []byte("a-body"), PutOptions{
		Purpose:     "aws.s3.object",
		ContentType: "text/plain",
	}); err != nil {
		t.Fatal(err)
	}

	snapshot := store.Snapshot()
	if len(snapshot.Assets) != 2 {
		t.Fatalf("snapshot asset count = %d, want 2", len(snapshot.Assets))
	}
	if snapshot.Assets[0].Metadata.ID != "alpha" || snapshot.Assets[1].Metadata.ID != "zeta" {
		t.Fatalf("snapshot order = %#v", snapshot.Assets)
	}
	if snapshot.Assets[0].Reference.Driver != ReferenceDriver || snapshot.Assets[0].Reference.Key != "alpha" {
		t.Fatalf("reference = %#v", snapshot.Assets[0].Reference)
	}
	if snapshot.Assets[0].Reference.Purpose != "aws.s3.object" {
		t.Fatalf("reference purpose = %q", snapshot.Assets[0].Reference.Purpose)
	}
	if snapshot.Assets[0].Reference.ContentLength != int64(len("a-body")) {
		t.Fatalf("reference length = %d", snapshot.Assets[0].Reference.ContentLength)
	}
	if snapshot.Assets[0].Reference.ChecksumSHA256 != hexDigestSHA256([]byte("a-body")) {
		t.Fatalf("reference sha256 = %q", snapshot.Assets[0].Reference.ChecksumSHA256)
	}

	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("a-body")) || bytes.Contains(raw, []byte("z-body")) {
		t.Fatalf("snapshot serialized body bytes: %s", raw)
	}
}

func TestStoreListDeleteAndReset(t *testing.T) {
	store := New(WithClock(fixedClock()))
	if _, err := store.PutBytes("b", []byte("b"), PutOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PutBytes("a", []byte("a"), PutOptions{}); err != nil {
		t.Fatal(err)
	}

	items := store.List()
	gotIDs := []string{items[0].ID, items[1].ID}
	if !reflect.DeepEqual(gotIDs, []string{"a", "b"}) {
		t.Fatalf("ids = %#v", gotIDs)
	}
	if !store.Delete("a") || store.Delete("a") {
		t.Fatal("delete did not report expected state")
	}
	if store.Count() != 1 {
		t.Fatalf("count = %d, want 1", store.Count())
	}

	store.Reset()
	if store.Count() != 0 {
		t.Fatalf("count after reset = %d, want 0", store.Count())
	}
}

func fixedClock() func() time.Time {
	return func() time.Time {
		return fixedTime()
	}
}

func fixedTime() time.Time {
	return time.Date(2026, 5, 19, 12, 0, 0, 123, time.UTC)
}

func hexDigestMD5(body []byte) string {
	sum := md5.Sum(body)
	return hex.EncodeToString(sum[:])
}

func hexDigestSHA256(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}
