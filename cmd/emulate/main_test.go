package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	emuruntime "github.com/vercel-labs/emulate/internal/runtime"
)

func TestRunListIncludesRegisteredServices(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"list"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("list exited with %d, stderr: %s", code, stderr.String())
	}
	out := stdout.String()
	for _, service := range []string{"github", "aws", "stripe", "clerk"} {
		if !strings.Contains(out, service) {
			t.Fatalf("list output missing %q:\n%s", service, out)
		}
	}
	if !strings.Contains(out, "  mongoatlas  MongoDB Atlas service emulator") {
		t.Fatalf("list output did not separate longest service name from label:\n%s", out)
	}
}

func TestRunListHelpExitsSuccessfully(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"list", "--help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("list help exited with %d, stderr: %s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "npx emulate list") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
	if strings.Contains(stdout.String(), "Available services") {
		t.Fatalf("list printed services for help:\n%s", stdout.String())
	}
}

func TestRunListRejectsUnexpectedArgument(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"list", "extra"}, &stdout, &stderr)
	if code == 0 {
		t.Fatal("list with unexpected argument exited successfully")
	}
	if !strings.Contains(stderr.String(), "Unexpected argument: extra") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
	if strings.Contains(stdout.String(), "Available services") {
		t.Fatalf("list printed services after unexpected argument:\n%s", stdout.String())
	}
}

func TestRunStartRejectsInvalidPort(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"start", "--port", "70000"}, &stdout, &stderr)
	if code == 0 {
		t.Fatal("start with invalid port exited successfully")
	}
	if !strings.Contains(stderr.String(), "Invalid port: 70000") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
}

func TestRunStartRejectsUnexpectedArgument(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"start", "github", "--port", "4010"}, &stdout, &stderr)
	if code == 0 {
		t.Fatal("start with unexpected argument exited successfully")
	}
	if !strings.Contains(stderr.String(), "Unexpected argument: github") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
	if strings.Contains(stdout.String(), "Requested base port") {
		t.Fatalf("start continued after unexpected argument:\n%s", stdout.String())
	}
}

func TestRunStartRejectsBaseURLTemplateForMultipleServices(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"start", "--service", "github,resend", "--base-url", "https://{service}.example.test"}, &stdout, &stderr)
	if code == 0 {
		t.Fatal("start with multi-service base URL template exited successfully")
	}
	if !strings.Contains(stderr.String(), "require exactly one service") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
}

func TestRunStartHelpExitsSuccessfully(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"start", "--help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("start help exited with %d, stderr: %s", code, stderr.String())
	}
	help := stderr.String()
	for _, want := range []string{
		"npx emulate [start] [options]",
		"--base-url <url>",
		"--portless",
	} {
		if !strings.Contains(help, want) {
			t.Fatalf("start help missing %q:\n%s", want, help)
		}
	}
	for _, unwanted := range []string{
		"Usage of start:",
		"\n  -base-url string",
		"\n  -portless\n",
	} {
		if strings.Contains(help, unwanted) {
			t.Fatalf("start help included Go flag syntax %q:\n%s", unwanted, help)
		}
	}
}

func TestRunStartServesHealthEndpoint(t *testing.T) {
	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--port", strconv.Itoa(port), "--service", "github"}, &stdout, &stderr)
	}()

	url := fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath)
	var body struct {
		OK       bool     `json:"ok"`
		Runtime  string   `json:"runtime"`
		Services []string `json:"services"`
	}
	waitForJSON(t, url, &body)

	if !body.OK || body.Runtime != "go" {
		t.Fatalf("unexpected health body: %#v", body)
	}
	if len(body.Services) != 1 || body.Services[0] != "github" {
		t.Fatalf("unexpected services: %#v", body.Services)
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}

	if !strings.Contains(stdout.String(), "Health check:") {
		t.Fatalf("stdout did not include health check:\n%s", stdout.String())
	}
	if stderr.Len() != 0 {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
}

func TestRunStartPortlessRequiresPortless(t *testing.T) {
	original := runPortlessCommand
	runPortlessCommand = func(args []string, stdout io.Writer, stderr io.Writer) error {
		return fmt.Errorf("missing")
	}
	t.Cleanup(func() {
		runPortlessCommand = original
	})

	var stdout, stderr bytes.Buffer
	code := run([]string{"start", "--service", "github", "--portless"}, &stdout, &stderr)
	if code == 0 {
		t.Fatal("portless start exited successfully")
	}
	if !strings.Contains(stderr.String(), "portless is required but not installed") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
}

func TestRunStartPortlessRegistersServiceAliases(t *testing.T) {
	original := runPortlessCommand
	calls := [][]string{}
	runPortlessCommand = func(args []string, stdout io.Writer, stderr io.Writer) error {
		calls = append(calls, append([]string(nil), args...))
		return nil
	}
	t.Cleanup(func() {
		runPortlessCommand = original
	})

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--service", "github", "--port", strconv.Itoa(port), "--portless"}, &stdout, &stderr)
	}()

	var health struct {
		OK      bool   `json:"ok"`
		Runtime string `json:"runtime"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath), &health)
	if !health.OK || health.Runtime != "go" {
		t.Fatalf("unexpected health: %#v", health)
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}

	wantCalls := [][]string{
		{"--version"},
		{"list"},
		{"alias", "github.emulate", strconv.Itoa(port), "--force"},
		{"alias", "--remove", "github.emulate"},
	}
	if fmt.Sprint(calls) != fmt.Sprint(wantCalls) {
		t.Fatalf("calls = %#v, want %#v", calls, wantCalls)
	}
	if !strings.Contains(stdout.String(), "https://github.emulate.localhost") {
		t.Fatalf("stdout missing portless URL:\n%s", stdout.String())
	}
}

func TestRunStartPortlessUsesSeedBaseURL(t *testing.T) {
	original := runPortlessCommand
	runPortlessCommand = func(args []string, stdout io.Writer, stderr io.Writer) error {
		return nil
	}
	t.Cleanup(func() {
		runPortlessCommand = original
	})

	tempDir := t.TempDir()
	seedPath := filepath.Join(tempDir, "emulate.config.json")
	if err := os.WriteFile(seedPath, []byte(`{"github":{"baseUrl":"https://custom-github.example.test"}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--service", "github", "--port", strconv.Itoa(port), "--seed", seedPath, "--portless"}, &stdout, &stderr)
	}()

	var health struct {
		OK      bool   `json:"ok"`
		Runtime string `json:"runtime"`
		BaseURL string `json:"base_url"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath), &health)
	if !health.OK || health.Runtime != "go" || health.BaseURL != "https://custom-github.example.test" {
		t.Fatalf("unexpected health: %#v", health)
	}
	if !strings.Contains(stdout.String(), "https://custom-github.example.test") {
		t.Fatalf("stdout missing seed base URL:\n%s", stdout.String())
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}
}

func TestRunStartSeedsResendFromJSONConfig(t *testing.T) {
	tempDir := t.TempDir()
	seedPath := filepath.Join(tempDir, "emulate.config.json")
	if err := os.WriteFile(seedPath, []byte(`{"resend":{"domains":[{"name":"example.com"}],"contacts":[{"email":"test@example.com","first_name":"Test"}]}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--port", strconv.Itoa(port), "--seed", seedPath}, &stdout, &stderr)
	}()

	healthURL := fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath)
	var health struct {
		OK       bool     `json:"ok"`
		Services []string `json:"services"`
	}
	waitForJSON(t, healthURL, &health)
	if !health.OK || len(health.Services) != 1 || health.Services[0] != "resend" {
		t.Fatalf("unexpected health body: %#v", health)
	}

	var domains struct {
		Data []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"data"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d/domains", port), &domains)
	if len(domains.Data) != 1 || domains.Data[0].Name != "example.com" || domains.Data[0].Status != "verified" {
		t.Fatalf("unexpected seeded domains: %#v", domains)
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}
}

func TestRunStartSeedsGitHubFromJSONConfig(t *testing.T) {
	tempDir := t.TempDir()
	seedPath := filepath.Join(tempDir, "emulate.config.json")
	if err := os.WriteFile(seedPath, []byte(`{"tokens":{"dev_token":{"login":"octocat","scopes":["repo","user"]}},"github":{"users":[{"login":"octocat","email":"octocat@github.com"}],"repos":[{"owner":"octocat","name":"hello-world","auto_init":true}]}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--port", strconv.Itoa(port), "--seed", seedPath}, &stdout, &stderr)
	}()

	var health struct {
		OK       bool     `json:"ok"`
		Services []string `json:"services"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath), &health)
	if !health.OK || len(health.Services) != 1 || health.Services[0] != "github" {
		t.Fatalf("unexpected health body: %#v", health)
	}

	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/repos/octocat/hello-world", port), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer dev_token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("repo status = %d", resp.StatusCode)
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}
}

func TestRunStartSeedsSlackFromJSONConfig(t *testing.T) {
	tempDir := t.TempDir()
	seedPath := filepath.Join(tempDir, "emulate.config.json")
	if err := os.WriteFile(seedPath, []byte(`{"slack":{"team":{"name":"Acme Corp","domain":"acme"},"users":[{"name":"alice","email":"alice@acme.com"}],"channels":[{"name":"engineering","topic":"Code talk"}]}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--port", strconv.Itoa(port), "--seed", seedPath}, &stdout, &stderr)
	}()

	var health struct {
		OK       bool     `json:"ok"`
		Services []string `json:"services"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath), &health)
	if !health.OK || len(health.Services) != 1 || health.Services[0] != "slack" {
		t.Fatalf("unexpected health body: %#v", health)
	}

	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/api/team.info", port), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer xoxb-test-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("team.info status = %d", resp.StatusCode)
	}
	var team struct {
		OK   bool `json:"ok"`
		Team struct {
			Name   string `json:"name"`
			Domain string `json:"domain"`
		} `json:"team"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&team); err != nil {
		t.Fatal(err)
	}
	if !team.OK || team.Team.Name != "Acme Corp" || team.Team.Domain != "acme" {
		t.Fatalf("unexpected team body: %#v", team)
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}
}

func TestRunStartSeedsStripeFromJSONConfig(t *testing.T) {
	tempDir := t.TempDir()
	seedPath := filepath.Join(tempDir, "emulate.config.json")
	if err := os.WriteFile(seedPath, []byte(`{"stripe":{"customers":[{"email":"seed@test.com","name":"Seeded User"}],"products":[{"name":"Widget"}],"prices":[{"product_name":"Widget","currency":"usd","unit_amount":999}]}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--port", strconv.Itoa(port), "--seed", seedPath}, &stdout, &stderr)
	}()

	var health struct {
		OK       bool     `json:"ok"`
		Services []string `json:"services"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath), &health)
	if !health.OK || len(health.Services) != 1 || health.Services[0] != "stripe" {
		t.Fatalf("unexpected health body: %#v", health)
	}

	var customers struct {
		Data []struct {
			Email string `json:"email"`
		} `json:"data"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d/v1/customers?email=seed@test.com", port), &customers)
	if len(customers.Data) != 1 || customers.Data[0].Email != "seed@test.com" {
		t.Fatalf("unexpected seeded customers: %#v", customers)
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}
}

func TestRunStartSeedsClerkFromJSONConfig(t *testing.T) {
	tempDir := t.TempDir()
	seedPath := filepath.Join(tempDir, "emulate.config.json")
	if err := os.WriteFile(seedPath, []byte(`{"clerk":{"users":[{"email_addresses":["alice@example.com"],"first_name":"Alice","password":"alice123"}],"organizations":[{"name":"Acme","slug":"acme","members":[{"email":"alice@example.com","role":"admin"}]}],"oauth_applications":[{"client_id":"test-client","client_secret":"test-secret","name":"Test App","redirect_uris":["http://localhost:3000/callback"]}]}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--port", strconv.Itoa(port), "--seed", seedPath}, &stdout, &stderr)
	}()

	var health struct {
		OK       bool     `json:"ok"`
		Services []string `json:"services"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath), &health)
	if !health.OK || len(health.Services) != 1 || health.Services[0] != "clerk" {
		t.Fatalf("unexpected health body: %#v", health)
	}

	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/v1/users?query=alice", port), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer sk_test_emulate")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("users status = %d", resp.StatusCode)
	}
	var users struct {
		TotalCount int `json:"total_count"`
		Data       []struct {
			FirstName string `json:"first_name"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&users); err != nil {
		t.Fatal(err)
	}
	if users.TotalCount != 1 || len(users.Data) != 1 || users.Data[0].FirstName != "Alice" {
		t.Fatalf("unexpected seeded users: %#v", users)
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}
}

func TestRunStartSeedsMongoAtlasFromJSONConfig(t *testing.T) {
	tempDir := t.TempDir()
	seedPath := filepath.Join(tempDir, "emulate.config.json")
	if err := os.WriteFile(seedPath, []byte(`{"mongoatlas":{"projects":[{"name":"CustomProject"}],"clusters":[{"name":"CustomCluster","project":"CustomProject"}],"database_users":[{"username":"appuser","project":"CustomProject","roles":[{"database_name":"mydb","role_name":"readWrite"}]}],"databases":[{"cluster":"CustomCluster","name":"mydb","collections":["items"]}]}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--port", strconv.Itoa(port), "--seed", seedPath}, &stdout, &stderr)
	}()

	var health struct {
		OK       bool     `json:"ok"`
		Services []string `json:"services"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath), &health)
	if !health.OK || len(health.Services) != 1 || health.Services[0] != "mongoatlas" {
		t.Fatalf("unexpected health body: %#v", health)
	}

	var projects struct {
		Results []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"results"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d/api/atlas/v2/groups", port), &projects)
	if len(projects.Results) != 2 || projects.Results[1].Name != "CustomProject" {
		t.Fatalf("unexpected projects: %#v", projects)
	}

	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/app/data-api/v1/action/insertOne", port), strings.NewReader(`{"dataSource":"CustomCluster","database":"mydb","collection":"items","document":{"name":"Widget"}}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("insert status = %d, body = %s", resp.StatusCode, string(raw))
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}
}

func TestRunStartSeedsAppleFromJSONConfig(t *testing.T) {
	tempDir := t.TempDir()
	seedPath := filepath.Join(tempDir, "emulate.config.json")
	if err := os.WriteFile(seedPath, []byte(`{"apple":{"users":[{"email":"apple@example.com","name":"Apple User"}],"oauth_clients":[{"client_id":"com.example.app","team_id":"TEAM001","name":"My Apple App","redirect_uris":["http://localhost:3000/callback"]}]}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--port", strconv.Itoa(port), "--seed", seedPath}, &stdout, &stderr)
	}()

	var health struct {
		OK       bool     `json:"ok"`
		Services []string `json:"services"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath), &health)
	if !health.OK || len(health.Services) != 1 || health.Services[0] != "apple" {
		t.Fatalf("unexpected health body: %#v", health)
	}

	var discovery struct {
		Issuer                string `json:"issuer"`
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		JWKSURI               string `json:"jwks_uri"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d/.well-known/openid-configuration", port), &discovery)
	if discovery.Issuer != fmt.Sprintf("http://localhost:%d", port) || discovery.AuthorizationEndpoint == "" || discovery.JWKSURI == "" {
		t.Fatalf("unexpected discovery: %#v", discovery)
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}
}

func TestRunStartSeedsMicrosoftFromJSONConfig(t *testing.T) {
	tempDir := t.TempDir()
	seedPath := filepath.Join(tempDir, "emulate.config.json")
	if err := os.WriteFile(seedPath, []byte(`{"microsoft":{"users":[{"email":"ms@example.com","name":"Microsoft User","tenant_id":"tenant-1"}],"oauth_clients":[{"client_id":"ms-client","client_secret":"ms-secret","name":"Microsoft App","redirect_uris":["http://localhost:3000/callback"],"tenant_id":"tenant-1"}]}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--port", strconv.Itoa(port), "--seed", seedPath}, &stdout, &stderr)
	}()

	var health struct {
		OK       bool     `json:"ok"`
		Services []string `json:"services"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath), &health)
	if !health.OK || len(health.Services) != 1 || health.Services[0] != "microsoft" {
		t.Fatalf("unexpected health body: %#v", health)
	}

	var discovery struct {
		Issuer                string `json:"issuer"`
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		JWKSURI               string `json:"jwks_uri"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d/tenant-1/v2.0/.well-known/openid-configuration", port), &discovery)
	if discovery.Issuer != fmt.Sprintf("http://localhost:%d/tenant-1/v2.0", port) || discovery.AuthorizationEndpoint == "" || discovery.JWKSURI == "" {
		t.Fatalf("unexpected discovery: %#v", discovery)
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}
}

func TestRunStartSeedsOktaFromJSONConfig(t *testing.T) {
	tempDir := t.TempDir()
	seedPath := filepath.Join(tempDir, "emulate.config.json")
	if err := os.WriteFile(seedPath, []byte(`{"okta":{"users":[{"login":"okta@example.com","email":"okta@example.com","first_name":"Okta","last_name":"User"}],"oauth_clients":[{"client_id":"okta-client","client_secret":"okta-secret","name":"Okta App","redirect_uris":["http://localhost:3000/callback"],"auth_server_id":"default"}]}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--port", strconv.Itoa(port), "--seed", seedPath}, &stdout, &stderr)
	}()

	var health struct {
		OK       bool     `json:"ok"`
		Services []string `json:"services"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath), &health)
	if !health.OK || len(health.Services) != 1 || health.Services[0] != "okta" {
		t.Fatalf("unexpected health body: %#v", health)
	}

	authorizeURL := fmt.Sprintf("http://127.0.0.1:%d/oauth2/default/v1/authorize?client_id=okta-client&redirect_uri=http%%3A%%2F%%2Flocalhost%%3A3000%%2Fcallback&response_type=code", port)
	resp, err := http.Get(authorizeURL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(raw), "okta@example.com") {
		t.Fatalf("unexpected authorize response status = %d, body = %s", resp.StatusCode, string(raw))
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}
}

func TestRunStartSeedsResendFromYAMLConfig(t *testing.T) {
	tempDir := t.TempDir()
	seedPath := filepath.Join(tempDir, "emulate.config.yaml")
	if err := os.WriteFile(seedPath, []byte("resend:\n  domains:\n    - name: example.com\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--port", strconv.Itoa(port), "--seed", seedPath}, &stdout, &stderr)
	}()

	var health struct {
		OK       bool     `json:"ok"`
		Services []string `json:"services"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath), &health)
	if !health.OK || len(health.Services) != 1 || health.Services[0] != "resend" {
		t.Fatalf("unexpected health body: %#v", health)
	}

	var domains struct {
		Data []struct {
			Name string `json:"name"`
		} `json:"data"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d/domains", port), &domains)
	if len(domains.Data) != 1 || domains.Data[0].Name != "example.com" {
		t.Fatalf("unexpected seeded domains: %#v", domains)
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}
}

func TestRunStartAutoDetectsYAMLConfig(t *testing.T) {
	tempDir := t.TempDir()
	oldDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(tempDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(oldDir); err != nil {
			t.Fatal(err)
		}
	})
	if err := os.WriteFile(filepath.Join(tempDir, "emulate.config.yaml"), []byte("resend:\n  domains:\n    - name: autodetect.example\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--port", strconv.Itoa(port)}, &stdout, &stderr)
	}()

	var health struct {
		OK       bool     `json:"ok"`
		Services []string `json:"services"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath), &health)
	if !health.OK || len(health.Services) != 1 || health.Services[0] != "resend" {
		t.Fatalf("unexpected health body: %#v", health)
	}

	var domains struct {
		Data []struct {
			Name string `json:"name"`
		} `json:"data"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d/domains", port), &domains)
	if len(domains.Data) != 1 || domains.Data[0].Name != "autodetect.example" {
		t.Fatalf("unexpected seeded domains: %#v", domains)
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}
}

func TestRunStartUsesSeedBaseURL(t *testing.T) {
	tempDir := t.TempDir()
	seedPath := filepath.Join(tempDir, "emulate.config.json")
	if err := os.WriteFile(seedPath, []byte(`{"github":{"baseUrl":"https://github.seed.example.test"}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--port", strconv.Itoa(port), "--seed", seedPath}, &stdout, &stderr)
	}()

	var health struct {
		OK       bool     `json:"ok"`
		BaseURL  string   `json:"base_url"`
		Services []string `json:"services"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath), &health)
	if !health.OK || health.BaseURL != "https://github.seed.example.test" || len(health.Services) != 1 || health.Services[0] != "github" {
		t.Fatalf("unexpected health body: %#v", health)
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}
}

func TestRunStartRejectsConflictingSeedBaseURLsForMultipleServices(t *testing.T) {
	tempDir := t.TempDir()
	seedPath := filepath.Join(tempDir, "emulate.config.json")
	if err := os.WriteFile(seedPath, []byte(`{"github":{"baseUrl":"https://github.seed.example.test"},"google":{"baseUrl":"https://google.seed.example.test"}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	code := run([]string{"start", "--service", "github,google", "--port", strconv.Itoa(freePort(t)), "--seed", seedPath}, &stdout, &stderr)
	if code == 0 {
		t.Fatal("start with conflicting seed base URLs exited successfully")
	}
	if !strings.Contains(stderr.String(), "baseUrl seed overrides require exactly one selected service") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
}

func TestRunStartSeedsAWSFromJSONConfig(t *testing.T) {
	tempDir := t.TempDir()
	seedPath := filepath.Join(tempDir, "emulate.config.json")
	if err := os.WriteFile(seedPath, []byte(`{"aws":{"region":"us-west-2","account_id":"999999999999","s3":{"buckets":[{"name":"example","region":"eu-west-1"}]},"sqs":{"queues":[{"name":"seeded-queue","visibility_timeout":45}]},"iam":{"users":[{"user_name":"developer","create_access_key":true}],"roles":[{"role_name":"lambda-execution-role","description":"Role for Lambda function execution"}]}}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runWithContext(ctx, []string{"start", "--port", strconv.Itoa(port), "--seed", seedPath}, &stdout, &stderr)
	}()

	var health struct {
		OK       bool     `json:"ok"`
		Services []string `json:"services"`
	}
	waitForJSON(t, fmt.Sprintf("http://127.0.0.1:%d%s", port, emuruntime.HealthPath), &health)
	if !health.OK || len(health.Services) != 1 || health.Services[0] != "aws" {
		t.Fatalf("unexpected health body: %#v", health)
	}

	req, err := http.NewRequest(http.MethodHead, fmt.Sprintf("http://127.0.0.1:%d/example", port), nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("x-amz-bucket-region") != "eu-west-1" {
		t.Fatalf("head bucket status = %d, region = %q", resp.StatusCode, resp.Header.Get("x-amz-bucket-region"))
	}

	resp, err = http.Post(fmt.Sprintf("http://127.0.0.1:%d/sqs/", port), "application/x-www-form-urlencoded", strings.NewReader("Action=GetQueueUrl&QueueName=seeded-queue"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(raw), "999999999999/seeded-queue") {
		t.Fatalf("get seeded queue status = %d, body = %s", resp.StatusCode, string(raw))
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with %d, stderr: %s", code, stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("start did not shut down after context cancellation")
	}
}

func TestRunTopLevelHelpIncludesFullStartOptions(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"--help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("top-level help exited with %d, stderr: %s", code, stderr.String())
	}
	help := stdout.String()
	for _, want := range []string{
		"npx emulate [start] [options]",
		"--seed <file>",
		"--base-url <url>",
		"--portless",
	} {
		if !strings.Contains(help, want) {
			t.Fatalf("top-level help missing %q:\n%s", want, help)
		}
	}
	if stderr.Len() != 0 {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("unexpected listener address: %v", listener.Addr())
	}
	return addr.Port
}

func waitForJSON(t *testing.T, url string, target any) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		resp, err := http.Get(url)
		if err == nil {
			func() {
				defer resp.Body.Close()
				if resp.StatusCode != http.StatusOK {
					lastErr = fmt.Errorf("status %d", resp.StatusCode)
					return
				}
				lastErr = json.NewDecoder(resp.Body).Decode(target)
			}()
			if lastErr == nil {
				return
			}
		} else {
			lastErr = err
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("GET %s did not return JSON: %v", url, lastErr)
}

func TestRunInitHelpExitsSuccessfully(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"init", "--help"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("init help exited with %d, stderr: %s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "npx emulate init [--service <service>]") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
}

func TestRunInitRejectsUnexpectedArgument(t *testing.T) {
	tempDir := t.TempDir()
	oldDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(tempDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(oldDir); err != nil {
			t.Fatal(err)
		}
	})

	var stdout, stderr bytes.Buffer
	code := run([]string{"init", "aws"}, &stdout, &stderr)
	if code == 0 {
		t.Fatal("init with unexpected argument exited successfully")
	}
	if !strings.Contains(stderr.String(), "Unexpected argument: aws") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
	if _, err := os.Stat(filepath.Join(tempDir, "emulate.config.yaml")); !os.IsNotExist(err) {
		t.Fatalf("unexpected config file stat error: %v", err)
	}
}

func TestRunInitWritesStarterConfig(t *testing.T) {
	tempDir := t.TempDir()
	oldDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(tempDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(oldDir); err != nil {
			t.Fatal(err)
		}
	})

	var stdout, stderr bytes.Buffer
	code := run([]string{"init", "--service", "aws"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("init exited with %d, stderr: %s", code, stderr.String())
	}

	raw, err := os.ReadFile(filepath.Join(tempDir, "emulate.config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	if strings.HasPrefix(content, "{") || strings.Contains(content, "\"tokens\"") {
		t.Fatalf("starter config was written as JSON:\n%s", content)
	}
	if !strings.HasPrefix(content, "tokens:\n") {
		t.Fatalf("starter config missing tokens YAML section:\n%s", content)
	}
	if !strings.Contains(content, "\naws:\n") {
		t.Fatalf("starter config missing aws YAML section:\n%s", content)
	}
	if strings.Contains(content, "\ngithub:\n") {
		t.Fatal("service-specific starter config included github")
	}
}

func TestRunInitRejectsExistingAutoDetectedConfig(t *testing.T) {
	tempDir := t.TempDir()
	oldDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(tempDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(oldDir); err != nil {
			t.Fatal(err)
		}
	})

	existing := filepath.Join(tempDir, "emulate.config.yaml")
	if err := os.WriteFile(existing, []byte("github: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	code := run([]string{"init", "--service", "aws"}, &stdout, &stderr)
	if code == 0 {
		t.Fatal("init with existing config exited successfully")
	}
	if !strings.Contains(stderr.String(), "Config file already exists: emulate.config.yaml") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
}

func TestRunVercelInitWritesScaffold(t *testing.T) {
	tempDir := t.TempDir()
	oldDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(tempDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(oldDir); err != nil {
			t.Fatal(err)
		}
	})

	var stdout, stderr bytes.Buffer
	code := run([]string{"vercel", "init", "--service", "resend,aws"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("vercel init exited with %d, stderr: %s", code, stderr.String())
	}
	handler, err := os.ReadFile(filepath.Join(tempDir, "api", "emulate.go"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(handler), `Services: []string{"resend", "aws"}`) {
		t.Fatalf("unexpected handler:\n%s", string(handler))
	}
	goMod, err := os.ReadFile(filepath.Join(tempDir, "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(goMod), "go 1.24") || !strings.Contains(string(goMod), "github.com/vercel-labs/emulate vdev") {
		t.Fatalf("unexpected go.mod:\n%s", string(goMod))
	}
	config, err := os.ReadFile(filepath.Join(tempDir, "vercel.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(config), `"/emulate/:path*"`) || !strings.Contains(stdout.String(), "Vercel Go Function scaffold ready for: resend, aws") {
		t.Fatalf("unexpected scaffold stdout = %s config = %s", stdout.String(), string(config))
	}
}

func TestRunVercelInitPreservesExistingRewriteFields(t *testing.T) {
	tempDir := t.TempDir()
	oldDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(tempDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(oldDir); err != nil {
			t.Fatal(err)
		}
	})

	existingConfig := `{
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "/api/:path*",
      "has": [{ "type": "host", "value": "example.com" }]
    },
    {
      "source": "/:path*",
      "destination": "/index"
    }
  ]
}
`
	if err := os.WriteFile(filepath.Join(tempDir, "vercel.json"), []byte(existingConfig), 0o644); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	code := run([]string{"vercel", "init", "--service", "resend"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("vercel init exited with %d, stderr: %s", code, stderr.String())
	}
	raw, err := os.ReadFile(filepath.Join(tempDir, "vercel.json"))
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Rewrites []map[string]any `json:"rewrites"`
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatal(err)
	}
	if len(config.Rewrites) != 3 {
		t.Fatalf("rewrites = %#v", config.Rewrites)
	}
	if config.Rewrites[1]["source"] != "/emulate/:path*" || config.Rewrites[2]["source"] != "/:path*" {
		t.Fatalf("unexpected rewrite order: %#v", config.Rewrites)
	}
	has, ok := config.Rewrites[0]["has"].([]any)
	if !ok || len(has) != 1 {
		t.Fatalf("existing rewrite metadata was not preserved: %#v", config.Rewrites[0])
	}
}

func TestRunVercelInitRejectsUnsupportedService(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"vercel", "init", "--service", "linear"}, &stdout, &stderr)
	if code == 0 {
		t.Fatal("vercel init exited successfully")
	}
	if !strings.Contains(stderr.String(), "currently supports native services") {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
}
