package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadExplicitJSONConfig(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "seed.json")
	if err := os.WriteFile(configPath, []byte(`{"tokens":{"t":{"login":"admin"}},"github":{"users":[]}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load(LoadOptions{Path: configPath})
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Format != FormatJSON {
		t.Fatalf("format = %s", loaded.Format)
	}
	if loaded.Filename != configPath {
		t.Fatalf("filename = %q", loaded.Filename)
	}
	if _, ok := loaded.Data["github"]; !ok {
		t.Fatalf("github config missing: %#v", loaded.Data)
	}
}

func TestLoadDiscoversCurrentConfigNamesInOrder(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "service-emulator.config.json"), []byte(`{"stripe":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "emulate.config.json"), []byte(`{"github":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load(LoadOptions{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Filename != "emulate.config.json" {
		t.Fatalf("discovered %q", loaded.Filename)
	}
	if services := InferServices(loaded.Data, []string{"github", "stripe"}); len(services) != 1 || services[0] != "github" {
		t.Fatalf("services = %#v", services)
	}
}

func TestLoadExplicitYAMLConfig(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "emulate.config.yaml"), []byte(`
tokens:
  dev_token:
    login: octocat
    scopes: [repo, user]
github:
  app:
    private_key: |
      -----BEGIN PRIVATE KEY-----
      abc123
      -----END PRIVATE KEY-----
  users:
    - login: octocat
      email: octocat@example.com
      site_admin: true
aws:
  region: us-west-2
  s3:
    buckets:
      - name: docs
        region: eu-west-1
`), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load(LoadOptions{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Format != FormatYAML {
		t.Fatalf("format = %s", loaded.Format)
	}
	var github struct {
		App struct {
			PrivateKey string `json:"private_key"`
		} `json:"app"`
		Users []struct {
			Login     string `json:"login"`
			Email     string `json:"email"`
			SiteAdmin bool   `json:"site_admin"`
		} `json:"users"`
	}
	if err := json.Unmarshal(loaded.Data["github"], &github); err != nil {
		t.Fatal(err)
	}
	if len(github.Users) != 1 || github.Users[0].Login != "octocat" || !github.Users[0].SiteAdmin {
		t.Fatalf("github = %#v", github)
	}
	if github.App.PrivateKey != "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\n" {
		t.Fatalf("private key = %q", github.App.PrivateKey)
	}
	var aws struct {
		Region string `json:"region"`
		S3     struct {
			Buckets []struct {
				Name   string `json:"name"`
				Region string `json:"region"`
			} `json:"buckets"`
		} `json:"s3"`
	}
	if err := json.Unmarshal(loaded.Data["aws"], &aws); err != nil {
		t.Fatal(err)
	}
	if aws.Region != "us-west-2" || len(aws.S3.Buckets) != 1 || aws.S3.Buckets[0].Region != "eu-west-1" {
		t.Fatalf("aws = %#v", aws)
	}
}

func TestLoadRejectsInvalidYAMLConfig(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "emulate.config.yaml"), []byte("github:\n   users: []\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := Load(LoadOptions{Dir: dir})
	if err == nil {
		t.Fatal("expected YAML parse error")
	}
	if IsUnsupportedFormat(err) {
		t.Fatalf("expected parse error, got %v", err)
	}
}

func TestLoadMissingConfig(t *testing.T) {
	_, err := Load(LoadOptions{Dir: t.TempDir()})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestSortedKeys(t *testing.T) {
	keys := SortedKeys(map[string]json.RawMessage{
		"z": nil,
		"a": nil,
	})
	if len(keys) != 2 || keys[0] != "a" || keys[1] != "z" {
		t.Fatalf("keys = %#v", keys)
	}
}
